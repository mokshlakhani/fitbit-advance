"""Daily update: download the last week of data and rebuild the dashboard.

setup.py schedules this to run every morning; it never opens a browser. If the
Google sign-in has expired it logs that and exits, and running setup.py again
reconnects.
"""
import os
import subprocess
import sys
from datetime import datetime

import google_health_sync

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    print(f'=== {datetime.now():%Y-%m-%d %H:%M:%S} ===', flush=True)
    try:
        google_health_sync.sync(7, interactive=False)
    except google_health_sync.NotConnected as e:
        print(f'Not connected: {e}')
        return 2
    result = subprocess.run([sys.executable, os.path.join(HERE, 'process_fitbit_openstrap.py')], cwd=HERE)
    print('OK' if result.returncode == 0 else f'Build failed ({result.returncode})', flush=True)
    return result.returncode


if __name__ == '__main__':
    sys.exit(main())
