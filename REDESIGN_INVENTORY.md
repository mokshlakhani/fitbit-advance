# Redesign inventory

Checklist for the dark, mobile-first reskin (branch `redesign-dark`). Every element below must still be present and working afterwards.

☑ checked on screen at 390 px (demo data, Standard and Performance; sheets in the web build).  
◐ restyled and present in the code, but its state couldn't be triggered here (needs a signed-in phone, a sync in progress, an app-logged workout or a failure). Worth a look on the phone.

Before/after screenshots: `docs/redesign/before/` and `docs/redesign/after/` (demo data, fictional person).

## Stack and styling

- **Stack:** plain web (HTML, CSS, vanilla JS), no framework. One codebase serves the desktop dashboard (`serve.py`) and both phone builds (`mobile/build.mjs` copies `index.html`, `styles.css`, `app.js`, `icons.js`, then adds `mobile/src/mobile.css` and `mobile.js` for the web app and the Android/Capacitor app).
- **Styling:** `styles.css` (custom properties in `:root`, plus many hard-coded colours and sizes), `mobile/src/mobile.css`, and inline `style=""` / SVG colours generated in `app.js` and `mobile.js`.
- **Theme:** dark only (`color-scheme: dark`). There's no theme toggle. The only toggle is Standard/Performance mode, which changes content, not theme.
- **Icons:** Phosphor (`icons.js`). Metric icons use the duotone weight, controls the regular one.

## Global chrome

| Element | Where | Done |
|---|---|---|
| Top bar (sticky, frosted) | `index.html .bar` | ☑ |
| Brand mark + "DataStrap" (desktop; replaced by the feedback button on phones) | `.brand` | ☑ |
| Date pill: previous day, date button (opens native date picker), next day, disabled at the ends | `.date-nav`, `#datePicker` | ☑ |
| Avatar initials (desktop, hidden in demo and on phones) | `#avatar` | ☑ |
| Phone: feedback button (left, only when feedback is configured) | `mobile.js .feedback-btn` | ☑ |
| Phone: sync button with status dot (signed out amber, error red, spinning while syncing) | `mobile.js .sync-btn` | ☑ |
| Sample-data banner | `#demoBanner` | ☑ |
| Footer (days analysed and date span, or "Sample data") | `#foot` | ☑ |
| Mood glow at the top of the page (follows recovery tier) | `body::before` | ☑ |
| Grain overlay (desktop only) | `body::after` | ☑ |
| Bottom tab bar: Standard = Today, Sleep, Activity, Heart. Performance = Today, Recovery, Sleep, Strain, Heart. Sliding highlight pill, drag-along-the-bar to switch, pop animation | `renderTabbar`, `.tabbar`, `.tab-ind` | ☑ |
| Chart tooltip (hover/scrub) | `#tooltip` | ☑ |
| Toast | `.toast` | ◐ |
| Pull to refresh indicator (phone) | `mobile.js .m-ptr` | ◐ |
| Page transitions (View Transitions, slide forward/back), reveal-on-scroll, count-up numbers, ring sweeps | `styles.css`, `observeReveals`, `animateNumbers` | ☑ |
| Mode switch takeover animations (Performance ECG line; Standard breathing orb) | `.mode-takeover` | ◐ |
| Reduced motion respected | `@media (prefers-reduced-motion)` | ☑ |

## Today (home), `#/`

