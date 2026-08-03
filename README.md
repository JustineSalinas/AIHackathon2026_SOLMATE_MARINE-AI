# Marine-AI

**Team SOLMATE — National AI Hackathon 2026, Blue Economy / Clean Energy track**

A retrofittable IoT and AI advisory system for traditional diesel fiberglass
passenger boats in the Philippines. Three sensor systems feed three parallel AI
modules — Speed Optimization, Route Optimization, and Predictive Maintenance —
which converge on a single bridge display showing a live waypoint route and a
recommended throttle setting.

No new vessel. No engine replacement. It installs onto boats already in service.

- **Live demo:** _(deployed before the sprint — see `docs/DEPLOY.md`)_
- **Project overview and status:** [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md)
- **Data sources and licences:** [`docs/DATA.md`](docs/DATA.md)
- **Third-party resources and licences:** [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md)
- **Deviations from the technical profile:** [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md)
- **Pitch-deck scaffold:** [`docs/DECK.md`](docs/DECK.md)
- **What the display is for:** [`PRODUCT.md`](PRODUCT.md)
- **Deploying the public demo:** [`docs/DEPLOY.md`](docs/DEPLOY.md)

---

## Problem statement and AI-based solution

### The problem

A Philippine wooden-hull or fiberglass passenger banca burns diesel that its
operator cannot measure, on a route nobody costed, behind an engine that gets
attention only after it fails. Three consequences follow, and they compound:

1. **Fuel is the largest controllable cost and it is spent blind.** There is no
   fuel-flow meter on these boats. The throttle setting is chosen by habit, and
   the difference between the habitual setting and the efficient one is invisible
   to the person holding the lever.
2. **Breakdowns are discovered at sea.** Maintenance is reactive. A cooling
   problem announces itself when the engine is already overheating, on a boat
   carrying passengers, often out of sight of a wharf.
3. **Emissions cannot be evidenced.** Operators have no record they could show an
   LGU, MARINA, or a green-finance lender — so efficiency gains that did happen
   earn nothing, because nobody can prove them.

None of this is solved by a new vessel. The fleet already exists and will not be
replaced; anything that helps has to retrofit onto boats currently in service.

### The AI-based solution

Marine-AI is a retrofit advisory system. Three AI modules run against sensor data
and converge on one bridge display:

| Module | What it learns | What it outputs |
|---|---|---|
| **Speed Optimization** | Fuel penalty of a worn engine (XGBoost on 1,326 wear states, served as ONNX) | A recommended RPM, and what it saves in litres/hour |
| **Route Optimization** | Sea state across the strait (gradient-boosted direction models + climatological lookup, trained on 2.5 years of real reanalysis) | A track costed leg-by-leg through the *same* fuel model, with depth and wave-height as hard constraints |
| **Predictive Maintenance** | This engine's own healthy correlations (PCA autoencoder + robust z-score, pure NumPy) | An anomaly score that names the *drifting sensor stream* — never a component or a failure date |

A fourth deliverable, the **auditable emissions layer**, turns the fuel the first
two modules save into a monthly CO₂-avoided report measured against the vessel's
own prior runs on the same route — the evidence problem, solved with zero extra
sensors.

### The design decision that shapes everything

**The AI predicts and detects. It never decides.**

The optimiser picks the RPM, the planner picks the track, and a deterministic
rule table trips the safety cutoffs. A language model is used for exactly one
thing — rewording the resulting sentence into plain English or Filipino — and its
rewrite is discarded if it changes a number or issues an order.

