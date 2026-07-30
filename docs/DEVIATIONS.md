# Deviations from the Technical Profile

The submitted technical profile (*Marine-AI by SOLMATE*, National AI Hackathon
2026, Blue Economy / Clean Energy track) is the specification this repository is
judged against. This page lists every place the build departs from it, why, and
what the departure costs.

It exists because a judge will find these anyway. Finding them here, with the
reasoning attached, is a very different experience from finding them by reading
the source and discovering the paper overstated something.

Nothing below was changed to make the build easier. Each item was forced by a
verified fact about a dataset, an API, or a sensor — the check that produced it
is named in every case, and every check is reproducible.

**Status: reviewed against the submitted PDF on 2026-07-22.**

| # | Profile says | Build does | Class |
|---|---|---|---|
| 1 | Fuel burn learned end-to-end by XGBoost from RPM, torque, wind, current, load | Hybrid: physics for conditions→power, XGBoost for wear→fuel penalty | **Architecture** |
| 2 | "Public marine-diesel engine performance datasets" | UCI CBM, a **gas turbine**, as a documented proxy | **Data** |
| 3 | FEMTO/PRONOSTIA pretrains the anomaly detector | Dropped; the detector learns each vessel's own baseline (see "Still outstanding" G) | **Data** |
| 4 | RPM is a core fuel-model input | Not a feature — collinear with load | **Modelling** |
| 5 | TensorFlow Lite for edge inference | ONNX Runtime | Stack |
| 6 | TimescaleDB for time-series storage | SQLite voyage store today, behind a `VoyageStore` seam; Supabase Postgres intended | Stack |
| 7 | PAGASA and OpenWeather marine forecasts | Open-Meteo Marine | Stack |
| 8 | Sonar hardware for depth | Charted bathymetry intended; **not yet integrated** | Sensing |
| 9 | AIS receiver for traffic avoidance | Omitted | Sensing |
| 10 | (not in profile) | Sentinel-2 satellite basemap; Google/Bing/Esri rejected on licence | Data |
| 11 | Docker for edge deployment | Container at deploy; not used locally | Minor |
| 12 | Autoencoder + IsolationForest for Phase 1 anomaly detection | PCA linear autoencoder + robust z-score ensemble, pure numpy | **Modelling** |

---

## 1. The fuel model is a hybrid, not end-to-end XGBoost

**Profile (§3.1):** *"A XGBoost regression model trained to answer one question:
given RPM, torque, wind, current, and load, how many liters per hour will this
engine burn?"*

**Build:** two layers. Conditions and load → required shaft power is **physics**
(`services/speed/resistance.py`). Shaft power and engine condition → litres per
hour is a published diesel BSFC curve plus an **XGBoost** wear model
(`services/speed/fuel.py`, `services/speed/train.py`).

**Why.** No public dataset supports learning that function end-to-end. Verified
by direct inspection before any model was written: the anchor dataset is a
complete factorial grid of 9 lever positions × 51 compressor-decay × 26
turbine-decay states. Wind, current, wave height and passenger load **do not
vary in it at all** — not as weak signals, as constants.

A model trained on that data and presented as having learned wind and current
would be ignoring the inputs the product acts on, while reporting confidence on
them. The failure would be invisible. A mis-specified physics coefficient is
inspectable, and calibratable against the vessel's own fuel-flow meter.

**What it costs.** The environmental terms are theory-driven rather than
fitted, so they are only as good as their coefficients. Every coefficient is
named, sourced, and exposed for per-vessel calibration
(`calibrate_admiralty`). This is the honest trade and we think it is the better
one.

## 2. The anchor dataset is a gas turbine

**Profile (§4):** *"public marine-diesel engine performance datasets for the
fuel/RPM curve."*

**Build:** UCI *Condition Based Maintenance of Naval Propulsion Plants* — a
27 MW frigate **gas turbine**. We could not find a public marine-diesel dataset
pairing shaft torque, RPM and ground-truth fuel flow at usable resolution.

**Why this is survivable, and exactly how far the proxy is trusted.** Only the
**dimensionless wear penalty** is taken from it. Not the fuel level, and — the
important part — **not the part-load curve either.**

