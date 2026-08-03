# Data Strategy

Machine-readable source of truth: [`data/registry.py`](../data/registry.py).
Nothing under `data/` is committed; fetch with `python -m data.download --all`.

Every dataset here is public, licensed for research and educational use, and
cited. No live operator telemetry is used in this submission, and no data was
collected from any vessel.

---

## Sources

| Key | Source | Licence | Used for |
|---|---|---|---|
| `uci-cbm` | UCI *Condition Based Maintenance of Naval Propulsion Plants* (Coraddu et al., 2014) | CC BY 4.0 | Engine fuel map for Speed Optimization |
| ~~`nasa-cmapss`~~ | NASA C-MAPSS turbofan degradation (Saxena et al., 2008) | Public domain (US Gov) | **Registered and fetchable, but consumed by nothing.** See the correction below. |
| `natural-earth-coastline` | Natural Earth 10m physical coastline | Public domain | Chart geometry on the bridge display |
| `sentinel2-cloudless` | Sentinel-2 cloudless 2020 (EOX) | CC BY 4.0 | Satellite basemap, and the land mask the helm view ray-casts for its horizon |
| `openseamap-seamarks` | OpenSeaMap aids to navigation (OpenStreetMap seamark tags) | ODbL 1.0 | Charted lights and harbour features on the bridge display — 10 marks, 8 lit, in the chart window |
| `open-meteo-weather-archive` | Open-Meteo Historical Weather API (ERA5 reanalysis) | CC BY 4.0 | Route forecaster's wind targets — 2.5 years, 9-point grid |
| `open-meteo-marine-archive` | Open-Meteo Marine Weather API (wave + ocean current models) | CC BY 4.0 | Route forecaster's wave/current targets — same grid and range |
| ~~GEBCO~~ | GEBCO global bathymetry grid | Public, attribution required | Depth safety constraint — **not yet integrated**, and deliberately absent from `data/registry.py` so `data/download.py` cannot fetch a source we do not use. Route Optimization is the module that needs it. |

