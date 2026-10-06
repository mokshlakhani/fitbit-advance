"""One local day of raw heart-rate readings (about every 2 s), on demand.

The dashboard file keeps only summaries; the Heart page asks serve.py for a
day's readings when it's opened (GET /hr/YYYY-MM-DD.json). Readings come from
the Google Health API files (api_data/heart-rate/, one file per UTC day) or,
for older days, the Takeout export (heart_rate-YYYY-MM-DD.json, also UTC days).
"""
import glob
import gzip
import json
import os
from datetime import datetime, timedelta

import pandas as pd

import profile_store

HERE = os.path.dirname(os.path.abspath(__file__))
API_DIR = os.path.join(HERE, 'api_data', 'heart-rate')
TAKEOUT_CANDIDATES = [os.path.join(HERE, p) for p in (
    'takeout/Google Health', 'FitbitAir Data/New_Data/Google Health', 'FitbitAir Data/Google Health')]


def _utc_days(date):
    d = datetime.strptime(date, '%Y-%m-%d')
    return [(d + timedelta(days=k)).strftime('%Y-%m-%d') for k in (-1, 0, 1)]


def _api_frame(date):
    frames = []
    for day in _utc_days(date):
        path = os.path.join(API_DIR, f'{day}.csv.gz')
        if os.path.exists(path):
            df = pd.read_csv(path, usecols=['time', 'bpm'])
            if not df.empty:
                frames.append(df)
    if not frames:
        return None
    df = pd.concat(frames, ignore_index=True)
    df['time'] = pd.to_datetime(df['time'], utc=True, format='ISO8601')
    return df


def _takeout_frame(date):
    base = next((p for p in TAKEOUT_CANDIDATES if os.path.isdir(p)), None)
    if not base:
        return None
    times, bpms = [], []
    for day in _utc_days(date):
        for path in glob.glob(os.path.join(base, 'Global Export Data', f'heart_rate-{day}.json')):
            with open(path) as fh:
                for item in json.load(fh):
                    times.append(item['dateTime'])
                    bpms.append(item['value']['bpm'])
    if not times:
        return None
    return pd.DataFrame({'time': pd.to_datetime(pd.Series(times, dtype=object), format='%m/%d/%y %H:%M:%S', utc=True),
                         'bpm': bpms})


def day_readings(date):
    """{'date', 'resolution': 'second', 't': seconds since local midnight, 'b': bpm} or None."""
    tz = profile_store.local_tz()
    for frame in (_api_frame(date), _takeout_frame(date)):
        if frame is None:
            continue
        local = frame['time'].dt.tz_convert(tz).dt.tz_localize(None)
        mask = local.dt.strftime('%Y-%m-%d') == date
        if not mask.any():
            continue
        loc = local[mask]
        sec = (loc.dt.hour * 3600 + loc.dt.minute * 60 + loc.dt.second).to_numpy()
        bpm = frame['bpm'][mask].astype(int).to_numpy()
        order = sec.argsort(kind='stable')
        return {'date': date, 'resolution': 'second', 't': sec[order].tolist(), 'b': bpm[order].tolist()}
    return None


def day_readings_json(date):
    """Gzipped JSON bytes for serve.py, or None."""
    data = day_readings(date)
    if data is None:
        return None
    return gzip.compress(json.dumps(data, separators=(',', ':')).encode())
