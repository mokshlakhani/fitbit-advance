import os
import glob
import json
import math
import numpy as np
import pandas as pd
from datetime import datetime, timedelta

import api_ingest
import profile_store
import sleep_score
import body_age

# Recovery baselines (OpenStrap readiness_composite.dart): each vital is compared
# with its own most recent BASELINE_READINGS nightly values, taken from at most
# the previous BASELINE_MAX_AGE days. Fewer readings than that is not a baseline,
# so the vital sits out; with fewer than MIN_INPUTS vitals (or under MIN_WEIGHT of
# the disclosed weight) there is no recovery score that night.
BASELINE_READINGS = 14
BASELINE_MAX_AGE = 28
MIN_INPUTS = 2
MIN_WEIGHT = 0.5

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
# Optional Google Takeout export (history from before the Google Health API
# connection). Unzip it so that one of these folders exists.
_EXPORT_CANDIDATES = [
    os.path.join(PROJECT_DIR, 'takeout', 'Google Health'),
    os.path.join(PROJECT_DIR, 'FitbitAir Data', 'New_Data', 'Google Health'),
    os.path.join(PROJECT_DIR, 'FitbitAir Data', 'Google Health'),
]
BASE_DIR = next((p for p in _EXPORT_CANDIDATES if os.path.isdir(p)), _EXPORT_CANDIDATES[0])

# Name, age, sex, height, weight, time zone: from profile.json (see profile_store).
USER_PROFILE = profile_store.dashboard_profile()


def _takeout_local(text):
    """Takeout's 'MM/DD/YY HH:MM:SS' UTC timestamps -> local naive datetime."""
    return profile_store.utc_to_local(datetime.strptime(text, '%m/%d/%y %H:%M:%S'))

def robust_z(val, baseline):
    if val is None or len(baseline) < 2:
        return 0.0
    arr = np.array([x for x in baseline if x is not None and not np.isnan(x)])
    if len(arr) < 2:
        return 0.0
    med = float(np.median(arr))
    mad = float(np.median(np.abs(arr - med)))
    if mad > 1e-4:
        return float((val - med) / (1.4826 * mad))
    std = float(np.std(arr))
    if std > 1e-4:
        return float((val - med) / std)
    return 0.0

def load_hrv():
    hrv = {}
    for f in glob.glob(os.path.join(BASE_DIR, 'Heart Rate Variability', '*.csv')):
        try:
            df = pd.read_csv(f)
            for _, r in df.iterrows():
                dt = str(r['timestamp'])[:10]
                rmssd = float(r['rmssd']) if pd.notna(r['rmssd']) else None
                nremhr = float(r['nremhr']) if pd.notna(r['nremhr']) and float(r['nremhr']) > 0 else None
                entropy = float(r['entropy']) if pd.notna(r['entropy']) else None
                if rmssd is not None:
                    hrv[dt] = {'rmssd': rmssd, 'nremhr': nremhr, 'entropy': entropy}
        except Exception:
            pass
    return hrv

def load_sleep_data():
    sleep_days = {}
    
    # 1. Sleep score CSV
    csv_path = os.path.join(BASE_DIR, 'Sleep Score', 'sleep_score.csv')
    if os.path.exists(csv_path):
        df = pd.read_csv(csv_path)
        for _, r in df.iterrows():
            dt = str(r['timestamp'])[:10]
            sleep_days[dt] = {
                'overall_score': int(r['overall_score']) if pd.notna(r['overall_score']) else None,
                'revitalization_score': int(r['revitalization_score']) if pd.notna(r['revitalization_score']) else None,
                'deep_sleep_minutes': int(r['deep_sleep_in_minutes']) if pd.notna(r['deep_sleep_in_minutes']) else 0,
                'resting_heart_rate': int(r['resting_heart_rate']) if pd.notna(r['resting_heart_rate']) else None,
                'restlessness': float(r['restlessness']) if pd.notna(r['restlessness']) else 0.05
            }
            
    # 2. Detailed sleep JSON
    for f in glob.glob(os.path.join(BASE_DIR, 'Global Export Data', 'sleep-*.json')):
        with open(f) as fp:
            try:
                data = json.load(fp)
                for s in data:
                    dt = s.get('dateOfSleep')
                    if not dt or not s.get('mainSleep', True):
                        continue
                    
                    cur = sleep_days.setdefault(dt, {})
                    # Fitbit's older staging: ~36 min less deep and ~20 min more
                    # awake than the current algorithm for the same night.
                    cur['stage_source'] = 'takeout-legacy'
                    cur['minutesAsleep'] = s.get('minutesAsleep', 0)
                    cur['minutesAwake'] = s.get('minutesAwake', 0)
                    cur['timeInBed'] = s.get('timeInBed', 0)
                    cur['efficiency'] = s.get('efficiency', 90)
                    cur['startTime'] = s.get('startTime')
                    cur['endTime'] = s.get('endTime')
                    
                    levels = s.get('levels', {})
                    summary = levels.get('summary', {})
                    cur['deep_min'] = summary.get('deep', {}).get('minutes', cur.get('deep_sleep_minutes', 0))
                    cur['rem_min'] = summary.get('rem', {}).get('minutes', 0)
                    cur['light_min'] = summary.get('light', {}).get('minutes', 0)
                    cur['wake_min'] = summary.get('wake', {}).get('minutes', cur.get('minutesAwake', 0))
                    
                    raw_hypno = levels.get('data', [])
                    hypno = []
                    for h in raw_hypno:
                        hypno.append({
                            'time': h.get('dateTime'),
                            'stage': h.get('level'),
                            'seconds': h.get('seconds')
                        })
                    cur['hypnogram'] = hypno
            except Exception:
                pass

    return sleep_days

SESSION_STAGE_NAMES = {'AWAKE': 'wake', 'LIGHT': 'light', 'DEEP': 'deep', 'REM': 'rem',
                       'ASLEEP': 'asleep', 'RESTLESS': 'restless'}

