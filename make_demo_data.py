"""Generate demo_data.json: 90 days of synthetic data for a fictional person.

The dashboard shows this until you connect your own Fitbit with setup.py.
Inputs are simulated (sleep cycles, heart rate, steps, workouts) and pushed
through the same analytics as real data (process_fitbit_openstrap.assemble),
so the demo always matches the real format. No real person's data is used.

    python3 make_demo_data.py
"""
import json
import math
import os
from datetime import date, datetime, timedelta

import numpy as np

import process_fitbit_openstrap as pipeline

HERE = os.path.dirname(os.path.abspath(__file__))
DAYS = 90
rng = np.random.default_rng(7)

PROFILE = {
    'name': 'Sample data', 'chronological_age': 30, 'sex': None, 'height_cm': 175.0, 'weight_kg': 70.0,
    'bmi': round(70 / 1.75 ** 2, 2), 'max_hr': round(208 - 0.7 * 30), 'timezone': 'UTC', 'temperature_unit': 'CELSIUS',
}
WORKOUTS = [('Run', 35, 140), ('Weights', 55, 115), ('Cycling', 50, 130), ('Walk', 40, 100), ('Football', 75, 145)]


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def sleep_night(wake_day, fatigue):
    """One night of stages ending on the morning of wake_day."""
    bed = datetime.combine(wake_day - timedelta(days=1), datetime.min.time()) + timedelta(
        hours=23, minutes=int(rng.normal(0, 40)))
    target = clamp(rng.normal(415 - 25 * fatigue, 45), 250, 540)
    stages, t, asleep, cycle = [], bed, 0, 0
    stages.append((t, 'wake', int(rng.integers(3, 15))))
    t += timedelta(minutes=stages[-1][2])
    while asleep < target:
        early = cycle < 2
        for stage, mean in (('light', 25), ('deep', 30 if early else 8), ('light', 15), ('rem', 12 if early else 28)):
            m = int(clamp(rng.normal(mean, mean * 0.3), 2, 60))
            stages.append((t, stage, m))
            t += timedelta(minutes=m)
            asleep += m
        if rng.random() < 0.35 + 0.2 * fatigue:
            m = int(rng.integers(2, 12))
            stages.append((t, 'wake', m))
            t += timedelta(minutes=m)
        cycle += 1
    mins = {k: sum(m for _, s, m in stages if s == k) for k in ('wake', 'light', 'deep', 'rem')}
    in_bed = sum(m for _, _, m in stages)
    asleep = in_bed - mins['wake']
    return {
        'stage_source': 'api', 'minutesAsleep': asleep, 'minutesAwake': mins['wake'], 'timeInBed': in_bed,
        'efficiency': round(asleep / in_bed * 100), 'startTime': bed.strftime('%Y-%m-%dT%H:%M:%S.000'),
        'endTime': t.strftime('%Y-%m-%dT%H:%M:%S.000'), 'deep_min': mins['deep'], 'rem_min': mins['rem'],
        'light_min': mins['light'], 'wake_min': mins['wake'],
        'hypnogram': [{'time': s.strftime('%Y-%m-%dT%H:%M:%S.000'), 'stage': k, 'seconds': m * 60} for s, k, m in stages],
    }, bed, t


def main():
    end = date.today()
    src = {k: {} for k in ('hrv', 'sleep', 'temp', 'spo2', 'vo2', 'steps', 'cal', 'hourly_steps',
                           'hourly_cals', 'resp', 'rhr', 'intraday_hr', 'workouts')}
    fatigue = 0.0
    vo2 = 46.0
    for i in range(DAYS):
        day = end - timedelta(days=DAYS - 1 - i)
        iso = day.isoformat()
        # Fatigue builds with hard days and fades with rest; vitals follow it.
        fatigue = clamp(fatigue * 0.6 + rng.normal(0.25, 0.35), 0, 1.5)
        rhr = int(round(clamp(rng.normal(58 + 4 * fatigue, 1.5), 48, 75)))
        src['rhr'][iso] = rhr
        src['hrv'][iso] = {'rmssd': round(clamp(rng.normal(58 - 14 * fatigue, 6), 20, 110), 1), 'nremhr': None, 'entropy': None}
        src['temp'][iso] = round(rng.normal(33.9 + 0.25 * fatigue, 0.18), 2)
        src['resp'][iso] = round(rng.normal(14.2 + 0.6 * fatigue, 0.4), 1)
        avg = round(clamp(rng.normal(96.6, 0.6), 93, 99.5), 1)
        src['spo2'][iso] = {'avg': avg, 'lower': round(avg - 1.6, 1), 'upper': round(min(100, avg + 1.8), 1)}
        vo2 = clamp(vo2 + rng.normal(0.01, 0.08), 40, 52)
        if i % 7 == 0:
            src['vo2'][iso] = round(vo2, 1)

        night, bed, wake = sleep_night(day, fatigue)
        src['sleep'][iso] = night

        workouts = []
        if rng.random() < 0.5:
            name, dur, hr = WORKOUTS[int(rng.integers(len(WORKOUTS)))]
            start_h = int(rng.choice([7, 8, 17, 18, 19]))
            workouts.append({'name': name, 'duration_minutes': int(dur + rng.integers(-10, 15)),
                             'calories': int(dur * hr / 22), 'avg_hr': int(hr + rng.integers(-8, 8)), 'time': f'{start_h:02d}:{int(rng.integers(0, 50)):02d}'})
        src['workouts'][iso] = workouts

        # Minute-by-minute heart rate, hourly steps and calories.
        hr, steps, cals = [], [0] * 24, [0.0] * 24
        midnight = datetime.combine(day, datetime.min.time())
        for minute in range(1440):
            t = midnight + timedelta(minutes=minute)
            h = minute // 60
            asleep = t < wake
            if asleep:
                bpm = rhr - 4 + rng.normal(0, 2)
            else:
                bpm = rhr + 18 + 6 * math.sin((h - 9) / 24 * 2 * math.pi) + rng.normal(0, 5)
                if 9 <= h <= 21 and rng.random() < 0.03:
                    bpm += rng.uniform(15, 35)
            for w in workouts:
                ws = int(w['time'][:2]) * 60 + int(w['time'][3:])
                if ws <= minute < ws + w['duration_minutes']:
                    bpm = w['avg_hr'] + rng.normal(0, 7)
            hr.append({'time': f'{h:02d}:{minute % 60:02d}', 'bpm': int(round(bpm))})
            if not asleep and 7 <= h <= 22:
                steps[h] += int(max(0, rng.normal(9, 12)))
            cals[h] += 1.15 + (0.06 * max(0, bpm - rhr) if not asleep else 0)
        for w in workouts:
            steps[int(w['time'][:2])] += int(rng.integers(800, 3500)) if w['name'] in ('Run', 'Walk', 'Football') else 200
        src['intraday_hr'][iso] = hr
        src['hourly_steps'][iso] = steps
        src['hourly_cals'][iso] = [round(c) for c in cals]
        src['steps'][iso] = sum(steps)
        src['cal'][iso] = round(sum(cals))

    output = pipeline.assemble(src, PROFILE, os.path.join(HERE, 'no_labels.csv'))
    output['demo'] = True
    with open(os.path.join(HERE, 'demo_data.json'), 'w') as fh:
        json.dump(output, fh, separators=(',', ':'))
    print(f"Wrote demo_data.json ({len(output['days'])} days).")


if __name__ == '__main__':
    main()