> **Corrected 2026-08-04 — C-MAPSS pretrains nothing.** This table previously
> listed its use as "Pretraining the Phase 1 anomaly detector." No code path
> consumes it: `git grep cmapss -- '*.py'` returns `data/registry.py` and nothing
> else, and there is no `services/maintenance/train.py`. The Phase 1 detector
> fits `VesselBaseline` at runtime, and the API serves
> `synthetic_healthy_baseline()` — a seeded RNG prior — until a vessel has logged
> its own history.
>
> The dataset stays in the registry because it is the intended Phase 2 (RUL)
> pretraining corpus, and removing it would lose the provenance work already done
> on it. But "registered" is not "used", and the difference belongs in the
> column that claims a use.
>
> This contradicted [Bias 3](#bias-3--the-anomaly-baseline-is-synthetic-not-this-vessels)
> in this same document, which has correctly described the baseline as synthetic
> all along. A sources table that disagrees with its own bias section is worse
> than either being wrong alone, because each looks corroborated by the file it
> sits in. Recorded here rather than quietly edited, per the convention this
> document already follows.

**PAGASA** is named in the technical profile but has **no public programmatic
API**. It is a stated future integration, not a working data source in this
build. See [`DEVIATIONS.md`](DEVIATIONS.md).

**OpenSeaMap is crowdsourced, and the display says so.** It is not a
hydrographic office and not a Notice to Mariners feed: several marks in this
window cite UK Admiralty notices from 2016, and a light may have changed since
it was last edited. Absence of a mark means nobody has mapped one, **never** that
the water is clear. It is fetched once at build time by
`python -m data.build_seamarks` and committed as `apps/bridge/public/seamarks.json`,
so the display fetches no tile from anyone at runtime — the same licence
position the basemap is held to.

---

## What the anchor dataset actually contains

*Verified by direct inspection on 2026-07-22, before any model was written.*

`uci-cbm` is 11,934 rows across 18 columns. It is not a voyage recording. It is
a **complete factorial grid**:

```
9 lever positions  x  51 compressor-decay states  x  26 turbine-decay states  =  11,934
```

Three consequences follow, and all three shaped the architecture:

1. **There are only 9 distinct ship speeds**, and speed is fully determined by
   lever position (r = 0.93). There is no independent speed variation to learn from.
2. **Ambient inlet temperature (T1) and pressure (P1) are constant.** They carry
   zero information and are dropped.
3. **Wind, current, wave height, and passenger load do not appear at all** — not
   as weak signals, but as variables that genuinely do not vary in the data.

### Why this matters, stated plainly

The technical profile describes the fuel model as answering: *given RPM, torque,
wind, current, and load, how many litres per hour will this engine burn?*

**No public dataset we could find supports learning that function end-to-end.**
Training a model on `uci-cbm` and presenting it as having learned wind and
current effects would be a fabrication — the model would simply be ignoring
inputs that were constant during training, and its confidence on those inputs
would be meaningless.

### What we do instead

We split the problem at the boundary where the data actually is, and use the
right tool on each side:

| Layer | Method | Justification |
|---|---|---|
| Conditions → required shaft power | **Physics**: hull resistance model (calm-water resistance + added resistance from wind, waves, current, and displacement from passenger/cargo load) | These relationships are well established in naval architecture and require no training data. Pretending to learn them from data that does not contain them would be worse, not better. |
| Shaft power + load → healthy fuel burn | **Engine-maker BSFC curve**, two named coefficients | A marine diesel's part-load curve is published data. The gas-turbine dataset's own part-load curve is wrong for a diesel by a factor of five — see below. |
| Engine condition → fuel penalty | **XGBoost**, trained on `uci-cbm` | This is exactly what the dataset contains, densely: 1,326 distinct wear states. Real ground-truth fuel flow, genuinely nonlinear, well suited to gradient boosting. |

**Shaft RPM is not a feature.** The technical profile calls RPM a fuel
predictor. In this dataset it is not an independent one: within a lever position
RPM varies by 0.01 rpm, so it is a relabelling of load, and including it would
add a feature that looks informative and carries nothing.

This is a **hybrid physics-ML model**, and it is a stronger design than pure ML,
not a weaker one. Use ML where there is ground truth; use physics where there is
established theory and no data. The honest failure mode of this design is a
mis-specified resistance coefficient, which is inspectable and calibratable. The
failure mode of the alternative is a model that silently ignores the inputs the
product claims to act on.

**Unexpected benefit.** Because the fuel map is trained across 51 compressor-decay
and 26 turbine-decay states, it predicts the *fuel penalty of a degraded engine*.
That is the literal, quantified data link between Problem 1 (inefficiency) and
Problem 2 (accelerated wear) that the technical profile asserts — not a claimed
connection, a measured one.

### The gas turbine caveat

`uci-cbm` is a **gas turbine frigate propulsion plant, not a marine diesel.** It
is used as a documented proxy because it is the only public dataset pairing shaft
torque, RPM, ship speed, and ground-truth fuel flow at this resolution.

**Only the dimensionless wear penalty is transferred.** Not the fuel level, and
not the part-load curve either.

That second exclusion is the one that matters, and it is measured rather than
assumed. In `uci-cbm` the gas turbine burns roughly **7×** its best-point
specific fuel consumption at 10% load. A marine diesel at 10% load burns about
**1.5×**. Borrowing the turbine's part-load shape would have overstated the
savings from slowing down by about a factor of five — in the product's own
favour, which is precisely the direction a judge should be suspicious of. So the
healthy-burn curve comes from published diesel part-load data
(`services/speed/fuel.py`), and the dataset is used only for what it uniquely
contains:

> at the same shaft load, how much more fuel does a **worn** engine burn than a
> healthy one?

That question is prime-mover-agnostic in form, densely sampled here (1,326 wear
states), and validated in `services/speed/train.py` against wear states held out
of training entirely. The observed penalty reaches **+7.9%** of fuel.

The transfer is still an assumption and is labelled as one, in the README, in
`models/fuel_degradation.card.json`, and on a pitch deck slide. A judge who
discovers it in the repository unprompted will weight it far more heavily than
one who was told.

### What the model is validated against

A random train/test split over a factorial grid leaks: every held-out row sits
0.001 of a decay coefficient from a training row, and any model scores near
perfectly without having generalised. The split is therefore over **whole wear
states** — 25% of the (compressor, turbine) decay pairs are never seen in
training. Against those:

| Model | Mean error, as % of fuel burn |
|---|---|
| Assume every engine is healthy (what a system with no fuel map does) | 5.02% |
| Linear regression | 0.64% |
| **XGBoost** | **0.09%** |

The first row is the size of the problem; the gap between the last two is why a
gradient-booster is used rather than a straight line. Both baselines are
computed on every training run and printed, so if the tree ever stops earning
its complexity that will be visible rather than assumed.

The honest weakness: load is sampled at only **7 distinct points**. The wear
axis is dense and trustworthy; the load axis is interpolated between coarse
steps. This is recorded in `known_limits` in the model card.

---

## The route forecaster's data

Fetched with `python -m data.fetch_route_forecast` (not `data/download.py` —
see the caveats on the two registry entries above for why), into
`data/raw/route_forecast/`. **196,272 hourly rows**, 9 grid points spanning
the Iloilo Strait operating box (`lat 10.58-10.78, lon 122.46-122.72`, matching
the bridge display's own chart bounds), **2024-01-29 to 2026-07-29**. 936 rows
(0.48%) dropped for a missing current reading, never imputed.

Nine targets were trained and evaluated against a climatological lookup-table
baseline on a held-out six-month window. Four won as gradient-boosted
regressors (wind and wave direction); five did not beat the lookup table and
ship as the lookup table instead. See `docs/DEVIATIONS.md` §13 for the full
reasoning and `models/route_forecast.card.json` for every target's MAE, R²,
and which method it shipped as.

**What this is not.** A live nowcast — see §13 for why `/route` has no recent
observed sea state to forecast forward from, and why the model answers with
the climatological expectation for a position and an absolute time instead.
Buoy-measured — ERA5 and the Marine API's wave/current models are reanalysis
and blended model output, and the Iloilo Strait is narrow and partly
land-sheltered, which coarse ocean models under-resolve. A multi-year
climatology — under three years of pulled history is one monsoon transition,
not a certified seasonal record.

---

## Data quality and cleaning

Implemented in [`packages/ingest/`](../packages/ingest/), applied to every frame
before it reaches any AI module:

- **Range checks** — each channel against physical bounds declared in
  `packages/contracts/telemetry.py`.
- **Timestamp validation** — timezone-aware UTC, monotonic per vessel,
  out-of-order and duplicate frames rejected rather than silently reordered.
- **Drift monitoring** — rolling comparison against the vessel's learned baseline;
  a sensor that has stopped moving is as suspect as one reading out of range.
- **Outlier trips are flagged, never silently averaged.** A voyage with a
  mid-passage signal dropout is marked and excluded from training, not smoothed.

Operator-entered maintenance logs (parts replaced, dates, failure reports) are
treated as **first-class data with the same validation rigour as sensor
telemetry**. Phase 2 of Predictive Maintenance depends entirely on accurate
labelled failure history: a mislabelled maintenance event two years from now
would directly corrupt the RUL model.

## Synthetic data

Voyage telemetry is generated by the simulator in
[`apps/bridge/lib/`](../apps/bridge/lib/) — `telemetry.ts` emulates the engine
loom, `simulation.ts` runs the vessel and clock, `environment.ts` supplies the
sea state. Controlled fault injections (coolant drift, oil-pressure decay,
bearing vibration, battery) drive the maintenance demo.

> **Corrected 2026-08-03.** This section previously named `packages/sim/` as the
> source of every telemetry frame. That directory is empty and has never
> contained code — the working simulator is the TypeScript above. The claim was
> wrong in a document about data provenance, which is the worst place for it to
> be wrong, so it is recorded here rather than quietly edited.

**Every synthetic frame is labelled `source="simulator"` in the contract itself**
(`packages/contracts/telemetry.py`), and the field has no default that could
claim otherwise. No frame in this submission originates from physical hardware.

---

## Representativeness and bias

The hackathon's data rules ask teams to use diverse datasets — *"data that
represents various groups (e.g. age, gender, geography)"* — and to disclose
inherent biases with the mitigations attempted.

**This project processes no personal data.** Its inputs are engine telemetry
(coolant temperature, oil pressure, exhaust gas temperature, vibration, battery
voltage), vessel geometry, and metocean forecasts. There is no demographic
attribute anywhere in the pipeline to be balanced across, and no model output is
about a person. Passenger count enters only as **mass**, in kilograms, through
`PASSENGER_MASS_KG` in the resistance calculation.

So the demographic reading of that rule does not apply. Skipping it on those
grounds would be a dodge, though — the *principle* absolutely applies, and on the
axes that do exist for a marine dataset this project has real, disclosed
representativeness gaps:

### Bias 1 — the fuel model is trained on the wrong prime mover

**The gap.** The wear model learns from a 27 MW marine **gas turbine**. It advises
a ~60 kW marine **diesel**. Those are different machines.

**Why we accepted it.** No public dataset pairs diesel fuel consumption with
graded engine degradation. The choice was a documented proxy or no learned wear
model at all.

**Mitigation, and it is measurable.** Only the *dimensionless wear penalty*
transfers. The part-load curve explicitly does **not** — measured on 2026-07-22,
the gas turbine burns ~7× its best-point SFC at 10% load where a diesel burns
~1.5×. Borrowing that shape would have overstated the savings from slowing down
by roughly **5×, in the product's own favour**. The absolute fuel level comes from
a published diesel BSFC curve instead. See §"The gas turbine caveat" above and
DEVIATIONS §1.

### Bias 2 — the forecaster has seen one strait

**The gap.** The route forecaster is trained on a **9-point grid over the Iloilo
Strait**, roughly 20 km across, from 2.5 years of reanalysis. It encodes the
seasonal and diurnal wind and current behaviour *of that box*.

**Consequence, stated plainly.** It will not generalise to Philippine waters it
has never seen. Deployed to Cebu, Surigao or the Sulu Sea it would produce
confident, wrong forecasts — the failure mode is silent, because a climatological
lookup always returns *a* number.

**Mitigation.** `forecast_source` is reported on every `/route` response, so a
consumer can always tell which forecaster answered, and the degrade path to
`analytic_field` is explicit rather than hidden. Scaling to a new region is a
retraining task on the same pipeline (`data/build_*.py` → `services/route/train.py`),
not a code change — but it is a task, and no claim is made that it has been done.

### Bias 3 — the anomaly baseline is synthetic, not this vessel's

**The gap.** `VesselBaseline.fit()` exists and is tested, but the API serves
`synthetic_healthy_baseline()` at startup. The detector is therefore measuring
deviation from a *modelled* healthy engine, not from the specific engine it is
watching.

**Consequence.** On a real vessel whose healthy correlations differ from the
synthetic ones, the false-positive and false-negative rates are unknown. We have
not measured them, and we do not claim a figure.

**Mitigation.** Phase 1 is architecturally forbidden from making a component-level
or dated claim — the contract validator rejects it — so the worst case is a
mislabelled *stream*, not a wrong maintenance date sent to an operator. Tracked
openly as DEVIATIONS "Still outstanding" row I.

### Bias 4 — no hardware has ever been in the loop

Every telemetry frame is simulated, declared as such in the contract, and cannot
claim otherwise. Real engine looms are noisier, drop frames, and drift in ways a
generator does not reproduce. Nothing in this submission has been validated
against a physical vessel.

---

**The through-line.** In each case the mitigation is the same: state the gap,
keep the affected quantity inspectable, and refuse to let a model make a claim
the data cannot support. That is also why the natural-language layer is
constrained to phrasing — see DEVIATIONS §12.