This is enforced rather than described: `test_safety_never_imports_a_model` reads
the safety module's own source and fails if anyone ever reaches for a model to
make a cutoff "smarter". See [The AI-authority boundary](#the-ai-authority-boundary)
below.

Why it matters: a mis-specified physics coefficient is inspectable and can be
calibrated against a vessel's own fuel meter. An invisible ML blind spot cannot.
On a boat carrying passengers, that difference is the whole argument.

---

## Hardware declaration

**No physical hardware was used in this submission.**

Every telemetry frame is produced by the documented sensor simulator in
`packages/sim/`, which replays public research datasets along a synthetic
Philippine short-haul route and overlays live marine forecast data. Frames carry
`source="simulator"` and the contract default never claims otherwise
(`packages/contracts/telemetry.py`).

The sensor set the simulator emits is exactly the set a physical retrofit kit
would install, so the pipeline from ingest to display is the one that would run
on a vessel. What is simulated is the sensing, not the system.

## External models and datasets

All external work is cited in [`docs/DATA.md`](docs/DATA.md) with licence,
source URL, and retrieval date. Summary:

| Component | Origin |
|---|---|
| Fuel-consumption model | Trained by us (XGBoost) on the UCI *Condition Based Maintenance of Naval Propulsion Plants* dataset. **Gas turbine data used as a documented proxy for diesel** — see `docs/DATA.md`. |
| Weather / wave / current forecasting | Trained by us on 2.5 years of real Open-Meteo reanalysis and wave-model history (`forecast_source="gbm_climatology"`): gradient-boosted regression for wind/wave direction, a climatological lookup table for wind/wave/current magnitude and current direction — whichever won per target on held-out data. **Not a Temporal Fusion Transformer** — `/route` has no live sea-state history to forecast forward from, so a sequence model has nothing to fuse; see [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md) §13. Falls back to a deterministic analytic field (`forecast_source="analytic_field"`) if the artifact is absent. |
| Anomaly detection (Phase 1) | Trained by us: an ensemble of a robust per-stream z-score and a **PCA linear autoencoder**, learned from the vessel's own baseline. Pure NumPy — no scikit-learn/scipy in the serving image. NASA C-MAPSS informs the run-to-failure methodology. FEMTO/PRONOSTIA is named in the profile but **is not used** — 25.6 kHz bench-rig vibration vs. a ~1 Hz retrofit IMU. See [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md). |
| Natural-language advisory | **Two providers, either used for phrasing only.** Anthropic Claude (`claude-haiku-4-5`) and Google Gemini (`gemini-flash-lite-latest`). **Haiku is deliberate, not a fallback** — rewriting one 180-character sentence does not need a frontier model, and both were measured on the same task before choosing. Whichever answers, the rewrite is checked against the deterministic sentence it was asked to reword and discarded if it changed a number or gave an order; `advisory_source` reports which one the frame is carrying. **Gemini is the default when `GOOGLE_API_KEY` is set** — set `MARINE_AI_ADVISORY_PROVIDER=claude` to force Anthropic. See [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md) and [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md). |
| Chart geometry | Natural Earth 10m coastline (public domain), extracted to the demo route by `data/build_chart.py`. GEBCO bathymetry is the intended source for the depth constraint and **is not yet integrated** — see [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md). |

No pretrained model weights from third parties are shipped in this repository.

---

## Setup

Requires **Python 3.11+** and **Node 20+**. Docker is optional (local edge stack only).

```bash
git clone https://github.com/JustineSalinas/AIHackathon2026_SOLMATE_MARINE-AI.git
cd AIHackathon2026_SOLMATE_MARINE-AI
```

### 1. Python services

```bash
pip install uv                      # if you don't have it
uv venv --python 3.11
uv pip install -e ".[dev]"          # everything needed to run and test
```

**`[dev]` is all you need to run the system, the demo and the full test suite.**
Add `[train]` only to *retrain* the fuel model from scratch — it pulls roughly
2 GB, most of which is PyTorch left over from the Temporal Fusion Transformer
that was evaluated and then dropped in favour of gradient boosting plus a
climatological table (`docs/DEVIATIONS.md` §13). Nothing in the codebase imports
`torch` today; retraining needs only `skl2onnx` from that group.

Activate the venv: `source .venv/bin/activate` (macOS/Linux) or
`.venv\Scripts\activate` (Windows).

### 2. Fetch the datasets

Nothing under `data/` is committed. Every source is public and fetched by script:

```bash
python -m data.download --all       # or --dataset uci-cbm
```

Each download asserts its licence and records a card in `docs/DATA.md`.

### 3. Train the model, build the chart

```bash
python -m services.speed.train      # ~5s, XGBoost engine-wear model
python -m data.build_chart          # Natural Earth -> apps/bridge/public/chart.json
```

The trainer prints its held-out scores and writes
`models/fuel_degradation.card.json` with the full model card. Validation holds
out **whole engine-wear states**, not rows: the source dataset is a factorial
grid, so a row-wise split puts near-identical neighbours on both sides and
reports a meaningless number.

**Both steps are optional.** The API serves without the artifact — engine
condition is then assumed healthy, confidence is reduced, and every response
says so via `model_trained: false`. The display falls back to a schematic
outline without the chart file.

*Built and served today: Speed, Route, Phase 1 Predictive Maintenance, the
auditable emissions layer, and the learned route forecaster — `/route` reports
`forecast_source="gbm_climatology"` when its artifacts are present and degrades
to `"analytic_field"` when they are not. Roadmap: Phase 2 remaining-useful-life,
GEBCO depth, and fitting the health baseline from a vessel's own logged history
instead of the synthetic default. See [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md).*

### 4. Run

**The advisory API first — both front-ends are useless without it.** Every number
either of them shows comes from here:

```bash
uvicorn apps.api.main:app --reload      # http://localhost:8000
```

Then pick a front-end. They are two different views of the same API, and the
**console is the one to open first** — it is the demo surface:

**a) Navigation console** — chart, pathfinder, voyage simulation. *This is the
public Demo URL.*

```bash
cd apps/console
npm install
npm run dev                             # http://localhost:3200
```

It reads `MARINE_AI_API_URL`, defaulting to `http://127.0.0.1:8000`, so with the
API on its default port there is nothing to configure — **and no CORS setup
either**, because the console's Express server calls the API itself and the
browser only ever talks to `localhost:3200`. Drop the departure and destination
pins on the map, then press **Start**.

