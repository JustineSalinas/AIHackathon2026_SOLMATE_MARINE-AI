/**
 * Navigation console backend — the Express app itself.
 *
 * Split from `server.ts` so the same app can be served three ways without a
 * second copy of the translation layer: `tsx server.ts` locally, a bundled
 * Node process in a container, and a serverless function on Vercel
 * (`api/index.ts`). A serverless runtime imports the app and calls it per
 * request -- it never gets to call `listen`, so the listener cannot live in
 * the same function that builds the routes.
 *
 * This file used to hold four Gemini prompts: one that asked a language model
 * for a throttle percentage, one that asked it for waypoints, one that asked it
 * to critique a path and emit corrected waypoints, and one that asked it to
 * search the web for engine specifications. All four are gone.
 *
 * **Nothing here decides anything.** Every number this server returns was
 * computed by the Python API in `apps/api`: `optimise_throttle` picks the RPM,
 * `plan_route` picks the track. This process translates between the console's
 * wire shape and the API's contract, and that is all it does. The one place a
 * language model still appears in the system is `services/advisory/phraser.py`,
 * which re-words a sentence the optimiser already wrote and is checked by
 * `services/advisory/guard.py` -- same numbers, no imperative mood, or the
 * rewrite is discarded. Its verdict rides on every response as
 * `advisorySource`, so the display can say which wrote the line it is showing.
 *
 * Two consequences worth knowing before editing:
 *
 * **A throttle percentage is derived, not decided.** The optimiser works in RPM
 * because the fuel model does; this console's gauges are in percent of rated.
 * The conversion lives in `throttlePctFromRpm` and nowhere else, so the two
 * units cannot drift apart the way they would if each call site did its own
 * arithmetic.
 *
 * **Sea-state safety is not this endpoint's job.** `/api/advise` returns
 * `scheduleFeasible`, which means "the engine can hold the requested ETA" -- not
 * "it is safe to sail". The abort rule stays client-side in `analyzeSafety`,
 * deterministic and visible, and the rule-based cutoffs live behind the Python
 * `/safety` endpoint, which needs a telemetry frame this console does not yet
 * produce. Do not merge the two flags: one is a schedule, the other is a hull.
 */

import express from "express";
import path from "path";

