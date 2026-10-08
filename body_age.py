"""Body age: a physiological age from Fitbit data (design: docs/BODY_AGE_DESIGN.md).

Each driver's published effect on all-cause mortality is compared between you
and a typical peer of your age and sex, converted to years with the Gompertz
rate of ageing (mortality doubles about every 8 years), discounted for overlap
between related drivers and, under 30, for evidence measured in older adults.

The phone app has an exact JavaScript twin (mobile/src/engine.js, "Body age");
mobile/test/parity.mjs checks they agree.
"""
import math
import re
from datetime import datetime, timedelta

GAMMA = math.log(2) / 8.0          # Gompertz: age-related mortality doubles every ~8 years
WINDOW_DAYS = 180                  # six months, like WHOOP Age
UPDATE_WEEKDAY = 0                 # recomputed on Mondays and held for the week
MIN_RECOVERIES, RECOVERY_SPAN = 21, 31  # nights with a recovery score needed in the last 31 days
MIN_DAYS = 14
FLOOR = 17.0
PACE_SHORT, PACE_LONG, PACE_MIN_HISTORY = 30, 180, 90
# Body age wobbles 0.1-0.25 years month to month from noise alone, so changes
# smaller than this between the 30-day and long-term windows read as steady.
PACE_DEADBAND = 0.3
STRENGTH_RE = re.compile(r'weight|strength|machine|lift|resistance|crossfit|kettlebell|calisthenic', re.I)

# Peers (typical person of the same age and sex). Sources in the design doc.
VO2_NORMS = [  # Loe et al. 2013 (HUNT3): age, men mean, men SD, women mean, women SD
    (25, 54.4, 8.4, 43.0, 7.7), (35, 49.1, 7.5, 40.0, 6.8), (45, 47.2, 7.7, 38.4, 6.9),
    (55, 42.6, 7.4, 34.4, 5.7), (65, 39.2, 6.7, 31.1, 5.1), (75, 35.3, 6.5, 28.3, 5.2),
]
BMI_POINTS = [  # Global BMI Mortality Collaboration 2016, never-smokers: category midpoints
    (15.0, 1.51), (18.5, 1.51), (19.25, 1.13), (21.25, 1.0), (23.75, 1.0),
    (26.25, 1.07), (28.75, 1.20), (32.5, 1.45), (37.5, 1.94),
]
AREM_POINTS = [(0.0, 1.0), (0.5, 0.80), (1.5, 0.69), (2.5, 0.63), (4.0, 0.61), (10.0, 0.61)]  # Arem et al. 2015

LABELS = {
    'vo2': 'VO₂ max', 'rhr': 'Resting heart rate', 'steps': 'Daily steps', 'zone': 'Zone minutes',
    'strength': 'Strength training', 'sleep': 'Sleep duration', 'sri': 'Sleep regularity', 'bmi': 'BMI',
}
GROUP = {'vo2': 'fitness', 'rhr': 'fitness', 'steps': 'activity', 'zone': 'activity', 'strength': 'activity',
         'sleep': 'sleep', 'sri': 'sleep', 'bmi': 'body'}
GROUP_FACTOR = {'fitness': 1.0, 'activity': 0.5, 'sleep': 0.8, 'body': 1.0}
DRIVER_FACTOR = {'rhr': 0.6, 'bmi': 0.5}      # overlap with VO2 max; BMI can't tell muscle from fat
REL_SE = {'vo2': 0.15, 'rhr': 0.2, 'steps': 0.2, 'zone': 0.3, 'strength': 0.3, 'sleep': 0.25, 'sri': 0.1, 'bmi': 0.1}


def _interp_log(points, x):
    """Log-linear interpolation of a hazard ratio over (x, HR) points; flat outside."""
    if x <= points[0][0]:
        return math.log(points[0][1])
    for (x0, h0), (x1, h1) in zip(points, points[1:]):
        if x <= x1:
            if x1 == x0:
                return math.log(h1)
            return math.log(h0) + (x - x0) / (x1 - x0) * (math.log(h1) - math.log(h0))
    return math.log(points[-1][1])


def _norm_row(row, sex):
    _, mm, ms, wm, ws = row
    if sex == 'male':
        return mm
    if sex == 'female':
        return wm
    return (mm + wm) / 2.0


def peer_vo2(age, sex):
    if age <= VO2_NORMS[0][0]:
        return _norm_row(VO2_NORMS[0], sex)
    for lo, hi in zip(VO2_NORMS, VO2_NORMS[1:]):
        if age <= hi[0]:
            f = (age - lo[0]) / (hi[0] - lo[0])
            m0, m1 = _norm_row(lo, sex), _norm_row(hi, sex)
            return m0 + f * (m1 - m0)
    return _norm_row(VO2_NORMS[-1], sex)


