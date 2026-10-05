#!/usr/bin/env python3
"""One-command setup for the OpenStrap dashboard.

    python3 setup.py

1. Creates a private Python environment (.venv) and installs dependencies.
2. Opens Google sign-in so the dashboard can read your Fitbit data. You only
   click "Allow"; your data goes straight from Google to this computer.
3. Downloads your profile and the last 90 days of data.
4. Builds the dashboard.
5. Schedules a daily update at 10:00 (macOS and Linux).
6. Opens the dashboard in your browser.

Safe to run again at any time: finished steps are skipped or refreshed.
"""
import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import textwrap
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
VENV = os.path.join(HERE, '.venv')
WINDOWS = platform.system() == 'Windows'


def step(n, text):
    print(f'\n[{n}/6] {text}', flush=True)


def venv_python():
    return os.path.join(VENV, 'Scripts', 'python.exe') if WINDOWS else os.path.join(VENV, 'bin', 'python')


def in_venv():
    return os.path.realpath(sys.prefix) == os.path.realpath(VENV)


def ensure_environment(args):
    """Re-run this script inside .venv with the dependencies installed."""
    if sys.version_info < (3, 9):
        sys.exit('Python 3.9 or newer is required. Install it from https://www.python.org/downloads/')
    if in_venv():
        return
    step(1, 'Preparing a private Python environment')
    py = venv_python()
    if not os.path.exists(py):
        subprocess.check_call([sys.executable, '-m', 'venv', VENV])
    have = subprocess.run([py, '-c', 'import numpy, pandas, scipy'], capture_output=True).returncode == 0
    if not have:
        print('  Installing numpy, pandas and scipy (first run only)...', flush=True)
        subprocess.check_call([py, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check',
                               '-r', os.path.join(HERE, 'requirements.txt')])
    else:
        print('  Already set up.')
    os.execv(py, [py, os.path.abspath(__file__), '--in-venv'] + [a for a in sys.argv[1:] if a != '--in-venv'])


def connect_and_profile():
    import google_health_sync as g
    import profile_store
    step(2, 'Connecting to Google Health')
    try:
        tokens = g.get_valid_tokens(interactive=True)
    except g.NotConnected as e:
        sys.exit(f'  {e}\n  Run python3 setup.py again to retry.')
    profile = g.sync_profile(tokens['access_token'])
    print(f"  Connected{' as ' + profile['name'] if profile.get('name') else ''}.")
    if not profile.get('sex') and sys.stdin.isatty():
        # The training-load formula has separate coefficients for men and women;
        # Google Health doesn't share this, so ask once.
        answer = input('  Sex, used only for the training-load formula (m/f, or Enter to skip): ').strip().lower()
        if answer[:1] in ('m', 'f'):
            profile_store.save({'sex': 'male' if answer[0] == 'm' else 'female'})


def download(days):
    import google_health_sync as g
    step(3, f'Downloading the last {days} days (a few minutes the first time)')
    g.sync(days, interactive=True, log=lambda line: print('  ' + line, flush=True))


def build():
    step(4, 'Building your dashboard')
    subprocess.check_call([sys.executable, os.path.join(HERE, 'process_fitbit_openstrap.py')], cwd=HERE)


def schedule():
    step(5, 'Scheduling a daily update at 10:00')
    job = [sys.executable, os.path.join(HERE, 'daily_sync.py')]
    os.makedirs(os.path.join(HERE, 'logs'), exist_ok=True)
    log = os.path.join(HERE, 'logs', 'daily_sync.log')
    tag = hashlib.sha1(HERE.encode()).hexdigest()[:8]
    system = platform.system()

    if system == 'Darwin':
        home = os.path.expanduser('~')
        protected = [os.path.join(home, d) for d in ('Desktop', 'Documents', 'Downloads')]
        if any(HERE == p or HERE.startswith(p + os.sep) for p in protected):
            print(textwrap.indent(textwrap.dedent(f'''\
                Skipped: macOS doesn't let background jobs read files in Desktop, Documents or
                Downloads. Move this folder (e.g. to {os.path.join(home, os.path.basename(HERE))})
                and run setup.py again, or update by hand with: python3 daily_sync.py'''), '  '))
            return
        label = f'com.openstrap.dashboard.{tag}'
        plist = os.path.join(home, 'Library', 'LaunchAgents', f'{label}.plist')
        args_xml = ''.join(f'<string>{escape(a)}</string>' for a in job)
        with open(plist, 'w') as fh:
            fh.write(f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key><array>{args_xml}</array>
  <key>WorkingDirectory</key><string>{escape(HERE)}</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>{escape(log)}</string>
  <key>StandardErrorPath</key><string>{escape(log)}</string>
</dict>
</plist>
''')
        domain = f'gui/{os.getuid()}'
        subprocess.run(['launchctl', 'bootout', f'{domain}/{label}'], capture_output=True)
        subprocess.run(['launchctl', 'bootstrap', domain, plist], check=True)
        print(f'  Done. Log: {os.path.relpath(log, HERE)}')
    elif system == 'Linux' and shutil.which('crontab'):
        marker = f'# openstrap-dashboard {tag}'
        line = f'0 10 * * * cd "{HERE}" && "{job[0]}" "{job[1]}" >> "{log}" 2>&1 {marker}'
        current = subprocess.run(['crontab', '-l'], capture_output=True, text=True).stdout
        lines = [l for l in current.splitlines() if marker not in l] + [line]
        subprocess.run(['crontab', '-'], input='\n'.join(lines) + '\n', text=True, check=True)
        print(f'  Done (cron). Log: {os.path.relpath(log, HERE)}')
    else:
        print('  Automatic scheduling isn\'t set up on this system. To update, run: python3 daily_sync.py')
        if WINDOWS:
            print(f'  Or schedule it with: schtasks /create /tn OpenStrap /sc daily /st 10:00 /tr "\\"{job[0]}\\" \\"{job[1]}\\""')


def open_dashboard():
    import serve
    step(6, 'Opening your dashboard')
    serve.serve()


def main():
    ap = argparse.ArgumentParser(description='Set up the OpenStrap dashboard.')
    ap.add_argument('--days', type=int, default=90, help='days of history to download (default 90)')
    ap.add_argument('--no-schedule', action='store_true', help="don't schedule the daily update")
    ap.add_argument('--no-open', action='store_true', help="don't start the dashboard at the end")
    ap.add_argument('--schedule-only', action='store_true', help='only (re)create the daily update schedule')
    ap.add_argument('--in-venv', action='store_true', help=argparse.SUPPRESS)
    args = ap.parse_args()

    os.chdir(HERE)
    ensure_environment(args)
    sys.path.insert(0, HERE)
    if args.schedule_only:
        schedule()
        return
    connect_and_profile()
    download(args.days)
    build()
    if not args.no_schedule:
        schedule()
    if not args.no_open:
        open_dashboard()
    else:
        print('\nAll set. Open the dashboard any time with: python3 serve.py')


if __name__ == '__main__':
    main()