Measured, not assumed: the turbine burns ~**7×** its best-point specific fuel
consumption at 10% load. A marine diesel burns ~**1.5×**. Borrowing the
turbine's part-load shape would have overstated the savings from slowing down by
roughly **five times, in our own favour**. So healthy burn comes from published
diesel part-load data, and the dataset answers only the question it uniquely
can: *at the same shaft load, how much more does a worn engine burn than a
healthy one?* — a question whose **form** is prime-mover-agnostic, sampled here
across 1,326 wear states, validated against wear states held out of training.

There is a regression test pinning the diesel curve inside published part-load
bands specifically so it can never drift back toward the turbine's.

## 3. FEMTO/PRONOSTIA was dropped

**Profile (§3.1, §4):** named alongside NASA C-MAPSS as Phase 1 pretraining.

**Build:** neither dataset pretrains the detector. C-MAPSS is downloaded and
registered (`data/registry.py`) and was evaluated; the Phase 1 detector fits a
per-vessel baseline from that vessel's own telemetry instead. See "Still
outstanding" G — the profile's pretraining claim is unmet, and the dataset
citation must not be allowed to imply otherwise on a slide.

**Why.** FEMTO is bench-rig bearing vibration sampled at **25.6 kHz**. The
retrofit IMU in the profile's own parameter list logs at roughly **1 Hz** —
three to four orders of magnitude too slow to resolve bearing defect
frequencies. Pretraining on it would imply a diagnostic capability the specified
sensor physically cannot deliver.

Dropping it is a smaller error than keeping it. **`README.md` and `docs/DATA.md`
must not list FEMTO as a source.**

## 4. Shaft RPM is not a fuel-model feature

**Profile (§3.2):** *"Engine RPM sensor — core input to the fuel-consumption
model."*

**Build:** not a feature. In the training data, RPM varies by **0.01 rpm** within
a lever position — it is a relabelling of load, not an independent predictor.
Including it would add a feature that looks informative and carries nothing.

RPM is still ingested, still displayed, and still the unit the recommendation is
delivered in (`SpeedRecommendation.recommended_rpm`) — a captain sets a throttle,
not a kilowatt. It is the *model input* that changed, not the interface.

## 5. ONNX Runtime instead of TensorFlow Lite

**Profile (§3.1 Tools):** TensorFlow Lite for edge inference.

**Build:** ONNX Runtime, and it is **in use, not planned**. The trained model
is exported by `services/speed/train.py` to `models/fuel_degradation.onnx`, and
that file is what the API loads — `services/speed/fuel.py` imports no xgboost.

TFLite targets TensorFlow graphs; exporting gradient-boosted trees through it
means a conversion no one should be debugging during a sprint. ONNX is the
native export path for both XGBoost and scikit-learn estimators, and runs on
the same class of edge hardware.

The decision earned its keep sooner than expected. Serving through xgboost
requires xgboost, scikit-learn, scipy and pandas — **358 MB of runtime for a
363 kB tree ensemble**. ONNX Runtime plus numpy is **85 MB**, which is what
lets the advisory API run as a serverless function inside a 500 MB limit
instead of needing a dedicated host. The same argument applies unchanged to a
control unit aboard a vessel.

The export is gated: the trainer refuses to write an ONNX file whose
predictions differ from the trained model by more than `1e-4`, so the deployed
model is provably the one the metrics describe. Observed drift is `1.5e-6`,
which is float32 rounding.

## 6. Supabase Postgres instead of TimescaleDB

**Profile (§3.1 Tools):** TimescaleDB.

**Build:** Supabase Postgres. Supabase *is* Postgres, so the SQL and the schema
are portable to Timescale later; what is lost is hypertable partitioning and
native continuous aggregates, neither of which matters at hackathon data
volumes. What is gained is a managed free tier, connection pooling, and a public
URL — and the submission requires a **publicly reachable** prototype.

Firebase and Convex were considered and rejected: training needs bulk SQL reads,
and Firestore free-tier read quotas would break a single training run.

## 7. Open-Meteo instead of PAGASA and OpenWeather

