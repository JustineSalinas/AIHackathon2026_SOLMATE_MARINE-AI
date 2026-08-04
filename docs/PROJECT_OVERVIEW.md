# Marine-AI — Project Overview & Status

**Team SOLMATE · National AI Hackathon 2026 · Blue Economy / Clean Energy track**
**Deadline: August 4, 2026** · *Status snapshot: July 23, 2026*

> A shared reference for the team: what Marine-AI is, what's built, the tech
> stack, the approach behind each module, every dataset and its licence, and
> what's left. Everything here matches the code as it stands today — where the
> build differs from our submitted profile, it's flagged and explained.

---

## 1. What we're building

A **retrofittable IoT + AI advisory system** for traditional diesel fiberglass
passenger boats in the Philippines. It installs onto boats **already in service** —
no new vessel, no engine replacement. Three sensor systems feed three parallel AI
modules that converge on **one bridge-mounted display**:

1. **Speed Optimization** — the cheapest throttle that still meets the schedule.
2. **Route Optimization** — the cheapest lawful track for the same arrival time.
3. **Predictive Maintenance** — engine health, honest about what it can't yet know.

Plus a cross-cutting **Auditable Emissions Layer** (monthly CO₂-avoided report for
LGU / MARINA compliance and green financing).

**The one idea that ties it together:** there is **one fuel model** in the whole
system. Speed, Route and Emissions are all scored by it — so the litres a route
saves and the litres a throttle saves can never come from two different models.
This is enforced by a test, not just claimed.

**The product is the *delta*, not the number.** Not "run at 1650 RPM" but "1650
RPM saves 2.1 L/h." The system **advises; the captain decides.** It never actuates
the vessel.

---

## 2. Status at a glance

| Area | Status | Notes |
|---|---|---|
| **Speed Optimization** | ✅ Built + tested | Physics + ML hybrid fuel model, throttle optimizer, ONNX serving |
| **Route Optimization** | ✅ Built + tested | Geodesy, planner, depth/weather constraints, shared fuel cost |
| **Predictive Maintenance (Phase 1)** | ✅ Built + tested | Anomaly detector (PCA + robust z-score ensemble) |
| **Auditable Emissions Layer** | ✅ Built + tested | CO₂ accounting from the same burn figure |
| **Advisory API** | ✅ Live | `POST /advise`, `/route`, `/maintenance`, `/health` |
| **Bridge display (Next.js)** | ✅ Built | Simulator console, 4 POV modes incl. procedural helm view |
| **Contracts → TypeScript** | ✅ Built | Pydantic models are the single source of truth; TS generated |
| **Route learned forecaster (TFT)** | 🟡 Gated | Runs on an honest analytic weather field today; TFT/GBM is the upgrade |
| **Predictive Maintenance Phase 2 (RUL)** | ⬜ Not started | Contract + maturity gate exist; RUL model is roadmap |
| **Safety cutoffs** | ⬜ Planned | Rule-based, deterministic, no ML |
| **Pitch deck** | 🟡 Scaffolded | `docs/DECK.md` — slide-by-slide content, not yet a PPT |
| **Video screencast** | ⬜ Not started | Required deliverable |
| **Public deployment** | ⬜ Pending | Runbook ready (`docs/DEPLOY.md`); run by team lead |

**Tests: 174 passing · `ruff` clean.** ✅ = working today, 🟡 = partial/gated,
⬜ = not started.

---

## 3. Tech stack

### Backend — Python 3.11
| Tool | Role |
|---|---|
| **FastAPI** + **Uvicorn** | The advisory API (`apps/api`) |
| **Pydantic v2** | Contracts / data validation — the single source of truth |
| **NumPy** | Physics, geodesy, the maintenance detector |
| **XGBoost** + **scikit-learn** | Training the fuel-wear model (dev only) |
| **ONNX Runtime** | **Serving** the fuel model (not xgboost) — see below |
| **pandas / pyarrow** | Data prep (dev only) |
| **SQLAlchemy** + **psycopg** | Storage layer (Supabase Postgres) |

