# CLAUDE.md — Project knowledge base

## 1. Overview
**OpenStrap** is a self-hosted dashboard for Fitbit data. It downloads a user's data from the Google Health API (optionally plus a Google Takeout export), applies analytics ported from the open-source **OpenStrap** library (`OpenStrap/analytics-main/lib`), and serves a dark-mode dashboard on the user's own computer. No personal data is committed: everything personal lives in git-ignored files.

Metrics: recovery (0–100, with driver breakdown), day strain (0–21, Banister TRIMP), sleep (stages, efficiency, estimated sleep score), heart (resting HR, HRV, intraday HR, stress index), body (skin temperature, SpO₂, breathing rate, VO₂ max, fitness age), workouts.

## 2. Files
```
setup.py                     # One-command setup: .venv, Google sign-in, download, build, schedule, open
serve.py                     # Serves the dashboard on 127.0.0.1 only, whitelisted files only
daily_sync.py                # Scheduled daily job: sync last 7 days + rebuild (never opens a browser)
google_health_sync.py        # Google sign-in (desktop OAuth: loopback + PKCE), profile, data download → api_data/
api_ingest.py                # Loaders for api_data/, keyed by the user's local date
process_fitbit_openstrap.py  # Pipeline: load (Takeout + API) → assemble() analytics → dashboard_data.json
sleep_score.py               # Sleep score estimate (§4.E); `python3 sleep_score.py` prints its accuracy
profile_store.py             # profile.json (name, age, sex, height, weight, time zone, units)
make_demo_data.py            # Generates demo_data.json (fictional person) through assemble()
index.html, styles.css, app.js  # Dashboard (home + per-metric Day/Week/Month/3-month pages, SVG charts)
demo_data.json               # Shown until the user connects
oauth_client.json            # Shared Google OAuth client (Desktop app type) used by setup.py
app_sleep_scores.example.csv # Template for app_sleep_scores.csv
OpenStrap/                   # OpenStrap analytics library (MIT), reference implementation
```
Git-ignored, per user: `profile.json`, `google_tokens.json`, `credentials.json` (optional own OAuth client, takes precedence over `oauth_client.json`), `api_data/`, `dashboard_data.json`, `app_sleep_scores.csv`, `takeout/` (optional Takeout export, `takeout/Google Health/…`), `.venv/`, `logs/`.

## 3. Profile and time
- `profile_store.py` holds name, age, height, weight, time zone and temperature unit, filled from the Google Health `profile` and `settings` endpoints and the latest `weight`/`height` data points on every sync. Sex isn't exposed by the API; `setup.py` asks once (optional).
- All timestamps are converted with the user's IANA time zone (DST-aware). Days are keyed by local date; a night's sleep belongs to the local wake-up date.
- Max HR uses Tanaka (208 − 0.7·age), 190 if age is unknown.

## 4. Analytics

### A. Recovery (`wellness/readiness_composite.dart`)
- Robust z-score of each vital against its trailing 14 days: `z = (v − median) / (1.4826·MAD)` (std fallback).
- Weights/signs: HRV 0.40 (+), resting HR 0.30 (−), breathing rate 0.20 (−), skin temperature 0.10 (−); renormalised over the vitals present.
- `composite_z = Σ wᵢ·signᵢ·zᵢ / Σ wᵢ`, score = logistic mapping. Tiers: ≥67 optimal (strain 14–18), 34–66 adequate (10–14), <34 low (<10). Driver contributions are shown.

### B. Strain (`clinical/load_trimp.dart`)
- `HRR = clamp((HR − RHR)/(HRmax − RHR), 0, 1)`; TRIMP = Σ minutes HRR·a·e^(b·HRR) with Banister coefficients (men a=0.64, b=1.92; women a=0.86, b=1.67; midpoint if unknown).
- Strain = 21·ln(1 + TRIMP)/ln(7201).

### C. Fitness age
- Expected VO₂max for age ≈ 54.4 − 0.38·age; fitness age shifts with the difference (and resting HR). Not shown without VO₂max and age. VO₂max is carried forward between measurements (the API has none; it comes from Takeout).

### D. Sleep
- Main sleep per night, from least to most preferred: Takeout `sleep-*.json` (older staging) → Takeout `Health Fitness Data_GoogleData/UserSleeps` + `UserSleepStages` v2 sessions → Google Health API. Each night records `stage_source` (`takeout-legacy`, `takeout-v2`, `api`).
- Fitbit runs two staging algorithms side by side (`sleep_session_v1`, `v2`). The API returns v2; the export's v2 sessions match it within ~2 min per stage. Takeout's sleep JSON uses older staging (~36 min less deep, ~20 min more awake for the same night), so it's only a fallback.
- The API sometimes flags another app's session (e.g. Samsung Health via Health Connect) as `mainSleep`; ingest falls back to the night's longest Fitbit session.

### E. Sleep score estimate (`sleep_score.py`)
- Google's API doesn't provide Fitbit's sleep score, and none of the Takeout scores (v1, v2, `Sleep Score/sleep_score.csv`) match the Fitbit app. Naps aren't scored; only the main sleep.
- Model: `score = b0 + b1·hours asleep (credited up to 7 h) + b2·REM/30 min + b3·deep/30 min + b4·ln(1 + awake min)`, least squares with b1–b3 ≥ 0, b4 ≤ 0, inputs limited to the range seen in the training scores. Refit on every build from `app_sleep_scores.csv` (≥15 nights), else `DEFAULT_MODEL`.
- Reference accuracy (one user, 31 app scores, leave-one-out): ±3.0 points on average, 74% within ±5; under-scores the best nights by ~3.
- Not estimated: unstaged ("classic") nights, nights under 2 h, `takeout-legacy` nights.

## 5. Gotchas
- **Google Cloud OAuth brand rejected**: app names can't contain "Fitbit"/"Google"; leave domain/privacy-policy fields blank for testing.
- **Shared OAuth client**: must be a *Desktop app* client (any loopback port allowed). The consent screen must be **In production** for other users (Testing mode only admits listed test users and expires refresh tokens after 7 days). Unverified apps show a warning and are capped at 100 users.
- **macOS background jobs** can't read ~/Desktop, ~/Documents or ~/Downloads; `setup.py` skips scheduling there and explains why.
- **Health Connect duplicates**: the sync requests `dataSourceFamily=google-sources` to exclude other apps (Samsung Health double-counted steps and added conflicting SpO₂). Sleep can't be source-filtered at the API, so it's filtered in `api_ingest`.
- **Takeout timestamps** are UTC; files are UTC days.

## 6. Run
```bash
python3 setup.py          # first run, or to reconnect
python3 serve.py          # open the dashboard
python3 daily_sync.py     # update by hand
python3 sleep_score.py    # sleep score estimate accuracy
python3 make_demo_data.py # regenerate demo_data.json
```
