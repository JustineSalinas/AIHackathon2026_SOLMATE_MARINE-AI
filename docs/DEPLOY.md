# Deploying the demo

The submission requires a **public Demo URL**, and private or restricted links
are an immediate disqualification. This page is the runbook.

The Demo URL is the **navigation console** (`apps/console`). That is the page a
judge opens. The bridge display is the captain's two-second instrument and is
deployed alongside it as a second, linked surface — see §3.

> **Changed 2026-08-03.** This runbook previously named `apps/bridge` as the Demo
> URL. The team's decision is console-as-demo, bridge-as-captain-view; if you are
> following a printout older than that, this line is the one that moved.

---

## The thing that breaks this

The demo is **three deployables**, and only two of them are websites:

```
  apps/console  Vite SPA + Express  -> the Demo URL
  apps/bridge   Next.js display     -> the captain view, linked from the deck
  api/index.py  FastAPI advisory    -> every number both of them show
```

**Neither front end computes any physics.** Speed, burn, recommended RPM, the
route and the CO2 all come from the API. Deploy either page without a reachable
API and it renders perfectly and says nothing: the console shows
`OPTIMISER OFFLINE` and dashes, the bridge shows `ADVISORY OFFLINE`. Both are
correct behaviour at sea and a dead demo for a judge, because on first load
there is no last-known value to fall back on.

Three independent things cause it, and all three are silent:

1. **The API URL is unset** → the front end falls back to `localhost:8000`,
   which on a judge's machine is their own computer. Console:
   `MARINE_AI_API_URL`, read per request. Bridge: `NEXT_PUBLIC_API_URL`,
   **inlined at build time** — changing it in the dashboard does nothing until
   you redeploy.
2. **An `http://` API** → a page served over HTTPS may not call plain HTTP.
   Browsers block it as mixed content. The API must be HTTPS.
3. **CORS not pointed back** → the browser blocks the response after a
   successful request, which looks identical to the API being down. See §4.

---

## Three Vercel projects, one repository

All from `github.com/JustineSalinas/AIHackathon2026_SOLMATE_MARINE-AI`.

> Renamed 2026-08-03 to the format the hackathon rules require
> (`AIHackathon2026_TeamName_ProjectTitle`), and switched to **private** with
> `github.com/aifesthackathon` added as a viewer. GitHub redirects the old URL,
> so an existing clone keeps working — but run
> `git remote set-url origin <new URL>` anyway rather than depending on a
> redirect. **The repository being private does not make the deployed demo
> private**: Vercel deploys from a private repo perfectly well, and the Demo URL
> must still be reachable by a signed-out visitor.

> **Deployed 2026-08-03. The live hostnames are:**
>
> | What | URL | Status |
> |---|---|---|
> | **Demo URL** (submit this) | `https://solmate-marine-ai.vercel.app` | live |
> | Advisory API | `https://marine-aisolmate-marine-ai-api.vercel.app` | live |
> | Captain view (bridge) | `https://solmate-marine-ai-bridge.vercel.app` | live |
>
> **Deployed 2026-08-04, and it is not optional any more.** The Phase 1
> predictive-maintenance detector is only reachable from this surface: the
> console never calls `/maintenance` (its engine strip is a local threshold on a
> locally computed health score). Without the bridge deployed, the one module the
> deck sells as AI-driven maintenance has no demonstrable front end.
>
> ⚠️ **`NEXT_PUBLIC_API_URL` was set with a BOM on the first attempt and every
> API call 404'd.** Piping a value into `vercel env add` from PowerShell prepends
> a UTF-8 BOM, so the URL became `%EF%BB%BFhttps://…` — a *relative* path — and
> the bridge showed ADVISORY OFFLINE while looking perfectly healthy otherwise.
> `$OutputEncoding` does not fix it. What works is a BOM-less file plus cmd
> redirection:
>
> ```powershell
> [System.IO.File]::WriteAllText($f, $url, (New-Object System.Text.UTF8Encoding $false))
> cmd /c "vercel env add NEXT_PUBLIC_API_URL production < `"$f`""
> ```
>
> Verify by loading the page and reading the network panel: the requests must go
> to `https://marine-aisolmate-…/advise`, not to a path under the bridge's own
> host.
>
> **The API hostname is mangled and that is not a typo.** `vercel link`
> pre-fills the project-name field and appends what you type, so `marine-ai` +
> `solmate-marine-ai-api` became one string. Renaming the project afterwards did
> **not** move the domain: `solmate-marine-ai-api.vercel.app` returns
> `DEPLOYMENT_NOT_FOUND`. The mangled host is the one that resolves, so it is
> what `MARINE_AI_API_URL` must point at. Clear the field before typing if you
> ever rebuild these projects.

