"""Synthetic cases for the parity test: several ages and sexes, 200 days (covers body age pace)."""
import json
import os
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))
import numpy as np
import make_demo_data as demo
import process_fitbit_openstrap as pipeline

cases = []
for k, (age, sex, h, w) in enumerate([(22, 'male', 180.0, 74.0), (22, 'female', 165.0, 50.0), (45, None, 172.0, 95.0)]):
    demo.rng = np.random.default_rng(100 + k)
    src = demo.build_src(200, end=date(2026, 9, 30))
    profile = dict(demo.PROFILE, chronological_age=age, sex=sex, height_cm=h, weight_kg=w,
                   bmi=round(w / (h / 100) ** 2, 2), max_hr=round(208 - 0.7 * age), zone_max_hr=220 - age)
    out = pipeline.assemble(src, profile, os.path.join(HERE, 'none.csv'))
    cases.append({'src': src, 'profile': profile, 'expected': out})
with open(os.path.join(sys.argv[1], 'synthetic.json'), 'w') as fh:
    json.dump(cases, fh)
