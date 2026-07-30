# Deploying the demo

The submission requires a **public Demo URL**, and private or restricted links
are an immediate disqualification. This page is the runbook.

The Demo URL is the **bridge display**. That is the page a judge opens.

---

## The thing that breaks this

The demo is **two deployables**, and only one of them is a website:

```
  apps/bridge   Next.js display   -> the Demo URL
  api/index.py  FastAPI advisory  -> everything the display shows
```

The display computes no physics. Speed, burn, recommended RPM and CO2 all come
from `POST /advise`. If the API is unreachable the page renders, ages its data,
and shows `ADVISORY OFFLINE` — correct behaviour at sea, and a dead demo for a
judge, because on first load there is no last-known value to fall back on.

Two independent things cause that, and both are silent:

1. **`NEXT_PUBLIC_API_URL` unset** → the bundle ships with `http://localhost:8000`,
   which on a judge's machine is their own computer.
2. **An `http://` API** → a page served over HTTPS may not call plain HTTP.
   Browsers block it as mixed content. The API must be HTTPS.

`NEXT_PUBLIC_*` is inlined at **build** time. Changing it in the dashboard does
nothing until you redeploy.

---

## Two Vercel projects, one repository

Both from `github.com/JustineSalinas/MARINE-AI---National-AI-Hackathon---AI-Fest`.

| Project | Root Directory | Serves | Config |
|---|---|---|---|
| `marine-ai` | `apps/bridge` | The display — **this is the Demo URL** | auto-detected Next.js |
| `marine-ai-api` | *(repository root)* | `POST /advise`, `GET /health` | `vercel.json` |

Vercel reads `vercel.json` from each project's Root Directory, so the root
config applies only to the API project and the Next app is untouched by it.

### 1. The API

```bash
vercel link          # scope to a NEW project, e.g. marine-ai-api
vercel --prod        # note the URL it prints
```

Root Directory stays the repository root. `vercel.json` handles the rest:
every path rewrites to `api/index.py`, which exposes the FastAPI app.

Verify before going further — this must return JSON with
`"wear_model_loaded": true`:

```bash
curl https://marine-ai-api.vercel.app/health
```

If `wear_model_loaded` is `false`, `models/fuel_degradation.onnx` did not reach
the deployment. It is committed on purpose (see `.gitignore`); regenerate with
`python -m services.speed.train` and push.

### 2. The display

```bash
cd apps/bridge
vercel link          # a SECOND project, e.g. marine-ai
```

Set **Root Directory = `apps/bridge`** in Project Settings, then set the
environment variable for Production **and** Preview:

```
NEXT_PUBLIC_API_URL = https://marine-ai-api.vercel.app
```

```bash
vercel --prod
```

### 3. Point the API back at it

On the API project:

```
MARINE_AI_CORS_ORIGINS = https://marine-ai.vercel.app
```

Preview deployments get a new hostname on every push, so the API also accepts
`https://*.vercel.app` by default (`MARINE_AI_CORS_ORIGIN_REGEX`). The API is
public, unauthenticated and read-only, so this concedes nothing that `/advise`
does not already return to anyone who asks.

### 4. The Claude advisory layer (optional, but wanted for the demo)

Still on the API project:

```
ANTHROPIC_API_KEY = sk-ant-...
```

Unset, the system is fully functional but every advisory sentence ships as
`advisory_source: "template"` — correct, not broken, but not what the deck
promises. Set the key and redeploy the API project (env vars only apply to new
deployments), then confirm with:

```bash
curl https://marine-ai-api.vercel.app/health
# {"status":"ok","wear_model_loaded":true,"advisory_layer":"claude","advisory_only":true}
```

`ANTHROPIC_MODEL` (default `claude-opus-5`), `MARINE_AI_ADVISORY_TIMEOUT_S`,
`MARINE_AI_ADVISORY_BLOCKING` and `MARINE_AI_ADVISORY_DISABLED` are optional
overrides — see `.env.example`. Nothing here needs the bridge project touched;
the display just renders whichever `advisory_source` the API sends.

---

## Why the API fits in a serverless function

Vercel's Python runtime allows 500 MB. Measured footprints:

| Stack | Size |
|---|---|
| xgboost + scikit-learn + scipy + pandas | 358 MB |
| onnxruntime + numpy | 85 MB |

358 MB fits only barely, and that figure is from Windows wheels — the Linux
`xgboost` wheel bundles `libxgboost.so` and runs larger. Rather than bet a
deadline on a wheel size we do not control, `services/speed/train.py` exports
the model to ONNX and `requirements.txt` installs only the serving stack.

The trainer refuses to write an ONNX file whose predictions differ from the
trained model by more than `1e-4`, so the deployed model is provably the one the
tests validate. Observed drift is `1.5e-6`, which is float32 rounding.

This also makes `docs/DEVIATIONS.md` §5 true rather than aspirational: ONNX
Runtime is the inference path, on the API and on a vessel control unit alike.

---

## Smoke test the live demo

Do this from a machine that is not the build machine, ideally on mobile data,
because it catches exactly the failures a judge would hit.

1. `GET https://marine-ai-api.vercel.app/health` → `"status": "ok"`,
   `"wear_model_loaded": true`.
2. Open the Demo URL. The trust bar must read **LIVE**, not `ADVISORY OFFLINE`.
3. Press **Start voyage**. Speed becomes non-zero and the recommended RPM moves.
4. Raise wind and wave height → speed falls, burn rises. This is the whole
   product claim; if it does not happen, the display is not talking to the API.
5. Cycle all four views. **Helm** must show the Guimaras shoreline.
6. Open the browser console. No CORS errors, no mixed-content warnings.

---

## Checklist before submitting the links

- [ ] GitHub repository is **public** (verified 2026-07-22: it is)
- [ ] Demo URL loads for a signed-out visitor in a private window
- [ ] Vercel **Deployment Protection is off** on the display project — it is on
      by default for some plans and makes the URL 401 for anyone not logged in,
      which is exactly the restricted-access case that disqualifies
- [ ] Video screencast link is public and unlisted-not-private
- [ ] `README.md` setup instructions work from a fresh clone