### Frontend — the bridge display (`apps/bridge`)
| Tool | Version |
|---|---|
| **Next.js** | 16.2 (App Router) |
| **React** | 19.2 |
| **TypeScript** | 5 |
| **Tailwind CSS** | 4 |

### Serving, deploy & tooling
- **Serving image is deliberately tiny:** `numpy + onnxruntime` only (~85 MB) vs.
  the full training stack (~358 MB). This is what lets the API run as a serverless
  function inside a 500 MB limit. Every module respects this — e.g. the
  maintenance detector is pure NumPy specifically to avoid dragging scikit-learn
  back into serving.
- **Deploy targets:** Vercel (display) + Python serverless function (API) +
  Supabase Postgres (storage).
- **Tooling:** `uv` (env/deps), `ruff` (lint), `pytest` (174 tests), `hatchling`
  (build). Windows dev machine: no Docker/gh/pnpm locally.

---

## 4. Approach, module by module

### 4.1 Speed Optimization — a *hybrid* fuel model
The core insight, and our strongest data-integrity point:

```
conditions + load  →[ physics: naval architecture ]→  required shaft power
shaft power + wear  →[ diesel BSFC curve × XGBoost ]→  litres per hour
```

- **Why not pure end-to-end ML?** No public dataset varies wind, current, wave or
  load — they're *constants* in the training data. A model "learning" them would
  ignore the very inputs the product acts on while reporting confidence on them.
  So conditions→power is **physics** (Admiralty coefficient + semi-displacement
  hump penalty + wind/wave/current terms), with every coefficient **named,
  sourced, and calibratable per vessel** from the boat's own fuel-flow meter.
- The **throttle optimizer** holds the committed ETA and finds the cheapest RPM
  that still arrives on time (a brute-force sweep — can't get stuck in a local
  minimum on stage).
- **Files:** `services/speed/resistance.py`, `fuel.py`, `optimizer.py`, `train.py`.

### 4.2 Route Optimization — same cost basis, real constraints
- Generates candidate tracks (direct great-circle + lateral offsets), breaks each
  into short legs, reads the forecast per leg, and **costs every leg through the
  same throttle optimizer as Speed.** A one-leg route agrees with the throttle
  advisor **to 1e-6** (enforced by test).
- **Hard constraints:** charted depth (a shorter track over a shoal is *rejected*,
  not costed) and forecast wave height.
- **The forecaster is a gated decision.** Today the route plans against a
  deterministic **analytic weather field**, labelled `forecast_source:
  "analytic_field"` on every response — honest about what it is. The learned
  forecaster (the profile's Temporal Fusion Transformer, or a gradient-boosted
  fallback) slots into one function when it trains to a usable loss.
- **Files:** `services/route/geo.py`, `forecast.py`, `bathymetry.py`, `planner.py`.

### 4.3 Predictive Maintenance (Phase 1) — honest about maturity
- **Two-phase maturity, enforced in code.** Phase 1 (first ~24 months): can say
  *which sensor stream is deviating* — "coolant temperature is drifting" — but
  **cannot name a component or a repair date.** A Pydantic validator *rejects* a
  Phase-1 status that tries to. The fairness promise is a validator, not a comment.
- **The detector is a pure-NumPy ensemble of two:**
  - **Robust per-stream z-score** (median/MAD) — catches one channel drifting.
  - **PCA linear-autoencoder reconstruction error** — catches a fault that keeps
    every channel individually in range but in a joint pattern a healthy engine
    never produces (e.g. coolant up while load is flat).
- **The Problem 1 → Problem 2 link is priced:** a worn engine's fuel penalty is a
  line item in litres/hour and pesos/hour, straight from the fuel model.
- **Files:** `services/maintenance/baseline.py`, `detector.py`.

### 4.4 Auditable Emissions Layer — arithmetic, not a fake model
- CO₂ is **chemistry, not a prediction:** **2.68 kg CO₂ per litre** of marine
  diesel, from carbon mass balance. Zero extra sensors.
