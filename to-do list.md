# To-do list

## Now

### Let other people sign in (Google Cloud Console)
- [ ] **Create a Desktop sign-in client.** APIs & Services → Credentials → Create credentials → OAuth client ID → application type **Desktop app**. Download the JSON file, save it in this folder as `oauth_client.json`, and ask Claude to commit and push it. Until then, `python3 setup.py` stops at the sign-in step for everyone else.
- [ ] **Publish the app.** Google Auth Platform → Audience → make sure it's **In production**, not Testing. In Testing, only listed test users can sign in and their sign-in expires every 7 days.
- [ ] **Add the settings permission.** Google Auth Platform → Data Access → add `googlehealth.settings.readonly` (lets the dashboard read each user's time zone and units).
- [ ] **Rename the app to DataStrap** (optional). Google Auth Platform → Branding. It currently shows "personal-dashboard" on the sign-in screen. Don't use "Fitbit" or "Google" in the name, or Google rejects it.

### On your Mac
- [ ] **Stop the old dashboard server.** `python3 -m http.server 8088` shares the whole folder, including your Google sign-in tokens, with any device on your Wi-Fi. Stop it (Ctrl+C in its terminal) and open the dashboard with `python3 serve.py` instead.
- [ ] **Sign in again once** after adding the settings permission, so your own dashboard gets it too:
  ```bash
  cd ~/fitbit-advance && python3 google_health_sync.py --auth
  ```
- [ ] **Check the temperature unit** after signing in again. The dashboard will follow the unit set in your Fitbit app; switch it there to °F if it shows °C.

### GitHub
- [ ] **Decide on the repo name.** It's still `fitbit-advance`. Claude can rename it to `datastrap`; GitHub redirects the old link automatically.

## Future Things

### Keep the sleep score accurate
- [ ] Every week or two, add scores from the Fitbit app to `app_sleep_scores.csv` (`date,score`, using the date you woke up). Then run `python3 sleep_score.py` to see the accuracy. More nights make the estimate closer to the app.
- [ ] Once you have about 60+ nights of app scores, ask Claude to re-check the formula, including whether the 7-hour cap on credited sleep still fits your data.

### Data and backups
- [ ] **Download a new Google Takeout export every few months.** It's the only source of VO₂ max (fitness age) and older history. Unzip it so the `Google Health` folder sits at `takeout/Google Health/` in this folder.
- [ ] **Back up your data outside git.** `FitbitAir Data/`, `api_data/`, `app_sleep_scores.csv` and `profile.json` aren't on GitHub (on purpose). Copy them to iCloud Drive or an external drive now and then.

### Keep the daily update running
- [ ] Glance at `logs/daily_sync.log` occasionally. Every successful run ends with `OK`. If it says **Not connected**, run `python3 setup.py` to sign in again.
- [ ] Keep the project folder outside Desktop, Documents and Downloads; macOS blocks background jobs there.
- [ ] The update runs at 10:00. If your Mac is asleep, it runs when it wakes; if it's shut down, that day is skipped and caught up the next day.

### If DataStrap gets popular
- [ ] Google allows at most **100 users** on an unverified app. To go beyond that, and to remove the "unverified app" warning, apply for **Google verification**. It needs a privacy policy, a homepage, and possibly a security assessment, because health data is sensitive.
- [ ] Watch the GitHub repo for issues and questions from users.

### Ideas from the original roadmap
- [ ] Automatically import a new Takeout zip when one is dropped into the folder or Downloads.
- [ ] Weekly or monthly reports (PDF or a summary page).
- [ ] Daily scheduling for Windows (currently macOS and Linux only).
