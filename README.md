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
- **Deviations from the technical profile:** [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md)
- **Pitch-deck scaffold:** [`docs/DECK.md`](docs/DECK.md)
- **What the display is for:** [`PRODUCT.md`](PRODUCT.md)
- **Deploying the public demo:** [`docs/DEPLOY.md`](docs/DEPLOY.md)

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
| Weather / wave / current forecasting | Trained by us on 2.6 years of real Open-Meteo reanalysis and wave-model history (`forecast_source="gbm_climatology"`): gradient-boosted regression for wind/wave direction, a climatological lookup table for wind/wave/current magnitude and current direction — whichever won per target on held-out data. **Not a Temporal Fusion Transformer** — `/route` has no live sea-state history to forecast forward from, so a sequence model has nothing to fuse; see [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md) §13. Falls back to a deterministic analytic field (`forecast_source="analytic_field"`) if the artifact is absent. |
| Anomaly detection (Phase 1) | Trained by us: an ensemble of a robust per-stream z-score and a **PCA linear autoencoder**, learned from the vessel's own baseline. Pure NumPy — no scikit-learn/scipy in the serving image. NASA C-MAPSS informs the run-to-failure methodology. FEMTO/PRONOSTIA is named in the profile but **is not used** — 25.6 kHz bench-rig vibration vs. a ~1 Hz retrofit IMU. See [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md). |
| Natural-language advisory | Anthropic Claude API (`claude-opus-5`), used for phrasing only. Its rewrite is checked against the deterministic sentence it was asked to reword and discarded if it changed a number or gave an order — see [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md). |
| Chart geometry | Natural Earth 10m coastline (public domain), extracted to the demo route by `data/build_chart.py`. GEBCO bathymetry is the intended source for the depth constraint and **is not yet integrated** — see [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md). |

No pretrained model weights from third parties are shipped in this repository.

---

## Setup

Requires **Python 3.11+** and **Node 20+**. Docker is optional (local edge stack only).

```bash
git clone https://github.com/<org>/marine-ai.git
cd marine-ai
```

### 1. Python services

```bash
pip install uv                      # if you don't have it
uv venv --python 3.11
uv pip install -e ".[train,dev]"    # omit [train] to skip torch (~2 GB)
```

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

*Built and served today: Speed, Route, and Phase 1 Predictive Maintenance.
Gated / roadmap: the learned route forecaster (analytic field runs in its place)
and Phase 2 remaining-useful-life. See [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md).*

### 4. Run

Two processes. First the advisory API:

```bash
uvicorn apps.api.main:app --reload      # http://localhost:8000
```

Then, in a second terminal, the bridge display:

```bash
cd apps/bridge
npm install
npm run dev                             # http://localhost:3000
npm run dev -- --port 3100              # …or pick another port
```

The API accepts `localhost` on ports 3000, 3001 and 3100 out of the box. To use
any other origin, set `MARINE_AI_CORS_ORIGINS` for the API and
`NEXT_PUBLIC_API_URL` for the display.

Open the display, press **Start voyage**, and switch between the four views —
*North-up*, *Course-up*, *Follow*, and *Helm*. Nothing in the browser computes
physics: every speed, burn and recommendation comes from `POST /advise`. Kill
the API mid-voyage and the display ages its last known values visibly rather
than blanking, which is the designed behaviour for routes that lose signal.

The advisory sentence is Claude-phrased when `ANTHROPIC_API_KEY` is set and the
deterministic template otherwise (`advisory_source` says which, per frame). The
display never blocks on it: on Vercel the rewrite is fetched synchronously
under a short timeout; everywhere else it is fetched in the background and the
template ships immediately. See `services/advisory/`.

### 5. Test

```bash
pytest                                  # 276 tests
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