| Element | Mode | Done |
|---|---|---|
| Day strip: every day, swipeable, weekday/month label, date, mini ring (steps in Standard, recovery in Performance), selected day highlighted, edge "falling" effect | both | ☑ |
| Standard / Performance segmented switch | both | ☑ |
| Rings card: three concentric rings + legend rows (Recovery, Sleep score with "Est." tag, Steps in Standard or Strain in Performance), each row opens its page | both | ☑ |
| Insight card: date, headline, explanation, chips (Aim for X strain [Perf], Slept, Steps), sparkle icon | both | ☑ |
| My Day panel: avg bpm, legend (heart rate range, sleep, workouts count), 24 h heart-rate chart with sleep/workout bands, resting-HR dashed line, NOW marker, scrub tooltips. Empty state "No heart rate recorded" | both | ☑ |
| Section "Key metrics": Std = Avg heart rate, Resting HR, HRV, Blood oxygen. Perf = Body age, VO₂ max, HRV, Resting HR, Breathing rate, Blood oxygen, Skin temp, Stress, Avg heart rate | both | ☑ |
| Section "Sleep": Time asleep (wide card, stage strip + stage legend), Score (Est. tag), Efficiency | both | ☑ |
| Section "Activity": Steps, Energy, Strain [Perf], Zone minutes, Workouts card (rows or "No workouts logged.") | both | ☑ |
| Metric card anatomy: icon chip (animated "living" icon), label, Est. tag, chevron (desktop hover), value + unit, delta vs usual (good/poor coloured, arrow), 7-day sparkline (line or bars), "No data" / "No score for this night" empty text | both | ☑ |
| Body age card: "X younger/older than your age" or "Calibrating" | Perf | ☑ |
| Section "Trends": Strain & Recovery 14-day combo chart (recovery bars by tier, strain line), legend, note | Perf | ☑ |
| Log + floating button (only when the host can log) | both | ☑ |

## Metric pages, `#/m/<key>/<range>`

Shared shell for all 17 metrics (recovery, steps, energy, strain, zones, sleep, sleepScore, efficiency, rhr, hrv, hr, stress, temp, spo2, resp, vo2, bioAge):

| Element | Done |
|---|---|
| Back button (label = Today / date, icon-only on phones) | ☑ |
| Title with living icon chip | ☑ |
| Range segmented control: Day, Week, Month, 3 Months (3M on phones), sliding thumb | ☑ |
| Period navigator: previous / label / next, disabled at data ends | ☑ |
| Headline: label, big value + unit, note (good/poor coloured), empty text (No data / No score / Calibrating) | ☑ |
| Stat tiles (2×2 on phones) | ☑ |
| Footnote (`m.note`) | ☑ |

Day views, by metric:

| Metric | Day content | Done |
|---|---|---|
| Steps, Energy | Hourly bar chart; tiles: most active hour, active hours, usual, goal / 30-day high | ☑ |
| Strain, Zone minutes | Time-in-zone bars (Light/Moderate/Vigorous/Peak); tiles | ☑ |
| Heart rate | 10-min line + area with resting baseline; then full-resolution day envelope chart with tap-to-zoom hour, hour zoom panel, "Show hourly breakdown" disclosure with hour rows [Perf]; zone panel [Perf]; tiles; loading note | ☑ |
| Time asleep | Hypnogram (4 stage rows), stage legend with %; tiles: in bed, efficiency, short of 8h, sleep score | ☑ |
| Recovery | Std: one-line tip + note. Perf: driver rows (title, sub, centred ± meter, points) + note; calibrating / waiting empty states | ☑ |
| Sleep score | Perf: driver rows + note + last-7-days line chart (hollow dots = estimates). Std: headline only | ☑ |
| Body age | Updated note, driver rows with ± bars, levers rows, 90-day trend line; calibrating empty state; tiles: body age, your age, pace, biggest lever | ☑ |
| VO₂ max | Range gauge + last 7 days; tiles: for your age, fitness age, usual, 30-day high | ☑ |
| Other nightly metrics (RHR, HRV, stress, temp, SpO₂, breathing, efficiency) | Range gauge ("Usual a – b") + last-7-days line with normal band; tiles: usual, normal range, 30-day low/high | ☑ |

Week / Month / 3 Months views: bar or line chart (goal line, normal band, selected day, tap a bar/point to open that day), "Select a bar…" note, comparison note vs previous period, tiles (total / days logged, lowest, highest, best day / normal range).

Strain / Activity pages also have the **Workouts panel**: that day's workouts and up to 8 recent ones, or "No workouts on this day."

**Performance-only page in Standard** (strain, stress, skin temp, breathing, body age, VO₂ max): back, title, "part of Performance mode" text, "Switch to Performance" button.

## Workout page, `#/w/<date>/<i>`