| Project | Root Directory | Serves | Config |
|---|---|---|---|
| `solmate-marine-ai` | `apps/console` | The console — **this is the Demo URL** | `apps/console/vercel.json` |
| `solmate-marine-ai-api` | *(repository root)* | `/advise`, `/route`, `/maintenance`, `/safety`, `/health` | `vercel.json` |
| `solmate-marine-ai-bridge` | `apps/bridge` | The captain view | auto-detected Next.js |

> **Do not use the names `marine-ai` or `marine-ai-api`.** Checked live on
> 2026-08-01: `marine-ai-api.vercel.app` 404s (never deployed) and
> `marine-ai.vercel.app` returns **200 for somebody else's application** — a
> prerendered Next.js site with a three-week cache age. `<project>.vercel.app` is
> globally unique, so those names are simply taken. Following an older printout
> of this file will point the console at a stranger's site.

Vercel reads `vercel.json` from each project's Root Directory, so the root
config applies only to the API project, `apps/console/vercel.json` only to the
console, and the Next app is untouched by both.

### 1. The API

```bash
vercel link          # scope to a NEW project: solmate-marine-ai-api
vercel --prod        # note the URL it prints
```

Root Directory stays the repository root. `vercel.json` handles the rest:
every path rewrites to `api/index.py`, which exposes the FastAPI app.

Verify before going further — this must return JSON with
`"wear_model_loaded": true`:

```bash
curl https://solmate-marine-ai-api.vercel.app/health
```

If `wear_model_loaded` is `false`, `models/fuel_degradation.onnx` did not reach
the deployment. It is committed on purpose (see `.gitignore`); regenerate with
`python -m services.speed.train` and push.

**One thing the API cannot do on Vercel: keep voyages.** `packages/store` writes
SQLite, `open_store` degrades to an in-memory store on a read-only filesystem,
and nothing in the repo reads `DATABASE_URL` — there is no Postgres backend, so
the Supabase credentials in `.env` change nothing here. The store is therefore
per-instance and empty after every cold start, which means **the emissions
demo — three crossings with no baseline, then a fourth measured against their
median — does not reproduce on the deployed API.** The report is still correct
and still says `durable=False`; there is just never any history for it to
measure against. Demo emissions locally, or wire a Postgres store first.

### 2. The console — the Demo URL

```bash
cd apps/console
vercel link          # a SECOND project: solmate-marine-ai
```

Set **Root Directory = `apps/console`** in Project Settings, then set this for
Production **and** Preview:

```
MARINE_AI_API_URL = https://solmate-marine-ai-api.vercel.app
```

```bash
vercel --prod
```

`apps/console/vercel.json` builds the Vite bundle and the WASM, serves `dist/`
from Vercel's static layer, and rewrites only `/api/*` to the Express app in
`apps/console/api/index.ts`. The app itself lives in `apps/console/app.ts` — the
serverless function imports it and never calls `listen`, which is why that split
exists.

**`MARINE_AI_API_URL` is read per request, not baked in.** Change it in the
dashboard and the next request picks it up; no redeploy. This is the one place
the console is easier to operate than the bridge.

### 3. The bridge — the captain view

```bash
cd apps/bridge
vercel link          # a THIRD project: solmate-marine-ai-bridge
```

Root Directory `apps/bridge`, then:

```
NEXT_PUBLIC_API_URL = https://solmate-marine-ai-api.vercel.app
```

```bash
vercel --prod
```

⚠️ **`NEXT_PUBLIC_*` is inlined at BUILD time.** Changing it in the dashboard
does nothing until you redeploy. Set it *before* the first production build, or
build twice. This has already cost one silent failure.

### 4. Point the API back at both

On the API project:

```
MARINE_AI_CORS_ORIGINS = https://solmate-marine-ai.vercel.app,https://solmate-marine-ai-bridge.vercel.app
```

