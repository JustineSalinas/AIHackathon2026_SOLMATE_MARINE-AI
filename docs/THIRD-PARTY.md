# Third-party resources, models and licences

Every external resource this project uses, what it is used for, and the licence
it carries. The hackathon rules require that *"any use of external resources
must be clearly documented and disclosed in the project submission"* — this file
is that disclosure, and it is deliberately exhaustive rather than selective.

Team SOLMATE's own code is MIT (see [`LICENSE`](../LICENSE)). Nothing in this
file is relicensed by that; several entries below carry attribution or
share-alike obligations that survive independently.

Datasets also appear in [`DATA.md`](DATA.md) with provenance, preprocessing and
known limits. This file is the licence view; that one is the data-integrity view.

---

## 1. AI models and APIs

| Resource | Role | Licence / terms |
|---|---|---|
| **Anthropic Claude** (`claude-opus-5`) | Natural-language advisory layer — **phrasing only**. Rewrites a deterministic sentence; the rewrite is discarded if it changed a number or issued an order. | Commercial API, Anthropic terms of service |
| **Google Gemini** (`gemini-flash-lite-latest`) | Same role, alternate provider. Default when `GOOGLE_API_KEY` is present. | Commercial API, Google terms of service |

**Neither model makes a decision.** The throttle setting, the route and the
health verdict are computed by deterministic code; `tests/test_safety.py`
contains a test that reads the safety module's own source and fails if a model
is ever imported into it. See [`DEVIATIONS.md`](DEVIATIONS.md) §12.

## 2. Models we trained ourselves

| Artifact | Trained on | Notes |
|---|---|---|
| `models/fuel_degradation.onnx` | UCI CBM (below) | XGBoost wear model, exported to ONNX. Model card: `models/fuel_degradation.card.json` |
| `models/route_forecast/` | Open-Meteo archives (below) | Gradient-boosted direction models + climatological lookup. Model card: `models/route_forecast.card.json` |

No pre-trained third-party model weights are used anywhere in the project.

## 3. Datasets

| Dataset | Licence | Used for |
|---|---|---|
| UCI CBM — *Condition Based Maintenance of Naval Propulsion Plants* (Coraddu et al., 2014) | CC BY 4.0 | Fuel wear model. **Gas turbine data used as a documented proxy for a small marine diesel** — see §5 below and DEVIATIONS §1 |
| Open-Meteo Historical Weather API (ERA5 reanalysis) | CC BY 4.0 | Route forecaster — wind targets |
| Open-Meteo Marine Weather API | CC BY 4.0 | Route forecaster — wave and current targets |
| Sentinel-2 cloudless (EOX) | CC BY 4.0 | Satellite basemap and the land mask the helm view ray-casts |
| Natural Earth 10m physical coastline | Public domain | Chart geometry |
| OpenSeaMap aids to navigation (OpenStreetMap seamark tags) | **ODbL 1.0** | Charted lights and harbour features |
| NASA C-MAPSS | US Government — public domain | Downloaded and registered; **informs methodology only**, not imported by the detector (DEVIATIONS "Still outstanding" G) |

**ODbL is the one share-alike obligation here.** OpenSeaMap data is fetched at
*build* time into `apps/bridge/public/seamarks.json` and attributed on the chart;
it is not mixed into any other dataset.

## 4. Software dependencies

### Python — serving (`requirements.txt`)

| Package | Licence |
|---|---|
| fastapi | MIT |
| pydantic | MIT |
| numpy | BSD-3-Clause |
| onnxruntime | MIT |
| google-genai | Apache-2.0 |
| anthropic | MIT |

### Python — training and tooling (`pyproject.toml`, not shipped to serving)

| Package | Licence |
|---|---|
| xgboost | Apache-2.0 |
| scikit-learn | BSD-3-Clause |
| scipy | BSD-3-Clause |
| pandas | BSD-3-Clause |
| pytest, ruff | MIT |
| python-pptx (deck build) | MIT |

### JavaScript — `apps/bridge`

next, react, react-dom, tailwindcss, eslint (all **MIT**); typescript
(**Apache-2.0**).

### JavaScript — `apps/console`

vite, express, driver.js, esbuild, tsx, tailwindcss (all **MIT**); typescript,
assemblyscript (**Apache-2.0**).

Authoritative licence text ships inside each package; the table records what the
project relies on, not a substitute for those files.

## 5. Runtime third-party origins (browser)

`apps/console` loads these **from the network at runtime**. They are listed
separately because they are a different kind of dependency: they are not vendored,
they are fetched by the visitor's browser, and they fail if the venue has no
internet.

| Origin | Resource | Licence |
|---|---|---|
| `cdnjs.cloudflare.com` | Leaflet 1.9.4 | BSD-2-Clause |
| `cdnjs.cloudflare.com` | three.js r128 | MIT |
| `cdnjs.cloudflare.com` | nipplejs 0.10.1 | MIT |
| `cdnjs.cloudflare.com` | Font Awesome 6.4.0 Free | Icons CC BY 4.0; CSS MIT; fonts SIL OFL 1.1 |
| `cdn.jsdelivr.net` | Chart.js | MIT |
| `cdn.jsdelivr.net` | @turf/turf 6 | MIT |
| `unpkg.com` | maplibre-gl 3.6.2 | BSD-3-Clause |
| `fonts.googleapis.com` | Inter, JetBrains Mono | SIL OFL 1.1 |
| `embed.windy.com` | Windy weather map iframe | **Proprietary** — free embed under Windy's terms, attribution required |
| `api.open-meteo.com`, `marine-api.open-meteo.com` | Live metocean fetch | CC BY 4.0 |

Two honest notes on this table:

**The offline claim does not hold for the console.** Ten runtime origins means
the console degrades without internet. The *bridge* chart is different by
deliberate design — OpenSeaMap marks are fetched at build time precisely so that
no third-party tile server can fail on stage, and that is the one-sentence
licence answer for the chart. The console has not been held to the same standard.

**`embed.windy.com` is the only proprietary dependency in the project** and the
only one whose terms are not an open licence. It is a decorative weather overlay,
not a data source for any computation — no model, route or advisory reads from it.

## 6. Rejected on licence grounds

Recorded because the rules ask what we used, and the near-misses show the
standard applied:

- **Google Maps / Bing / Esri tiles** — rejected twice. An earlier build rendered
  `mt1.google.com/vt` satellite and roadmap tiles credited "© Google Maps" on
  screen, which their terms do not permit in this form. Replaced with Sentinel-2
  (CC BY 4.0). See DEVIATIONS §10.
- **FEMTO/PRONOSTIA bearing dataset** — named in our own submitted profile but
  **not used**, on capability rather than licence grounds: it is 25.6 kHz bench-rig
  vibration and the retrofit IMU logs at ~1 Hz.

## 7. AI development tools

Anthropic's Claude Code was used during development as a coding assistant.
Commits it contributed to carry a `Co-Authored-By: Claude Opus 5` trailer, so the
extent is auditable from `git log` rather than asserted here. All architectural
decisions, dataset selections and the deviations recorded in
[`DEVIATIONS.md`](DEVIATIONS.md) are the team's own.