def peer_rhr(age, sex):
    # NHANES 1999-2008 (Ostchega et al. 2011): 20-39 medians; adults plateau near 72.
    if age < 40:
        return 68.0 if sex == 'male' else 74.0 if sex == 'female' else 71.0
    return 72.0


def peer_steps(age, sex):
    # All of Us Fitbit users (Zheng et al. 2026, 18-39; Master et al. 2022 overall).
    if age < 40:
        return 8300.0 if sex == 'male' else 7100.0 if sex == 'female' else 7600.0
    return 7700.0


PEER_ZONE = 75.0      # 0.5x guideline: only 25.7% of 18-29s meet it (Singh et al. 2024)
PEER_SRI = 61.0       # UK Biobank median (Cribb et al. 2023)


# ---------- each driver's ln(hazard ratio) as a function of its value ----------
def ln_vo2(v, sex):
    per_met = 0.85 if sex == 'male' else 0.92 if sex == 'female' else 0.885  # Nes et al. 2014
    return math.log(per_met) * v / 3.5


def ln_rhr(v):
    return math.log(1.12) * (v - 45.0) / 10.0  # Zhang et al. 2016, linear from 45 bpm


def ln_steps(v):
    return math.log(0.85) * min(max(v, 4000.0), 10000.0) / 1000.0  # Banach 2023; Paluch 2022 plateau


def ln_zone(minutes):
    return _interp_log(AREM_POINTS, minutes / 150.0)


def ln_strength(m):
    if m <= 0:
        return 0.0
    if m < 30:
        return math.log(0.85) * m / 30.0
    if m <= 60:
        return math.log(0.85)
    if m <= 140:
        return math.log(0.85) + (m - 60.0) / 80.0 * (math.log(0.92) - math.log(0.85))
    return math.log(0.92)  # Momma et al. 2022: benefit fades above ~130-140 min/week


def ln_sleep(hours):
    short = 1.0 if hours <= 6 else (7.0 - hours) if hours < 7 else 0.0
    long = 1.0 if hours >= 9 else (hours - 8.0) if hours > 8 else 0.0
    return short * math.log(1.12) + 0.5 * long * math.log(1.30)  # Cappuccio et al. 2010; long half weight


def ln_sri(sri):
    if sri < PEER_SRI:
        return math.log(1.53) * (PEER_SRI - max(sri, 41.0)) / 20.0
    return math.log(0.90) * (min(sri, 75.0) - PEER_SRI) / 14.0  # Cribb et al. 2023


def ln_bmi(b):
    return _interp_log(BMI_POINTS, b)


# ---------- inputs from the daily records ----------
def _mean(vals):
    vals = [v for v in vals if v is not None]
    return (sum(vals) / len(vals), len(vals)) if vals else (None, 0)


def _parse(ts):
    return datetime.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S')


def sleep_pairs(records):
    """Per day d: (same, total) minutes where being asleep or not matches the minute 24 h later.

    Only counted when the sleep of nights d, d+1 and d+2 were all recorded,
    so a missing night is never read as "awake all night".
    """
    by_date = {r['date']: r for r in records}
    asleep = {}
    for r in records:
        h = [x for x in (r['sleep'].get('hypnogram') or []) if x.get('time') and x.get('seconds')]
        if not h or r['sleep'].get('duration_minutes') is None:
            continue
        a = _parse(h[0]['time'])
        b = _parse(h[-1]['time']) + timedelta(seconds=h[-1]['seconds'])
        t = a.replace(second=0)
        while t < b:
            asleep.setdefault(t.strftime('%Y-%m-%d'), set()).add(t.hour * 60 + t.minute)
            t += timedelta(minutes=1)
    out = {}
    for r in records:
        d0 = datetime.strptime(r['date'], '%Y-%m-%d')
        d1, d2 = (d0 + timedelta(days=1)).strftime('%Y-%m-%d'), (d0 + timedelta(days=2)).strftime('%Y-%m-%d')
        if not all(x in by_date and by_date[x]['sleep'].get('duration_minutes') is not None for x in (r['date'], d1, d2)):
            continue
        a0, a1 = asleep.get(r['date'], set()), asleep.get(d1, set())
        same = sum(1 for m in range(1440) if (m in a0) == (m in a1))
        out[r['date']] = (same, 1440)
    return out