Preview deployments get a new hostname on every push, so the API also accepts
`https://*.vercel.app` by default (`MARINE_AI_CORS_ORIGIN_REGEX`). The API is
public, unauthenticated and read-only, so this concedes nothing that `/advise`
does not already return to anyone who asks.

### 5. The Claude advisory layer (optional, but wanted for the demo)

Still on the API project:

```
ANTHROPIC_API_KEY = sk-ant-...
```

Unset, the system is fully functional but every advisory sentence ships as
`advisory_source: "template"` — correct, not broken, but not what the deck
promises. Set the key and redeploy the API project (env vars only apply to new
deployments).

**Do not verify this with `/health`.** It reports the layer as enabled whenever a
key string is present — it does not spend a token, so it cannot tell a working
key from an expired one, a typo, or an account with no credit balance. All three
fail identically and silently: the guard falls through, the deterministic
template ships, and the display looks entirely healthy. Verified on 2026-08-01
against a valid key on an unfunded account — `/health` said `"claude"` while
every single call was returning HTTP 400.

The only check that proves it is a round trip that costs a token:

```bash
curl -s -X POST https://<api-host>/advise \
  -H 'content-type: application/json' -d '{}' \
  | grep -o '"advisory_source":"[a-z]*"'
# want: "advisory_source":"claude"
```

`"template"` here means the layer is not working, whatever `/health` claims.
Check the function logs — the phraser logs the underlying error before it
degrades. Note that off Vercel the rewrite is fetched in the *background* and the
template ships immediately, so this check only means anything against the
deployed API (or locally with `MARINE_AI_ADVISORY_BLOCKING=1`).

`ANTHROPIC_MODEL` (default `claude-haiku-4-5`), `MARINE_AI_ADVISORY_TIMEOUT_S`,
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

1. `GET https://<api-host>/health` → `"status": "ok"`,
   `"wear_model_loaded": true`.
1. `POST https://<api-host>/advise` with `{}` → `"advisory_source": "claude"`.
   This is the only check that proves the Claude layer works; `/health` cannot.
   See §5 — a valid key on an unfunded account passes `/health` and fails here.
2. Open the **Demo URL** (the console). Route Status must not read
   `OPTIMISER OFFLINE`, and the Throttle Advisory card must show an RPM rather
   than a dash. A dash there means the console reached Vercel but not the API.
3. Place both ports, press **Start**. The vessel moves and the advisory RPM
   updates.
4. Raise wind and wave height → burn rises and the advised RPM moves. This is
   the whole product claim; if it does not happen, the console is not talking
   to the API.
5. Hard-reload once (Ctrl-Shift-R). The service worker is network-first for
   HTML, so you must get the *current* build — if you see an old one, the
   deploy did not replace `sw.js`.
6. Open the **bridge** URL. The trust bar must read **LIVE**, not
   `ADVISORY OFFLINE`; cycle all four views, and **Helm** must show the
   Guimaras shoreline.
7. Open the browser console on both. No CORS errors, no mixed-content warnings.

---

## Checklist before submitting the links

- [ ] GitHub repository is **private**, with `github.com/aifesthackathon` added
      as a viewer. Confirmed with the organizers 2026-08-03: private is what
      they want, and the "public or immediate DQ" rule applies to the **demo
      URL** only. Verify the collaborator invite is *accepted*, not merely sent
      — a private repo the judges cannot open scores the same as no repo
- [ ] **Everything is pushed.** The repo is a graded deliverable in its own
      right ("clean, documented source code"), and an unpushed working tree is
      the failure mode this project has actually had — on 2026-08-03 the remote
      was three days behind and did not contain `apps/console`, the
      advisory layer, or the `anthropic` dependency the deck cites.
- [ ] Demo URL loads for a signed-out visitor in a private window
- [ ] Vercel **Deployment Protection is off on all three projects** — it is on
      by default for some plans and makes the URL 401 for anyone not logged in,
      which is exactly the restricted-access case that disqualifies
- [ ] Video screencast link is public and unlisted-not-private
- [ ] The deck's Slide 1 and Slide 17 carry the real hostnames, not the
      placeholders
- [ ] `README.md` setup instructions work from a fresh clone
