"""Loaders for Google Health API data synced by google_health_sync.py.

Each loader returns the same shape as its Takeout counterpart in
process_fitbit_openstrap.py, keyed by the user's local ISO date, so the two
sources can be merged day by day.
"""
import os
import glob
import json
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

import profile_store

API_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'api_data')


def _load_json(name):
    path = os.path.join(API_DIR, f'{name}.json')
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return json.load(f)


def _iso(date_obj):
    return f"{date_obj['year']:04d}-{date_obj['month']:02d}-{date_obj['day']:02d}"


def _to_local(utc_strings):
    """UTC ISO timestamps -> naive local times in the user's time zone."""
    tz = profile_store.local_tz()
    return pd.to_datetime(utc_strings, utc=True, format='ISO8601').dt.tz_convert(tz).dt.tz_localize(None)


def _local(utc_str, offset=None):
    t = datetime.fromisoformat(utc_str.replace('Z', '+00:00')).replace(tzinfo=None)
    if offset:
        return t + timedelta(seconds=int(offset.rstrip('s')))
    return profile_store.utc_to_local(t)


def _read_daily_csvs(data_type):
    files = sorted(glob.glob(os.path.join(API_DIR, data_type, '*.csv.gz')))
    frames = [pd.read_csv(f) for f in files]
    frames = [f for f in frames if not f.empty]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def _drop_first_partial_day(by_date):
    # Files are UTC days, so the earliest local day can be missing some of its
    # first 5.5 hours. Drop it so the merge falls back to Takeout for that day.
    if by_date:
        by_date.pop(min(by_date))
    return by_date


def load_hrv():
    out = {}
    for p in _load_json('daily-heart-rate-variability'):
        d = p['dailyHeartRateVariability']
        rmssd = d.get('averageHeartRateVariabilityMilliseconds')
        if rmssd is None:
            continue
        nrem = d.get('nonRemHeartRateBeatsPerMinute')
        out[_iso(d['date'])] = {
            'rmssd': float(rmssd),
            'nremhr': float(nrem) if nrem and float(nrem) > 0 else None,
            'entropy': d.get('entropy'),
        }
    return out


def load_resting_hr():
    out = {}
    for p in _load_json('daily-resting-heart-rate'):
        d = p['dailyRestingHeartRate']
        v = float(d.get('beatsPerMinute', 0))
        if 30 < v < 120:
            out[_iso(d['date'])] = round(v)
    return out


def load_spo2():
    out = {}
    for p in _load_json('daily-oxygen-saturation'):
        d = p['dailyOxygenSaturation']
        if d.get('averagePercentage') is None:
            continue
        avg = d['averagePercentage']
        out[_iso(d['date'])] = {
            'avg': round(avg, 1),
            'lower': round(d.get('lowerBoundPercentage', avg), 1),
            'upper': round(d.get('upperBoundPercentage', avg), 1),
        }
    return out


def load_temperature():
    out = {}
    for p in _load_json('daily-sleep-temperature-derivations'):
        d = p['dailySleepTemperatureDerivations']
        if d.get('nightlyTemperatureCelsius') is not None:
            out[_iso(d['date'])] = float(d['nightlyTemperatureCelsius'])
    return out


STAGE_NAMES = {'AWAKE': 'wake', 'LIGHT': 'light', 'DEEP': 'deep', 'REM': 'rem',
               'ASLEEP': 'asleep', 'RESTLESS': 'restless'}


