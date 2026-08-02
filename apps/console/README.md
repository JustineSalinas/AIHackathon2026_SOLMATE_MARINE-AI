# Navigation console

Chart, pathfinder and voyage simulation for planning a crossing: draggable ports,
an A\*/D\* Lite/RRT water-mask pathfinder, live Open-Meteo metocean, OpenSeaMap
seamarks, an offline service worker and a guided tour.

**No decision in this app is made here.** Every recommended number comes from the
Python API in [`apps/api`](../api): `services/speed/optimizer.py` picks the RPM,
`services/route/planner.py` picks the track. `server.ts` translates between this
console's wire shape and the API's contract and does nothing else.

## Running it

The API must be up first — the console shows "OPTIMISER OFFLINE" and blanks its
readouts without it, by design.

```bash
# terminal 1, from the repo root
uvicorn apps.api.main:app --reload

# terminal 2
cd apps/console
npm install
npm run dev            # http://localhost:3200
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `MARINE_AI_API_URL` | `http://127.0.0.1:8000` | Where the optimiser lives. |
| `PORT` | `3200` | Console port. Not 3000 — that is usually taken. |
| `MARINE_AI_API_TIMEOUT_MS` | `8000` | Give-up time on an API call. |

There is no API key of any kind in this app.

## What changed from the AI Studio build

This started as a Google AI Studio app in which a language model computed the
throttle percentage, chose the route waypoints, graded the pathfinder's
trajectory out of 100, and web-searched the engine's specifications. Those four
endpoints are gone.

| Was | Is now |
| --- | --- |
| `POST /api/ai-optimize` — Gemini returned a throttle % | `POST /api/advise` → `optimise_throttle` |
| `POST /api/ai-waypoints` — Gemini invented waypoints | `POST /api/route` → `plan_route` |
| `POST /api/ai-review-route` — Gemini graded the path B− | `POST /api/route`; the panel shows the planner's own constraint notes |
| `POST /api/extract-engine-specs` — Gemini web-searched a datasheet | `POST /api/engine-specs` → a committed reference table |

Three displayed numbers were fabricated and are now measured or blank:

- **Fuel saving %** was `15.0 + Math.random() * 5 + 3 - penalty`. It is now
  `savings_l` from the planner, which costs the chosen track and the direct
  track through the same fuel model. In flat weather it correctly reads `0.0%`.
- **Route grade / safety / efficiency scores** were invented by the model. The
  panel now shows planned burn, achievable crossing time, and which constraints
  bound the route.
- **Waypoint "Speed Rec: 15 kts"** was a hardcoded literal. It now shows the
  planner's per-leg RPM, or a dash.

## Where the language model still is

One place: `services/advisory/phraser.py`, which re-words the sentence the
optimiser already wrote into plainer English and Filipino. Every rewrite is
checked by `services/advisory/guard.py` — the number set must be identical to
the template's and the mood must not be imperative — and discarded if it fails.
The Throttle Advisory card labels each sentence `phrasing: Claude` or
`phrasing: template` so the display never implies more than happened.

## Known gaps

- **Live GNSS and IMU.** `src/main.js` still calls
  `navigator.geolocation.watchPosition` and listens for `deviceorientation` in
  the Live Trip feature. The repo's hardware declaration says telemetry is
  simulated. Either the declaration needs a sentence about browser sensors or
  the feature needs to go — a deck decision, not a code one.
- **Health and safety are not on this screen.** `POST /maintenance` and
  `POST /safety` exist on the API and have no panel here. The bridge display in
  [`apps/bridge`](../bridge) has both.
- **No test runner.** Like `apps/bridge`, this app has no unit tests; the API
  contract it depends on is covered on the Python side.
