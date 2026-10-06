# DataStrap for phones

Two versions built from the same code:

- **Web app**, for iPhone and anyone else: a website you add to your home screen. It's published to GitHub Pages and installs from a link. See [Web app](#web-app).
- **Android app**: a native APK, for personal builds that bundle your history from the computer.

Both run entirely on the phone: they sign in to Google there, download from the Google Health API, and work out recovery, strain, sleep and body age themselves. Neither needs a computer once installed.

## How it works

| Piece | What it does |
|---|---|
| `../index.html`, `../app.js`, `../styles.css` | The same dashboard as the desktop, copied into the app at build time |
| `src/engine.js` | The analytics from `process_fitbit_openstrap.py` and `sleep_score.py`, in JavaScript |
| `src/ingest.js` | `api_ingest.py` in JavaScript: API data to per-day values |
| `src/google.js` | Downloads from the Google Health API (port of `google_health_sync.sync`) |
| `src/store.js` | Keeps everything in the app's private storage (IndexedDB) |
| `src/mobile.js` | Sign-in, syncing, and the sync sheet (the ↻ button) |
| `src/webauth.js` | Google sign-in for the web app (browser redirect) |
| `src/takeout.js` | Reads VO₂ max from a Google Takeout zip (web app) |
| `android/…/GoogleHealthAuthPlugin.java` | Google sign-in through Google Play services |

The app syncs when it opens, when you return to it, and every 5 minutes while it's open. Heart rate is downloaded at full resolution, like the desktop.

**Parity:** `npm test` runs the desktop pipeline and the JavaScript port on the same data and compares every value. Both must report 0 differences.

## Seed history (optional)

`node build.mjs` bundles `seed.json` into the app when this computer has the desktop setup: every day the desktop pipeline knows about, including Takeout-only data such as VO₂ max. The app layers its own downloads on top. Use `node build.mjs --no-seed` for an app that starts empty and downloads 90 days.

`seed.json` is personal health data. It lives only in `www/` and the APK, which are both gitignored. Don't share an APK built with it.

## Build

You need Node 20+ and Android Studio (for its Java runtime and the Android SDK).

```bash
cd mobile
npm install
npm run sync
cd android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

To install it on a phone with USB debugging on:

```bash
~/Library/Android/sdk/platform-tools/adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## Google sign-in setup (once)

Google only issues tokens to an Android app it knows about. In the Google Cloud project that has the Google Health API enabled:

1. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Choose **Android** as the application type.
3. Enter the package name `app.datastrap.personal`.
4. Enter the SHA-1 of the key that signs the APK. For debug builds:
   ```bash
   keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android | grep SHA1
   ```
5. No client ID goes into the app. Google matches the package name and signature.

The app uses the same scopes as the desktop sync.

## Web app

### Install (iPhone)

1. Open the link in **Safari**.
2. Tap **Share**, then **Add to Home Screen**, then open DataStrap from the home screen.
3. Tap **Sign in with Google**. Google shows an "unverified app" warning; tap **Advanced → Go to …** and allow access.
4. The first sync downloads 90 days of summaries, steps and calories, and the 14 most recent days of heart rate. Older heart-rate days fill in over the next few syncs.
5. Optional: ↻ → **Import from Takeout**, then choose a Google Takeout Fitbit export (.zip). This adds VO₂ max and fitness age.

On Android, Chrome offers **Install app** from its menu.

### How sign-in works

The web app uses Google's browser sign-in (redirect, no popup). Google gives browser apps tokens that last an hour and no long-lived refresh token. When a token runs out, the app sends you to Google and straight back with no screen, which shows as a brief reload.

### Build and publish

```bash
cd mobile
node build.mjs --web        # → web/
```

Pushing to `main` publishes it with `.github/workflows/web-app.yml`. GitHub Pages must be set to **GitHub Actions** (Settings → Pages → Source).

The web app needs a **Web application** OAuth client in the Google Cloud project, with:

- **Authorized JavaScript origins**: `https://<user>.github.io` and `http://localhost:8092` (local testing)
- **Authorized redirect URIs**: the site's address with a trailing slash, e.g. `https://<user>.github.io/<repo>/`, and `http://localhost:8092/`

Put its client ID in `web.config.json`. A browser client ID isn't a secret, so it's committed.
