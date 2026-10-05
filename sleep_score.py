"""Sleep score: the Fitbit app's score where recorded, an estimate elsewhere.

Google's Health API doesn't provide Fitbit's sleep score, and none of the three
scores in a Takeout export match the number the Fitbit app shows. So this:

1. reads scores copied from the app into app_sleep_scores.csv,
2. fits  score = b0 + b1·hours asleep + b2·(REM min / 30) + b3·(deep min / 30)
                    + b4·ln(1 + awake min)
   by least squares with b1..b3 >= 0 and b4 <= 0 (more sleep can't lower the
   score and more time awake can't raise it; the log term makes the first
   minutes awake cost the most), and
3. gives each night the app's score if one was recorded, else the estimate.

Two safeguards keep the straight-line fit from extrapolating: each input is
limited to the range seen in the app scores it was fitted to, and time asleep
earns credit only up to 7 hours (app scores plateau beyond that; on held-out
nights this matched the app slightly better than no cap or an 8-hour cap).

Only nights staged by Fitbit's current algorithm are estimated: the Google
Health API, or the export's sleep_session_v2 sessions. Takeout's sleep JSON
uses older staging (about 36 min less deep and 20 min more awake for the same
night), which would bias the estimate low.

Run `python3 sleep_score.py` for a leave-one-out accuracy report.
"""
import csv
import json
import math
import os

import numpy as np
from scipy.optimize import lsq_linear

LABELS_FILE = 'app_sleep_scores.csv'
CURRENT_STAGING = {'api', 'takeout-v2'}
MIN_SLEEP_MIN = 120   # the shortest night Fitbit has scored was 142 min
MIN_LABELS = 15       # with fewer app scores than this, use DEFAULT_MODEL
ASLEEP_CAP_MIN = 420  # time asleep beyond 7 h earns no extra credit

TERMS = [
    ('asleep', 'Time asleep'),
    ('rem', 'REM sleep'),
    ('deep', 'Deep sleep'),
    ('awake', 'Time awake'),
]
LOWER = [-np.inf, 0, 0, 0, -np.inf]
UPPER = [np.inf, np.inf, np.inf, np.inf, 0]
# Fitted to 31 app scores (Sep 1 – Oct 4 2026); only used if the labels file
# has fewer than MIN_LABELS usable nights.
DEFAULT_MODEL = {
    'coef': [34.21, 5.03, 2.80, 2.43, -2.63],
    'range': {'asleep': (204, 491), 'rem': (34, 116), 'deep': (58, 107), 'awake': (0, 90)},
}


def night_features(sleep):
    """Minutes asleep, REM, deep and awake for a night that can be estimated, else None."""
    if not sleep or sleep.get('stage_source') not in CURRENT_STAGING:
        return None
    asleep = sleep.get('duration_minutes')
    if asleep is None or asleep < MIN_SLEEP_MIN:
        return None
    # Classic (unstaged) nights have no REM or deep to measure.
    if not {h.get('stage') for h in sleep.get('hypnogram') or []} & {'light', 'deep', 'rem'}:
        return None
    feats = {'asleep': asleep, 'rem': sleep.get('rem_min'), 'deep': sleep.get('deep_min'), 'awake': sleep.get('wake_min')}
    if any(v is None for v in feats.values()):
        return None
    return {k: float(v) for k, v in feats.items()}


def _bounded(f, rng):
    return {k: min(max(f[k], rng[k][0]), rng[k][1]) for k, _ in TERMS}


def _terms(coef, f, rng):
    """Each term's contribution to the score (intercept excluded)."""
    v = _bounded(f, rng)
    return {
        'asleep': coef[1] * min(v['asleep'], ASLEEP_CAP_MIN) / 60,
        'rem': coef[2] * v['rem'] / 30,
        'deep': coef[3] * v['deep'] / 30,
        'awake': coef[4] * math.log1p(v['awake']),
    }


def _design_row(f, rng):
    unit = [1.0, 1.0, 1.0, 1.0, 1.0]
    t = _terms(unit, f, rng)
    return [1.0, t['asleep'], t['rem'], t['deep'], t['awake']]


def fit(features, scores):
    rng = {k: (min(f[k] for f in features), max(f[k] for f in features)) for k, _ in TERMS}
    X = np.array([_design_row(f, rng) for f in features])
    coef = lsq_linear(X, np.asarray(scores, dtype=float), bounds=(LOWER, UPPER)).x.tolist()
    return {'coef': coef, 'range': rng}


def predict(model, f):
    return model['coef'][0] + sum(_terms(model['coef'], f, model['range']).values())


def to_score(value):
    return int(round(min(100.0, max(0.0, value))))


def load_labels(path):
    """{'YYYY-MM-DD': score} from the labels CSV; lines starting with # are notes."""
    labels = {}
    if not os.path.exists(path):
        return labels
    with open(path, newline='') as fh:
        lines = [ln for ln in fh if ln.strip() and not ln.lstrip().startswith('#')]
    for row in csv.DictReader(lines):
        try:
            labels[row['date'].strip()] = float(row['score'])
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    return labels


def leave_one_out(features, scores):
    """Error for each night when predicted by a model fitted to all the others."""
    errors = []
    for i in range(len(scores)):
        model = fit(features[:i] + features[i + 1:], scores[:i] + scores[i + 1:])
        errors.append(predict(model, features[i]) - scores[i])
    return errors


