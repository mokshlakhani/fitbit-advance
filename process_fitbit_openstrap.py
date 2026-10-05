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

BASELINE_DAYS = 14  # trailing window for recovery z-scores

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
                
                workouts.setdefault(iso, []).append({
                    'name': name,
                    'duration_minutes': dur_mins,
                    'calories': cal,
                    'avg_hr': avg_hr,
                    'time': time_str
                })
    return workouts

def load_intraday_hr():
    daily_hr = {}
    # Files hold UTC days, so bucket every sample by its local date and minute.
    buckets = {}
    for f in glob.glob(os.path.join(BASE_DIR, 'Global Export Data', 'heart_rate-*.json')):
        try:
            with open(f) as fp:
                for item in json.load(fp):
                    dt_local = _takeout_local(item['dateTime'])
                    day = buckets.setdefault(dt_local.strftime('%Y-%m-%d'), {})
                    day.setdefault(dt_local.strftime('%H:%M'), []).append(item['value']['bpm'])
        except Exception:
            pass
    for dt_str, minutes in buckets.items():
        daily_hr[dt_str] = [{'time': hm, 'bpm': round(float(np.mean(v)))} for hm, v in sorted(minutes.items())]
    return daily_hr

# Banister TRIMP weighting y = a·exp(b·HRR): published coefficients for men and
# women; their midpoint when sex isn't known.
TRIMP_COEF = {'male': (0.64, 1.92), 'female': (0.86, 1.67), None: (0.75, 1.795)}

def calculate_trimp_and_strain(minute_hr_series, resting_hr, max_hr=190, sex=None):
    a, b = TRIMP_COEF.get(sex, TRIMP_COEF[None])
    if not minute_hr_series or resting_hr is None or resting_hr >= max_hr:
        return 0.0, 0.0, {'rest': 100, 'fat_burn': 0, 'cardio': 0, 'peak': 0}
        
    reserve = max_hr - resting_hr
    trimp = 0.0
    zones = {'rest': 0, 'fat_burn': 0, 'cardio': 0, 'peak': 0}
    
    for pt in minute_hr_series:
        hr = pt['bpm']
        if hr <= resting_hr:
            zones['rest'] += 1
            continue
            
        hrr = min(1.0, max(0.0, (hr - resting_hr) / reserve))
        
        # Karvonen Zone classification
        if hrr >= 0.85:
            zones['peak'] += 1
        elif hrr >= 0.70:
            zones['cardio'] += 1
        elif hrr >= 0.50:
            zones['fat_burn'] += 1
        else:
            zones['rest'] += 1
            
        y = a * math.exp(b * hrr)
        trimp += 1.0 * hrr * y
        
    # OpenStrap StrainScorer logarithmic strain mapping (0 - 21 scale):
    # strain = 21.0 * ln(1 + trimp) / ln(strainDenominator), where strainDenominator = 7201.0
    strain = 21.0 * math.log(1.0 + trimp) / math.log(7201.0)
    strain = min(21.0, max(0.0, round(strain, 1)))
    
    total_z = max(1, sum(zones.values()))
    zone_pct = {k: round(v / total_z * 100, 1) for k, v in zones.items()}
    
    return round(trimp, 1), strain, zone_pct

def calculate_body_age(chronological_age, vo2_max, resting_hr, bmi):
    if vo2_max is None or chronological_age is None:
        return None, None
    if resting_hr is None:
        resting_hr = 64
        
    expected_vo2 = 54.4 - 0.38 * chronological_age
    vo2_delta = vo2_max - expected_vo2
    
    age_offset = vo2_delta * 0.45
    rhr_offset = (64 - resting_hr) * 0.1
    
    fitness_age = max(18.0, round(chronological_age - age_offset - rhr_offset, 1))
    vitality_index = min(99, max(75, round(70 + (vo2_max - 50) * 1.8)))
    
    return fitness_age, vitality_index