def _parse_offset(text):
    sign = -1 if str(text).startswith('-') else 1
    hours, minutes = str(text).lstrip('+-').split(':')
    return sign * timedelta(hours=int(hours), minutes=int(minutes))

def load_sleep_sessions():
    """Main sleep per night from the export's per-session tables.

    Takeout's Health Fitness Data folder holds every session Fitbit's current
    algorithm (sleep_session_v2) produced, staged the same way as the Google
    Health API: within ~2 minutes per stage on nights both cover. The main
    sleep is the night's longest v2 session, keyed by local wake-up date.
    """
    folder = os.path.join(BASE_DIR, 'Health Fitness Data_GoogleData')
    sessions_f = sorted(glob.glob(os.path.join(folder, 'UserSleeps_*.csv')))
    stages_f = sorted(glob.glob(os.path.join(folder, 'UserSleepStages_*.csv')))
    if not sessions_f or not stages_f:
        return {}
    sessions = pd.concat([pd.read_csv(f) for f in sessions_f]).drop_duplicates('sleep_id')
    sessions = sessions[sessions['algorithm_version'] == 'sleep_session_v2']
    stages = pd.concat([pd.read_csv(f) for f in stages_f]).drop_duplicates('sleep_stage_id')
    stages = stages[stages['sleep_id'].isin(sessions['sleep_id'])]

    def local(ts, offset):
        return pd.Timestamp(ts).tz_localize(None) + _parse_offset(offset)

    by_session = {}
    for r in stages.itertuples():
        start = local(r.sleep_stage_start, r.start_utc_offset)
        end = local(r.sleep_stage_end, r.end_utc_offset)
        by_session.setdefault(r.sleep_id, []).append((start, end, r.sleep_stage_type))

    out = {}
    for r in sessions.itertuples():
        start = local(r.sleep_start, r.start_utc_offset)
        end = local(r.sleep_end, r.end_utc_offset)
        dt = end.strftime('%Y-%m-%d')
        asleep = int(r.minutes_asleep)
        if dt in out and out[dt]['minutesAsleep'] >= asleep:
            continue
        segs = sorted(by_session.get(r.sleep_id, []))
        stage_min = {}
        for s_start, s_end, kind in segs:
            stage_min[kind] = stage_min.get(kind, 0) + (s_end - s_start).total_seconds() / 60
        in_bed = int(r.minutes_in_sleep_period) or int((end - start).total_seconds() // 60)
        out[dt] = {
            'stage_source': 'takeout-v2',
            'minutesAsleep': asleep,
            'minutesAwake': int(r.minutes_awake),
            'timeInBed': in_bed,
            'efficiency': round(asleep / in_bed * 100) if in_bed else None,
            'startTime': start.strftime('%Y-%m-%dT%H:%M:%S.000'),
            'endTime': end.strftime('%Y-%m-%dT%H:%M:%S.000'),
            'deep_min': round(stage_min.get('DEEP', 0)),
            'rem_min': round(stage_min.get('REM', 0)),
            'light_min': round(stage_min.get('LIGHT', 0)),
            'wake_min': round(stage_min.get('AWAKE', r.minutes_awake)),
            'hypnogram': [{
                'time': s_start.strftime('%Y-%m-%dT%H:%M:%S.000'),
                'stage': SESSION_STAGE_NAMES.get(kind, str(kind).lower()),
                'seconds': int((s_end - s_start).total_seconds()),
            } for s_start, s_end, kind in segs],
        }
    return out

def load_temperature():
    temps = {}
    for f in glob.glob(os.path.join(BASE_DIR, 'Temperature', 'Computed Temperature - *.csv')):
        try:
            df = pd.read_csv(f)
            for _, r in df.iterrows():
                dt = str(r.get('sleep_end', r.get('sleep_start', '')))[:10]
                if dt and pd.notna(r.get('nightly_temperature')):
                    temps[dt] = float(r['nightly_temperature'])
        except Exception:
            pass
    return temps

def load_spo2():
    spo2 = {}
    for f in glob.glob(os.path.join(BASE_DIR, 'Oxygen Saturation (SpO2)', 'Daily SpO2 - *.csv')):
        try:
            df = pd.read_csv(f)
            for _, r in df.iterrows():
                dt = str(r['timestamp'])[:10]
                if pd.notna(r['average_value']):
                    spo2[dt] = {
                        'avg': round(float(r['average_value']), 1),
                        'lower': round(float(r.get('lower_bound', r['average_value'])), 1),
                        'upper': round(float(r.get('upper_bound', r['average_value'])), 1)
                    }
        except Exception:
            pass
    return spo2

def load_vo2_max():
    vo2 = {}
    for f in glob.glob(os.path.join(BASE_DIR, 'Global Export Data', 'demographic_vo2_max-*.json')):
        try:
            with open(f) as fp:
                d = json.load(fp)
                for item in d:
                    raw_dt = item['dateTime'].split()[0]
                    m, day, y = raw_dt.split('/')
                    iso_dt = f'20{y}-{m.zfill(2)}-{day.zfill(2)}'
                    val = float(item['value'].get('filteredDemographicVO2Max', item['value'].get('demographicVO2Max', 60.0)))
                    vo2[iso_dt] = round(val, 1)
        except Exception:
            pass
    return vo2

def load_steps_and_calories():
    # Daily totals plus 24 hourly buckets per local day.
    steps = {}
    calories = {}
    hourly_steps = {}
    hourly_cals = {}
    
    for f in glob.glob(os.path.join(BASE_DIR, 'Global Export Data', 'steps-*.json')):
        try:
            with open(f) as fp:
                d = json.load(fp)
                for item in d:
                    # Takeout timestamps are UTC; bucket by local day.
                    t_local = _takeout_local(item['dateTime'])
                    iso = t_local.strftime('%Y-%m-%d')
                    val = int(item['value'])
                    steps[iso] = steps.get(iso, 0) + val
                    hourly_steps.setdefault(iso, [0] * 24)[t_local.hour] += val
        except Exception:
            pass
            
    for f in glob.glob(os.path.join(BASE_DIR, 'Global Export Data', 'calories-*.json')):
        try:
            with open(f) as fp:
                d = json.load(fp)
                for item in d:
                    # Takeout timestamps are UTC; bucket by local day.
                    t_local = _takeout_local(item['dateTime'])
                    iso = t_local.strftime('%Y-%m-%d')
                    val = float(item['value'])
                    calories[iso] = calories.get(iso, 0.0) + val
                    hourly_cals.setdefault(iso, [0.0] * 24)[t_local.hour] += val
        except Exception:
            pass
            
    hourly_cals = {k: [round(x) for x in v] for k, v in hourly_cals.items()}
    return steps, {k: round(v) for k, v in calories.items()}, hourly_steps, hourly_cals

def load_respiratory_rate():
    resp = {}
    for f in glob.glob(os.path.join(BASE_DIR, 'Heart Rate Variability', 'Daily Respiratory Rate Summary - *.csv')):
        try:
            df = pd.read_csv(f)
            for _, r in df.iterrows():
                if pd.notna(r['daily_respiratory_rate']):
                    resp[str(r['timestamp'])[:10]] = round(float(r['daily_respiratory_rate']), 1)
        except Exception:
            pass
    return resp

def load_resting_hr():
    rhr = {}
    for f in glob.glob(os.path.join(BASE_DIR, 'Global Export Data', 'resting_heart_rate-*.json')):
        try:
            with open(f) as fp:
                d = json.load(fp)
                for item in d:
                    raw_dt = item['dateTime'].split()[0]
                    m, day, y = raw_dt.split('/')
                    iso = f'20{y}-{m.zfill(2)}-{day.zfill(2)}'
                    v = float(item['value']['value'])
                    if v > 30 and v < 120:
                        rhr[iso] = round(v)
        except Exception:
            pass
    return rhr

def load_workouts():
    workouts = {}
    path = os.path.join(BASE_DIR, 'Global Export Data', 'exercise-0.json')
    if os.path.exists(path):
        with open(path) as fp:
            d = json.load(fp)
            for ex in d:
                raw_dt = ex.get('startTime', '').split()[0]
                if not raw_dt: continue
                m, day, y = raw_dt.split('/')
                iso = f'20{y}-{m.zfill(2)}-{day.zfill(2)}'
                
                dur_mins = round(ex.get('duration', 0) / 1000.0 / 60.0)
                cal = ex.get('calories', 0)
                avg_hr = ex.get('averageHeartRate', 0)
                name = ex.get('activityName', 'Workout')
                
                time_str = ex.get('startTime', '').split()[-1][:5]
                dist = ex.get('distance')
                if dist is not None and (ex.get('distanceUnit') or '').lower().startswith('mile'):
                    dist = dist * 1.609344
                azm = (ex.get('activeZoneMinutes') or {}).get('totalMinutes')

                workouts.setdefault(iso, []).append({
                    'name': name,
                    'duration_minutes': dur_mins,
                    'calories': cal,
                    'avg_hr': avg_hr,
                    'time': time_str,
                    'steps': ex.get('steps'),
                    'distance_km': round(dist, 2) if dist else None,
                    'elevation_m': round(ex['elevationGain']) if ex.get('elevationGain') else None,
                    'active_zone_minutes': azm,
                })
    return workouts

def _workout_windows(workouts_by_date):
    """{date: [(start, end + tail), ...]} in seconds since local midnight."""
    out = {}
    for dt, ws in workouts_by_date.items():
        for w in ws:
            win = workout_window(w)
            if win:
                out.setdefault(dt, []).append((win[0], win[1] + WORKOUT_TAIL_S))
    return out


def select_workout_samples(local_times, bpms, windows):
    """Raw readings that fall in a workout window, as {date: [[seconds, bpm], ...]} sorted."""
    if not windows or not len(bpms):
        return {}
    ts = pd.DatetimeIndex(local_times)
    df = pd.DataFrame({'date': ts.strftime('%Y-%m-%d'),
                       'sec': ts.hour * 3600 + ts.minute * 60 + ts.second,
                       'bpm': np.asarray(bpms, dtype=int)})
    df = df[df['date'].isin(windows.keys())]
    out = {}
    for dt, g in df.groupby('date'):
        keep = np.zeros(len(g), dtype=bool)
        sec = g['sec'].to_numpy()
        for lo, hi in windows[dt]:
            keep |= (sec >= lo) & (sec < hi)
        rows = g[keep].sort_values(['sec', 'bpm'])
        if len(rows):
            out[dt] = rows[['sec', 'bpm']].astype(int).values.tolist()
    return out


_TAKEOUT_HR = None


def _takeout_hr():
    """Every Takeout heart-rate reading as a DataFrame (local time, bpm), loaded once."""
    global _TAKEOUT_HR
    if _TAKEOUT_HR is None:
        times, bpms = [], []
        for f in sorted(glob.glob(os.path.join(BASE_DIR, 'Global Export Data', 'heart_rate-*.json'))):
            try:
                with open(f) as fp:
                    for item in json.load(fp):
                        times.append(item['dateTime'])
                        bpms.append(item['value']['bpm'])
            except Exception:
                pass
        utc = pd.to_datetime(pd.Series(times, dtype=object), format='%m/%d/%y %H:%M:%S', utc=True)
        local = utc.dt.tz_convert(profile_store.local_tz()).dt.tz_localize(None)
        _TAKEOUT_HR = pd.DataFrame({'time': local, 'bpm': bpms})
    return _TAKEOUT_HR


def load_workout_samples_takeout(workouts_by_date):
    windows = _workout_windows(workouts_by_date)
    df = _takeout_hr()
    if not windows or df.empty:
        return {}
    return select_workout_samples(df['time'], df['bpm'].tolist(), windows)


def load_intraday_hr():
    """Per-minute mean BPM by local day from the Takeout readings."""
    df = _takeout_hr()
    if df.empty:
        return {}
    g = pd.DataFrame({'date': df['time'].dt.strftime('%Y-%m-%d'), 'hm': df['time'].dt.strftime('%H:%M'), 'bpm': df['bpm']})
    daily_hr = {}
    for (dt_str, hm), v in g.groupby(['date', 'hm'])['bpm']:
        daily_hr.setdefault(dt_str, []).append({'time': hm, 'bpm': round(float(np.mean(v.to_numpy())))})
    return daily_hr

# Banister TRIMP weighting y = a·exp(b·HRR): published coefficients for men and
# women; their midpoint when sex isn't known.
TRIMP_COEF = {'male': (0.64, 1.92), 'female': (0.86, 1.67), None: (0.75, 1.795)}
# Heart-rate zones as shares of heart-rate reserve, the cut-offs Fitbit uses
# for Active Zone Minutes: light < 40%, moderate 40-59%, vigorous 60-84%,
# peak 85%+.
ZONES = [('peak', 0.85), ('vigorous', 0.60), ('moderate', 0.40), ('light', 0.0)]


def hr_zone(hrr):
    return next(name for name, lo in ZONES if hrr >= lo)


# Only minutes at or above light activity count towards strain: 30% of heart-rate
# reserve is where ACSM's "light" intensity starts. Below it (sleep, sitting,
# pottering about) the heart is above resting but not training.
ACTIVE_HRR = 0.30

def calculate_trimp_and_strain(minute_hr_series, resting_hr, max_hr=190, sex=None, zone_max_hr=None):
    a, b = TRIMP_COEF.get(sex, TRIMP_COEF[None])
    if not minute_hr_series or resting_hr is None or resting_hr >= max_hr:
        return 0.0, 0.0, {'light': 100, 'moderate': 0, 'vigorous': 0, 'peak': 0}
        
    reserve = max_hr - resting_hr
    zone_reserve = max((zone_max_hr or max_hr) - resting_hr, 1)
    trimp = 0.0
    zones = {'light': 0, 'moderate': 0, 'vigorous': 0, 'peak': 0}
    
    for pt in minute_hr_series:
        hr = pt['bpm']
        if hr <= resting_hr:
            zones['light'] += 1
            continue
            
        hrr = min(1.0, max(0.0, (hr - resting_hr) / reserve))
        zones[hr_zone(min(1.0, (hr - resting_hr) / zone_reserve))] += 1

        if hrr < ACTIVE_HRR:
            continue
        y = a * math.exp(b * hrr)
        trimp += 1.0 * hrr * y
        
    # OpenStrap StrainScorer logarithmic strain mapping (0 - 21 scale):
    # strain = 21.0 * ln(1 + trimp) / ln(strainDenominator), where strainDenominator = 7201.0
    strain = 21.0 * math.log(1.0 + trimp) / math.log(7201.0)
    strain = min(21.0, max(0.0, round(strain, 1)))
    
    total_z = max(1, sum(zones.values()))
    zone_pct = {k: round(v / total_z * 100, 1) for k, v in zones.items()}
    
    return round(trimp, 1), strain, zone_pct


# ---------- Workouts ----------
WORKOUT_TAIL_S = 150   # samples kept after a workout ends, for heart-rate recovery
MAX_SAMPLE_GAP_S = 10  # a reading counts for at most this long (gaps aren't filled)


def workout_window(w):
    """(start, end) of a workout in seconds since local midnight, or None."""
    try:
        h, m = (int(x) for x in (w.get('time') or '').split(':'))
    except ValueError:
        return None
    start = h * 3600 + m * 60
    return start, min(86400, start + max(1, int(w.get('duration_minutes') or 0)) * 60)


def _mean_bpm(samples, lo, hi):
    vals = [b for t, b in samples if lo <= t < hi]
    return sum(vals) / len(vals) if vals else None


def analyse_workout(w, minute_hr, samples, resting_hr, max_hr=190, sex=None, zone_max_hr=None):
    """A workout with its heart rate rebuilt from the raw readings (about every 2 s).

    `samples` is the day's [seconds since local midnight, bpm] readings around
    workouts. Each reading counts for the time until the next one (at most
    MAX_SAMPLE_GAP_S). Falls back to the day's per-minute averages when there
    are no raw readings. Adds: the heart-rate series, peak and average, time in
    each zone (same heart-rate-reserve zones as the day), the workout's own
    TRIMP and strain, and heart-rate recovery 1 and 2 minutes after it ended.
    """
    out = dict(w, hr_resolution=None, hr_t=[], hr_bpm=[], peak_hr=None, avg_hr_measured=None,
               zone_minutes=None, trimp=None, strain=None, hr_recovery=None, hr_recovery_60=None)
    win = workout_window(w)
    if win is None:
        return out
    start, end = win
    a, b = TRIMP_COEF.get(sex, TRIMP_COEF[None])
    raw = [(t, bpm) for t, bpm in (samples or []) if start <= t < end]
    if len(raw) >= 10:
        times = [t for t, _ in raw]
        bpms = [bpm for _, bpm in raw]
        durs = [min(times[i + 1] - times[i], MAX_SAMPLE_GAP_S) for i in range(len(times) - 1)]
        durs.append(min(end - times[-1], MAX_SAMPLE_GAP_S))
        out['hr_resolution'] = 'second'
        out['hr_t'] = [t - start for t in times]
        out['hr_bpm'] = bpms
        end_bpm = _mean_bpm(samples, end - 10, end)
        for key, lag in (('hr_recovery_60', 60), ('hr_recovery', 120)):
            later = _mean_bpm(samples, end + lag - 5, end + lag + 5)
            if end_bpm is not None and later is not None:
                out[key] = int(round(end_bpm - later))
    else:
        by_min = {}
        for pt in minute_hr:
            hh, mm = pt['time'].split(':')
            by_min[int(hh) * 3600 + int(mm) * 60] = pt['bpm']
        series = [(t, by_min[t]) for t in range(start - start % 60, end, 60) if t in by_min and t >= start]
        if not series:
            return out
        times = [t for t, _ in series]
        bpms = [bpm for _, bpm in series]
        durs = [60] * len(bpms)
        out['hr_resolution'] = 'minute'
        out['hr_t'] = [t - start for t in times]
        out['hr_bpm'] = bpms
        after, last = by_min.get(end + 60), by_min.get(end - 60)
        if after is not None and last is not None:
            out['hr_recovery'] = last - after
    total = sum(durs)
    out['peak_hr'] = max(bpms)
    out['avg_hr_measured'] = int(round(sum(x * d for x, d in zip(bpms, durs)) / total)) if total else int(round(sum(bpms) / len(bpms)))
    if resting_hr is None or resting_hr >= max_hr or not total:
        return out
    reserve = max_hr - resting_hr
    zone_reserve = max((zone_max_hr or max_hr) - resting_hr, 1)
    zone_s = {'light': 0, 'moderate': 0, 'vigorous': 0, 'peak': 0}
    trimp = 0.0
    for x, d in zip(bpms, durs):
        hrr = min(1.0, max(0.0, (x - resting_hr) / reserve))
        zone_s[hr_zone(min(1.0, max(0.0, (x - resting_hr) / zone_reserve)))] += d
        if x > resting_hr and hrr >= ACTIVE_HRR:
            trimp += hrr * (a * math.exp(b * hrr)) * d / 60.0
    out['trimp'] = round(trimp, 1)
    out['strain'] = min(21.0, max(0.0, round(21.0 * math.log(1.0 + trimp) / math.log(7201.0), 1)))
    out['zone_minutes'] = {k: round(v / 60.0, 1) for k, v in zone_s.items()}
    return out


# ---------- Recovery (OpenStrap readiness composite) ----------
# (key, label, disclosed weight, orientation)
RECOVERY_INPUTS = [
    ('hrv', 'HRV (RMSSD)', 0.40, 'higher'),
    ('rhr', 'Resting Heart Rate', 0.30, 'lower'),
    ('resp', 'Respiratory Rate', 0.20, 'steady'),
    ('temp', 'Skin Temperature', 0.10, 'steady'),
]
# Breathing rate and skin temperature are warning signs when they move away
# from normal, a rise twice as much as a fall: a lower reading is not "better
# recovered" (OpenStrap's own notes flag the old lower-is-better sign for
# temperature). STEADY_CENTER = E[max(z,0) + 0.5·max(-z,0)] for a normal z
# = 1.5/sqrt(2*pi), so an ordinary night adds nothing on average.
STEADY_CENTER = 1.5 / math.sqrt(2 * math.pi)


def baseline_for(history, dt):
    """The most recent BASELINE_READINGS values from the BASELINE_MAX_AGE days before dt, or None."""
    cutoff = (datetime.strptime(dt, '%Y-%m-%d') - timedelta(days=BASELINE_MAX_AGE)).strftime('%Y-%m-%d')
    vals = [v for d, v in history if cutoff <= d < dt]
    return vals[-BASELINE_READINGS:] if len(vals) >= BASELINE_READINGS else None


def orient(z, how):
    """Sign a z-score so that positive means good for recovery."""
    if how == 'higher':
        return z
    if how == 'lower':
        return -z
    return STEADY_CENTER - max(z, 0.0) - 0.5 * max(-z, 0.0)


def recovery_composite(values, histories, dt):
    """(score, composite_z, drivers, inputs_used) for one night; score is None without enough baseline.

    Each driver's points are its share of (score - 50), so the drivers add up
    to how far the score is from a neutral 50.
    """
    used = []
    for key, label, weight, how in RECOVERY_INPUTS:
        v = values.get(key)
        if not v:
            continue
        base = baseline_for(histories[key], dt)
        if base is None:
            continue
        # Resting HR comes in whole bpm: a baseline with less than 1 bpm of spread
        # has no measurable variation to compare against.
        if key == 'rhr' and float(np.std(base)) < 1.0:
            continue
        used.append((label, weight, orient(robust_z(v, base), how)))
    weight_sum = sum(w for _, w, _ in used)
    if len(used) < MIN_INPUTS or weight_sum < MIN_WEIGHT:
        return None, None, [], len(used)
    composite = sum(w * o for _, w, o in used) / weight_sum
    score = 100.0 / (1.0 + math.exp(-composite))
    drivers = []
    for label, weight, o in used:
        share = weight * o / weight_sum
        points = (score - 50.0) * share / composite if abs(composite) > 1e-9 else 25.0 * share
        drivers.append({'metric': label, 'weight': weight, 'z': round(o, 2), 'impact': round(points, 1),
                        'direction': 'positive' if o > 0 else 'negative'})
    drivers.sort(key=lambda x: abs(x['impact']), reverse=True)
    return int(round(score)), composite, drivers, len(used)


def nightly_stress(rmssd, rhr, histories, dt):
    """0-100: how far resting HR is above, and HRV below, your own baseline (50 = typical)."""
    if not rmssd or not rhr:
        return None
    base_hrv = baseline_for(histories['hrv'], dt)
    base_rhr = baseline_for(histories['rhr'], dt)
    if base_hrv is None or base_rhr is None:
        return None
    s = (robust_z(rhr, base_rhr) - robust_z(rmssd, base_hrv)) / 2.0
    return int(round(100.0 / (1.0 + math.exp(-s))))


# ---------- Fitness age (VO2max against population norms) ----------
# Loe H, Rognmo Ø, Saltin B, Wisløff U (2013). Aerobic capacity reference data
# in 3816 healthy men and women 20-90 years. PLOS ONE 8(5): e64319 (HUNT3
# Fitness Study), Table 2: VO2max mL/kg/min, mean and SD, by age group.
# Keyed by each group's middle age; 70+ is placed at 75.
VO2_NORMS = [
    # age, men mean, men SD, women mean, women SD
    (25, 54.4, 8.4, 43.0, 7.7),
    (35, 49.1, 7.5, 40.0, 6.8),
    (45, 47.2, 7.7, 38.4, 6.9),
    (55, 42.6, 7.4, 34.4, 5.7),
    (65, 39.2, 6.7, 31.1, 5.1),
    (75, 35.3, 6.5, 28.3, 5.2),
]
VO2_CARRY_DAYS = 30  # use a VO2max estimate for at most this long after it was measured


def _norm_row(row, sex):
    _, mm, ms, wm, ws = row
    if sex == 'male':
        return mm, ms
    if sex == 'female':
        return wm, ws
    return (mm + wm) / 2.0, (ms + ws) / 2.0


def vo2_norm(age, sex):
    """(mean, SD) VO2max for this age and sex, interpolated between age groups."""
    if age <= VO2_NORMS[0][0]:
        return _norm_row(VO2_NORMS[0], sex)
    for lo, hi in zip(VO2_NORMS, VO2_NORMS[1:]):
        if age <= hi[0]:
            f = (age - lo[0]) / (hi[0] - lo[0])
            (m0, s0), (m1, s1) = _norm_row(lo, sex), _norm_row(hi, sex)
            return m0 + f * (m1 - m0), s0 + f * (s1 - s0)
    return _norm_row(VO2_NORMS[-1], sex)


def _erf(x):
    # Abramowitz & Stegun 7.1.26 (error < 1.5e-7); written out so the phone
    # version (mobile/src/engine.js) computes exactly the same numbers.
    sign = -1.0 if x < 0 else 1.0
    x = abs(x)
    t = 1.0 / (1.0 + 0.3275911 * x)
    y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * math.exp(-x * x)
    return sign * y


def fitness_profile(age, sex, vo2):
    """Fitness age, percentile and tier from VO2max against same-sex norms.

    Fitness age is the age whose average VO2max matches yours. The norms start
    at the 20-29 group (centred on 25) and end at 70+ (75), so it is limited to
    25-75: 'lower' means 25 or younger, 'upper' means 75 or older.
    """
    out = {'fitness_age': None, 'fitness_age_limit': None, 'age_delta': None, 'percentile': None, 'tier': None}
    if vo2 is None:
        return out
    means = [_norm_row(r, sex)[0] for r in VO2_NORMS]
    ages = [r[0] for r in VO2_NORMS]
    if vo2 >= means[0]:
        fit_age, limit = float(ages[0]), 'lower'
    elif vo2 <= means[-1]:
        fit_age, limit = float(ages[-1]), 'upper'
    else:
        fit_age, limit = None, None
        for (a0, m0), (a1, m1) in zip(zip(ages, means), zip(ages[1:], means[1:])):
            if m0 >= vo2 >= m1:
                fit_age = a0 + (m0 - vo2) / (m0 - m1) * (a1 - a0)
                break
    out['fitness_age'] = round(fit_age, 1)
    out['fitness_age_limit'] = limit
    if age is not None:
        if limit is None:
            out['age_delta'] = round(fit_age - age, 1)
        mean, sd = vo2_norm(age, sex)
        pct = 50.0 * (1.0 + _erf((vo2 - mean) / sd / math.sqrt(2.0)))
        out['percentile'] = int(min(99, max(1, round(pct))))
        p = out['percentile']
        out['tier'] = ('Elite for your age' if p >= 90 else 'Excellent for your age' if p >= 75
                       else 'Above average for your age' if p >= 50 else 'Below average for your age' if p >= 25
                       else 'Low for your age')
    return out

def assemble(src, profile, labels_path):
    """Per-day analytics (recovery, strain, sleep, body age, sleep score) from loaded sources.

    `src` maps each source name to its {date: value} dict, as produced by the
    loaders in this module and api_ingest. make_demo_data.py feeds synthetic
    sources through this same function.
    """
    hrv_data = src['hrv']
    sleep_data = src['sleep']
    temp_data = src['temp']
    spo2_data = src['spo2']
    vo2_data = src['vo2']
    steps_data = src['steps']
    cal_data = src['cal']
    hourly_steps = src['hourly_steps']
    hourly_cals = src['hourly_cals']
    resp_data = src['resp']
    rhr_data = src['rhr']
    intraday_hr = src['intraday_hr']
    workouts_data = src['workouts']

    all_dates = sorted(list(set(
        list(hrv_data.keys()) +
        list(sleep_data.keys()) +
        list(temp_data.keys()) +
        list(spo2_data.keys()) +
        list(vo2_data.keys()) +
        list(intraday_hr.keys())
    )))
    
    all_dates = [d for d in all_dates if d <= datetime.now().strftime('%Y-%m-%d')]
    if not all_dates:
        raise SystemExit("No data yet. Run `python3 setup.py` to connect your Fitbit, then try again.")
    print(f"Processing {len(all_dates)} days from {all_dates[0]} to {all_dates[-1]}...")
    
    # (date, value) per vital, for the recovery and stress baselines.
    histories = {'hrv': [], 'rhr': [], 'resp': [], 'temp': []}
    last_vo2 = None
    last_vo2_date = None
    
    daily_records = []
    
    for dt in all_dates:
        hrv_entry = hrv_data.get(dt, {})
        rmssd = hrv_entry.get('rmssd')
        
        sleep_entry = sleep_data.get(dt, {})
        rhr = rhr_data.get(dt) or sleep_entry.get('resting_heart_rate')
        
        temp = temp_data.get(dt)
        # Missing readings stay None so the dashboard can show "No data"
        # instead of a made-up default.
        spo2_entry = spo2_data.get(dt)
        # VO2max changes slowly and is only exported occasionally: carry the
        # last measured value forward, for up to VO2_CARRY_DAYS.
        if dt in vo2_data:
            last_vo2, last_vo2_date = vo2_data[dt], dt
        age_days = (datetime.strptime(dt, '%Y-%m-%d') - datetime.strptime(last_vo2_date, '%Y-%m-%d')).days if last_vo2_date else None
        vo2 = last_vo2 if age_days is not None and age_days <= VO2_CARRY_DAYS else None
        steps = steps_data.get(dt)
        cals = cal_data.get(dt)
        day_workouts = workouts_data.get(dt, [])
        
        # Fitbit's measured nightly breathing rate.
        resp_rate = resp_data.get(dt)
        
        # OpenStrap readiness composite: each vital against its own baseline,
        # weights renormalised over the vitals that have one.
        recovery_score, composite_z, drivers, inputs_used = recovery_composite(
            {'hrv': rmssd, 'rhr': rhr, 'resp': resp_rate, 'temp': temp}, histories, dt)

        if recovery_score is None:
            recovery_status = 'Calibrating'
            recovery_color = '#6B7280'
            target_strain = None
            coach_tip = (f'Recovery starts once at least two vitals have {BASELINE_READINGS} nights of data '
                         f'in the last {BASELINE_MAX_AGE} days.')
        elif recovery_score >= 67:
            recovery_status = 'Optimal'
            recovery_color = '#10B981'
            target_strain = '14.0 – 18.0'
            coach_tip = 'Body is well-recovered. High cardiovascular tolerance today—great day for strenuous training.'
        elif recovery_score >= 34:
            recovery_status = 'Adequate'
            recovery_color = '#F59E0B'
            target_strain = '10.0 – 14.0'
            coach_tip = 'Moderate recovery. Maintain steady volume without excessive overreaching.'
        else:
            recovery_status = 'Low / Recovery'
            recovery_color = '#EF4444'
            target_strain = '< 10.0'
            coach_tip = 'Autonomic indicators show elevated fatigue. Prioritize sleep and active recovery.'

        # Intraday HR & Strain
        minute_hr = intraday_hr.get(dt, [])
        trimp, day_strain, hr_zones = calculate_trimp_and_strain(minute_hr, rhr, profile['max_hr'], profile['sex'], profile.get('zone_max_hr'))
        day_samples = src.get('workout_hr', {}).get(dt)
        day_workouts = [analyse_workout(w, minute_hr, day_samples, rhr, profile['max_hr'], profile['sex'], profile.get('zone_max_hr')) for w in day_workouts]
        
        # Sleep details: only from a recorded main sleep, never estimated.
        minutes_asleep = sleep_entry.get('minutesAsleep') or None
        has_sleep = minutes_asleep is not None
        time_in_bed = (sleep_entry.get('timeInBed') or None) if has_sleep else None
        sleep_efficiency = (sleep_entry.get('efficiency') or (round(minutes_asleep / time_in_bed * 100) if time_in_bed else None)) if has_sleep else None
        deep_min = sleep_entry.get('deep_min') if has_sleep else None
        rem_min = sleep_entry.get('rem_min') if has_sleep else None
        light_min = sleep_entry.get('light_min') if has_sleep else None
        wake_min = sleep_entry.get('wake_min') if has_sleep else None
        
        sleep_debt_minutes = max(0, 480 - minutes_asleep) if has_sleep else None
        
        fitness = fitness_profile(profile['chronological_age'], profile['sex'], vo2)
        stress = nightly_stress(rmssd, rhr, histories, dt)
        
        # Downsampled HR series for intraday sparkline chart (every 10 mins)
        intraday_spark = [minute_hr[i] for i in range(0, len(minute_hr), 10)] if len(minute_hr) > 0 else []
        
        record = {
            'date': dt,
            'day_name': datetime.strptime(dt, '%Y-%m-%d').strftime('%a, %b %d'),
            'recovery': {
                'score': recovery_score,
                'status': recovery_status,
                'color': recovery_color,
                'composite_z': round(composite_z, 2) if composite_z is not None else None,
                'inputs_used': inputs_used,
                'target_strain': target_strain,
                'coach_tip': coach_tip,
                'drivers': drivers
            },
            'sleep': {
                # Filled in by sleep_score.apply(): the Fitbit app's score when
                # one has been recorded, otherwise an estimate.
                'score': None,
                'score_source': None,
                'stage_source': sleep_entry.get('stage_source') if has_sleep else None,
                'duration_minutes': minutes_asleep,
                'duration_formatted': f"{minutes_asleep // 60}h {minutes_asleep % 60}m" if has_sleep else None,
                'time_in_bed_minutes': time_in_bed,
                'efficiency': sleep_efficiency,
                'debt_minutes': sleep_debt_minutes,
                'debt_formatted': (f"{sleep_debt_minutes // 60}h {sleep_debt_minutes % 60}m" if sleep_debt_minutes > 0 else "0m (Restored)") if has_sleep else None,
                'deep_min': deep_min,
                'rem_min': rem_min,
                'light_min': light_min,
                'wake_min': wake_min,
                'hypnogram': sleep_entry.get('hypnogram', [])
            },
            'cardiovascular': {
                'rhr': rhr,
                'hrv_rmssd': round(rmssd, 1) if rmssd else None,
                'vo2_max': vo2,
                'spo2': spo2_entry['avg'] if spo2_entry else None,
                'temp': round(temp, 2) if temp else None,
                'respiration_rate': resp_rate,
                'stress_index': stress
            },
            'body_age': {'chronological': profile['chronological_age'], **fitness},
            'strain': {
                'score': day_strain,
                'trimp': trimp,
                'steps': steps,
                'calories': cals,
                'zones': hr_zones,
                'zone_minutes': {k: round(v / 100 * len(minute_hr)) for k, v in hr_zones.items()} if minute_hr else None,
                'workouts': day_workouts,
                'intraday_hr': intraday_spark,
                # From the per-minute averages, not the 10-minute sparkline above.
                'hr_stats': ({'avg': int(round(sum(p['bpm'] for p in minute_hr) / len(minute_hr))),
                              'min': min(p['bpm'] for p in minute_hr),
                              'max': max(p['bpm'] for p in minute_hr),
                              'max_time': max(minute_hr, key=lambda p: p['bpm'])['time']} if minute_hr else None),
                'hourly_steps': hourly_steps.get(dt),
                'hourly_calories': hourly_cals.get(dt)
            }
        }
        
        daily_records.append(record)
        
        for key, v in (('hrv', rmssd), ('rhr', rhr), ('resp', resp_rate), ('temp', temp)):
            if v:
                histories[key].append((dt, v))

    daily_records.sort(key=lambda x: x['date'])

    # Sleep score: Fitbit app scores where recorded, an estimate elsewhere.
    score_model = sleep_score.apply(daily_records, labels_path)
    body_age.apply(daily_records, profile)
    accuracy = (f"typical error ±{score_model['mae']} over {score_model['training_nights']} nights"
                if score_model['method'] == 'fit' else 'default weights until 15 app scores are recorded')
    print(f"Sleep score: {score_model['app_nights']} nights from the Fitbit app, "
          f"{score_model['estimated_nights']} estimated ({accuracy}).")

    all_recoveries = [r['recovery']['score'] for r in daily_records if r['recovery']['score'] is not None]
    scored = [r for r in daily_records if r['recovery']['score'] is not None]
    all_sleeps = [r['sleep']['score'] for r in daily_records if r['sleep']['score']]
    all_strains = [r['strain']['score'] for r in daily_records]
    all_hrvs = [r['cardiovascular']['hrv_rmssd'] for r in daily_records if r['cardiovascular']['hrv_rmssd']]
    all_rhrs = [r['cardiovascular']['rhr'] for r in daily_records if r['cardiovascular']['rhr']]
    
    overview = {
        'total_days_analyzed': len(daily_records),
        'date_start': daily_records[0]['date'],
        'date_end': daily_records[-1]['date'],
        'avg_recovery': round(float(np.mean(all_recoveries)), 1) if all_recoveries else None,
        'avg_sleep_score': round(float(np.mean(all_sleeps)), 1) if all_sleeps else None,
        'avg_strain': round(float(np.mean(all_strains)), 1),
        'avg_hrv': round(float(np.mean(all_hrvs)), 1) if all_hrvs else None,
        'avg_rhr': round(float(np.mean(all_rhrs)), 1) if all_rhrs else None,
        'best_recovery_day': max(scored, key=lambda x: x['recovery']['score'])['date'] if scored else None,
        'highest_strain_day': max(daily_records, key=lambda x: x['strain']['score'])['date'],
        'sleep_score_model': score_model,
    }
    
    output = {
        'profile': profile,
        'overview': overview,
        'days': daily_records
    }
    
    return output


def build_dataset():
    if not os.path.isdir(BASE_DIR):
        print(f"WARNING: Takeout export not found at {BASE_DIR}; only Google Health API days will be included.")
    print(f"Loading raw Fitbit exports & workouts from {os.path.relpath(BASE_DIR, PROJECT_DIR)}...")
    hrv_data = load_hrv()
    sleep_data = load_sleep_data()
    temp_data = load_temperature()
    spo2_data = load_spo2()
    vo2_data = load_vo2_max()
    steps_data, cal_data, hourly_steps, hourly_cals = load_steps_and_calories()
    resp_data = load_respiratory_rate()
    rhr_data = load_resting_hr()
    intraday_hr = load_intraday_hr()
    workouts_data = load_workouts()

    # Google Health API data (google_health_sync.py) takes precedence over the
    # Takeout export for any day both cover. The API has no VO2max, so that
    # stays Takeout-only.
    print("Merging Google Health API data...")
    api_steps, api_cals, api_hourly_steps, api_hourly_cals = api_ingest.load_steps_and_calories()
    for target, api_part in [
        (hrv_data, api_ingest.load_hrv()),
        (temp_data, api_ingest.load_temperature()),
        (spo2_data, api_ingest.load_spo2()),
        (rhr_data, api_ingest.load_resting_hr()),
        (intraday_hr, api_ingest.load_intraday_hr()),
        (workouts_data, api_ingest.load_workouts()),
        (steps_data, api_steps),
        (cal_data, api_cals),
        (hourly_steps, api_hourly_steps),
        (hourly_cals, api_hourly_cals),
        (resp_data, api_ingest.load_respiratory_rate()),
    ]:
        target.update(api_part)
    # Sleep, per night, from least to most preferred: Takeout's sleep JSON (older
    # staging), the export's current-algorithm sessions, then the API. Entries
    # also carry Takeout-only fields (resting HR from the sleep score CSV), so
    # merge per day rather than replace.
    for dt, entry in load_sleep_sessions().items():
        sleep_data.setdefault(dt, {}).update(entry)
    # Raw heart rate around each workout, for the workout pages: the API's
    # readings where it has them, the export's otherwise.
    workout_hr = load_workout_samples_takeout(workouts_data)
    workout_hr.update(api_ingest.load_workout_samples(workouts_data, select_workout_samples, _workout_windows))
    for dt, entry in api_ingest.load_sleep_data().items():
        cur = sleep_data.setdefault(dt, {})
        # Don't let a shorter API session (e.g. a nap, when the API is missing
        # that night's main sleep) replace the export's main sleep.
        if cur.get('stage_source') == 'takeout-v2' and cur.get('minutesAsleep', 0) > entry['minutesAsleep']:
            continue
        cur.update(entry)
    
    src = {'workout_hr': workout_hr, 'hrv': hrv_data, 'sleep': sleep_data, 'temp': temp_data, 'spo2': spo2_data, 'vo2': vo2_data, 'steps': steps_data, 'cal': cal_data, 'hourly_steps': hourly_steps, 'hourly_cals': hourly_cals, 'resp': resp_data, 'rhr': rhr_data, 'intraday_hr': intraday_hr, 'workouts': workouts_data}
    output = assemble(src, USER_PROFILE, os.path.join(PROJECT_DIR, sleep_score.LABELS_FILE))

    out_path = os.path.join(PROJECT_DIR, 'dashboard_data.json')
    with open(out_path, 'w') as f:
        json.dump(output, f, indent=2)
        
    print(f"Successfully generated {out_path} with {len(output['days'])} days.")

if __name__ == '__main__':
    build_dataset()