| Element | Mode | Done |
|---|---|---|
| Back (to Strain / Activity), title with activity icon | both | ☑ |
| When line, one-sentence summary | both | ☑ |
| Big stats: Strain (accent tile) [Perf], Duration, Calories, Average HR, Peak HR | both | ☑ |
| Heart-rate chart coloured by zone, zone threshold lines, peak dot, zone legend, explanatory note | Perf | ☑ |
| Time in each zone panel (bars + bpm ranges) | Perf | ☑ |
| Extra tiles: HR recovery 1/2 min [Perf], distance, pace, steps, elevation, Active Zone Minutes | both | ☑ |
| Compared with your last N sessions: comparison tiles + past workout rows | both | ☑ |
| Edit (secondary pill) and Delete (two-tap, armed state) for app-logged workouts; note otherwise | both (host only) | ◐ |

## Sheets and modals

| Element | Done |
|---|---|
| **Log / Edit activity sheet**: grabber, close, title, activity search box with icon, Suggested / Similar / Matching chips, date, start time, duration + quick-duration chips, "Optional information" disclosure (calories, distance), error, note, Save (disabled until an activity is picked, "Saving…") | ☑ |
| **Sync sheet** (phone ↻): status with spinner, error, note, Sync now / Sign in with Google; View (mode switch + note); Fitbit app sleep score form (date, score, Save) + count; Units select; About you (sex) select; VO₂ max Takeout import button + count; Sign out | ☑ |
| **Feedback sheet**: kind segmented radios (3), message textarea, contact input, status, Send | ☑ |
| **One-question sheet** (sex): Male / Female / Skip | ◐ |

## Phone-only full screens and states

| Element | Done |
|---|---|
| Connect your Fitbit (title, note, Sign in with Google, error, iPhone "Add to Home Screen" hint) | ☑ |
| First download (spinner ring, message, note, error, Try again, skeleton shimmer cards) | ◐ |
| Page error ("Couldn't show this page", Send report, technical detail) | ◐ |
| Couldn't load any data (desktop, no data files) | ◐ |

## Notes: elements that don't map cleanly

- **Header greeting.** The reference's "Hello, Name." lives in the top bar on Today only (your choice): "Hello," then the first name from the Google profile, or just "Hello." when there's no name (demo data). The bar sticks by its date row, so the greeting scrolls away and fades while the date pill stays. No bell: DataStrap has no notifications for it to open. The avatar's green dot shows on the desktop dashboard; on phones that slot has always been the sync button, which keeps its amber/rose status dot.
- **My Day → Day timeline.** The heart-rate chart stays (it's the data). The same sleep and workout bands are now also listed under it as timeline rows: dot, name, time range, Completed / In progress (periwinkle) / Upcoming, each opening its page. The chart's "NOW" marker became the reference's inverted time pill.
- **Palette.** UI and cards use the five accents. Recovery tiers map to green / amber / rose. Blood oxygen moved from the Body cyan to amber, as the brief asks. Heart-rate zones, sleep stages, strain (blue) and body (cyan) keep their own hues, re-tuned to the same pastel family.
- **Metric card arrow.** The desktop-only hover chevron became the reference's ↗, shown on every card that opens a page. Workouts and other non-link cards don't get one.
- **Icons.** Phosphor's two-tone weight became the thin regular weight everywhere; the small "living" icon animations are unchanged.
- **Glows.** On Today: the rings card (recovery colour), the first key metric and Time asleep. On metric pages: the main panel, in the metric's colour. On the workout page: the strain tile.
- **Desktop dashboard.** Same code, so it gets the same look, with a 4-column grid, the brand mark top right and the avatar.

Already like this before the redesign (not changed, reskin only):

- VO₂ max day view: the range gauge's "usual" band can run past the panel edges when the normal range is wider than the 30-day min/max (`rangeGauge`).
- Sleep score page with demo data: "typically within ±undefined" (the demo's `sleep_score_model` has no `mae`).
- Headless screenshots show the day strip scrolled to an earlier week; in a real browser it centres on the selected day as before.