/** Where the deterministic modules live. Everything numeric comes from here. */
const API_URL = (process.env.MARINE_AI_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

/** Not 3000: that port is commonly already taken by another dev server. */
const PORT = Number(process.env.PORT || 3200);

const API_TIMEOUT_MS = Number(process.env.MARINE_AI_API_TIMEOUT_MS || 8000);

/** Marine gas oil, grams per litre. Used only to express burn as an SFOC. */
const MGO_G_PER_L = 840.0;
/** Lower heating value of MGO, MJ/kg. */
const MGO_LHV_MJ_PER_KG = 42.7;

const KW_PER_HP = 0.7457;
const KM_PER_NM = 1.852;

/**
 * The demo vessel, in the API's own field names.
 *
 * These are the committed figures from `apps/bridge/lib/vessel.ts` -- the same
 * hull the bridge display advises on. Two apps in one repo quoting two different
 * boats would make "one fuel model" untrue at the first question a judge asks,
 * so if this needs to change it changes in both places or in neither.
 */
const DEMO_VESSEL = {
  vessel_id: "MV-SOLMATE-01",
  length_waterline_m: 11.5,
  beam_m: 2.8,
  draft_m: 1.1,
  displacement_kg: 8500.0,
  rated_kw: 90.0,
  rated_rpm: 2800.0,
  admiralty_coefficient: 70.0,
  best_bsfc_g_per_kwh: 215.0,
  idle_burn_lph: 1.2,
};

type Vessel = typeof DEMO_VESSEL;

/** Degrees into [0, 360). The API rejects anything outside it, and the console's
 * forecast interpolation can hand back a negative bearing after a wrap. */
function norm360(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return ((n % 360) + 360) % 360;
}

function nonNegative(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Percent of rated RPM.
 *
 * The console's throttle gauge is a percentage and the optimiser's answer is an
 * RPM; this is the only place the two meet. It is a linear map on purpose -- it
 * is a gauge reading, not a claim about the fuel curve, which is emphatically
 * not linear and lives in Python.
 */
function throttlePctFromRpm(rpm: number, ratedRpm: number): number {
  if (!(ratedRpm > 0)) return 0;
  return Math.max(0, Math.min(100, (rpm / ratedRpm) * 100));
}

/**
 * Realised specific fuel consumption, g/kWh, from burn and shaft power.
 *
 * Derived arithmetic on two numbers the API returned, not a second model. Shown
 * because "how hard is this engine working per unit of fuel" is the question the
 * engine panel exists to answer, and because it is checkable by hand.
 */
function sfocFrom(litresPerHour: number, shaftKw: number): number | null {
  if (!(shaftKw > 0) || !(litresPerHour > 0)) return null;
  return (litresPerHour * MGO_G_PER_L) / shaftKw;
}

/** Brake thermal efficiency implied by an SFOC. 3.6 MJ per kWh over fuel energy in. */
function thermalEfficiencyPct(sfocGPerKwh: number | null): number | null {
  if (sfocGPerKwh === null || !(sfocGPerKwh > 0)) return null;
  const fuelEnergyMj = (sfocGPerKwh / 1000) * MGO_LHV_MJ_PER_KG;
  return (3.6 / fuelEnergyMj) * 100;
}

/**
 * The vessel to advise on.
 *
 * The console builds this in `vesselSpecForApi()` from the hull and engine the
 * operator typed, already in the API's field names. Anything it omits or sends
 * as nonsense falls back to the demo boat field by field rather than as a whole
 * -- a request that is right about the beam and silent about the draft should
 * not silently become a different vessel entirely.
 *
 * `mcrHp` at the top level is still honoured for callers that have only an
 * engine rating, which is the shape the old Gemini endpoints used.
 */
function vesselFrom(body: any): Vessel {
  const vessel = { ...DEMO_VESSEL };
  const sent = body?.vessel ?? {};

  const numeric: (keyof Vessel)[] = [
    "length_waterline_m",
    "beam_m",
    "draft_m",
    "displacement_kg",
    "rated_kw",
    "rated_rpm",
    "admiralty_coefficient",
    "best_bsfc_g_per_kwh",
  ];
  for (const field of numeric) {
    const value = Number(sent[field]);
    if (Number.isFinite(value) && value > 0) {
      (vessel[field] as number) = value;
    }
  }
  // Idle burn is the one field the API accepts at zero.
  const idle = Number(sent.idle_burn_lph);
  if (Number.isFinite(idle) && idle >= 0) vessel.idle_burn_lph = idle;

  if (typeof sent.vessel_id === "string" && sent.vessel_id.trim()) {
    vessel.vessel_id = sent.vessel_id.trim();
  }

  const mcrHp = Number(body?.mcrHp ?? sent.mcrHp);
  if (Number.isFinite(mcrHp) && mcrHp > 0 && !(Number(sent.rated_kw) > 0)) {
    vessel.rated_kw = mcrHp * KW_PER_HP;
  }

  return vessel;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`marine-ai API ${status}: ${detail}`);
  }
}

/**
 * Call the Python API.
 *
 * Failures are not smoothed over. When the optimiser is unreachable the console
 * is told so and says so; it does not substitute a plausible-looking number,
 * because a displayed recommendation that no model produced is the exact failure
 * this whole rewrite exists to remove.
 */