**Profile (§4):** *"API feeds: PAGASA and OpenWeather marine forecasts."*

**Build:** Open-Meteo Marine.

**PAGASA has no public programmatic API.** It publishes bulletins for human
readers. It is a stated future integration — appropriate for a Philippine
product and worth pursuing through a data-sharing agreement — but it is not a
working data source in this build and the profile should not have implied it was.

Open-Meteo is preferred over OpenWeather for the marine variables actually
needed: wave height, wave direction and ocean current are in its free tier and
behind OpenWeather's paid tier. It is CC BY 4.0 and needs no API key, so a judge
can clone and run without registering anywhere.

## 8. Charted bathymetry instead of sonar — and not yet built

**Profile (§2.1, §3.1):** sonar hardware supplies the depth safety constraint.

**Build:** charted depth from GEBCO is the intended substitute, forced by the
no-hardware declaration — there is no sonar transducer because there is no
vessel. Charted depth is not live: it misses uncharted obstructions and silting,
which is exactly why the profile specifies sonar for production. The constraint
would be real; the sensing is not.

**Status as of 2026-07-22: not integrated.** The depth constraint belongs to
Route Optimization, which is not built yet. GEBCO is therefore deliberately
*absent* from `data/registry.py`, so `data/download.py` refuses to fetch it and
no part of the repository can imply a bathymetry source is in use when it is
not. The chart the display draws is Natural Earth coastline only, extracted by
`data/build_chart.py`, and it carries its own scale caveat in the output file.

Recording an unbuilt thing as unbuilt is cheaper than being asked about it.

## 9. AIS is omitted

**Profile (§3.2):** AIS receiver, marked *recommended addition*, feeding traffic
avoidance in the MPC loop.

**Build:** omitted. No free live AIS feed covers Philippine coastal waters at
usable rates, and fabricating vessel traffic would make the collision-avoidance
constraint a demo of our own random number generator.

`RoutingFrame.nearby_vessel_count` exists in the contract and stays `None`, so
the field is reserved and the omission is visible in the data model rather than
hidden. It was a recommended addition, not baseline.

## 10. Satellite imagery: Sentinel-2, not Google

Not a deviation from the profile — the profile says nothing about basemaps — but
recorded here because it is the kind of decision a judge should be able to check.

The display shows **real satellite imagery of the Iloilo Strait**: Sentinel-2
cloudless 2020 by EOX, CC BY 4.0, containing modified Copernicus Sentinel data.
10 m ground resolution, no API key, attributed on screen as the licence requires.

**Google, Bing and Esri satellite tiles were considered and rejected.** Their
terms permit use only through their own APIs and forbid redistributing or
re-hosting imagery in another application; a screenshot of a web map is neither
licensed nor attributable. The brief grades "use only licensed or public
datasets", so a Google Maps capture is a scoring risk before it is anything
else. An earlier prototype used exactly that and it was removed.

The same imagery does double duty: `data/build_chart.py` classifies it into a
land/water mask, and the helm view ray-casts that mask to build its horizon. So
the shoreline under the vessel and the silhouette on the skyline come from one
source and cannot contradict each other.

Its limits are recorded in `data/registry.py`: it is imagery, not a chart. No
depth, no aids to navigation, and an annual composite showing no particular day.

## 11. Docker

**Profile (§3.1 Tools):** Docker for edge deployment.

Accurate for deployment — the API ships to Fly.io as a container. It is simply
not used for local development on the build machine. Listed only for
completeness.

## 12. Phase 1 anomaly detector: PCA + z-score, not a deep autoencoder or isolation forest

**Profile (§3.1):** the Phase 1 cold-start detector is described as an
**autoencoder plus IsolationForest** ensemble.

**Build:** the ensemble is a **PCA linear autoencoder** (reconstruction error in
the discarded principal directions) plus a **robust per-stream z-score**
(median/MAD). Both are pure numpy — `services/maintenance/`.

**Why.** Two forced reasons, in order.

