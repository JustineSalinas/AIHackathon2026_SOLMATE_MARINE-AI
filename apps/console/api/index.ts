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

// The `.js` extension is required and is not a typo. This package is
// `"type": "module"`, so Vercel compiles this file to real ESM and Node's
// resolver does not guess extensions -- an extensionless `"../app"` deploys
// cleanly and then fails on every request with:
//
//   ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/app'
//
// which is invisible locally, because `tsx` (dev) and `esbuild --bundle`
// (build) both resolve extensionless paths happily. Writing `.js` while the
// source is `.ts` is the normal TypeScript-ESM spelling: the compiler maps it
// back to `app.ts`, and the emitted import matches the emitted file.
import { createApp } from "../app.js";

export default createApp();