def load_sleep_data():
    """Each night's main Fitbit sleep, keyed by local wake-up date.

    The API sometimes puts the mainSleep flag on another app's session (e.g.
    Samsung Health) instead of the Fitbit one, so a night with no flagged
    Fitbit session falls back to its longest Fitbit session.
    """
    out = {}
    rank = {}
    for p in _load_json('sleep'):
        s = p['sleep']
        # Sleep can't be source-filtered at the API, so drop other apps
        # (e.g. Samsung Health via Health Connect) here.
        if p.get('dataSource', {}).get('platform') != 'FITBIT':
            continue
        flagged = bool(s.get('metadata', {}).get('mainSleep', False))
        iv = s['interval']
        start = _local(iv['startTime'], iv.get('startUtcOffset'))
        end = _local(iv['endTime'], iv.get('endUtcOffset'))
        dt = end.strftime('%Y-%m-%d')  # Fitbit's dateOfSleep is the wake-up date

        summary = s.get('summary', {})
        stage_min = {x['type']: int(x.get('minutes', 0)) for x in summary.get('stagesSummary', [])}
        asleep = int(summary.get('minutesAsleep', 0))
        in_bed = int(summary.get('minutesInSleepPeriod', 0)) or int((end - start).total_seconds() // 60)

        hypno = []
        for st in s.get('stages', []):
            st_start = _local(st['startTime'], st.get('startUtcOffset'))
            st_end = _local(st['endTime'], st.get('endUtcOffset'))
            hypno.append({
                'time': st_start.strftime('%Y-%m-%dT%H:%M:%S.000'),
                'stage': STAGE_NAMES.get(st['type'], st['type'].lower()),
                'seconds': int((st_end - st_start).total_seconds()),
            })

        if dt in rank and rank[dt] >= (flagged, asleep):
            continue
        rank[dt] = (flagged, asleep)
        out[dt] = {
            'stage_source': 'api',
            'minutesAsleep': asleep,
            'minutesAwake': int(summary.get('minutesAwake', 0)),
            'timeInBed': in_bed,
            'efficiency': round(asleep / in_bed * 100) if in_bed else None,
            'startTime': start.strftime('%Y-%m-%dT%H:%M:%S.000'),
            'endTime': end.strftime('%Y-%m-%dT%H:%M:%S.000'),
            'deep_min': stage_min.get('DEEP', 0),
            'rem_min': stage_min.get('REM', 0),
            'light_min': stage_min.get('LIGHT', 0),
            'wake_min': stage_min.get('AWAKE', int(summary.get('minutesAwake', 0))),
            'hypnogram': hypno,
        }
    return out


def load_workouts():
    out = {}
    for p in _load_json('exercise'):
        ex = p['exercise']
        iv = ex['interval']
        start = _local(iv['startTime'], iv.get('startUtcOffset'))
        m = ex.get('metricsSummary', {})
        dur_s = float(str(ex.get('activeDuration', '0s')).rstrip('s') or 0)
        if not dur_s:
            dur_s = int((_local(iv['endTime']) - _local(iv['startTime'])).total_seconds())
        out.setdefault(start.strftime('%Y-%m-%d'), []).append({
            'name': ex.get('displayName') or ex.get('exerciseType', 'Workout').replace('_', ' ').title(),
            'duration_minutes': round(dur_s / 60),
            'calories': round(m.get('caloriesKcal', 0)),
            'avg_hr': int(m.get('averageHeartRateBeatsPerMinute', 0)),
            'time': start.strftime('%H:%M'),
        })
    return out


def _hourly(df, value_col, cast):
    out = {}
    for (d, h), v in df.groupby(['date', 'hour'])[value_col].sum().items():
        out.setdefault(d, [0] * 24)[h] = cast(v)
    return out


def load_steps_and_calories():
    """Daily totals and 24 hourly buckets per local day for steps and calories."""
    steps, calories, hourly_steps, hourly_cals = {}, {}, {}, {}
    for kind in ('steps', 'total-calories'):
        df = _read_daily_csvs(kind)
        if df.empty:
            continue
        local = _to_local(df['start'])
        df['date'] = local.dt.strftime('%Y-%m-%d')
        df['hour'] = local.dt.hour
        if kind == 'steps':
            steps = _drop_first_partial_day({k: int(v) for k, v in df.groupby('date')['count'].sum().items()})
            hourly_steps = {k: v for k, v in _hourly(df, 'count', int).items() if k in steps}
        else:
            calories = _drop_first_partial_day({k: round(float(v)) for k, v in df.groupby('date')['kcal'].sum().items()})
            hourly_cals = {k: v for k, v in _hourly(df, 'kcal', lambda x: round(float(x))).items() if k in calories}
    return steps, calories, hourly_steps, hourly_cals


def load_respiratory_rate():
    out = {}
    for p in _load_json('daily-respiratory-rate'):
        d = p['dailyRespiratoryRate']
        if d.get('breathsPerMinute') is not None:
            out[_iso(d['date'])] = round(float(d['breathsPerMinute']), 1)
    return out


def load_intraday_hr():
    """Per-minute mean BPM by local day, built from the full-resolution samples."""
    df = _read_daily_csvs('heart-rate')
    if df.empty:
        return {}
    local = _to_local(df['time'])
    df = pd.DataFrame({'date': local.dt.strftime('%Y-%m-%d'),
                       'hm': local.dt.strftime('%H:%M'),
                       'bpm': df['bpm']})
    out = {}
    for (dt, hm), bpm in df.groupby(['date', 'hm'])['bpm'].mean().items():
        out.setdefault(dt, []).append({'time': hm, 'bpm': round(float(bpm))})
    return _drop_first_partial_day(out)