1. **Serving size.** The advisory API serves from a deliberately minimal
   `numpy + onnxruntime` image — 85 MB, inside Vercel's 500 MB limit (see
   `requirements.txt`, and deviation §5 on why the fuel model went to ONNX for
   exactly this). `sklearn.ensemble.IsolationForest` pulls scikit-learn **and**
   scipy back into the serving path, more than quintupling the image and undoing
   the ONNX decision. A deep autoencoder pulls in a tensor framework, which is
   worse.
2. **Model fit.** At cold-start the detector has a handful of low-rate channels
   (~1 Hz) and little history. A 100-tree isolation forest or a multi-layer
   autoencoder over seven features would overfit the little normal data there is;
   a robust univariate statistic plus a linear-Gaussian (PCA) joint model is the
   better-conditioned tool and is fully explainable — every stream's contribution
   to the score decomposes exactly, which the display needs.

**What is preserved.** A linear autoencoder trained with reconstruction loss is
*mathematically* PCA, so `AnomalyStream.reconstruction_error` means precisely what
the profile intended — the "autoencoder" half is real, just linear. The
IsolationForest's job, catching multivariate outliers, is done by the same PCA
reconstruction residual. The upgrade path is open: a trained model can be exported
to ONNX and loaded through the same seam the fuel and forecast models use, if a
vessel ever logs enough history to justify one.

---

## 13. Route forecaster: gradient-boosted regression + a climatological lookup, not a Temporal Fusion Transformer

**Profile:** a Temporal Fusion Transformer forecasts sea state along candidate
routes, multiple horizons ahead.

**Build:** nine independent models, trained and evaluated against each other
on real data (`services/route/train.py`, `services/route/dataset.py`):
gradient-boosted regressors (XGBoost, served through ONNX) for wind and wave
*direction*; a climatological lookup table (mean by grid point, 3-hour bucket
and month) for wind speed, wave height, current speed and current direction.
Trained on 2.6 years of real hourly data pulled from Open-Meteo's Historical
Weather and Marine Weather APIs (`data/registry.py`:
`open-meteo-weather-archive`, `open-meteo-marine-archive`) over a 3x3 grid
spanning the Iloilo Strait operating box. `RouteRecommendation.forecast_source`
reports `"gbm_climatology"` when this is what answered a request, never `"tft"`.

**Why not a TFT — the structural reason.** A Temporal Fusion Transformer
forecasts forward from a recent *observed* history. `/route` has none to give
it: the ingest path feeds Safety and Maintenance, not a live sea-state
nowcast, and `/route` is asked for a track before the vessel leaves the wharf
from origin, destination and departure time alone. Wiring a live third-party
weather call into route planning to manufacture that input would put an
external API's uptime between a captain and a route recommendation, the exact
failure mode the ONNX-everywhere serving story in this document exists to
avoid. Without an observed history to fuse, what a TFT would reduce to here is
a position-and-calendar-time regression — which is what was trained instead,
directly, as the generalisation of `AnalyticFieldForecast` (already
position/time-of-day only) fit to real reanalysis and wave-model data rather
than hand-picked sinusoid parameters.

**Why not still gradient-boosted trees end to end — the finding, not a
hand-wave.** All nine targets were trained with XGBoost and scored against a
lookup-table baseline on a held-out six-month window (a single global date
cutoff, never a row-wise split — hourly readings are strongly autocorrelated).
XGBoost won cleanly on the two direction pairs with real learnable seasonal
structure (wind and wave bearing both track the monsoon cycle). It did **not**
beat the lookup table on wind speed, wave height, or current — not before
tuning, and only partially after deliberately regularising harder
(`min_child_weight=30`, shallower trees). The losing scoreboard was kept
rather than tuned away: five of nine targets ship as the lookup table because
it is the better-performing model there, not because gradient boosting was
never tried. Full per-target MAE, R², and the method each one shipped as are
in `models/route_forecast.card.json`.

**What this is honestly not.** A live nowcast — it answers with the
climatological expectation for a position and an absolute time, which is the
correct honest framing given the data-flow constraint above, not a forecast
that has seen this week's weather. Reanalysis and blended wave/current model
output, not buoy measurement, in a strait narrow and sheltered enough that
coarse ocean models under-resolve it. Under three years of history — one
monsoon transition, not a certified multi-year climatology.