def inputs(records, i, profile, pairs, window):
    """The drivers' input values as of day i, over the `window` days ending there."""
    lo = max(0, i - window + 1)
    win = records[lo:i + 1]
    before = records[lo:i]                       # activity: the as-of day may be unfinished
    r = records[i]
    out = {}
    if r['cardiovascular'].get('vo2_max') is not None:
        out['vo2'] = r['cardiovascular']['vo2_max']
    v, n = _mean([x['cardiovascular'].get('rhr') for x in win])
    if n >= MIN_DAYS:
        out['rhr'] = v
    v, n = _mean([x['strain'].get('steps') for x in before])
    if n >= MIN_DAYS:
        out['steps'] = v
    zm = [x['strain'].get('zone_minutes') for x in before if x['strain'].get('zone_minutes')]
    if len(zm) >= MIN_DAYS:
        total = sum(z.get('moderate', 0) + 2 * (z.get('vigorous', 0) + z.get('peak', 0)) for z in zm)
        out['zone'] = total / (len(zm) / 7.0)
        strength = sum(w.get('duration_minutes') or 0 for x in before for w in (x['strain'].get('workouts') or [])
                       if STRENGTH_RE.search(w.get('name') or ''))
        out['strength'] = strength / (len(zm) / 7.0)
    v, n = _mean([x['sleep'].get('duration_minutes') for x in win])
    if n >= MIN_DAYS:
        out['sleep'] = v / 60.0
    p = [pairs[x['date']] for x in win if x['date'] in pairs]
    if len(p) >= MIN_DAYS:
        out['sri'] = 200.0 * sum(s for s, _ in p) / sum(t for _, t in p) - 100.0
    if profile.get('bmi'):
        out['bmi'] = profile['bmi']
    return out


# ---------- the model ----------
def driver_years(key, value, age, sex):
    """(years, sigma) for one driver after transfer and overlap factors."""
    tau = 1.0 if key == 'vo2' or age >= 30 else 0.7
    if key == 'vo2':
        ln_you, ln_peer = ln_vo2(value, sex), ln_vo2(peer_vo2(age, sex), sex)
    elif key == 'rhr':
        ln_you, ln_peer = ln_rhr(value), ln_rhr(peer_rhr(age, sex))
    elif key == 'steps':
        ln_you, ln_peer = ln_steps(value), ln_steps(peer_steps(age, sex))
    elif key == 'zone':
        ln_you, ln_peer = ln_zone(value), ln_zone(PEER_ZONE)
    elif key == 'strength':
        ln_you, ln_peer = ln_strength(value), 0.0
    elif key == 'sleep':
        ln_you, ln_peer = ln_sleep(value), 0.0
    elif key == 'sri':
        ln_you, ln_peer = ln_sri(value), 0.0
    else:
        ln_you, ln_peer = ln_bmi(value), 0.0
    factor = DRIVER_FACTOR.get(key, 1.0) * GROUP_FACTOR[GROUP[key]]
    base = (ln_you - ln_peer) / GAMMA
    years = tau * factor * base
    sigma_effect = REL_SE[key] * abs(years)
    sigma_transfer = (1.0 - tau) * factor * abs(base)
    if key == 'vo2':
        per_met = 0.85 if sex == 'male' else 0.92 if sex == 'female' else 0.885
        sigma_meas = tau * factor * abs(math.log(per_met)) / GAMMA       # +/- 3.5 ml/kg/min
    elif key == 'rhr':
        sigma_meas = tau * factor * math.log(1.12) * 0.2 / GAMMA          # +/- 2 bpm
    else:
        sigma_meas = 0.0
    return years, math.sqrt(sigma_effect ** 2 + sigma_transfer ** 2 + sigma_meas ** 2)


def evaluate(values, age, sex):
    """(delta years before bounds, sigma, {key: years}) for a set of driver values."""
    per = {}
    var = 0.0
    for key in ('vo2', 'rhr', 'steps', 'zone', 'strength', 'sleep', 'sri', 'bmi'):
        if key in values:
            y, s = driver_years(key, values[key], age, sex)
            per[key] = y
            var += s * s
    model = 3.0 if age < 30 else 2.0
    return sum(per.values()), math.sqrt(var + model * model), per


def bounded(age, delta):
    cap = 8.0 if age < 30 else 10.0
    return max(FLOOR, age + min(cap, max(-cap, delta)))


PEER_FN = {
    'vo2': lambda age, sex: peer_vo2(age, sex), 'rhr': lambda age, sex: peer_rhr(age, sex),
    'steps': lambda age, sex: peer_steps(age, sex), 'zone': lambda age, sex: PEER_ZONE,
    'strength': lambda age, sex: 0.0, 'sleep': lambda age, sex: 7.5, 'sri': lambda age, sex: PEER_SRI,
    'bmi': lambda age, sex: 23.75,
}


def lever_target(key, v):
    """A sensible target for a driver, or None if it's already there."""
    targets = {
        'vo2': v + 3.5, 'rhr': v - 5.0, 'steps': max(v, 10000.0), 'zone': max(v, 300.0),
        'strength': 45.0 if (v < 30 or v > 140) else None, 'sleep': 7.5 if (v < 7 or v > 8) else None,
        'sri': max(v, 75.0), 'bmi': (21.25 if v < 20 else 24.9 if v > 25 else None),
    }
    return targets.get(key)