- The claim that matters is the **baseline:** the vessel vs. its *own* recorded
  burn on the *same* route before Marine-AI. A month that burned more reports as
  **negative**, not floored at zero — because that's auditable.
- **File:** `services/emissions/__init__.py`.

### 4.5 The AI-authority boundary (ethics + maritime liability)
- The system **never overrides the captain and never actuates the vessel.**
- Safety cutoffs are **rule-based and independent of every model** — deterministic
  and auditable.
- **Claude phrases, it does not decide.** The advisory layer never produces a
  number or threshold; a deterministic template ships if the API is slow/down, and
  the source is labelled in the payload. Language is never imperative.

---

## 5. Data used — sources & licences

Every dataset is **public or licensed**. No scraped or unlicensed imagery.
Declared in `data/registry.py` (the code refuses to fetch anything undeclared).

| Source | Role | Licence |
|---|---|---|
| **UCI — Condition Based Maintenance of Naval Propulsion Plants** | Fuel-wear model (used as a **documented gas-turbine proxy**; only the dimensionless wear penalty transfers) | CC BY 4.0 (UCI ML Repository) |
| **NASA C-MAPSS** (turbofan degradation) | Registered and fetchable, but **consumed by nothing today** — the intended Phase 2 (RUL) corpus. It does **not** pretrain the Phase 1 detector | U.S. Government work — public domain |
| **Published marine-diesel BSFC part-load data** | Healthy-burn curve in the fuel model | Literature (cited) |
| **Open-Meteo Marine** | Wind / wave / current forecast (route) | CC BY 4.0, no API key |
| **GEBCO bathymetry** | Depth constraint *(intended — **not yet wired**; analytic depth today)* | Open |
| **Sentinel-2 cloudless (EOX)** — Iloilo Strait | Satellite basemap + helm-view horizon mask | CC BY 4.0 (modified Copernicus Sentinel data 2020) |
| **Natural Earth 10m coastline** | Drawn nautical chart geometry | Public domain |

**Notes for the team (a judge will check these):**
- The UCI dataset is a **gas turbine**, not a diesel. We use it *only* for "how
  much more does a worn engine burn than a healthy one at the same load." We do
  **not** borrow its part-load curve — doing so would overstate our savings ~5×.
- **FEMTO/PRONOSTIA is named in our profile but deliberately NOT used** — it's
  25.6 kHz bench vibration and the retrofit IMU logs at ~1 Hz (3–4 orders of
  magnitude too slow). Do not list it as a source.
- **C-MAPSS pretrains nothing.** `git grep cmapss -- '*.py'` returns
  `data/registry.py` and nothing else; there is no `services/maintenance/train.py`.
  The Phase 1 detector fits `VesselBaseline` at runtime. This claim has now been
  found and corrected three times in three different documents — if you are about
  to write it again, check `docs/DATA.md`, `docs/DEVIATIONS.md` and this file
  together.
- **Google/Bing/Esri satellite tiles were rejected** — their terms forbid reuse
  outside their own APIs; the brief grades "licensed or public data only."
- **Claude (`claude-haiku-4-5`, Anthropic API)** is used for advisory *phrasing
  only* — never a number, threshold, or recommendation. No third-party model
  weights are shipped in the repo. The model is the code default
  (`services/advisory/phraser.py`) and overridable by `ANTHROPIC_MODEL`; if you
  change it, change it here, in `README.md`, and on deck slide 13 too — the
  brief requires external models to be cited accurately.

---

## 6. Deviations from our submitted profile (the honesty ledger)

We keep `docs/DEVIATIONS.md` — every place the build departs from the submitted
technical profile, why, and what it costs. Highlights:

| Profile said | Build does | Why |
|---|---|---|
| Fuel burn learned end-to-end by XGBoost | **Hybrid**: physics for conditions→power, XGBoost for wear→fuel | No dataset varies weather/load |
| "Public marine-diesel datasets" | UCI **gas turbine** as documented proxy | No public diesel dataset at needed resolution |
| FEMTO + C-MAPSS pretraining | **Neither** — the detector fits each vessel's own baseline | FEMTO is 25.6 kHz vs a ~1 Hz IMU; a turbofan's wear modes are not a marine diesel's |
| TensorFlow Lite (edge) | **ONNX Runtime** | Native export path; 85 MB vs 358 MB serving |
| TimescaleDB | **Supabase Postgres** | Managed free tier + public URL required |
| PAGASA + OpenWeather | **Open-Meteo Marine** | PAGASA has no public API; marine vars free |
| Sonar depth | **Charted bathymetry** (GEBCO, not yet wired) | No hardware; declared |
| AIS traffic avoidance | **Omitted** (reserved in contract) | No free live PH AIS feed |
| Autoencoder + IsolationForest | **PCA linear AE + robust z-score** (pure NumPy) | Serving size + better cold-start fit |

> This ledger is a **trust asset**: a judge finds these by reading the source
> anyway; finding them documented, with reasoning, is a completely different
> experience. Lead with it, don't hide it.

---

## 7. The API (what the display consumes)

Base URL `http://localhost:8000` in dev · interactive docs at `/docs`.

| Endpoint | Returns |
|---|---|
| `GET /health` | Status + whether the wear model is loaded; declares `advisory_only` |
| `POST /advise` | Speed recommendation (throttle delta, power breakdown, wear, emissions, speed/burn curve) |
| `POST /route` | Route recommendation (waypoints, burn, honest baseline delta, depth/weather flags, forecast source) |
| `POST /maintenance` | Phase-1 engine-health status (anomaly score, ranked deviating streams, advisory) |

The browser **renders**; it never computes physics. There is one fuel model and
it is in Python.

---

## 8. Testing & quality

- **174 tests passing** (`pytest`), **`ruff` clean** across the repo.
- Load-bearing tests that guard the product's core claims:
  - Weather actually slows the boat at the same throttle (not a decorative slider).
  - A one-leg route agrees with the throttle optimizer to **1e-6** (one fuel model).
  - The multivariate detector catches broken-correlation faults no single channel shows.
  - A Phase-1 maintenance status can **never** name a component or date.
  - Emissions come from the same burn figure the recommendation uses.

---

## 9. What's left

**Hard deliverables (due Aug 4):**
- [ ] **Public deployment** — display + API live, Vercel Deployment Protection OFF
      (runbook: `docs/DEPLOY.md`). *Run by team lead.*
- [ ] **Pitch deck (PPT)** — build from the scaffold in `docs/DECK.md`.
- [ ] **Video screencast** of the AI in action.

**Engineering (nice-to-have / post-MVP):**
- [ ] Learned route forecaster (TFT, or gradient-boosted fallback) — the D5 gate.
- [ ] Predictive Maintenance Phase 2 (RUL) — methodology demo on C-MAPSS.
- [ ] Wire GEBCO bathymetry into the route depth constraint.
- [ ] Bridge display: consume `/route` and `/maintenance` (types already generated).
- [ ] Rule-based safety cutoffs (`services/safety/`).

**Blocked on us:** Supabase `DATABASE_URL` (storage falls back to local SQLite
until then).

---

## 10. Key references (in the repo)

| Doc | What's in it |
|---|---|
| `docs/DATA.md` | Full data strategy, model validation, cleaning |
| `docs/DEVIATIONS.md` | Every departure from the profile, with reasoning |
| `docs/DECK.md` | Slide-by-slide pitch-deck scaffold |
| `docs/DEPLOY.md` | Deployment runbook |
| `PRODUCT.md` | What the display is for (the captain's 2-second glance) |
| `README.md` | Setup & run instructions |

**Repo:** github.com/JustineSalinas/AIHackathon2026_SOLMATE_MARINE-AI (private;
`aifesthackathon` added as a viewer per the hackathon rules)
