"""The user's profile and local time zone, shared by sync, pipeline and setup.

profile.json is written by setup.py / google_health_sync.py from the user's
Google Health profile and settings (age, height, weight, time zone,
temperature unit). The API has no display name; add "name" by hand if wanted. Sex isn't available from the API, so setup asks for it once.
Nothing personal is hard-coded anywhere else.
"""
import json
import os
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    ZoneInfo = None

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
PROFILE_FILE = os.path.join(PROJECT_DIR, 'profile.json')

DEFAULTS = {
    'name': None,
    'age': None,
    'sex': None,             # 'male' | 'female' | None
    'height_cm': None,
    'weight_kg': None,
    'timezone': None,        # IANA name, e.g. 'Europe/London'
    'temperature_unit': None,  # 'CELSIUS' | 'FAHRENHEIT'
}


def load():
    data = dict(DEFAULTS)
    if os.path.exists(PROFILE_FILE):
        with open(PROFILE_FILE) as fh:
            data.update({k: v for k, v in json.load(fh).items() if v is not None})
    return data


def save(updates):
    data = load()
    data.update({k: v for k, v in updates.items() if v is not None})
    with open(PROFILE_FILE, 'w') as fh:
        json.dump(data, fh, indent=2)
    return data


def dashboard_profile():
    """Profile fields the dashboard and analytics use, with derived values."""
    p = load()
    age = p.get('age')
    h, w = p.get('height_cm'), p.get('weight_kg')
    return {
        'name': p.get('name') or '',
        'chronological_age': age,
        'sex': p.get('sex'),
        'height_cm': h,
        'weight_kg': w,
        'bmi': round(w / ((h / 100.0) ** 2), 2) if h and w else None,
        # Tanaka formula; 190 bpm if age is unknown. Used for strain.
        'max_hr': round(208 - 0.7 * age) if age else 190,
        # Heart-rate zones use Fitbit's 220 - age, so they match the Fitbit app.
        'zone_max_hr': 220 - age if age else 190,
        'timezone': timezone_name(),
        'temperature_unit': p.get('temperature_unit') or 'CELSIUS',
    }


def _system_timezone():
    # macOS and most Linux distributions link /etc/localtime into the zoneinfo tree.
    try:
        target = os.path.realpath('/etc/localtime')
        if 'zoneinfo/' in target:
            return target.split('zoneinfo/', 1)[1]
    except OSError:
        pass
    return os.environ.get('TZ') or None


def timezone_name():
    return load().get('timezone') or _system_timezone() or 'UTC'


def local_tz():
    """tzinfo for the user's time zone (DST-aware when zoneinfo is available)."""
    name = timezone_name()
    if ZoneInfo is not None:
        try:
            return ZoneInfo(name)
        except Exception:
            pass
    return datetime.now(timezone.utc).astimezone().tzinfo


def utc_to_local(dt_utc_naive):
    """Naive UTC datetime -> naive local datetime in the user's time zone."""
    return dt_utc_naive.replace(tzinfo=timezone.utc).astimezone(local_tz()).replace(tzinfo=None)