async function callApi<T>(route: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(response.status, text.slice(0, 400));
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

function apiFailure(res: express.Response, route: string, err: unknown): void {
  const detail =
    err instanceof ApiError
      ? err.detail
      : err instanceof Error && err.name === "AbortError"
        ? `no response within ${API_TIMEOUT_MS} ms`
        : String(err);
  console.log(`[marine-ai] ${route} unavailable: ${detail.slice(0, 200)}`);
  res.status(503).json({
    ok: false,
    unavailable: true,
    source: "unavailable",
    route,
    apiUrl: API_URL,
    detail,
    message:
      "Optimiser unreachable. Start the Python API (uvicorn apps.api.main:app) " +
      "or set MARINE_AI_API_URL. No recommendation is shown rather than a guessed one.",
  });
}

/**
 * Engine reference figures, from published manufacturer datasheets.
 *
 * This replaces an endpoint that asked a language model to search the web for
 * an engine's thermal efficiency and SFOC and then fed the answer into every
 * downstream fuel calculation. That is the most dangerous kind of hallucination
 * available to this product: it is invisible, it is numeric, and it propagates
 * into savings figures that end up on a slide.
 *
 * A short committed table is strictly better. It is inspectable, it is the same
 * on every run, and where it is an approximation it says so in a field rather
 * than in prose. `isApproximated` is true for every entry here by construction:
 * these are class-typical published figures, not a survey of the operator's
 * actual engine, and the moment a real vessel is fitted its own datasheet
 * replaces the row.
 */
function engineReference(engineTypeStr: string, mcrHpVal: number) {
  const hp = positive(mcrHpVal, 1200);
  const kw = hp * KW_PER_HP;
  const lowerType = (engineTypeStr || "").toLowerCase();

  const base = {
    engineModel: engineTypeStr || "4-Stroke Marine Diesel",
    thermalEfficiencyPct: 43.5,
    baseSFOC: 195.0,
    optimalLoadMinPct: 75,
    optimalLoadMaxPct: 85,
    fuelType: "Marine Gas Oil (MGO)",
    energyDensityMJkg: 42.7,
    co2Factor: 3.206,
    ratedRpm: 1800,
    bmepBar: 22.0,
    cylinders: "12-Cylinder V-Engine",
  };

  const table: { match: string[]; spec: Partial<typeof base> }[] = [
    {
      match: ["2-stroke", "low speed", "man b&w", "wingd"],
      spec: {
        thermalEfficiencyPct: 52.0,
        baseSFOC: 168.0,
        optimalLoadMinPct: 70,
        optimalLoadMaxPct: 80,
        fuelType: "Heavy Fuel Oil (HFO) / VLSFO",
        co2Factor: 3.114,
        ratedRpm: 105,
        bmepBar: 19.5,
        cylinders: "6-Cylinder Inline Low-Speed 2-Stroke",
        engineModel: "MAN B&W 6S50ME-C Low-Speed 2-Stroke",
      },
    },
    {
      match: ["lng", "dual fuel", "gas"],
      spec: {
        thermalEfficiencyPct: 48.5,
        baseSFOC: 145.0,
        fuelType: "Liquefied Natural Gas (LNG)",
        energyDensityMJkg: 49.0,
        co2Factor: 2.75,
        ratedRpm: 750,
        bmepBar: 21.0,
        cylinders: "8-Cylinder Medium-Speed Dual-Fuel",
        engineModel: "Wärtsilä 34DF Dual-Fuel",
      },
    },
    {
      match: ["methanol"],
      spec: {
        thermalEfficiencyPct: 46.0,
        baseSFOC: 325.0,
        fuelType: "Methanol (Green/E-Methanol)",
        energyDensityMJkg: 19.9,
        co2Factor: 1.375,
        ratedRpm: 500,
        bmepBar: 23.0,
        cylinders: "6-Cylinder Dual-Fuel Methanol",
      },
    },
    {
      match: ["cat", "caterpillar", "c32", "3512", "3516", "c18"],
      spec: {
        thermalEfficiencyPct: 44.2,
        baseSFOC: 192.0,
        bmepBar: 22.8,
        cylinders: "V-12 4-Stroke Marine Engine",
        engineModel: "Caterpillar C32 ACERT Marine Propulsion",
      },
    },
    {
      match: ["yanmar"],
      spec: {
        thermalEfficiencyPct: 43.8,
        baseSFOC: 198.0,
        ratedRpm: 1900,
        bmepBar: 21.5,
        cylinders: "6-Cylinder Inline 4-Stroke Marine",
        engineModel: "Yanmar 6CXBM-GT Marine Engine",
      },
    },
    {
      match: ["cummins", "qsk", "kta"],
      spec: {
        thermalEfficiencyPct: 43.0,
        baseSFOC: 200.0,
        bmepBar: 22.1,
        cylinders: "V-12 Turbocharged Marine Diesel",
        engineModel: "Cummins QSK19-M Marine Engine",
      },
    },
    {
      match: ["volvo", "d13", "d16"],
      spec: {
        thermalEfficiencyPct: 44.5,
        baseSFOC: 191.0,
        bmepBar: 23.5,
        cylinders: "6-Cylinder Inline 4-Stroke Diesel",
        engineModel: "Volvo Penta D13-MH Marine Diesel",
      },
    },
    {
      match: ["wartsila", "wärtsilä", "w20", "w32"],
      spec: {
        thermalEfficiencyPct: 49.0,
        baseSFOC: 178.0,
        optimalLoadMinPct: 72,
        optimalLoadMaxPct: 82,
        fuelType: "Heavy Fuel Oil (HFO) / MGO",
        ratedRpm: 750,
        bmepBar: 25.0,
        cylinders: "8-Cylinder Medium Speed Marine",
        engineModel: "Wärtsilä 20 Medium-Speed Diesel",
      },
    },
    {
      match: ["mtu", "12v2000", "16v2000", "4000"],
      spec: {
        thermalEfficiencyPct: 42.8,
        baseSFOC: 202.0,
        ratedRpm: 2200,
        bmepBar: 24.5,
        cylinders: "12-Cylinder 90° V-Engine",
        engineModel: "MTU 12V2000 M96L Marine Diesel",
      },
    },
  ];

  const hit = table.find((row) => row.match.some((m) => lowerType.includes(m)));
  const spec = { ...base, ...(hit?.spec ?? {}) };
  if (engineTypeStr && !hit) spec.engineModel = engineTypeStr;

  return {
    ...spec,
    summary:
      `Class-typical published datasheet figures for ${spec.engineModel} at about ` +
      `${Math.round(hp)} HP (${Math.round(kw)} kW). These are reference values for an ` +
      `engine of this type, not a survey of this vessel's engine; fit them from the ` +
      `boat's own fuel-flow meter before quoting a saving.`,
    isApproximated: true,
    source: "committed-reference-table",
    sources: [],
  };
}

export function createApp(): express.Express {
  const app = express();

  app.use(express.json());

  /** OpenStreetMap raster proxy. Kept: caching them here is politer than
   * hammering tile.openstreetmap.org from every client. */
  app.get("/api/tiles/:z/:x/:y", async (req, res) => {
    try {
      const { z, x, y } = req.params;
      const response = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
        headers: { "User-Agent": "MarineAI-SOLMATE/1.0 (hackathon prototype)" },
      });
      if (!response.ok) throw new Error("Tile fetch failed");
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(buffer);
    } catch {
      res.status(502).send("Tile unavailable");
    }
  });

  /** Is the optimiser up? The console shows this rather than guessing. */
  app.get("/api/status", async (_req, res) => {
    try {
      const response = await fetch(`${API_URL}/health`, {
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      res.json({ ok: response.ok, apiUrl: API_URL, health: await response.json() });
    } catch (e) {
      res.status(503).json({ ok: false, apiUrl: API_URL, detail: String(e) });
    }
  });

  /**
   * Throttle advice. Was `/api/ai-optimize`, which asked Gemini for a percentage.
   *
   * Now: `services/speed/optimizer.py` sweeps the fuel model and returns the RPM
   * that burns least while holding the requested ETA.
   */
  app.post("/api/advise", async (req, res) => {
    const { conditions = {}, etaHours, currentDistKm, headingDeg, currentRpm } = req.body || {};
    const vessel = vesselFrom(req.body);

    const request = {
      vessel,
      sea: {
        wind_speed_kn: nonNegative(conditions.windSpd, 0),
        wind_direction_deg: norm360(conditions.windDir),
        current_speed_kn: nonNegative(conditions.currentSpd, 0),
        current_direction_deg: norm360(conditions.currentDir),
        wave_height_m: nonNegative(conditions.waveHt, 0),
        wave_direction_deg: norm360(conditions.waveDir),
      },
      heading_deg: norm360(headingDeg),
      distance_remaining_nm: positive(Number(currentDistKm) / KM_PER_NM, 2.0),
      minutes_available: Number.isFinite(Number(etaHours))
        ? positive(Number(etaHours) * 60, 25)
        : null,
      current_rpm: Number.isFinite(Number(currentRpm)) ? nonNegative(currentRpm) : null,
      passenger_count: Math.max(0, Math.round(nonNegative(req.body?.passengerCount, 0))),
      cargo_kg: nonNegative(req.body?.cargoKg, 0),
    };

    try {
      const data: any = await callApi("/advise", request);
      const rec = data.recommendation;
      const sfoc = sfocFrom(rec.predicted_burn_lph, data.power?.total_kw);

      res.json({
        ok: true,
        source: "marine-ai/advise",

        // What the console's gauges read.
        recThrottle: throttlePctFromRpm(rec.recommended_rpm, vessel.rated_rpm),
        recommendedRpm: rec.recommended_rpm,
        recommendedSpeedKn: rec.recommended_speed_kn,
        achievableSpeedKn: data.achievable_speed_kn,
        maxSpeedKn: data.max_speed_kn,

        // The product: the delta.
        currentBurnLph: rec.current_burn_lph,
        predictedBurnLph: rec.predicted_burn_lph,
        savingsLph: rec.savings_lph,
        savingsPhpPerHour: rec.savings_php_per_hour,
        savingsPct:
          rec.current_burn_lph > 0 ? (rec.savings_lph / rec.current_burn_lph) * 100 : null,
        etaImpactMinutes: rec.eta_impact_minutes,

        // The sentence the captain reads, and who wrote it.
        reason: rec.advisory_en,
        advisoryEn: rec.advisory_en,
        advisoryFil: rec.advisory_fil,
        advisorySource: rec.advisory_source,

        // Engine panel, derived from the two numbers above.
        shaftKw: data.power?.total_kw,
        environmentalPenaltyPct: data.power?.environmental_penalty_pct,
        expectedSfoc: sfoc,
        thermalEfficiencyPct: thermalEfficiencyPct(sfoc),
        wearMultiplier: data.wear?.multiplier,
        co2KgPerHour: data.emissions?.co2_kg_per_hour,

        // Schedule, NOT safety. See the note at the top of this file.
        scheduleFeasible: data.feasible,
        notes: data.notes ?? [],
        modelConfidence: rec.model_confidence,
        modelTrained: data.model_trained,
        curve: data.curve ?? [],
      });
    } catch (e) {
      apiFailure(res, "/advise", e);
    }
  });

  /**
   * Engine health. Forwards a window of telemetry to the Phase 1 anomaly
   * detector and returns only what the strip needs.
   *
   * `baselineFrames` is the part that matters. Without it the detector scores
   * this vessel against the served reference engine, and a boat that merely
   * differs -- this console simulates a 24V loom where the reference assumes 12V
   * -- reads as faulty from its first frame, at every throttle setting. That is
   * not a detector working badly; it is a detector correctly answering a
   * question nobody asked. Sending a healthy warm-up window makes "normal" mean
   * this engine's normal.
   *
   * The console holds no opinion about engine health of its own here. It relays
   * the API's score, or it shows nothing -- the same rule the throttle and route
   * panels follow.
   */
  /** null unless the value is genuinely a finite number. Guards the `Number(null) === 0` trap. */
  const numberOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  app.post("/api/maintenance", async (req, res) => {
    const { frames = [], baselineFrames = null, observedHours = null, ratedRpm = null } =
      req.body || {};

    if (!Array.isArray(frames) || frames.length === 0) {
      res.status(400).json({ error: "frames required" });
      return;
    }

    try {
      const upstream = await fetch(`${API_URL}/maintenance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          vessel_id: "MV-CONSOLE-01",
          frames,
          baseline_frames:
            Array.isArray(baselineFrames) && baselineFrames.length ? baselineFrames : null,
          // `Number(null)` is 0, not NaN, so a bare Number.isFinite() check lets
          // a missing value through as zero -- and `rated_rpm` is gt=0, so the
          // whole request 422s. Test for absence first, then for finiteness.
          observed_hours: numberOrNull(observedHours),
          rated_rpm: numberOrNull(ratedRpm),
        }),
      });
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      const data = (await upstream.json()) as Record<string, unknown>;
      const streams = (data.streams as Record<string, unknown>[]) ?? [];
      res.json({
        anomalyScore: data.anomaly_score,
        isAnomalous: data.is_anomalous,
        phase: data.phase,
        // Whether the score means "deviating from its own normal" or "not the
        // reference engine" is the difference between a usable reading and a
        // misleading one, so the strip is told which it got.
        baselineFitted: Array.isArray(baselineFrames) && baselineFrames.length > 0,
        streams: streams.slice(0, 3).map((s) => ({
          label: s.label_en,
          zScore: s.z_score,
          contributionPct: s.contribution_pct,
        })),
      });
    } catch (e) {
      apiFailure(res, "/maintenance", e);
    }
  });

  /**
   * Route. Was `/api/ai-waypoints` and `/api/ai-review-route`, which asked a
   * language model to invent waypoints while promising "deep navigable water" --
   * a promise it had no depth data to keep.
   *
   * Now: `services/route/planner.py` sweeps candidate tracks, costs every leg
   * through the same fuel model `/advise` uses, and rejects any that violate the
   * depth or forecast-wave constraint. Where it returns the direct track with no
   * saving, that is the true answer for that weather, and it says so.
   */
  app.post("/api/route", async (req, res) => {
    const { startPort, endPort, etaMinutes } = req.body || {};
    const vessel = vesselFrom(req.body);

    if (!Number.isFinite(Number(startPort?.lat)) || !Number.isFinite(Number(endPort?.lat))) {
      res.status(400).json({
        ok: false,
        detail: "startPort and endPort with numeric lat/lng are required.",
      });
      return;
    }

    const request = {
      vessel,
      origin: {
        latitude: Number(startPort.lat),
        longitude: Number(startPort.lng),
        name: startPort.name ?? null,
      },
      destination: {
        latitude: Number(endPort.lat),
        longitude: Number(endPort.lng),
        name: endPort.name ?? null,
      },
      minutes_available: Number.isFinite(Number(etaMinutes))
        ? positive(Number(etaMinutes), 25)
        : null,
      passenger_count: Math.max(0, Math.round(nonNegative(req.body?.passengerCount, 0))),
      cargo_kg: nonNegative(req.body?.cargoKg, 0),
    };

    try {
      const data: any = await callApi("/route", request);
      const rec = data.recommendation;

      res.json({
        ok: true,
        source: "marine-ai/route",

        // The console draws these. Interior points only: it already has the
        // departure and destination markers the operator placed.
        waypoints: (rec.waypoints ?? []).slice(1, -1).map((w: any, i: number) => ({
          lat: w.latitude,
          lng: w.longitude,
          name: w.name || `Waypoint ${String.fromCharCode(65 + i)}`,
          tacticalReason:
            w.recommended_rpm != null
              ? `Leg planned at ${Math.round(w.recommended_rpm)} rpm` +
                (w.min_depth_m != null ? `, least depth ${w.min_depth_m.toFixed(1)} m` : "") +
                "."
              : "Planned leg.",
          recommendedRpm: w.recommended_rpm,
          minDepthM: w.min_depth_m,
          forecastWindKn: w.forecast_wind_kn,
          forecastWaveHeightM: w.forecast_wave_height_m,
        })),
        allWaypoints: rec.waypoints ?? [],

        strategicStrategy: rec.advisory_en,
        advisoryEn: rec.advisory_en,
        advisoryFil: rec.advisory_fil,
        advisorySource: rec.advisory_source,

        totalDistanceNm: rec.total_distance_nm,
        predictedBurnL: rec.predicted_burn_l,
        baselineDistanceNm: rec.baseline_distance_nm,
        baselineBurnL: rec.baseline_burn_l,
        savingsL: rec.savings_l,
        savingsPct:
          rec.baseline_burn_l > 0 ? ((rec.savings_l ?? 0) / rec.baseline_burn_l) * 100 : null,
        achievableMinutes: rec.achievable_minutes,
        eta: rec.eta,

        depthConstrained: rec.depth_constrained,
        weatherConstrained: rec.weather_constrained,
        constraintNotes: rec.constraint_notes ?? [],
        forecastSource: rec.forecast_source,
        modelConfidence: rec.model_confidence,
        scheduleFeasible: data.schedule_feasible,
        modelTrained: data.model_trained,
      });
    } catch (e) {
      apiFailure(res, "/route", e);
    }
  });

  /**
   * Engine reference figures. Was `/api/extract-engine-specs`, which asked a
   * language model to web-search a datasheet. See `engineReference`.
   */
  app.post("/api/engine-specs", (req, res) => {
    const { engineType, mcrHp } = req.body || {};
    res.json({ ...engineReference(engineType, mcrHp), timestamp: new Date().toISOString() });
  });

  /** Live metocean, keyless. Open-Meteo is the repo's declared forecast source. */
  app.get("/api/live-metocean-weather", async (req, res) => {
    const lat = Number(req.query.lat) || 10.6928;
    const lng = Number(req.query.lng) || 122.5644;
    try {
      const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}&current=wave_height,wave_direction,wave_period,swell_wave_height`;
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=wind_speed_10m,wind_direction_10m,surface_pressure`;

      const [marineRes, weatherRes] = await Promise.allSettled([
        fetch(marineUrl),
        fetch(weatherUrl),
      ]);

      const marineData: any =
        marineRes.status === "fulfilled" && marineRes.value.ok ? await marineRes.value.json() : {};
      const weatherData: any =
        weatherRes.status === "fulfilled" && weatherRes.value.ok
          ? await weatherRes.value.json()
          : {};

      const hasMarine = marineData.current != null;
      const hasWeather = weatherData.current != null;

      res.json({
        success: hasMarine || hasWeather,
        // Never claim a live reading when the fetch fell through. The console
        // labels the source on screen, so a lie here becomes a lie on the display.
        source:
          hasMarine && hasWeather
            ? "Open-Meteo Marine + Forecast (live)"
            : hasMarine || hasWeather
              ? "Open-Meteo (partial)"
              : "unavailable",
        latitude: lat,
        longitude: lng,
        metocean: {
          waveHeightM: marineData.current?.wave_height ?? null,
          wavePeriodS: marineData.current?.wave_period ?? null,
          waveDirDeg: marineData.current?.wave_direction ?? null,
          windSpeedKts:
            weatherData.current?.wind_speed_10m != null
              ? Number((weatherData.current.wind_speed_10m * 0.539957).toFixed(1))
              : null,
          windDirDeg: weatherData.current?.wind_direction_10m ?? null,
          pressureHpa: weatherData.current?.surface_pressure ?? null,
        },
      });
    } catch (err: any) {
      res.status(503).json({ success: false, source: "unavailable", detail: String(err) });
    }
  });

  return app;
}
