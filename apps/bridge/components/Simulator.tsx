"use client";

// The simulator console.
//
// Two surfaces live on this page and they serve different people. This console
// -- twenty controls, a log, a telemetry breakdown -- is for judges and
// operators driving the demo. The bridge display is the THROTTLE / ROUTE /
// HEALTH panel inside it, and that one is governed by PRODUCT.md: two seconds, a
// number and a direction, no interpretation. Conflating them would put twenty
// sliders in front of a captain at 05:40.
//
// React owns the panels. lib/simulation.ts owns the vessel and mutates at 60fps
// behind a ref; a throttled snapshot is the only thing that crosses into state.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiUnavailable,
  advise,
  checkHealth,
  checkSafety,
  planRoute,
  recordVoyage,
} from "@/lib/api";
import type {
  AdviseRequest,
  MaintenanceRequest,
  RouteRequest,
  SafetyRequest,
  VoyageRecord,
} from "@/lib/contracts";
import { fetchOpenMeteo } from "@/lib/environment";
import { relativeBearing } from "@/lib/nautical";
import { drawChart } from "@/lib/render-chart";
import { HELM_FOV_DEG, drawHelm, vesselMotion } from "@/lib/render-helm";
import { type LandMask, horizonProfile, loadLandMask } from "@/lib/landmask";
import { WEATHER } from "@/lib/environment";
import {
  type ChartData,
  type PovMode,
  type SimState,
  addLog,
  createState,
  currentRpm,
  distanceRemainingNm,
  endPort,
  headingDeg as vesselHeadingDeg,
  localConditions,
  placeVesselAtStart,
  rebuildRoute,
  startPort,
  step,
  toLatLon,
} from "@/lib/simulation";
import ControlPanel from "./ControlPanel";
import TelemetryPanel from "./TelemetryPanel";

const ADVISE_INTERVAL_MS = 1000;
const SNAPSHOT_INTERVAL_MS = 200;
/** Engine health is scored over a rolling window, so calling it faster than the
 *  window moves buys nothing but load. */
const HEALTH_INTERVAL_MS = 4000;
/** Safety runs at the advisory rate, not the health rate: a threshold breach is
 *  not something to average over a window. */
const SAFETY_INTERVAL_MS = 1000;
/** A route is planned at the dock, not every second. This is the re-plan floor
 *  for a voyage already under way; the interesting re-plans are event-driven
 *  (ports moved, direction reversed, voyage started). */
const ROUTE_INTERVAL_MS = 30_000;

export interface Snapshot {
  running: boolean;
  arrived: boolean;
  pov: PovMode;
  speedKn: number;
  headingDeg: number;
  throttlePct: number;
  rpm: number;
  progress: number;
  zone: string;
  diverted: boolean;
  relativeWindDeg: number;
  relativeWaveDeg: number;
  rollDeg: number;
  encounterPeriod: number;
  fuelUsedL: number;
  advisedFuelL: number;
  elapsedSeconds: number;
  api: SimState["api"];
  routePlan: SimState["routePlan"];
  health: Omit<SimState["health"], "frames"> & { frameCount: number };
  safety: SimState["safety"];
  log: SimState["log"];
  liveForecast: boolean;
  timeScale: number;
}

type Tool = "pointer" | "obstacle" | "storm";