def body_age_for_day(records, i, profile, pairs, window=WINDOW_DAYS, with_detail=True):
    age, sex = profile.get('chronological_age'), profile.get('sex')
    if age is None:
        return None
    values = inputs(records, i, profile, pairs, window)
    have_core = 'vo2' in values or 'rhr' in values
    if len(values) < 3 or not have_core:
        missing = [LABELS[k] for k in ('vo2', 'rhr', 'steps', 'zone', 'sleep', 'sri') if k not in values]
        return {'status': 'calibrating', 'value': None, 'delta': None, 'raw_delta': None, 'chronological': age,
                'sigma': None, 'pace': None, 'pace_change': None, 'missing': missing, 'floored': False, 'drivers': [], 'levers': []}
    delta, sigma, per = evaluate(values, age, sex)
    value = round(bounded(age, delta), 1)
    out = {'status': 'ok', 'value': value, 'delta': round(value - age, 1), 'raw_delta': round(delta, 2),
           'chronological': age, 'sigma': max(2, int(round(sigma))), 'pace': None, 'pace_change': None, 'missing': [],
           'floored': value <= FLOOR and age + delta < FLOOR, 'drivers': [], 'levers': []}
    if not with_detail:
        return out
    drivers = [{'key': k, 'label': LABELS[k], 'value': round(values[k], 2), 'peer': round(PEER_FN[k](age, sex), 2),
                'years': round(y, 1)} for k, y in per.items()]
    drivers.sort(key=lambda x: abs(x['years']), reverse=True)
    out['drivers'] = drivers
    levers = []
    for k in per:
        t = lever_target(k, values[k])
        if t is None:
            continue
        moved = dict(values, **{k: t})
        gain = evaluate(moved, age, sex)[0] - delta
        if gain < -0.05:
            levers.append({'key': k, 'label': LABELS[k], 'from': round(values[k], 2), 'to': round(t, 2), 'years': round(gain, 1)})
    levers.sort(key=lambda x: x['years'])
    out['levers'] = levers[:3]
    return out


def _calibrating(age, missing, recoveries=None):
    return {'status': 'calibrating', 'value': None, 'delta': None, 'raw_delta': None, 'chronological': age,
            'sigma': None, 'pace': None, 'pace_change': None, 'missing': missing, 'floored': False,
            'drivers': [], 'levers': [], 'recoveries': recoveries}


def _recoveries(records, i):
    lo = max(0, i - RECOVERY_SPAN + 1)
    return sum(1 for r in records[lo:i + 1] if (r.get('recovery') or {}).get('score') is not None)


def weekly_value(records, i, profile, pairs, first):
    """Body age and pace as of day i (a Monday), or a calibrating result."""
    ba = body_age_for_day(records, i, profile, pairs)
    if ba is None:
        return None
    n = _recoveries(records, i)
    if ba['status'] == 'ok' and n < MIN_RECOVERIES:
        return _calibrating(ba['chronological'], [], n)
    if ba['status'] == 'ok':
        span = (datetime.strptime(records[i]['date'], '%Y-%m-%d') - first).days + 1
        if span >= PACE_MIN_HISTORY:
            long_w = min(PACE_LONG, span)
            short = body_age_for_day(records, i, profile, pairs, PACE_SHORT, with_detail=False)
            longb = body_age_for_day(records, i, profile, pairs, long_w, with_detail=False)
            if short and longb and short['status'] == 'ok' and longb['status'] == 'ok':
                dt = (long_w - PACE_SHORT) / 2.0 / 365.0
                change = short['raw_delta'] - longb['raw_delta']
                pace = 1.0 if abs(change) < PACE_DEADBAND else 1.0 + change / dt
                ba['pace'] = round(min(3.0, max(-1.0, pace)), 1)
                ba['pace_change'] = round(change, 1)
    return ba


def apply(records, profile):
    """Fill record['bio_age'] for every day. Like WHOOP Age it moves slowly: the
    value (180-day window) and pace (30 vs 180 days) are worked out each Monday
    and held for the week; a Monday short of 21 recovery nights in 31 days keeps
    the last good value. `updated` is the Monday it's from."""
    pairs = sleep_pairs(records)
    first = datetime.strptime(records[0]['date'], '%Y-%m-%d') if records else None
    current, updated = None, None
    for i, r in enumerate(records):
        if datetime.strptime(r['date'], '%Y-%m-%d').weekday() == UPDATE_WEEKDAY:
            ba = weekly_value(records, i, profile, pairs, first)
            if ba is not None and (ba['status'] == 'ok' or current is None or current['status'] != 'ok'):
                current, updated = ba, r['date']
        if current is None:
            age = profile.get('chronological_age')
            r['bio_age'] = None if age is None else dict(_calibrating(age, [], _recoveries(records, i)), updated=None)
        else:
            r['bio_age'] = dict(current, updated=updated)
