# Marine-AI — Pitch Deck Scaffold

> **Purpose.** This is the slide-by-slide content source for the Final Technical
> Pitch Deck (PPT), due **August 4, 2026**. It is written so that the deck and
> the repository agree everywhere: every technical claim below is one the source
> code will confirm if a judge opens it. Where the build departs from the
> submitted technical profile, the deck *leads* with the departure rather than
> hiding it — see [`docs/DEVIATIONS.md`](DEVIATIONS.md).
>
> **How to use it.** Each slide has: the on-slide content (kept glanceable), the
> speaker notes (what you actually say), and the rubric criterion it is built to
> score on. Build the PPT from this; do not invent numbers at design time.

## Judging weights this deck is built against

**Updated 2026-08-03 from the on-site orientation slides.** These supersede the
weights in the brief PDF — Presentation dropped 15% → 10%, Innovation rose
10% → 15% and is now scored on *impact*, and "Impact & Feasibility" became
"Feasibility & Scalability" with explicit venture language.

| Criterion | Weight | Scored on |
|---|---|---|
| **Technical Soundness** | **50%** | Mentor-assigned. Functional prototype, AI architecture, data ethics, track alignment |
| Feasibility & Scalability | 25% | Real-world viability: **path to adoption, sustainability as a venture, capacity to scale beyond the prototype** |
| Innovation & Impact | 15% | Impact on intended beneficiaries, and how compellingly that impact is communicated |
| Presentation | 10% | Storytelling, live demo execution, Q&A defence |

**Technical Soundness is half the grade and it breaks down further** — this is the
table to design against, because it is mentor-assigned during Day 1–2 mentoring,
not at the pitch:

| Sub-criterion | Share of the 50% | Effective weight | Where this deck answers it |
|---|---|---|---|
| AI Architecture & Model Fit | 30% | **15%** | Slides 6, 7, 10, 12 |
| Data Strategy & Ethics | 25% | **12.5%** | Slides 4, 13, 14 + `DATA.md` §Representativeness, `THIRD-PARTY.md` |
| Local Relevance & Innovation | 25% | **12.5%** | Slides 2, 3, 15 (track alignment = Blue Economy) |
| Functional Prototype | 20% | **10%** | The live demo + code quality and documentation |

Two consequences worth internalising before rehearsing:

1. **Data Strategy & Ethics alone (12.5%) outweighs Presentation (10%).** The
   deviations table and the representativeness disclosure are not defensive
   throat-clearing — they are a bigger scoring surface than the pitch delivery.
2. **Half the grade is decided before anyone presents.** Get a mentor in front of
   the running system early on Day 1 and lead with `DEVIATIONS.md`.

Two brief requirements that lose marks if missed and are handled explicitly
below: **external models must be cited in the deck** (Slide 13), and **hardware
use must be declared in the deck** (Slide 4).

---

## Slide 1 — Title

**On slide:**
- Marine-AI
- *A retrofittable AI advisory system for Philippine diesel passenger boats.*
- Team SOLMATE · National AI Hackathon 2026 · Blue Economy / Clean Energy track
- Public demo URL · public repo URL (both must resolve — required, or DQ)

**Speaker notes:** One sentence. "We make boats already in the water burn less
fuel, break down less, and prove it — without replacing the boat or the engine."

**Serves:** first impression; sets the retrofit framing that makes impact
credible.

---

## Slide 2 — The problem, in the operator's words

**On slide:**
- ~5,000+ wooden/fiberglass diesel passenger boats in PH inter-island service.
- Fuel is the largest controllable operating cost; captains throttle on instinct.
- Breakdowns are discovered at sea, not scheduled at the dock.
- No emissions evidence → locked out of green financing and LGU/MARINA incentives.

**Speaker notes:** Three costs the operator already feels — fuel wasted, downtime
unplanned, and money left on the table for lack of a report they can't produce.
We did not invent a problem; we instrumented one.

**Serves:** Innovation & Impact (15%); Local Relevance (12.5%). Ground the pitch
in a real operator, the
captain from [`PRODUCT.md`](../PRODUCT.md).