def drivers(model, f, typical):
    """Points each term adds or removes compared with a typical night."""
    mine = _terms(model['coef'], f, model['range'])
    usual = _terms(model['coef'], typical, model['range'])
    return [{
        'key': key,
        'label': label,
        'minutes': round(f[key]),
        'typical_minutes': round(typical[key]),
        'points': round(mine[key] - usual[key], 1),
    } for key, label in TERMS]


def apply(records, labels_path):
    """Fill each record's sleep score fields in place and return a model summary."""
    labels = load_labels(labels_path)
    feats = {r['date']: night_features(r['sleep']) for r in records}
    train = [(feats[d], s) for d, s in sorted(labels.items()) if feats.get(d)]

    summary = {'labels': len(labels), 'training_nights': len(train), 'min_sleep_minutes': MIN_SLEEP_MIN,
               'asleep_cap_minutes': ASLEEP_CAP_MIN}
    if len(train) >= MIN_LABELS:
        F, y = [t[0] for t in train], [t[1] for t in train]
        model = fit(F, y)
        errors = np.abs(leave_one_out(F, y))
        summary.update(method='fit', mae=round(float(errors.mean()), 1),
                       within3=round(float((errors <= 3).mean() * 100)),
                       within5=round(float((errors <= 5).mean() * 100)),
                       max_error=round(float(errors.max()), 1))
    else:
        model = {'coef': list(DEFAULT_MODEL['coef']), 'range': dict(DEFAULT_MODEL['range'])}
        summary['method'] = 'default'

    usable = [f for f in feats.values() if f]
    typical = {k: float(np.median([f[k] for f in usable])) for k, _ in TERMS} if usable else None
    coef = model['coef']
    summary.update(
        coefficients={'intercept': round(coef[0], 2), 'per_hour_asleep': round(coef[1], 2),
                      'per_30_min_rem': round(coef[2], 2), 'per_30_min_deep': round(coef[3], 2),
                      'per_ln_awake_minute': round(coef[4], 2)},
        learned_range={k: [round(lo), round(hi)] for k, (lo, hi) in model['range'].items()},
        typical_night={k: round(v) for k, v in typical.items()} if typical else None,
        typical_score=to_score(predict(model, typical)) if typical else None,
    )

    app_nights = estimated = 0
    for r in records:
        sleep = r['sleep']
        f = feats[r['date']]
        sleep['score_estimate'] = to_score(predict(model, f)) if f else None
        sleep['score_drivers'] = drivers(model, f, typical) if f and typical else []
        if r['date'] in labels:
            sleep['score'] = int(round(labels[r['date']]))
            sleep['score_source'] = 'app'
            app_nights += 1
        elif sleep['score_estimate'] is not None:
            sleep['score'] = sleep['score_estimate']
            sleep['score_source'] = 'estimate'
            estimated += 1
        else:
            sleep['score'] = None
            sleep['score_source'] = None
    summary.update(app_nights=app_nights, estimated_nights=estimated)
    return summary


def report(data_path, labels_path):
    """Print leave-one-out accuracy against the recorded app scores."""
    with open(data_path) as fh:
        records = json.load(fh)['days']
    labels = load_labels(labels_path)
    feats = {r['date']: night_features(r['sleep']) for r in records}
    rows = [(d, feats[d], s) for d, s in sorted(labels.items()) if feats.get(d)]
    skipped = sorted(d for d in labels if not feats.get(d))
    if len(rows) < 3:
        print(f'Only {len(rows)} app scores have estimable nights; nothing to evaluate.')
        return
    dates = [r[0] for r in rows]
    F = [r[1] for r in rows]
    y = [r[2] for r in rows]
    errors = np.array(leave_one_out(F, y))
    baseline = np.abs(np.array(y) - np.mean(y))
    print(f'{len(rows)} nights with an app score ({len(skipped)} skipped: {", ".join(skipped) or "none"})')
    print(f'Leave-one-out error: average {np.abs(errors).mean():.2f}, '
          f'within ±3 {np.mean(np.abs(errors) <= 3) * 100:.0f}%, within ±5 {np.mean(np.abs(errors) <= 5) * 100:.0f}%, '
          f'worst {np.abs(errors).max():.1f}  (always guessing the average: {baseline.mean():.2f})')
    model = fit(F, y)
    print('Weights: ' + ', '.join(f'{n} {c:+.2f}' for n, c in zip(
        ['intercept', 'per hour asleep (up to 7 h)', 'per 30 min REM', 'per 30 min deep', 'per ln(1+awake min)'], model['coef'])))
    print('Learned range: ' + ', '.join(f'{k} {lo:.0f}–{hi:.0f} min' for k, (lo, hi) in model['range'].items()))
    print(f'\n{"night":12s} {"app":>4s} {"est":>5s} {"err":>5s}  asleep  REM  deep  awake')
    for d, f, s, e in zip(dates, F, y, errors):
        print(f'{d:12s} {s:4.0f} {s + e:5.1f} {e:+5.1f}  {f["asleep"]:6.0f} {f["rem"]:4.0f} {f["deep"]:5.0f} {f["awake"]:6.0f}')


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    report(os.path.join(here, 'dashboard_data.json'), os.path.join(here, LABELS_FILE))
