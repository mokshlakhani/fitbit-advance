"""Dump api_ingest.py's loader outputs to JSON for the JS ingest parity test."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import api_ingest
import profile_store

steps, cal, hs, hc = api_ingest.load_steps_and_calories()
out = {
    'tz': profile_store.timezone_name(),
    'hrv': api_ingest.load_hrv(), 'temp': api_ingest.load_temperature(), 'spo2': api_ingest.load_spo2(),
    'rhr': api_ingest.load_resting_hr(), 'intraday_hr': api_ingest.load_intraday_hr(),
    'workouts': api_ingest.load_workouts(), 'steps': steps, 'cal': cal, 'hourly_steps': hs, 'hourly_cals': hc,
    'resp': api_ingest.load_respiratory_rate(), 'sleep': api_ingest.load_sleep_data(),
}
import process_fitbit_openstrap as pipeline
out['workout_hr'] = api_ingest.load_workout_samples(out['workouts'], pipeline.select_workout_samples, pipeline._workout_windows)
with open(os.path.join(sys.argv[1], 'api_expected.json'), 'w') as fh:
    json.dump(out, fh)