---

## Not deviations

Worth stating, because they are the claims most likely to be doubted:

- **No physical hardware, and it is declared.** Every frame carries
  `source="simulator"`, and the contract has no default that could claim
  otherwise (`packages/contracts/telemetry.py`).
- **The Phase 1 / Phase 2 maintenance maturity curve is real and enforced in
  code**, not just described. The contract refuses to emit a component-level
  prediction while a vessel is in Phase 1 — the profile's honesty commitment is
  a validator, not a promise.
- **"Claude phrases, it does not decide" is a check, not a slogan.** The
  optimiser renders its decision as a sentence; Claude is asked to re-say that
  sentence, and what comes back is compared against it before anything reaches
  the display. The set of numbers must match exactly — no rounding, no dropping
  the peso figure, no inventing a saving — and no clause may open in the
  imperative. A rewrite that fails either check is discarded and the frame ships
  the deterministic template, labelled as such. `services/advisory/guard.py`,
  pinned by `tests/test_advisory.py`, including the case that matters most: a
  model that writes "saves 3.0 L/h" when the optimiser said 2.1 never reaches a
  captain.
- **The AI-authority boundary holds.** Safety cutoffs are rule-based and
  independent of every model: `services/safety/rules.py` imports no model, loads
  no artifact, and carries no state between requests, and a test asserts that it
  never imports one. Served at `POST /safety`. No module actuates anything.

## Still outstanding

Listed here rather than left for a judge to find. These are the places where the
build does not yet meet the profile, as distinct from the deliberate departures
above.

| # | Profile says | Build does | Status |
|---|---|---|---|
| A | Claude natural-language advisor writes the bridge sentence | Built. Claude re-words the throttle, route and health advisories; the rewrite is checked against the deterministic sentence and discarded if it changed a number or gave an order. `advisory_source` reports `"claude"` or `"template"` per frame | **Built** (2026-07-30) |
| B | Temporal Fusion Transformer forecasts along candidate routes | Gradient-boosted regression (wind/wave direction) + a climatological lookup table (wind/wave/current magnitude and current direction), trained on 2.6 years of real Open-Meteo reanalysis data. `forecast_source="gbm_climatology"` | **Built** (2026-07-30) — decision recorded in §13 |
| C | MPC loop re-solves the route continuously | Brute-force candidate sweep, re-planned on event | **Not built** |
| F | MQTT telemetry transport | HTTP/JSON | **Not built** |
| G | Phase 1 detector pretrained on NASA C-MAPSS | Dataset downloaded and registered; the detector fits a per-vessel baseline instead | **Not built** |

On **G** specifically: row 3 of the deviations table above says "Dropped; NASA
C-MAPSS only", which reads as though C-MAPSS pretrains the detector. It does not.
The Phase 1 detector learns each vessel's own normal — which is the more
defensible design, since a turbofan's degradation modes are not a marine
diesel's — but the profile's claim of pretraining is unmet either way, and the
honest thing is to say so rather than let the dataset citation imply otherwise.

On **B**: shipped 2026-07-30, and the interesting part is not "we trained a
model", it's that the model that shipped is not one architecture — it is
whichever of two tried approaches actually won, per target, on held-out real
data, and the losing half was kept rather than tuned away. See §13 for the
full reasoning and `models/route_forecast.card.json` for the numbers.

On **A**: shipped 2026-07-30. Two things about it are worth a judge's attention
more than the fact of the integration. First, the template is not dead code —
it is the fallback the display falls back *to*, on a missing key, an API error,
a timeout, or a rewrite that failed the guard, and `advisory_source` says which
path a given frame took. Second, the guard is the actual engineering: without
it, "the LLM only phrases things" is an assertion about a model's behaviour,
which is not a thing you can promise a maritime regulator. With it, the claim is
a property of the code. See `services/advisory/`.

**Still honest about the boundary:** the layer is downstream of every decision
and nothing upstream may consult it. `tests/test_advisory.py` greps the
optimiser, the route planner, the anomaly detector and the safety rules and
fails if any of them imports it.
