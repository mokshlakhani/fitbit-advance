"""Seed history for the Android app from this computer's data.

Runs the desktop pipeline (process_fitbit_openstrap.build_dataset) and saves
the exact inputs it hands to assemble(): every per-day source, the profile and
the Fitbit app sleep scores. The app merges its own Google Health downloads
over this, so it starts with the full history, including Takeout-only data such
as VO2max that the API doesn't provide.

    python make_seed.py OUT.json [EXPECTED.json]

EXPECTED.json (optional) receives the pipeline's own output, for the parity test.
The seed holds personal health data: it goes into mobile/www/, which is gitignored.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import process_fitbit_openstrap as pipeline
import sleep_score

out_path = sys.argv[1]
expected_path = sys.argv[2] if len(sys.argv) > 2 else None
real_assemble = pipeline.assemble


def capture(src, profile, labels_path):
    result = real_assemble(src, profile, labels_path)
    with open(out_path, 'w') as fh:
        json.dump({'src': src, 'profile': profile, 'labels': sleep_score.load_labels(labels_path)}, fh,
                  default=str, separators=(',', ':'))
    if expected_path:
        with open(expected_path, 'w') as fh:
            json.dump(result, fh)
    raise SystemExit(0)


pipeline.assemble = capture
pipeline.build_dataset()