---

## Slide 3 — One system, three problems, one screen

**On slide (diagram):**

<!-- diagram:architecture -->

- Cross-cutting: the **Auditable Emissions Layer** rides on the same fuel model,
  so it needs no sensor the other three have not already earned.

**Speaker notes:** The architectural claim that ties it together: **there is one
fuel model in this system.** Speed, Route and Emissions are all scored by it, so
the litres a route saves and the litres a throttle saves can never come from two
different models. That is enforced by a test, not a promise.

**Serves:** Innovation & Impact; AI Architecture & Model Fit.

---

## Slide 4 — What is real, and what is declared (HARDWARE DECLARATION)

**On slide:**
- **No retrofit hardware in this build. Declared, not hidden.**
- Every telemetry frame carries `source="simulator"`; the contract has no default
  that could claim otherwise (`packages/contracts/telemetry.py`).
- The retrofit sensor kit is *specified* (RPM pickup, EGT probe, IMU, GPS, fuel-
  flow meter, weather feed) — the model inputs are exactly what that kit produces.
- The one real sensor path: the console can optionally read **the browser's own
  GNSS and orientation**, to place the vessel on the chart at your actual
  position. It feeds the map only. **No engine, fuel or temperature stream is
  ever anything but simulated.**
- The demo drives the real models with simulated telemetry, at real physics.

**Speaker notes:** This is the honesty slide, up front. We are a pre-sprint
software prototype. The sensors are named and the data they'd produce is exactly
what the models consume — so this is a working system waiting for a sensor kit,
not a mock-up. Saying so plainly is worth more than a staged hardware photo.

