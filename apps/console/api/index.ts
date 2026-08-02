/**
 * Vercel entry point.
 *
 * Vercel runs this as a function and calls the exported Express app once per
 * request; it never calls `listen`, which is why the app is built in `app.ts`
 * rather than inside the local runner in `server.ts`.
 *
 * `vercel.json` rewrites only `/api/*` here. Everything else — index.html, the
 * hashed Vite bundles, the WASM, the service worker — is served by Vercel's own
 * static layer straight out of `dist/`, so the function is not in the path for
 * a page load.
 *
 * `MARINE_AI_API_URL` is read at REQUEST time by `app.ts`, not baked in at
 * build time. Changing the optimiser's URL in the Vercel dashboard therefore
 * takes effect on the next request with no redeploy — unlike the bridge's
 * `NEXT_PUBLIC_API_URL`, which is inlined into the bundle at build and has
 * silently served a stale value before.
 */

import { createApp } from "../app";

export default createApp();