**b) Bridge display** — the captain's-eye view, with the four camera modes and
the procedural helm horizon.

```bash
cd apps/bridge
npm install
npm run dev                             # http://localhost:3000
npm run dev -- --port 3100              # …or pick another port
```

The bridge calls the API straight from the browser, so it is the one that needs
CORS: the API allows `localhost` and `127.0.0.1` on ports 3000, 3001 and 3100 out
of the box. For any other origin set `MARINE_AI_CORS_ORIGINS` for the API and
`NEXT_PUBLIC_API_URL` for the display.

On the bridge display, press **Start voyage** and switch between the four views —
*North-up*, *Course-up*, *Follow*, and *Helm*. Nothing in the browser computes
physics: every speed, burn and recommendation comes from `POST /advise`. Kill
the API mid-voyage and the display ages its last known values visibly rather
than blanking, which is the designed behaviour for routes that lose signal.

The advisory sentence is model-phrased when either `GOOGLE_API_KEY` or
`ANTHROPIC_API_KEY` is set, and the deterministic template otherwise —
`advisory_source` says which, per frame. Google wins when both keys are present;
`MARINE_AI_ADVISORY_PROVIDER=claude` overrides that.

**The first request for any given advice always reads `template`, by design.**
The display never blocks on a rewrite: off Vercel the template ships immediately
and the rewrite is fetched in the background, so it arrives on the next poll a
second later. On Vercel the instance can be frozen the moment it responds — there
is no background to speak of — so the call blocks under a short timeout instead.
The cache key is the deterministic sentence itself, so two requests that reached
the same decision share one entry and a whole crossing costs a handful of calls.
See `services/advisory/`.

### 5. Test

```bash
pytest                                  # 334 tests
ruff check apps services packages tests data
cd apps/bridge && npx tsc --noEmit && npx eslint .
```

---

## Repository layout

`[built]` runs today. `[planned]` is a directory with a stated purpose and no
implementation yet — listed so the gap is visible rather than discovered.

```
apps/bridge/          [built]   Next.js simulator console + bridge display, 4 POV modes
apps/api/             [built]   FastAPI advisory service: POST /advise, /route, /maintenance
services/speed/       [built]   Hull resistance (physics) + fuel map (XGBoost) + optimizer
services/route/       [built]   Geodesy + trained sea-state forecaster + planner (shared fuel cost)
services/maintenance/ [built]   Phase 1 anomaly detector (PCA + robust z-score). Phase 2 RUL planned
services/emissions/   [built]   CO2 accounting from the same burn figure (Problem 3)
services/safety/      [built]   Rule-based cutoffs. Deterministic, no ML, no network.
services/advisory/    [built]   Claude re-words a decision already made; a guard checks it did not change one
packages/contracts/   [built]   Pydantic models -> generated TypeScript. Source of truth.
packages/ingest/      [built]   Range checks, timestamp validation, drift monitoring
packages/sim/         [planned] Vessel and sensor simulator with fault injection
data/                 [built]   Dataset registry, download and chart-build scripts
models/               [built]   Trained artifacts + model cards (gitignored)
infra/                [planned] Container and deploy configuration
docs/                 [built]   Overview, data strategy, deviations, deploy runbook, deck
```

## The AI-authority boundary

Marine-AI never overrides the captain and never autonomously actuates the
vessel. All three modules produce recommendations; the captain acts on them.

Safety cutoffs — over-temperature, over-pressure, critical battery voltage —
are **rule-based, not ML-based**, so behaviour under fault is deterministic and
auditable. `services/safety/` imports no model, loads no artifact, and makes no
network call. Given the same input it returns the same answer, forever.

This is simultaneously an ethics safeguard, a legal necessity under maritime
liability, and the correct engineering answer for advisory AI in a high-stakes
physical domain.

## Maturity: Predictive Maintenance is honest about what it cannot yet do

Predictive maintenance cannot be precise on day one. It needs labelled failure
history, not just sensors.

- **Phase 1 (months 0–24):** unsupervised anomaly detection. Flags *that*
  something is deviating and *which sensor stream*. Cannot name a component or
  a date.
- **Phase 2 (after ~24 months):** with accumulated labelled maintenance history,
  supervised remaining-useful-life models per component.

This build ships **Phase 1** as a live prediction, served at `POST /maintenance`,
because that is the honest state of any newly installed unit. The Phase 1 detector
(`services/maintenance/`) is an ensemble of a robust per-stream z-score and a PCA
linear-autoencoder reconstruction — pure NumPy, learned from the vessel's own
baseline. The constraint is enforced in code: `packages/contracts/maintenance.py`
raises a validation error if a Phase 1 status carries a component name or a
maintenance date. **Phase 2** (supervised remaining-useful-life per component) is
roadmap: the contract fields and the maturity gate exist, but no RUL model is
trained yet.

## Licence

MIT — see [`LICENSE`](LICENSE).