def vo2_tier(vo2, age):
    """VO2max relative to the expected value for age (54.4 - 0.38·age)."""
    if vo2 is None or age is None:
        return None
    delta = vo2 - (54.4 - 0.38 * age)
    if delta >= 10:
        return 'Elite for your age'
    if delta >= 5:
        return 'Excellent for your age'
    if delta >= 0:
        return 'Above average for your age'
    return 'Below average for your age'

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
    
    history_hrv = []
    history_rhr = []
    history_resp = []
    history_temp = []
    last_vo2 = None
    
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
        # last measured value forward.
        if dt in vo2_data:
            last_vo2 = vo2_data[dt]
        vo2 = last_vo2
        steps = steps_data.get(dt)
        cals = cal_data.get(dt)
        day_workouts = workouts_data.get(dt, [])
        
        # Fitbit's measured nightly breathing rate.
        resp_rate = resp_data.get(dt)
        
        # OpenStrap Readiness Composite: each vital against its trailing
        # BASELINE_DAYS, weights renormalised over the vitals present today.
        components = []  # (weight, sign, z)
        if rmssd: components.append((0.40, 1, robust_z(rmssd, history_hrv[-BASELINE_DAYS:])))
        if rhr: components.append((0.30, -1, robust_z(rhr, history_rhr[-BASELINE_DAYS:])))
        if resp_rate: components.append((0.20, -1, robust_z(resp_rate, history_resp[-BASELINE_DAYS:])))
        if temp: components.append((0.10, -1, robust_z(temp, history_temp[-BASELINE_DAYS:])))
        z_hrv = robust_z(rmssd, history_hrv[-BASELINE_DAYS:]) if rmssd else 0.0
        z_rhr = robust_z(rhr, history_rhr[-BASELINE_DAYS:]) if rhr else 0.0
        z_resp = robust_z(resp_rate, history_resp[-BASELINE_DAYS:]) if resp_rate else 0.0
        z_temp = robust_z(temp, history_temp[-BASELINE_DAYS:]) if temp else 0.0
        
        w_sum = sum(w for w, _, _ in components)
        composite_z = sum(w * sign * z for w, sign, z in components) / w_sum if w_sum else 0.0
        
        raw_recovery = 100.0 / (1.0 + math.exp(-composite_z))
        recovery_score = int(round(min(98, max(22, raw_recovery * 0.8 + 20))))
        
        if recovery_score >= 67:
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
            
        drivers = []
        if rmssd:
            drivers.append({'metric': 'HRV (RMSSD)', 'weight': 0.40, 'z': round(z_hrv, 2), 'impact': round(0.40 * z_hrv * 15, 1), 'direction': 'positive' if z_hrv > 0 else 'negative'})
        if rhr:
            drivers.append({'metric': 'Resting Heart Rate', 'weight': 0.30, 'z': round(-z_rhr, 2), 'impact': round(-0.30 * z_rhr * 15, 1), 'direction': 'positive' if z_rhr < 0 else 'negative'})
        if resp_rate:
            drivers.append({'metric': 'Respiratory Rate', 'weight': 0.20, 'z': round(-z_resp, 2), 'impact': round(-0.20 * z_resp * 15, 1), 'direction': 'positive' if z_resp < 0 else 'negative'})
        if temp:
            drivers.append({'metric': 'Skin Temperature', 'weight': 0.10, 'z': round(-z_temp, 2), 'impact': round(-0.10 * z_temp * 15, 1), 'direction': 'positive' if z_temp < 0 else 'negative'})
        drivers.sort(key=lambda x: abs(x['impact']), reverse=True)
        
        # Intraday HR & Strain
        minute_hr = intraday_hr.get(dt, [])
        trimp, day_strain, hr_zones = calculate_trimp_and_strain(minute_hr, rhr, profile['max_hr'], profile['sex'])
        
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
        
        # Body age
        body_age, vitality = calculate_body_age(profile['chronological_age'], vo2, rhr, profile['bmi'])
        
        # Baevsky Stress Index
        baevsky_si = round(min(120, max(20, (100 - rmssd * 0.8) + (70 - rhr) * 0.5)), 1) if rmssd and rhr else None
        
        # Downsampled HR series for intraday sparkline chart (every 10 mins)
        intraday_spark = [minute_hr[i] for i in range(0, len(minute_hr), 10)] if len(minute_hr) > 0 else []
        
        record = {
            'date': dt,
            'day_name': datetime.strptime(dt, '%Y-%m-%d').strftime('%a, %b %d'),
            'recovery': {
                'score': recovery_score,
                'status': recovery_status,
                'color': recovery_color,
                'composite_z': round(composite_z, 2),
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
                'stress_index': baevsky_si
            },
            'body_age': {
                'chronological': profile['chronological_age'],
                'fitness_age': body_age,
                'age_delta': round(body_age - profile['chronological_age'], 1) if body_age is not None else None,
                'vitality_index': vitality,
                'tier': vo2_tier(vo2, profile['chronological_age'])
            },
            'strain': {
                'score': day_strain,
                'trimp': trimp,
                'steps': steps,
                'calories': cals,
                'zones': hr_zones,
                'zone_minutes': {k: round(v / 100 * len(minute_hr)) for k, v in hr_zones.items()} if minute_hr else None,
                'workouts': day_workouts,
                'intraday_hr': intraday_spark,
                'hourly_steps': hourly_steps.get(dt),
                'hourly_calories': hourly_cals.get(dt)
            }
        }
        
        daily_records.append(record)
        
        if rmssd: history_hrv.append(rmssd)
        if rhr: history_rhr.append(rhr)
        if resp_rate: history_resp.append(resp_rate)
        if temp: history_temp.append(temp)

    daily_records.sort(key=lambda x: x['date'])

    # Sleep score: Fitbit app scores where recorded, an estimate elsewhere.
    score_model = sleep_score.apply(daily_records, labels_path)
    accuracy = (f"typical error ±{score_model['mae']} over {score_model['training_nights']} nights"
                if score_model['method'] == 'fit' else 'default weights until 15 app scores are recorded')
    print(f"Sleep score: {score_model['app_nights']} nights from the Fitbit app, "
          f"{score_model['estimated_nights']} estimated ({accuracy}).")

    all_recoveries = [r['recovery']['score'] for r in daily_records]
    all_sleeps = [r['sleep']['score'] for r in daily_records if r['sleep']['score']]
    all_strains = [r['strain']['score'] for r in daily_records]
    all_hrvs = [r['cardiovascular']['hrv_rmssd'] for r in daily_records if r['cardiovascular']['hrv_rmssd']]
    all_rhrs = [r['cardiovascular']['rhr'] for r in daily_records if r['cardiovascular']['rhr']]
    
    overview = {
        'total_days_analyzed': len(daily_records),
        'date_start': daily_records[0]['date'],
        'date_end': daily_records[-1]['date'],
        'avg_recovery': round(float(np.mean(all_recoveries)), 1),
        'avg_sleep_score': round(float(np.mean(all_sleeps)), 1) if all_sleeps else None,
        'avg_strain': round(float(np.mean(all_strains)), 1),
        'avg_hrv': round(float(np.mean(all_hrvs)), 1),
        'avg_rhr': round(float(np.mean(all_rhrs)), 1),
        'best_recovery_day': max(daily_records, key=lambda x: x['recovery']['score'])['date'],
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
    for dt, entry in api_ingest.load_sleep_data().items():
        cur = sleep_data.setdefault(dt, {})
        # Don't let a shorter API session (e.g. a nap, when the API is missing
        # that night's main sleep) replace the export's main sleep.
        if cur.get('stage_source') == 'takeout-v2' and cur.get('minutesAsleep', 0) > entry['minutesAsleep']:
            continue
        cur.update(entry)
    
    src = {'hrv': hrv_data, 'sleep': sleep_data, 'temp': temp_data, 'spo2': spo2_data, 'vo2': vo2_data, 'steps': steps_data, 'cal': cal_data, 'hourly_steps': hourly_steps, 'hourly_cals': hourly_cals, 'resp': resp_data, 'rhr': rhr_data, 'intraday_hr': intraday_hr, 'workouts': workouts_data}
    output = assemble(src, USER_PROFILE, os.path.join(PROJECT_DIR, sleep_score.LABELS_FILE))

    out_path = os.path.join(PROJECT_DIR, 'dashboard_data.json')
    with open(out_path, 'w') as f:
        json.dump(output, f, indent=2)
        
    print(f"Successfully generated {out_path} with {len(output['days'])} days.")

if __name__ == '__main__':
    build_dataset()
