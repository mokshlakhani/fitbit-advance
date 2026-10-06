# Body age: design

Status: **implemented** in `body_age.py` and `mobile/src/engine.js` ("Body age"), with a parity test covering real and synthetic data. This document specifies how DataStrap would compute a "body age" from Fitbit data, including for users aged 18–30.

## 1. What it is and isn't

- **It is** a physiological age: how your fitness, heart, activity, sleep and body size compare with people of your age and sex, expressed in years of age-related mortality risk. It follows the same approach WHOOP describes for WHOOP Age: published mortality effects, weighted, with overlap removed.
- **It isn't** a clinical or molecular biological age. PhenoAge needs blood tests and epigenetic clocks need DNA. It has not been validated against ageing outcomes, so it's always shown as an estimate with a range and its drivers.

## 2. Core idea

Mortality from age-related disease rises exponentially with age (the Gompertz law): about 9% a year, doubling roughly every 8 years. A risk factor that multiplies that risk by *r* is therefore worth the same as being

> years = ln(r) / γ,  with γ = ln 2 / 8 ≈ 0.087 per year

older, or younger if *r* < 1. This is the "rate advancement period" ([Spiegelhalter 2016, BMC Med Inform Decis Mak](https://link.springer.com/article/10.1186/s12911-016-0342-z)).

### Why this works at 18–30

Under 30, total mortality is mostly accidents and other external causes, and it's nearly flat with age, so it can't be converted into years. The Gompertz–Makeham model splits mortality into:

- a **constant background** term (accidents, infection), and
- an **exponential ageing** term (heart disease, cancer, diabetes), which is tiny at 20 but grows at the same ~8–10% per year at every adult age.

The habits and physiology measured here act on the ageing term, and the conversion only needs that term's **growth rate**, not its level. So `ln(r)/γ` is valid at 20 as long as *r* is the effect on age-related risk.

### Peer-relative, not ideal-relative

Each driver compares **you with a typical person of your age and sex**, not with an ideal:

> years_i = τ_i · o_i · [ ln r_i(your value) − ln r_i(peer value) ] / γ
>
> body age = chronological age + Σ years_i (then bounded, §6)

so a perfectly typical person scores exactly their own age.

- **τ_i (transfer factor):** how confident we are that an effect measured mostly in older adults applies at the user's age. It's 1.0 where there is evidence from young people, otherwise 0.7 under 30 and 1.0 from 30.
- **o_i (overlap factor):** discounts metrics that measure the same thing (§5).

## 3. Drivers

All effects are on all-cause mortality. "Window" is the trailing period averaged; "Min" is the minimum data needed before a driver counts.

| Driver | Your value from | Effect (source) | Peer value | τ (<30) | Window / Min |
|---|---|---|---|---|---|
| **VO₂ max** | Fitbit cardio fitness (Takeout or phone import), last value ≤ 30 days old | Per 1 MET (3.5 ml/kg/min) higher: HR **0.85** men, **0.92** women ([Nes et al. 2014, MSSE, HUNT](https://pubmed.ncbi.nlm.nih.gov/24576863/)) | HUNT mean for age and sex ([Loe et al. 2013](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0064319)): men 20–29 = 54.4, women 43.0 (already in `VO2_NORMS`) | **1.0** (young evidence: fittest vs least-fit fifth at age 18, HR 0.49 over 29 years, n = 1.3M; [Högström et al. 2016, IJE](https://scholar.google.com/scholar_lookup?doi=10.1093/ije/dyv321&amp=&pmid=26686843)) | latest / 1 |
| **Resting HR** | Nightly resting HR | Per 10 bpm higher: RR **1.12** (1.07–1.17), linear from 45 bpm ([Zhang et al. 2016, CMAJ, 1.25M people](https://www.cmaj.ca/content/188/3/E53)) | NHANES 1999–2008 median for age and sex ([Ostchega et al. 2011, NHSR 41](https://www.cdc.gov/nchs/data/nhsr/nhsr041.pdf)); 20–39: men ≈ 68, women ≈ 74 bpm (interquartile ranges 61–76 and 66–82) | 0.7 | 90 d / 14 nights |
| **Daily steps** | Daily steps, today excluded | Per 1,000 steps: RR **0.85**, counted from 4,000 up to 10,000 (no extra benefit beyond 10,000 under 60) ([Banach et al. 2023, EJPC](https://academic.oup.com/eurjpc/article/30/18/e88/7264789); [Paluch et al. 2022, Lancet Public Health](https://www.researchgate.net/publication/359050623_Daily_steps_and_all-cause_mortality_a_meta-analysis_of_15_international_cohorts)) | Fitbit users aged 18–39 in All of Us (n = 4,556): median **men 8,300, women 7,100** steps/day; 7,600 if sex unknown ([Zheng et al. 2026, Nat Commun](https://pmc.ncbi.nlm.nih.gov/articles/PMC13234009/)). From 40: the All of Us overall median, 7,700 ([Master et al. 2022, Nat Med](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9671804/)), until age-specific values are added | 0.7 | 90 d / 14 days |
| **Zone minutes** | Weekly guideline-equivalent minutes = moderate + 2 × (vigorous + peak), from the day's heart-rate zones | Against inactive: <1× the 150 min/week guideline **0.80**, 1–2× **0.69**, 2–3× **0.63**, 3–5× **0.61**, flat beyond ([Arem et al. 2015, JAMA IM](https://jamanetwork.com/journals/jamainternalmedicine/fullarticle/2212267)); interpolated on the log scale | **0.5× guideline (75 min/week)**: only 25.7% of 18–29-year-old Fitbit users in All of Us meet the guideline, so the typical peer is well below it ([Singh et al. 2024, JMIR](https://pmc.ncbi.nlm.nih.gov/articles/PMC11668988/)). That study counted Fitbit's movement-based active minutes rather than heart-rate zone minutes, so this is an approximation (§9) | 0.7 | 90 d / 2 weeks |
| **Strength training** | Weekly minutes of workouts named weights, machines, strength, lifting or similar | Any: RR **0.85** (0.79–0.93); best at 30–60 min/week, benefit fading above ~130–140 min/week ([Momma et al. 2022, BJSM](https://www.researchgate.net/publication/358938786_Muscle-strengthening_activities_are_associated_with_lower_risk_and_mortality_in_major_non-communicable_diseases_a_systematic_review_and_meta-analysis_of_cohort_studies)) | 0 min/week | 0.7 | 90 d / 2 weeks |
| **Sleep duration** | Main-sleep time asleep | Short: RR **1.12**; long: RR **1.30** ([Cappuccio et al. 2010, SLEEP, 1.38M people](https://www.semanticscholar.org/paper/Sleep-duration-and-all-cause-mortality:-a-review-of-Cappuccio-D%E2%80%99elia/26bcac1fa60a9b5eaa5be0843fdc1bb7737c7a79)). Model: 7–8 h = 1.0; full short effect at ≤ 6 h, linear 6–7 h; long effect at half weight (illness confounding), full at ≥ 9 h, linear 8–9 h | 7–8 h | 0.7 | 90 d / 14 nights |
| **Sleep regularity (SRI)** | Sleep Regularity Index from sleep sessions: chance of being in the same state (asleep or awake) at two times 24 h apart, scaled −100 to 100 | Against the median SRI of 61: SRI 41 → HR **1.53** (1.41–1.66), SRI 75 → **0.90** (0.81–1.00); log-linear between and flat outside ([Cribb et al. 2023, UK Biobank, n ≈ 89k](https://pmc.ncbi.nlm.nih.gov/articles/PMC10666928/)); regularity predicts more strongly than duration ([Windred et al. 2024, SLEEP](https://academic.oup.com/sleep/article/47/1/zsad253/7280269)) | 61 (UK Biobank median; adults 40–79, so young adults may sit lower) | 0.7 | 90 d / 14 consecutive day pairs |
| **BMI** | Weight and height | Never-smokers without disease, against 22.5–25: 15–18.5 **1.51**, 18.5–20 **1.13**, 20–25 **1.00**, 25–27.5 **1.07**, 27.5–30 **1.20**, 30–35 **1.45**, 35–40 **1.94** ([Global BMI Mortality Collaboration 2016, Lancet](https://www.thelancet.com/article/S0140-6736(16)30175-1/fulltext)); interpolated between category midpoints | 22.5–25 (HR 1.0) | 0.7 × **0.5** confidence (BMI can't tell muscle from fat, and DataStrap has no lean-mass input like WHOOP's) | latest weight / 1 |

Notes:

- **What's left out.** HRV and nightly stress are left out of body age because there's no reliable age-mortality conversion for wrist RMSSD. They stay in recovery. Daily strain is left out because it's a load measure, not a long-term exposure.
- **SRI computation.** Mark each minute asleep if it falls in any recorded sleep session (main sleep and naps), compare every minute with the same minute 24 h later over the window, and SRI = 200 × P(same) − 100. Nights with no sleep recorded are excluded rather than counted as awake all night.

## 4. Per-driver uncertainty

Each driver gets a standard deviation in years:

- **Effect uncertainty:** SE(ln r) = (ln upper CI − ln lower CI) / 3.92, scaled by the distance from the peer value.
- **Transfer uncertainty:** (1 − τ_i) × |years_i|.
- **Measurement uncertainty:** VO₂ max ± 3.5 ml/kg/min (consumer estimate error); resting HR ± 2 bpm; the others are negligible over 90 days.

σ_i = √(effect² + transfer² + measurement²). Total σ = √(Σ σ_i² + σ_model²), with σ_model = **3 years under 30** and **2 years from 30** (combining published effects has its own error). It's shown as "±σ" rounded to whole years, and never below ±2.

## 5. Overlap between drivers

The studies mostly adjust for some covariates but not each other, so related drivers would double-count. Within a group, the drivers' years are summed and then multiplied by the group factor; groups are added together.

| Group | Drivers | Factor | Reason |
|---|---|---|---|
| Fitness | VO₂ max, resting HR | resting HR × **0.6** (VO₂ max × 1.0) | Resting HR is an input to fitness estimates and its effect weakens once fitness is accounted for; VO₂ max has the stronger, young-adult evidence |
| Activity | Steps, zone minutes, strength | sum × **0.5** | They overlap heavily with each other and with VO₂ max |
| Sleep | Duration, regularity | sum × **0.8** | Regularity stayed predictive after adjusting for duration |
| Body | BMI | (confidence factor only) | |

These factors are judgement calls, disclosed in the app's "how it works" text and kept as named constants.

## 6. Bounds and display rules

- **Cap:** total years within ±8 under 30 and ±10 from 30 (Garmin caps its "achievable" fitness age at −10).
- **Floor: 17.** A body age never shows below 17.0.
- **Format:** one decimal place, e.g. "Body age 23.4 ± 3", with the difference shown as "−2.6 years".
- **Range:** the ± is rounded to whole years (the estimate isn't more precise than that).
- **Minimum to show:** at least 3 drivers with enough data, including VO₂ max or resting HR. Otherwise it shows "Calibrating" and lists what's missing.
- **Driver list:** every driver shows your value, the peer value, its years (+/−), the source in one line, and whether it was discounted for overlap or young age.

## 7. Pace of aging

Following WHOOP (recent 30 days against a long-term average):

> change = BA₃₀ − BA₁₈₀ (unbounded body-age deltas)
>
> pace = 1.0 if |change| < 0.3 years, otherwise 1 + change / Δt

- BA₃₀ is body age computed over the last 30 days and BA₁₈₀ over the last 180 (or all data if less, minimum 90 days of history).
- Δt is the time between the two windows' midpoints, (180 − 30) / 2 days = 0.205 years.
- It's clipped to −1.0× to 3.0×, and the change in years is shown next to it.

**Why the 0.3-year dead band:** on synthetic people whose habits don't change, the 30-day and 180-day body ages still differ by 0.12–0.23 years (standard deviation) from noise alone. Without the dead band that turns into pace swings of about ±1×. Changes smaller than about twice the noise therefore read as "Steady".

## 8. Where it lives in the app

- **Today:** a "Body age" card in Key metrics: big number, ± range, pace, and the top driver ("strongest lever: sleep").
- **Detail page** (tab: Heart or a new Body section):
  - headline, range and pace
  - the driver list with years
  - a body-age trend line (monthly)
  - **"What would move it"**: years gained if each driver reached a sensible target, e.g. steps 10,000/day, sleep 7–8 h, SRI 75, 150 zone minutes a week, resting HR −5 bpm
  - the method and sources
- **VO₂ max page:** keeps fitness age and the percentile as they are now.

### Implementation outline (for later)

- `process_fitbit_openstrap.py` → `body_age(records, profile, as_of)`, with a JS twin in `mobile/src/engine.js`; parity test extended. Output per day goes in `body_age: {value, delta, sigma, pace, drivers[], status}`.
- Constants (effects, peer tables, factors, bounds) live in one table in each language, mirroring this document.
- Tests:
  - a typical peer scores exactly their own age;
  - each driver moves in the right direction;
  - bounds and floor;
  - missing-data rules;
  - synthetic personas from `make_demo_data.py`.

## 9. Decisions and remaining caveats

Decided:

- Floor **17**, values shown to **one decimal place**.
- **BMI kept at half weight** until there's a lean-mass or body-fat input.
- Peer step and activity values come from **Fitbit users aged 18–39** (All of Us), not from older accelerometer studies, so they're measured on the same kind of device.

Caveats to keep in the "how it works" text:

- The zone-minutes peer value is based on Fitbit's movement-based "active minutes", while DataStrap counts heart-rate zones (like Active Zone Minutes). They're related but not identical.
- The sleep-regularity peer value (SRI 61) comes from UK Biobank adults aged 40–79. Young adults are likely less regular, so a young user scores slightly worse than they would against true peers.
- Peer values from age 40 need their own age-specific sources before older users are supported fully.

A worked example on real data is kept out of the repository (`docs/*.local.md`, gitignored) because it contains personal health data.
