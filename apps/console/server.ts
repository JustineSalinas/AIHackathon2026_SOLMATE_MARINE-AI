/**
 * Local runner for the navigation console.
 *
 * The app itself lives in `app.ts`; this file only decides how to serve it and
 * opens a port. Vercel imports the app through `api/index.ts` and never runs
 * this file — which is the whole reason the two are separate. See the header of
 * `app.ts`.
 *
 *   npm run dev     tsx server.ts, Vite in middleware mode, HMR
 *   npm start       node dist/server.cjs, static files from dist/
 */

import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { createApp } from "./app";

/** Not 3000: that port is commonly already taken by another dev server. */
const PORT = Number(process.env.PORT || 3200);

async function startServer() {
  const app = createApp();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Navigation console on http://localhost:${PORT}`);
    console.log(
      `Optimiser (decides every number): ${process.env.MARINE_AI_API_URL || "http://127.0.0.1:8000"}`,
    );
  });
}

startServer();