**Serves:** Ethics/Data Integrity (this is the brief's declaration requirement);
buys credibility for every later claim.

---

## Slide 5 — Problem 1: Speed Optimization

**On slide:**
- Product is not a recommended RPM. Product is the **delta**: litres/hour saved
  for the same arrival time.
- Physics decides how much power a speed costs in *these* conditions; the fuel
  model decides how many litres that power burns.
- Held-at-ETA optimiser: it never tells you to just go slower — it finds the
  cheapest throttle that still arrives on time.

**Speaker notes:** Demo beat — show head-sea vs calm at the same throttle; the
boat actually slows. In the old prototype the weather slider moved the readout
and never the boat; that bug is now a failing test if it ever returns.

**Serves:** Functional Prototype (10% — the working demo); the live-demo moment.

---

## Slide 6 — The fuel model is a hybrid (AI STRATEGY / MODEL FIT)

**On slide:**
- `conditions + load → shaft power` = **physics** (naval-architecture, calibratable).
- `shaft power + wear → litres/hour` = published diesel BSFC curve × **XGBoost**
  wear penalty.
- Why not end-to-end ML? **No public dataset varies wind, current, wave or load** —
  they are constants in it. A model "learning" them would ignore the inputs it
  acts on while reporting confidence on them.

**Speaker notes:** This is our single strongest data-integrity point and it maps
to the 20% "did you pick the right tool" criterion. We split the problem so the
part we can learn honestly is learned, and the part no dataset supports is
computed from physics with every coefficient named and per-vessel calibratable.

**Serves:** AI Architecture & Model Fit — 30% of Technical Soundness, so **15% of
the total grade**, the single largest sub-criterion there is. See
[`docs/DEVIATIONS.md`](DEVIATIONS.md) §1.

---

## Slide 7 — Model validation (TECHNICAL SOUNDNESS)

**On slide (table):**

| Model | Mean error, % of fuel burn |
|---|---|
| Assume every engine is healthy (a system with no fuel map) | 5.02% |
| Linear regression | 0.64% |
| **XGBoost wear model** | **0.09%** |

- Validated on **whole held-out wear states** (25% of decay pairs never seen in
  training) — not a random split, which would leak on a factorial grid.
- Honest weakness stated on-slide: **load sampled at only 7 points**; the wear
  axis is dense, the load axis is interpolated.

**Speaker notes:** The 5.02% row is the size of the problem. The gap from 0.64%
to 0.09% is why a tree earns its complexity over a straight line. Both baselines
print on every training run, so if the tree ever stops earning it, we'd see it.

**Serves:** Technical Soundness (50% final, from the mentor report).

---

## Slide 8 — Problem 2: Predictive Maintenance, honest about maturity

**On slide:**
- Two phases, enforced in code, not just described:
  - **Phase 1 (~first 24 months):** "coolant temperature is drifting" — anomaly,
    never a component-level countdown.
  - **Phase 2 (after labelled failure history exists):** component-level RUL.
- The contract **refuses** to emit a Phase-2 prediction during Phase 1
  (`packages/contracts/maintenance.py`). The honesty commitment is a validator.

<!-- diagram:sensor-bridge -->

**Speaker notes:** Most predictive-maintenance demos overclaim on day one. Ours
physically cannot: the data model rejects a failure-date prediction before the
failure history that would justify it exists.

**Serves:** Ethics/Bias (over-claim avoidance); Technical Soundness.

> **Build status note (delete before pitch):** the Phase-1 anomaly detector is
> **built, tested and live on the display** — a pure-numpy ensemble of a robust
> per-stream z-score and a PCA linear autoencoder, served by `POST /maintenance`
> and rendered in the bridge Health zone.
>
> The demo beat to rehearse, **re-measured live against the running API on
> 2026-08-03**: hold the coolant gauge at the *same* reading, 87.4 °C, and change
> only how it got there. Reached by a load-coupled rise — coolant, exhaust
> temperature, NOx and vibration all moving together the way they do when the
> throttle opens — it scores **0.30 and stays nominal**. Reached by a coolant
> creep on its own it scores **0.62 and flags**, naming the coolant stream. Same
> number on the gauge, opposite verdict: that correlation is what the PCA half
> learned, and a threshold detector cannot tell the two apart. Push the creep
> further and it saturates — coolant at 98 °C alone scores **0.9998**.
>
> The old "0.09 vs 0.99" pair in this note was **not reproducible** from the API
> and has been replaced by the measured figures above. Quote the constant-gauge
> pair, not a lone low number: holding the reading fixed is what makes the point
> unarguable.

---

## Slide 9 — Problem 3: The Auditable Emissions Layer

**On slide:**
- Monthly **CO₂-avoided** report — exportable evidence for LGU / MARINA compliance
  and ESG-linked green financing. **Zero extra sensors** beyond Problems 1 & 2.
- CO₂ is not predicted — it is chemistry: **2.68 kg CO₂ per litre** of marine
  diesel, from carbon mass balance, not a tuned constant.
- The claim that matters is the **baseline**: the vessel vs its *own* recorded
  burn on the *same* route before Marine-AI. Not a fleet average. A month that
  burned more reports as **negative**, not floored at zero.

**Speaker notes:** An "AI emissions model" that multiplied litres by a constant
and called it a prediction would be the least defensible thing we could build. So
we don't. The accuracy of the emissions report is inherited, transparently, from
the accuracy of the fuel model.

The line to land: **the report refuses to flatter you.** A voyage with no
baseline contributes its fuel and its CO2 to the totals but *not* to the avoided
figure, and the report names how many voyages that was. A month that burned more
than baseline reports as negative. Both of those make the headline number
smaller, and both are why the number is worth anything.

> **Build status note (delete before pitch):** built and demonstrable as of
> 2026-07-26. `POST /voyages` records each crossing on arrival,
> `GET /emissions/report.csv` is the export, and there is an "Export month" link
> on the display. Live run: four crossings, the first three establish the route
> history and honestly report **no baseline**, the fourth is measured against the
> median of its own three priors — 2.841 L baseline vs 1.529 L actual,
> **+3.52 kg CO2 avoided**, method `own_prior_route`. Demo it in that order; the
> first three "no baseline" rows are the point, not a defect.

**Serves:** Feasibility & Scalability (the only deliverable aimed at the LGU / MARINA /
green-finance stakeholder — a third of the problem statement).

---

## Slide 10 — Route Optimization: shared cost, real constraints

**On slide:**
- Candidate tracks (direct great-circle + lateral offsets) → each leg costed
  through the **same** throttle optimiser as Speed. A one-leg route agrees with
  the throttle advisor **to 1e-6** (enforced by test).
- Hard constraints: **charted depth** (a shorter track over a shoal is rejected,
  not costed) and **forecast wave height**.
- Honest baseline delta: savings = direct-route burn − planned-route burn, shown
  with its real sign.
- The forecast behind every leg is **trained on 2.5 years of real Open-Meteo
  reanalysis data**, not a hand-tuned field: gradient-boosted regression for
  wind/wave direction, a climatological lookup table for the rest — whichever
  won, per target, on six months of held-out weather. `forecast_source` says
  `"gbm_climatology"` on every response that used it.

**Speaker notes:** This is where "one fuel model" pays off. Route isn't a second,
disconnected product with its own cost assumptions — it reuses Speed's model
leg-by-leg, so a judge can't find two numbers that disagree. The forecast
question is the other one worth being ready for: "did you train the Temporal
Fusion Transformer?" The honest answer is better than a yes — a TFT forecasts
from recent observed history, and this endpoint has none to give it (no live
weather feed is wired into route planning, by design). What trains instead is
a position-and-time regression, and even that wasn't shipped as one
architecture: nine targets were raced against a climatological lookup table on
held-out real weather, and the table won on five of them. Both halves shipped.

**Serves:** Innovation & Impact; AI Architecture & Model Fit.

> **Build status note (delete before pitch):** the route engine, its constraints,
> the `POST /route` API and the bridge Route zone that consumes it are built and
> tested (334 tests green). The learned forecaster is **built** as of
> 2026-07-30 (`services/route/train.py`, `docs/DEVIATIONS.md` §13):
> gradient-boosted regression for wind/wave direction plus a climatological
> lookup table for wind/wave/current magnitude and current direction, trained
> and validated against Open-Meteo's real historical archive. `forecast_source`
> now reports `"gbm_climatology"`. **A caveat that got stronger, not weaker,
> after training on real data:** swept across 16 (month, hour) combinations on
> the Muelle-to-Jordan crossing, and separately on a longer 16 nm leg spanning
> the full operating box, `savings_l` came back **zero every time** — 2026-07-30.
> The trained climatology's spatial variation across a ~20 km box is genuinely
> subtler than the analytic field's hand-tuned wind band, which was engineered
> specifically to give the offset search something to find. This is the honest
> cost of training on real data instead of a demo-shaped one: the model is more
> believable and less demoable. Do not promise a nonzero savings figure on
> Route without checking it live first. If the pitch needs one, either find a
> real leg/time that produces one before the sprint, or present the zero
> honestly — "the system checked and confirmed there is nothing to save on this
> crossing today" is a legitimate answer for an advisory system to give, and
> arguably a better one than a system that always finds a number.

---

## Slide 11 — The interface: two seconds on a wet bridge

**On slide (screenshot of the display):**
- Dark, high-contrast, oversized type — read at arm's length, in spray, at 05:40.
- Three zones by glance priority: **Throttle** (largest), **Route**, **Health** —
  all three live, each driven by its own endpoint (`/advise`, `/route`, `/maintenance`).
- Each zone **ages independently and visibly**: a route planned at the dock reads
  in minutes, the throttle advisory in seconds. One shared "last updated" would
  have made a stale throttle number look as trustworthy as a fresh one.
- Persistent trust bar: data freshness, connectivity, and
  **`ADVISORY ONLY — CAPTAIN COMMANDS`**.
- **Filipino is first-class**, not a translation afterthought.

**Speaker notes:** Every design decision falls out of one scene — a captain who
looks at the screen for under two seconds, twice a minute, one hand on the
throttle. Show the four POV modes / helm view here.

**Serves:** Presentation (10%); Innovation & Impact (usability by a non-engineer
captain is the impact claim).

---

## Slide 12 — The AI-authority boundary (ETHICS)

**On slide:**
- **The system never overrides the captain and never actuates the vessel.** Every
  module advises; the captain decides.
- Safety cut-offs are **rule-based and independent of every model**
  (`services/safety/rules.py`, served at `POST /safety`). It imports no model,
  loads no artifact, and holds no state — **a test asserts it can never import
  one**. Same frame, same verdict, forever.
- Thresholds are readable off the page and checkable against an engine manual:
  coolant ≥105 °C, oil pressure ≤100 kPa, bus voltage outside 12.0–15.8 V, EGT
  ≥580 °C. A missing sensor is **reported as skipped, never assumed safe**.
- Language is never imperative: "1650 RPM saves 2.1 L/h", never "reduce to 1650".
- **Claude writes the sentence; it never writes the number.** The rewrite is
  compared against the optimiser's own sentence — same numbers exactly, no
  imperative clause — and thrown away if it differs. `advisory_source` on every
  frame names who wrote what the captain is reading.
- **The model is sized to the job, and we measured it.** Rewriting one
  180-character sentence does not need a frontier model. Both were run on the
  same three advisories: `claude-opus-5` and `claude-haiku-4-5` each passed the
  guard 3/3 with every number preserved, and Haiku was **2.2× faster at ⅕ the
  cost** — so **Haiku is what ships**. The guard is provider-agnostic by design
  — Gemini passes it too — so the layer is a slot, not a dependency.

**Speaker notes:** Under maritime liability the advisory boundary is a legal
requirement, not a stylistic choice. So we did not describe it, we built it: the
safety path is a separate module that consults nothing learned, and the test
suite fails if anyone ever imports a model into it. When you are asked "what
happens when your model is wrong" — this is the answer, and it is the one part
of the system that cannot be wrong in a new way.

Worth saying out loud: opening the throttle raises coolant and exhaust together
and the *health* model correctly stays nominal, while a coolant cutoff fires the
instant the threshold is crossed regardless of what any model thinks. Two
independent judgements, and the threshold always wins.

**The Claude line is the one to slow down on.** Every team at this event will
have an LLM in the stack. The question a technical judge asks is what stops it
from being wrong in public — and "we prompted it carefully" is not an answer.
Ours is: the model is handed a finished sentence and asked to say it better, and
the result is diffed against that sentence before it is displayed. Change a
number, and it is discarded. Open a clause with a command verb, and it is
discarded. The captain sees the deterministic sentence instead, and the panel
says so. That is the difference between an LLM in the product and an LLM in the
decision path, and we are only in the first one.

> **Build status note (delete before pitch):** the safety engine is **built,
> wired and tested** (13 unit + 4 API tests) as of 2026-07-26. The Claude
> advisory layer is **built, wired and tested** as of 2026-07-30
> (`services/advisory/`, 28 tests) across the throttle, route and health
> sentences. It requires `ANTHROPIC_API_KEY` on the deployed API — **without it
> the demo is honest but shows `advisory_source: "template"` throughout**, so
> set the key in the Vercel project before recording the screencast, and check
> `GET /health` reports `"advisory_layer": "claude"`.

**Serves:** Data Strategy & Ethics — 25% of Technical Soundness, so **12.5% of the
total**, more than Presentation is worth.

---

## Slide 13 — Data & models, cited (DATA INTEGRITY — REQUIRED CITATIONS)

**On slide (table):**

| Source | Role | Licence |
|---|---|---|
| UCI *CBM of Naval Propulsion Plants* (gas turbine) | Wear-penalty model, as a **documented proxy** | Open (UCI ML) |
| NASA C-MAPSS | Evaluated for maintenance pretraining; **not used** — the detector learns each vessel's own baseline | US Gov public domain |
| Published marine-diesel BSFC part-load data | Healthy-burn curve | Literature |
| Open-Meteo Marine | Wind / wave / current forecast | CC BY 4.0 |
| GEBCO bathymetry | Depth constraint *(intended; not yet integrated)* | Open |
| Sentinel-2 cloudless (EOX) | Satellite basemap / helm horizon | CC BY 4.0 |
| Natural Earth | Coastline vector | Public domain |

- **Every dataset is public or licensed; no scraped or unlicensed imagery.**
  Google/Bing/Esri tiles were considered and **rejected** on their terms.

**Speaker notes:** The brief grades "use only licensed or public datasets" and
requires external models cited in the deck — this slide is that requirement,
discharged. Note the three honest caveats we lead with: the anchor dataset is a
gas turbine used only for the *dimensionless* wear penalty; GEBCO is intended but
not yet wired; and C-MAPSS is cited because we evaluated it, not because it
trains anything — the Phase 1 detector learns each vessel's own normal instead,
which is the better fit anyway, since a turbofan's degradation modes are not a
marine diesel's.

**Serves:** Data Strategy & Ethics (12.5% of the total); the brief's citation
requirement. Full licence disclosure lives in `docs/THIRD-PARTY.md`.

---

## Slide 14 — We list our own deviations

**On slide:**
- We keep a `DEVIATIONS.md` — every place the build departs from our submitted
  profile, why, and what it costs. Highlights:
  - Fuel model is **hybrid**, not end-to-end XGBoost.
  - Anchor dataset is a **gas turbine** proxy; only the wear penalty transfers —
    borrowing its part-load curve would have overstated savings ~**5× in our favour**.
  - **FEMTO dropped**: it's 25.6 kHz bench data; the spec'd IMU logs at ~1 Hz.
  - Stack: **ONNX** (not TFLite) — 85 MB vs 358 MB runtime; **Supabase** (not
    Timescale); **Open-Meteo** (PAGASA has no public API).

**Speaker notes:** A judge will find these by reading the source. Finding them
here, with the reasoning attached, is a completely different experience from
discovering the paper overstated something. This slide is a trust asset.

**Serves:** Technical Soundness; Ethics/Data Integrity; Q&A defence.

---

## Slide 15 — Feasibility & scalability (PATH TO ADOPTION)

**On slide:**
- **Retrofit, not replacement** — installs on boats already in service; the whole
  addressable fleet is reachable without new hulls.
- **Who pays, and why they say yes:** the kit is bought out of the fuel it saves.
  The operator's decision is a payback period, not a capital purchase.
- Three stakeholders, three surfaces: captain (bridge screen), owner/cooperative
  (savings + emissions report), LGU/MARINA/ESG lenders (exported evidence) — and
  the third is what makes this fundable rather than merely useful.
- Runs as a **serverless function** (85 MB serving image) — cheap to operate,
  same argument for an on-vessel edge unit.

**Speaker notes:** This criterion is now explicitly about *path to adoption,
sustainability as a venture, and capacity to scale beyond the prototype* — so
lead with the business mechanism, not the technology. We're not asking an
operator to buy a boat; we're asking them to bolt on a sensor kit that pays for
itself in fuel, and the emissions report gives a cooperative or lender a reason
to underwrite the kit up front.

Be ready for the venture question: who buys the first hundred units, and what
does the second year look like. The honest framing is a cooperative-level sale —
one operator with a dozen boats — rather than a hundred individual captains,
because the emissions evidence has value at the fleet level where an LGU or
lender is already looking.

**Serves:** Feasibility & Scalability (25%).

---

## Slide 16 — Scalability & roadmap

**On slide:**
- Per-vessel **calibration**: the physics coefficients fit to each boat's own
  fuel-flow meter (`calibrate_admiralty`) — the model becomes a model of *that* boat.
- Fleet path: same schema scales from one boat to a cooperative's fleet; SQL is
  portable to TimescaleDB when volume justifies it.
- Near-term: wire GEBCO depth; train the route forecaster on the Open-Meteo
  archive; fit per-vessel health baselines from logged telemetry in place of the
  demo default; PAGASA integration via data-sharing.
- Longer-term: AIS traffic avoidance (reserved in the contract today).

**Speaker notes:** Everything on the roadmap is a *named seam in the code today*,
not a wish. The forecaster loads through one function; AIS has a reserved contract
field; depth has a provider protocol. Scaling is wiring, not rewriting.

Note the scaling limit honestly if asked: the route forecaster is trained on a
9-point grid over one strait, so a new region is a retraining task on the same
pipeline — not a code change, but not free either. `DATA.md` §Representativeness
states this unprompted, which is the better place for a judge to find it than in
your answer to a hostile question.

**Serves:** Feasibility & Scalability (25%); Innovation & Impact (15%).

---

## Slide 17 — Team & close

**On slide:**
- Team SOLMATE — roles.
- One line: *"Marine-AI: less fuel, fewer breakdowns, and the receipts to prove
  it — on the boats that are already out there."*
- **Live demo: solmate-marine-ai.vercel.app** · repo · screencast · this deck.

**Speaker notes:** Close on the retrofit promise and the honesty posture. Invite
the Q&A — the deviations slide means we welcome the hard questions.

---

## Appendix / backup slides (for Q&A, not in the main flow)

- **A1 — Fuel model math:** the BSFC bathtub curve, the derived (not chosen)
  enrichment coefficient, the idle-burn floor.
- **A2 — Why ONNX earned its keep:** 358 MB → 85 MB; export gated at 1e-4 drift
  (observed 1.5e-6).
- **A3 — Route costing detail:** candidate sweep, per-leg optimiser reuse, the
  1e-6 agreement test.
- **A4 — The wear→fuel bridge:** EGT-excess-over-baseline as the wear signal
  (**r = 0.97–0.997 at fixed load**, mean 0.986 across the seven load points),
  ratio-against-healthy to cancel boundary bias. Say "at fixed load" out loud:
  pooled across loads r is 0.86, because load moves both variables, and that is
  exactly why `load_fraction` is the model's second feature rather than a
  nuisance to be averaged away.
- **A5 — Full deviations table** (12 deliberate departures from `DEVIATIONS.md`,
  plus the "Still outstanding" table of what is not built yet). Bring both. The
  second one is the harder slide and the more convincing one.
- **A6 — The safety path:** the rule table, the thresholds, and the test that
  fails if a model is ever imported into it.

---

## Pre-submission checklist

**From the brief:**

- [ ] Demo URL resolves and is reachable by a signed-out visitor (Vercel
      Deployment Protection **OFF**).
- [ ] **Video screencast of the AI in action** recorded and shareable.
- [ ] External models **cited in the deck** (Slide 13). ✔ scaffolded
- [ ] Hardware use **declared in the deck** (Slide 4). ✔ scaffolded (declared none)
- [ ] Every number on Slides 6–10 matches the code and `docs/DATA.md`. ✔ reconciled
      2026-08-03
- [ ] Build-status notes on Slides 8 & 10 resolved to what is actually true at
      sprint time.

**From the on-site orientation slides (2026-08-03) — these are new:**

- [ ] Repository is **private** on GitHub. ✔ done 2026-08-03
- [ ] Repository named `AIHackathon2026_TeamName_ProjectTitle`.
- [ ] Organizers added as viewers: **https://github.com/aifesthackathon**
- [ ] Repository link shared with the organizing team.
- [ ] **Progressive commits** throughout development — no bulk upload at the end.
- [ ] README contains all four required sections: project overview and
      objectives · problem statement and AI-based solution · AI tools, frameworks
      and datasets used · setup and run instructions. ✔ done 2026-08-03
- [ ] All data sources declared with metadata (origin, format, purpose,
      preprocessing). ✔ `docs/DATA.md`
- [ ] Potential biases disclosed with attempted mitigations.
      ✔ `docs/DATA.md` §Representativeness and bias
- [ ] All external resources documented and disclosed.
      ✔ `docs/THIRD-PARTY.md`

> **The private-vs-public tension is unresolved and needs an organizer's answer.**
> The orientation slide says create a *private* repository with organizers as
> viewers; the brief PDF says every submission link must be public or it is
> immediate disqualification. The most likely reading is that the *development
> repo* is private and the *demo URL* is public — but "most likely" is not good
> enough for a disqualification criterion. Ask, and record the answer here.
