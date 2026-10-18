"""Keeps the personal files in this folder readable by this user only.

Health data is stored as plain files (api_data/, dashboard_data.json, takeout/),
so the computer's disk encryption (FileVault on a Mac) is what protects them at
rest. This module makes sure other accounts on the computer can't read them,
keeps the data that can be downloaded again out of Time Machine, and reports
whether disk encryption is on, here and on Time Machine backup disks.
"""
import os
import plistlib
import stat
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PRIVATE = ['profile.json', 'google_tokens.json', 'credentials.json', 'fitbit_tokens.json', 'fitbit_config.json',
           'api_data', 'dashboard_data.json', 'app_sleep_scores.csv', 'takeout', 'logs']
# Downloaded again or rebuilt by the next sync, so backups don't need a copy.
NO_BACKUP = ['api_data', 'dashboard_data.json', 'logs']


def _chmod(path, mode):
    try:
        st = os.lstat(path)
        if not stat.S_ISLNK(st.st_mode) and stat.S_IMODE(st.st_mode) != mode and st.st_uid == os.getuid():
            os.chmod(path, mode)
    except (OSError, AttributeError):  # AttributeError: os.getuid on Windows
        pass


def lock_down():
    """New files are owner-only from now on; existing personal files are made so."""
    os.umask(0o077)
    for name in PRIVATE:
        path = os.path.join(HERE, name)
        if os.path.isdir(path) and not os.path.islink(path):
            _chmod(path, 0o700)
            for root, dirs, files in os.walk(path):
                for d in dirs:
                    _chmod(os.path.join(root, d), 0o700)
                for f in files:
                    _chmod(os.path.join(root, f), 0o600)
        elif os.path.isfile(path):
            _chmod(path, 0o600)
    if sys.platform == 'darwin':
        for name in NO_BACKUP:
            path = os.path.join(HERE, name)
            if os.path.exists(path):
                subprocess.run(['tmutil', 'addexclusion', path], capture_output=True)


def disk_encrypted():
    """True / False on a Mac (FileVault), None where it can't be told."""
    if sys.platform != 'darwin':
        return None
    try:
        out = subprocess.run(['fdesetup', 'status'], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return 'FileVault is On' in out if out else None


def unencrypted_backups():
    """Names of connected Time Machine disks that aren't encrypted (Mac only)."""
    if sys.platform != 'darwin':
        return []
    try:
        out = subprocess.run(['tmutil', 'destinationinfo', '-X'], capture_output=True, timeout=10).stdout
        dests = plistlib.loads(out).get('Destinations', []) if out else []
    except Exception:
        return []
    names = []
    for d in dests:
        mount = d.get('MountPoint')
        if not mount:
            continue  # not connected now; can't tell
        try:
            info = plistlib.loads(subprocess.run(['diskutil', 'info', '-plist', mount], capture_output=True, timeout=10).stdout)
        except Exception:
            continue
        if not (info.get('FileVault') or info.get('Encryption')):
            names.append(d.get('Name') or mount)
    return names