export default function Simulator() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SimState>(createState(null));
  const dragRef = useRef<0 | 1 | null>(null);
  const basemapRef = useRef<HTMLImageElement | null>(null);
  const landMaskRef = useRef<LandMask | null>(null);
  /** Tracks the arrival edge so a completed crossing is recorded once, not on
   *  every frame the vessel spends sitting at the destination. */
  const loggedArrivalRef = useRef(false);
  const [tool, setTool] = useState<Tool>("pointer");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [ready, setReady] = useState(false);

  // --- chart geometry ------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    fetch("/chart.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((chart: ChartData | null) => {
        if (cancelled) return;
        const next = createState(chart);
        next.width = stateRef.current.width;
        next.height = stateRef.current.height;
        stateRef.current = next;
        placeVesselAtStart(next);

        // Satellite basemap and the land mask derived from it. Both are
        // optional: without them the display falls back to the drawn chart and
        // an empty horizon, which is a degraded view rather than a broken one.
        if (chart?.basemap) {
          const image = new Image();
          image.src = chart.basemap.image;
          image.decode().then(
            () => {
              basemapRef.current = image;
            },
            () => undefined,
          );
          void loadLandMask(
            chart.basemap.landmask,
            chart.chart_width_nm,
            chart.chart_height_nm,
          ).then((mask) => {
            landMaskRef.current = mask;
          });
          addLog(next, `Basemap: ${chart.basemap.source}.`);
        }
        addLog(
          next,
          chart
            ? `Chart loaded: ${chart.attribution}. Crossing ${chart.crossing_nm} nm.`
            : "Chart geometry unavailable; running on the schematic outline.",
        );
        addLog(next, "Advisory system online. Captain retains command.", "advisory");
        setReady(true);
      })
      .catch(() => setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // --- canvas sizing -------------------------------------------------------

  useEffect(() => {
    const resize = () => {
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      if (!wrap || !canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const state = stateRef.current;
      const first = state.width === 0;
      state.width = w;
      state.height = h;
      if (first) placeVesselAtStart(state);
      else rebuildRoute(state);
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [ready]);

  // --- the advisory call ---------------------------------------------------

  const requestAdvice = useCallback(async () => {
    const state = stateRef.current;
    if (state.width === 0) return;

    const local = localConditions(state);
    const minutesLeft = Math.max(
      0.5,
      state.scheduleMinutes - state.voyage.elapsedSeconds / 60,
    );

    const body: AdviseRequest = {
      vessel: {
        vessel_id: "MV-SOLMATE-01",
        length_waterline_m: 11.5,
        beam_m: 2.8,
        draft_m: 1.1,
        displacement_kg: 8500,
        rated_kw: 90,
        rated_rpm: state.ratedRpm,
        admiralty_coefficient: 70,
        best_bsfc_g_per_kwh: 215,
        idle_burn_lph: 1.2,
      },
      sea: {
        wind_speed_kn: local.wind_speed_kn ?? 0,
        wind_direction_deg: local.wind_direction_deg ?? 0,
        current_speed_kn: local.current_speed_kn ?? 0,
        current_direction_deg: local.current_direction_deg ?? 0,
        wave_height_m: local.wave_height_m ?? 0,
        wave_direction_deg: local.wave_direction_deg ?? null,
      },
      heading_deg: vesselHeadingDeg(state),
      distance_remaining_nm: distanceRemainingNm(state),
      minutes_available: state.running ? minutesLeft : state.scheduleMinutes,
      current_rpm: currentRpm(state),
      passenger_count: state.passengers,
      cargo_kg: state.cargoKg,
      egt_excess_ratio: state.egtExcess > 1.0001 ? state.egtExcess : 1.0,
      php_per_litre: 70,
    };

    try {
      const response = await advise(body);
      state.api.response = response;
      state.api.error = null;
      state.api.lastRequestAt = performance.now();

      if (!response.feasible && state.running) {
        addLog(state, response.recommendation.advisory_en, "alert");
      }
    } catch (error) {
      // Losing the advisory service is a designed state. The display keeps the
      // last known values and ages them visibly rather than blanking.
      state.api.error =
        error instanceof ApiUnavailable ? error.message : "advisory service error";
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void requestAdvice();
    const id = setInterval(() => void requestAdvice(), ADVISE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [ready, requestAdvice]);

  // --- the route plan ------------------------------------------------------
  //
  // Berth to berth, in real coordinates. Note what is NOT sent: the sea state.
  // `/advise` is told the conditions at the vessel because it is answering about
  // right now; the route planner reads its own forecast forward along the track,
  // which is the whole difference between the two products. The response says
  // which forecaster answered in `forecast_source`, and the display shows it.

  const requestRoute = useCallback(async () => {
    const state = stateRef.current;
    if (state.width === 0 || state.routePlan.planning) return;

    const from = startPort(state);
    const to = endPort(state);
    const body: RouteRequest = {
      vessel: {
        vessel_id: "MV-SOLMATE-01",
        length_waterline_m: 11.5,
        beam_m: 2.8,
        draft_m: 1.1,
        displacement_kg: 8500,
        rated_kw: 90,
        rated_rpm: state.ratedRpm,
        admiralty_coefficient: 70,
        best_bsfc_g_per_kwh: 215,
        idle_burn_lph: 1.2,
      },
      origin: { ...toLatLon(state, from.position), name: from.name },
      destination: { ...toLatLon(state, to.position), name: to.name },
      minutes_available: state.scheduleMinutes,
      passenger_count: state.passengers,
      cargo_kg: state.cargoKg,
      egt_excess_ratio: state.egtExcess > 1.0001 ? state.egtExcess : 1.0,
    };

    state.routePlan.planning = true;
    try {
      const response = await planRoute(body);
      state.routePlan.response = response;
      state.routePlan.error = null;
      state.routePlan.lastRequestAt = performance.now();

      const rec = response.recommendation;
      const notes = rec.constraint_notes ?? [];
      if (notes.length > 0) addLog(state, notes[0], "warn");
      if (!response.schedule_feasible) {
        addLog(state, "Route planned, but the schedule cannot be held.", "alert");
      }
    } catch (error) {
      state.routePlan.error =
        error instanceof ApiUnavailable ? error.message : "route service error";
    } finally {
      state.routePlan.planning = false;
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void requestRoute();
    const id = setInterval(() => void requestRoute(), ROUTE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [ready, requestRoute]);

  // --- engine health -------------------------------------------------------
  //
  // The window of emulated frames is filled by lib/simulation.ts; this only
  // ships it. The detector is unsupervised and Phase 1 by contract: it may name
  // a deviating stream and no more, so there is nothing here to translate into a
  // component or a repair date, and by construction there could not be.

  const requestHealth = useCallback(async () => {
    const state = stateRef.current;
    const frames = state.health.frames;
    // The detector's trend arm splits the window in half and needs four frames
    // to compare. Below that there is genuinely nothing to say.
    if (frames.length < 4) return;

    const body: MaintenanceRequest = {
      vessel_id: "MV-SOLMATE-01",
      frames: frames.slice(),
      observed_hours: state.engineHours,
    };

    try {
      const status = await checkHealth(body);
      const wasAnomalous = state.health.status?.is_anomalous ?? false;
      state.health.status = status;
      state.health.error = null;
      state.health.lastRequestAt = performance.now();

      // Log the transition, not the state: a standing anomaly that re-logged
      // every four seconds would bury everything else in the event log.
      if (status.is_anomalous && !wasAnomalous) {
        addLog(state, status.advisory_en, "warn");
      } else if (!status.is_anomalous && wasAnomalous) {
        addLog(state, "Engine streams back within their learned normal.");
      }
    } catch (error) {
      state.health.error =
        error instanceof ApiUnavailable ? error.message : "maintenance service error";
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => void requestHealth(), HEALTH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [ready, requestHealth]);

  // --- safety cutoffs ------------------------------------------------------
  //
  // The newest frame, every second, against fixed thresholds. Faster than the
  // health window because a cutoff is not an average -- it fires on the reading
  // in front of it, and a coolant alarm delayed by a two-minute window is a
  // coolant alarm that arrives after the damage.
  //
  // Nothing here consults a model, on either side of the wire.

  const requestSafety = useCallback(async () => {
    const state = stateRef.current;
    const latest = state.health.frames[state.health.frames.length - 1];
    if (!latest) return;

    const body: SafetyRequest = { vessel_id: "MV-SOLMATE-01", frame: latest };

    try {
      const previous = state.safety.state?.severity ?? "nominal";
      const next = await checkSafety(body);
      state.safety.state = next;
      state.safety.error = null;
      state.safety.lastRequestAt = performance.now();

      // Log the transition, not the standing state: a critical that re-logged
      // every second would bury the entry that explains it.
      if (next.severity !== previous && next.active && next.active.length > 0) {
        addLog(
          state,
          next.active[0].message_en,
          next.severity === "critical" ? "alert" : "warn",
        );
      } else if (next.severity === "nominal" && previous !== "nominal") {
        addLog(state, "Safety cutoffs clear.");
      }
    } catch (error) {
      state.safety.error =
        error instanceof ApiUnavailable ? error.message : "safety service error";
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => void requestSafety(), SAFETY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [ready, requestSafety]);

  // --- recording the voyage ------------------------------------------------
  //
  // On arrival, once. This is the write side of Problem 3: the monthly emissions
  // report is an aggregate over these records, so a crossing that finishes
  // without being recorded is one the operator has no evidence for.
  //
  // **No baseline is sent, deliberately**, and this is the subtle part.
  //
  // The simulator has two fuel figures: `fuelUsedL`, burned at the throttle the
  // captain actually held, and `advisedFuelL`, what the same crossing would have
  // burned had the advisory been followed. It is tempting to send the second as
  // the baseline. It is also wrong.
  //
  // A baseline is what the vessel would have burned *without Marine-AI*. In this
  // demo the captain does not follow the advisory, so `advisedFuelL` is the
  // opposite: what would have burned *with* it. Sending it produces an "avoided"
  // figure that is really a foregone saving with its sign flipped -- which is
  // exactly the sort of number that makes an emissions report unusable as
  // evidence.
  //
  // So the record carries what was truly burned and no baseline at all. The
  // report then supplies the *right* baseline on its own: after three crossings
  // it uses this vessel's own median fuel-per-mile on this route, which is the
  // measured comparison the technical profile actually promises. Until then it
  // reports fuel and CO2 and declines to report avoided CO2, which is the honest
  // answer rather than a convenient one.

  const submitVoyage = useCallback(async (state: SimState) => {
    const from = startPort(state);
    const to = endPort(state);
    const departedMs = state.simClockMs - state.voyage.elapsedSeconds * 1000;

    const body: VoyageRecord = {
      voyage_id: `${state.simClockMs}-${from.name}-${to.name}`
        .replace(/[^a-zA-Z0-9-]+/g, "-")
        .toLowerCase(),
      vessel_id: "MV-SOLMATE-01",
      departed_at: new Date(departedMs).toISOString(),
      arrived_at: new Date(state.simClockMs).toISOString(),
      origin_name: from.name,
      destination_name: to.name,
      distance_nm: state.crossingNm,
      fuel_used_l: state.voyage.fuelUsedL,
      baseline_fuel_l: null,
      baseline_method: "none",
      passenger_count: state.passengers,
      cargo_kg: state.cargoKg,
      source: "simulator",
    };

    try {
      await recordVoyage(body);
      addLog(state, `Voyage logged: ${state.voyage.fuelUsedL.toFixed(2)} L for the emissions record.`);
    } catch {
      // A failed write must not lose the crossing silently. The captain is not
      // going to retry this by hand, so say it happened.
      addLog(state, "Voyage could not be logged; emissions record incomplete.", "warn");
    }
  }, []);

  // --- live forecast -------------------------------------------------------

  useEffect(() => {
    if (!ready) return;
    const pull = async () => {
      const state = stateRef.current;
      if (!state.liveForecast) return;
      const live = await fetchOpenMeteo();
      if (!live) {
        addLog(state, "Open-Meteo unreachable; holding last known conditions.", "warn");
        return;
      }
      Object.assign(state.env, live);
      addLog(
        state,
        `Open-Meteo: wind ${(live.windSpeedKn ?? 0).toFixed(0)} kn, ` +
          `sea ${(live.waveHeightM ?? 0).toFixed(1)} m.`,
      );
    };
    void pull();
    const id = setInterval(() => void pull(), 60_000);
    return () => clearInterval(id);
  }, [ready]);

  // --- render loop ---------------------------------------------------------

  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let last = performance.now();
    let lastSnapshot = 0;

    const loop = (now: number) => {
      const state = stateRef.current;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      step(state, dt);
      if (state.running) rebuildRoute(state);

      if (state.arrived && !loggedArrivalRef.current) {
        loggedArrivalRef.current = true;
        void submitVoyage(state);
      } else if (!state.arrived && loggedArrivalRef.current) {
        loggedArrivalRef.current = false;
      }

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (ctx && state.width > 0) {
        const local = localConditions(state);
        const preset = WEATHER[state.env.weather];

        if (state.pov === "helm") {
          // Where the eye actually is, in real coordinates. The helm view needs
          // it to place the sun.
          const eye = toLatLon(state, {
            x: state.width ? state.vessel.position.x / state.width : 0.5,
            y: state.height ? state.vessel.position.y / state.height : 0.5,
          });
          drawHelm(ctx, {
            width: state.width,
            height: state.height,
            timeSeconds: state.timeSeconds,
            headingDeg: vesselHeadingDeg(state),
            speedKn: state.vessel.speedKn,
            recommendedRpm: state.api.response?.recommendation.recommended_rpm ?? null,
            currentRpm: currentRpm(state),
            waveHeightM: local.wave_height_m ?? 0,
            waveDirectionDeg: local.wave_direction_deg ?? 0,
            windSpeedKn: local.wind_speed_kn ?? 0,
            windDirectionDeg: local.wind_direction_deg ?? 0,
            gloom: preset.gloom,
            rain: preset.rain,
            // The sun is placed from the simulated clock and the vessel's real
            // position, so the light matches the hour the voyage is running at.
            atMs: state.simClockMs,
            latitude: eye.latitude,
            longitude: eye.longitude,
            horizon: landMaskRef.current
              ? horizonProfile(
                  landMaskRef.current,
                  {
                    x: state.width ? state.vessel.position.x / state.width : 0.5,
                    y: state.height ? state.vessel.position.y / state.height : 0.5,
                  },
                  vesselHeadingDeg(state),
                  HELM_FOV_DEG,
                )
              : [],
          });
        } else {
          drawChart(ctx, {
            width: state.width,
            height: state.height,
            basemap: basemapRef.current,
            coastline: state.coastline,
            baseline: state.baseline,
            route: state.route,
            ports: state.ports,
            vessel: { position: state.vessel.position, headingRad: state.vessel.headingRad },
            obstacles: state.obstacles,
            storms: state.storms,
            windParticles: state.particles.wind,
            swellParticles: state.particles.swell,
            rainParticles: state.particles.rain,
            windDirectionDeg: local.wind_direction_deg ?? 0,
            windSpeedKn: local.wind_speed_kn ?? 0,
            waveHeightM: local.wave_height_m ?? 0,
            gloom: preset.gloom,
            view: state.pov,
            running: state.running,
            diverted: state.diverted,
          });
        }
      }

      if (now - lastSnapshot > SNAPSHOT_INTERVAL_MS) {
        lastSnapshot = now;
        setSnapshot(buildSnapshot(state));
      }

      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [ready, submitVoyage]);

  // --- pointer interaction -------------------------------------------------

  const canvasPoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const state = stateRef.current;
    const { x, y } = canvasPoint(event);

    if (tool === "obstacle") {
      state.obstacles.push({ x, y, radius: 22 + Math.random() * 16 });
      addLog(state, "Obstacle marked. Route re-shaped around it.", "warn");
      rebuildRoute(state);
      return;
    }
    if (tool === "storm") {
      state.storms.push({ x, y, radius: 55 + Math.random() * 35 });
      addLog(state, "Weather cell placed. Local wind and sea raised.", "warn");
      rebuildRoute(state);
      return;
    }

    // Pointer: grab a port, or clear a hazard.
    if (state.pov !== "north-up" || state.running) return;
    for (const index of [0, 1] as const) {
      const port = state.ports[index];
      const px = port.position.x * state.width;
      const py = port.position.y * state.height;
      if (Math.hypot(x - px, y - py) < 20) {
        dragRef.current = index;
        return;
      }
    }

    const before = state.obstacles.length + state.storms.length;
    state.obstacles = state.obstacles.filter((o) => Math.hypot(x - o.x, y - o.y) > o.radius);
    state.storms = state.storms.filter((s) => Math.hypot(x - s.x, y - s.y) > s.radius);
    if (state.obstacles.length + state.storms.length !== before) {
      addLog(state, "Hazard cleared.");
      rebuildRoute(state);
    }
  };

  const onMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const index = dragRef.current;
    if (index === null) return;
    const state = stateRef.current;
    const { x, y } = canvasPoint(event);
    state.ports[index].position = {
      x: Math.max(0.04, Math.min(0.96, x / state.width)),
      y: Math.max(0.04, Math.min(0.96, y / state.height)),
    };
    placeVesselAtStart(state);
  };

  const endDrag = () => {
    if (dragRef.current !== null) {
      dragRef.current = null;
      addLog(stateRef.current, "Port moved. Route re-planned.");
      void requestRoute();
    }
  };

  // --- control handlers ----------------------------------------------------

  const mutate = useCallback((fn: (state: SimState) => void) => {
    fn(stateRef.current);
    setSnapshot(buildSnapshot(stateRef.current));
  }, []);

  // A voyage that starts or reverses is a different voyage, so it gets a fresh
  // plan rather than inheriting the last one's numbers.
  const toggleVoyage = () => {
    let started = false;
    mutate((state) => {
      if (state.arrived) {
        placeVesselAtStart(state);
        state.running = true;
        started = true;
        addLog(state, "New voyage started.", "advisory");
        return;
      }
      state.running = !state.running;
      started = state.running;
      addLog(state, state.running ? "Under way." : "Voyage paused.", "advisory");
    });
    if (started) void requestRoute();
  };

  const swapPorts = () => {
    let swapped = false;
    mutate((state) => {
      if (state.running) return;
      state.direction = state.direction === 1 ? -1 : 1;
      placeVesselAtStart(state);
      swapped = true;
      addLog(state, `Now bound for ${endPort(state).name}.`);
    });
    if (swapped) void requestRoute();
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <span className="text-base font-semibold tracking-tight">
            Marine<span className="text-orange-500">-AI</span>
          </span>
          <span className="text-xs text-slate-400">
            Simulator console &middot; Iloilo Strait
          </span>
          {snapshot && snapshot.timeScale > 1 && (
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-amber-400">
              {snapshot.timeScale.toFixed(0)}x real time
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <PovSwitch
            value={snapshot?.pov ?? "north-up"}
            onChange={(pov) => mutate((state) => (state.pov = pov))}
          />
          <button
            onClick={swapPorts}
            disabled={snapshot?.running}
            className="rounded border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-40"
          >
            Reverse
          </button>
          <button
            onClick={toggleVoyage}
            className="rounded bg-orange-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-orange-600"
          >
            {snapshot?.arrived ? "New voyage" : snapshot?.running ? "Pause" : "Start voyage"}
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        <ControlPanel state={stateRef} snapshot={snapshot} onMutate={mutate} />

        <section className="relative min-w-0 flex-1" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={endDrag}
            onMouseLeave={endDrag}
            className="block h-full w-full"
            style={{ cursor: tool === "pointer" ? "grab" : "crosshair" }}
          />

          {snapshot?.pov !== "helm" && (
            <div className="absolute left-3 top-3 flex gap-1 rounded border border-slate-700 bg-slate-900/85 p-1 backdrop-blur">
              {(["pointer", "obstacle", "storm"] as Tool[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTool(t)}
                  className={`rounded px-2.5 py-1 text-xs capitalize ${
                    tool === t ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          {/* CC BY 4.0 requires attribution, so this is a licence condition
              rather than a courtesy. It stays on screen in every view. */}
          <p className="absolute bottom-2 left-3 max-w-[46rem] text-[10px] leading-snug text-slate-500">
            Imagery: Sentinel-2 cloudless by EOX &mdash; modified Copernicus Sentinel data 2020
            (CC BY 4.0). Coastline: Natural Earth (public domain). Forecast: Open-Meteo
            (CC BY 4.0). Not for navigation. Simulated telemetry &mdash; no hardware.
          </p>
        </section>

        <TelemetryPanel snapshot={snapshot} />
      </main>
    </div>
  );
}

function PovSwitch({
  value,
  onChange,
}: {
  value: PovMode;
  onChange: (pov: PovMode) => void;
}) {
  const options: { id: PovMode; label: string; hint: string }[] = [
    { id: "north-up", label: "North-up", hint: "Chart convention" },
    { id: "course-up", label: "Course-up", hint: "Bow up, as steered" },
    { id: "follow", label: "Follow", hint: "Centred on the vessel" },
    { id: "helm", label: "Helm", hint: "From behind the wheel" },
  ];
  return (
    <div className="flex rounded border border-slate-700 p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          title={option.hint}
          onClick={() => onChange(option.id)}
          className={`rounded px-2.5 py-1 text-xs ${
            value === option.id ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function buildSnapshot(state: SimState): Snapshot {
  const local = localConditions(state);
  const heading = vesselHeadingDeg(state);
  const motion = vesselMotion({
    width: state.width,
    height: state.height,
    timeSeconds: state.timeSeconds,
    headingDeg: heading,
    speedKn: state.vessel.speedKn,
    recommendedRpm: null,
    currentRpm: 0,
    waveHeightM: local.wave_height_m ?? 0,
    waveDirectionDeg: local.wave_direction_deg ?? 0,
    windSpeedKn: local.wind_speed_kn ?? 0,
    windDirectionDeg: local.wind_direction_deg ?? 0,
    gloom: 0,
    rain: 0,
    // Roll and pitch do not depend on the light, but the scene type carries it.
    atMs: state.simClockMs,
    latitude: 0,
    longitude: 0,
    horizon: [],
  });

  return {
    running: state.running,
    arrived: state.arrived,
    pov: state.pov,
    speedKn: state.vessel.speedKn,
    headingDeg: heading,
    throttlePct: state.throttlePct,
    rpm: currentRpm(state),
    progress: state.vessel.progress,
    zone: local.zone,
    diverted: state.diverted,
    relativeWindDeg: relativeBearing(heading, local.wind_direction_deg ?? 0),
    relativeWaveDeg: relativeBearing(heading, local.wave_direction_deg ?? 0),
    rollDeg: motion.rollDeg,
    encounterPeriod: motion.encounterPeriod,
    fuelUsedL: state.voyage.fuelUsedL,
    advisedFuelL: state.voyage.advisedFuelL,
    elapsedSeconds: state.voyage.elapsedSeconds,
    api: { ...state.api },
    routePlan: { ...state.routePlan },
    // The window itself never crosses into React state. It is up to 120 frames
    // rebuilt five times a second, and copying it into the snapshot would hand
    // the panel a large object it only ever wants the length of.
    health: {
      status: state.health.status,
      error: state.health.error,
      lastRequestAt: state.health.lastRequestAt,
      ageSeconds: state.health.ageSeconds,
      nextFrameAtMs: state.health.nextFrameAtMs,
      frameCount: state.health.frames.length,
    },
    safety: { ...state.safety },
    log: state.log.slice(0, 24),
    liveForecast: state.liveForecast,
    timeScale: state.timeScale,
  };
}
