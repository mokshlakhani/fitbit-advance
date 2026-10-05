# DataStrap

A private health dashboard for your Fitbit. It runs on your own computer, pulls your data from Google Health every morning, and shows recovery, strain, sleep, heart and body metrics, each with day, week, month and 3-month views.

Your data never leaves your computer. There's no account to create and no server in between: the data goes straight from Google to a folder on your machine.

## Quick start

You need **Python 3.9+** and a Fitbit that syncs to the Fitbit app.

```bash
git clone https://github.com/mokshlakhani/fitbit-advance.git
cd fitbit-advance
python3 setup.py
```

That one command:

1. sets up a private Python environment for the project,
2. opens Google sign-in in your browser (you click **Allow**; that's the only step),
3. downloads your last 90 days,
4. builds your dashboard,
5. schedules a daily update at 10:00 (macOS and Linux), and
6. opens the dashboard.

Until you connect, the dashboard shows sample data for a fictional person.

> **About the "Google hasn't verified this app" screen:** this project's Google sign-in hasn't been through Google's verification review. Choose **Advanced**, then **Go to …** (the app name) to continue. The app only requests read-only access to your health data, and nothing is sent anywhere except your own computer.

### After setup

```bash
python3 serve.py        # open the dashboard
python3 daily_sync.py   # update now instead of waiting for 10:00
python3 setup.py        # reconnect if Google sign-in expires
```

On macOS, keep the folder outside Desktop, Documents and Downloads (for example in your home folder), so the daily update is allowed to run.

## What you get

- **Recovery (0–100):** today's HRV, resting heart rate, breathing rate and skin temperature against your previous 14 days, with exactly which ones moved the score.
- **Strain (0–21):** cardiovascular load from your minute-by-minute heart rate (Banister TRIMP), plus time in heart rate zones.
- **Sleep:** stages through the night, efficiency, time short of 8 hours, and an estimated sleep score (see below).
- **Heart and body:** resting heart rate, HRV, heart rate through the day, stress index, skin temperature, blood oxygen, breathing rate, VO₂ max and fitness age.
- **Every metric** opens a detail page with calendar day, week, month and 3-month views.

### Sleep score

Google's Health API doesn't provide Fitbit's sleep score, so the dashboard estimates it from time asleep, REM, deep sleep and time awake. To make the estimate match your Fitbit app more closely, copy `app_sleep_scores.example.csv` to `app_sleep_scores.csv` and add scores from the app (15+ nights works well). Those nights then show the app's own score, and every other night is calibrated against them. `python3 sleep_score.py` reports the accuracy.

### Older history (optional)

The API covers recent data. For older history, request a [Google Takeout](https://takeout.google.com) export of your Fitbit data, unzip it, and put the `Google Health` folder in a `takeout/` folder here (`takeout/Google Health/…`). The next build picks it up; VO₂ max currently comes only from Takeout.

## Privacy

- Sign-in tokens, your profile, downloaded data and the built dashboard all stay in this folder and are git-ignored.
- `serve.py` only serves the dashboard's own files, and only to this computer.
- To disconnect, delete `google_tokens.json` and remove the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Using your own Google Cloud project

By default sign-in uses this project's shared Google client (`oauth_client.json`). To use your own instead, create a **Desktop app** OAuth client in a Google Cloud project with the Google Health API enabled, download it as `credentials.json` into this folder, and run `python3 setup.py`. Your own client always takes precedence.

## Credits

Analytics are ported from [OpenStrap](OpenStrap/analytics-main) (MIT). Not affiliated with Google or Fitbit.
