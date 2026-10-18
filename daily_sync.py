"""Daily update: download the last week of data and rebuild the dashboard.

setup.py schedules this to run every morning; it never opens a browser. If the
Google sign-in has expired it logs that and exits, and running setup.py again
reconnects. Network problems (common right after the computer wakes) are
retried a few times, and the dashboard is rebuilt from what's there either way.
"""
import os
import subprocess
import sys
import time
from datetime import datetime

import google_health_sync
import private_files

HERE = os.path.dirname(os.path.abspath(__file__))
RETRY_WAITS_S = [60, 300, 900]


def main():
    print(f'=== {datetime.now():%Y-%m-%d %H:%M:%S} ===', flush=True)
    private_files.lock_down()
    for wait in RETRY_WAITS_S + [None]:
        try:
            google_health_sync.sync(7, interactive=False)
            break
        except google_health_sync.NotConnected as e:
            print(f'Not connected: {e}')
            return 2
        except OSError as e:  # no network yet, timeouts, resets
            if wait is None:
                print(f'Sync failed ({e}); rebuilding from the data already downloaded.', flush=True)
                break
            print(f'Network problem ({e}); trying again in {wait // 60} min.', flush=True)
            time.sleep(wait)
    result = subprocess.run([sys.executable, os.path.join(HERE, 'process_fitbit_openstrap.py')], cwd=HERE)
    print('OK' if result.returncode == 0 else f'Build failed ({result.returncode})', flush=True)
    return result.returncode


if __name__ == '__main__':
    sys.exit(main())
