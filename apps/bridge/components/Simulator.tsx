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
  TelemetryFrame,
  VoyageRecord,
} from "@/lib/contracts";
import { fetchOpenMeteo } from "@/lib/environment";
import type { LocalConditions } from "@/lib/environment";
import { toVesselInput, type VesselSpec } from "@/lib/vessel";
import { relativeBearing } from "@/lib/nautical";
import { drawChart, type MapStyle } from "@/lib/render-chart";
import { HELM_FOV_DEG, drawHelm, vesselMotion } from "@/lib/render-helm";
import { drawChase } from "@/lib/render-chase";
import { type LandMask, horizonProfile, loadLandMask } from "@/lib/landmask";
import { loadSeamarks, type Seamark } from "@/lib/seamarks";
import { WEATHER } from "@/lib/environment";
import EngineXRay from "./EngineXRay";
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
  isChartView,
  localConditions,
  placeVesselAtStart,
  rebuildRoute,
  startPort,
  step,
  toLatLon,
} from "@/lib/simulation";
import ControlPanel from "./ControlPanel";
import TelemetryPanel from "./TelemetryPanel";
import { CompassRose, TOOLS, ToolRail, type Tool } from "./MapOverlay";

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
  /** The ETA budget the operator set, minutes. The Route zone needs it to say
   *  how far past the schedule an infeasible plan actually lands. */
  scheduleMinutes: number;
  relativeWindDeg: number;
  relativeWaveDeg: number;
  rollDeg: number;
  encounterPeriod: number;
  fuelUsedL: number;
  advisedFuelL: number;
  elapsedSeconds: number;
  /** Conditions at the vessel, not the base slider values. The panels that read
   *  this are reporting what the boat is actually in. */
  conditions: LocalConditions;
  /** The hull under advice, so panels can express figures per rating rather
   *  than against a constant they would have to hold their own copy of. */
  vessel: VesselSpec;
  api: SimState["api"];
  routePlan: SimState["routePlan"];
  health: Omit<SimState["health"], "frames"> & { frameCount: number };
  /** The rolling engine-frame window, copied.
   *
   *  Excluded from the snapshot originally, and for a good reason: the live
   *  array is mutated in place, so handing React the reference would give it a
   *  value that changes underneath a render. A copy at the 200 ms snapshot rate
   *  is ~120 objects five times a second, which is nothing, and it is what lets
   *  the X-ray draw a trend and export the log. */
  frames: TelemetryFrame[];
  safety: SimState["safety"];
  forecast: SimState["forecast"];
  log: SimState["log"];
  liveForecast: boolean;
  timeScale: number;
}

/** Demo speeds, as steps rather than a continuous slider.
 *
 *  Time compression is the one control that gets touched mid-sentence while
 *  presenting, and hunting for "20" on a 1-60 slider is not something to do with
 *  an audience watching. These are the values anyone actually wants. */
const TIME_SCALES = [1, 5, 20, 60, 120];

export default function Simulator() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SimState>(createState(null));
  const dragRef = useRef<0 | 1 | null>(null);
  const basemapRef = useRef<HTMLImageElement | null>(null);
  const landMaskRef = useRef<LandMask | null>(null);
  // A ref, like the basemap and mask above, for the same reason: these are
  // chart assets that arrive after the first paint and are read by the draw
  // loop, not values React renders.
  const seamarksRef = useRef<Seamark[]>([]);
  /** Tracks the arrival edge so a completed crossing is recorded once, not on
   *  every frame the vessel spends sitting at the destination. */
  const loggedArrivalRef = useRef(false);
  const [tool, setTool] = useState<Tool>("pointer");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [ready, setReady] = useState(false);
  // Both panels can be folded away. The chart is the part of this screen worth
  // projecting, and a demo on a laptop plugged into a room's display has a lot
  // less width to spend than the machine it was built on.
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [xrayOpen, setXrayOpen] = useState(false);
  const [mapStyle, setMapStyle] = useState<MapStyle>("satellite");
  // The draw loop runs off requestAnimationFrame and reads this every frame,
  // so it cannot depend on a value captured in the effect's closure -- the
  // style would change in the button and never in the chart. Same reason the
  // vessel lives in a ref: React state is for what is rendered, refs are for
  // what the 60fps loop reads.
  const mapStyleRef = useRef<MapStyle>("satellite");
  const chooseMapStyle = useCallback((style: MapStyle) => {
    mapStyleRef.current = style;
    setMapStyle(style);
  }, []);

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

        // Charted aids to navigation, optional in the same way the basemap is:
        // without them the chart draws its coastline and no marks, which is a
        // poorer chart rather than a broken one.
        void loadSeamarks().then((seamarks) => {
          if (cancelled || !seamarks) return;
          seamarksRef.current = seamarks.marks;
          const lit = seamarks.marks.filter((mark) => mark.light).length;
          addLog(
            stateRef.current,
            `Aids to navigation: ${seamarks.marks.length} charted, ${lit} lit ` +
              `— ${seamarks.source} (${seamarks.licence}), fetched ${seamarks.fetched}.`,
          );
        });
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
    // A ResizeObserver rather than a window listener: folding a side panel away
    // changes the chart's width without the window changing size at all, and a
    // window listener would miss it and leave the canvas stretched.
    const observer = new ResizeObserver(resize);
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => observer.disconnect();
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
      // One spec, read here and in the route request below. See lib/vessel.ts:
      // two hand-maintained copies is how "one fuel model, one hull" quietly
      // stops being true.
      vessel: toVesselInput(state.vesselSpec),
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
      vessel: toVesselInput(state.vesselSpec),
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
      vessel_id: state.vesselSpec.vesselId,
      frames: frames.slice(),
      observed_hours: state.engineHours,
      // Enables the duty-cycle summary. From the same spec that sizes the engine
      // everywhere else, so switching preset moves exposure and fuel together.
      rated_rpm: state.vesselSpec.ratedRpm,
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

    const body: SafetyRequest = { vessel_id: state.vesselSpec.vesselId, frame: latest };

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
      vessel_id: state.vesselSpec.vesselId,
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
  //
  // The values and their provenance arrive together and are stored together.
  // The panel renders both, because "live weather" is the easiest claim in this
  // simulator to make and the hardest for anyone watching to check -- so the
  // grid cell that answered, the time it answered, and which of the two
  // endpoints answered are all kept and shown rather than discarded here.

  const pullForecast = useCallback(async (manual = false) => {
    const state = stateRef.current;
    if (!state.liveForecast && !manual) return;

    state.forecast.syncing = true;
    setSnapshot(buildSnapshot(state));
    try {
      const result = await fetchOpenMeteo();
      if (!result) {
        state.forecast.error = "Open-Meteo unreachable";
        addLog(state, "Open-Meteo unreachable; holding last known conditions.", "warn");
        return;
      }
      Object.assign(state.env, result.values);
      // A real observation becomes the new set point. Without this a manual sync
      // taken while the drift walk is running would be hauled straight back to
      // the previous anchor, so the freshly-fetched conditions would visibly
      // decay toward stale ones over the next few seconds.
      Object.assign(state.drift.anchor, result.values);
      state.forecast.meta = result.meta;
      state.forecast.error = null;
      addLog(
        state,
        `Open-Meteo ${result.meta.gridLatitude?.toFixed(2)}°N ` +
          `${result.meta.gridLongitude?.toFixed(2)}°E: wind ` +
          `${(result.values.windSpeedKn ?? state.env.windSpeedKn).toFixed(0)} kn, ` +
          `sea ${(result.values.waveHeightM ?? state.env.waveHeightM).toFixed(1)} m.`,
      );
    } finally {
      state.forecast.syncing = false;
      setSnapshot(buildSnapshot(stateRef.current));
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void pullForecast();
    const id = setInterval(() => void pullForecast(), 60_000);
    return () => clearInterval(id);
  }, [ready, pullForecast]);

  // Manual sync turns the forecast on if it was off. Someone reaching for the
  // button is asking for live data, and refusing because a checkbox elsewhere is
  // unticked would be the interface arguing with an unambiguous instruction.
  const syncForecast = useCallback(() => {
    stateRef.current.liveForecast = true;
    void pullForecast(true);
  }, [pullForecast]);

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

        if (state.pov === "helm" || state.pov === "chase") {
          // Both exterior cameras are looking out from the same place at the
          // same instant, so they are handed the identical scene and differ only
          // in where the lens is. Building it once is what guarantees that -- two
          // constructions would be two chances to disagree about the sun.
          const eye = toLatLon(state, {
            x: state.width ? state.vessel.position.x / state.width : 0.5,
            y: state.height ? state.vessel.position.y / state.height : 0.5,
          });
          const scene = {
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
          };
          if (state.pov === "helm") drawHelm(ctx, scene);
          else drawChase(ctx, scene);
        } else {
          drawChart(ctx, {
            width: state.width,
            height: state.height,
            basemap: basemapRef.current,
            coastline: state.coastline,
            seamarks: seamarksRef.current,
            // Real elapsed time, not the simulated clock: a light's period is
            // counted against a watch, and time compression would strobe it.
            clockMs: now,
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
            style: mapStyleRef.current,
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

    // Nothing on this canvas is placeable unless the canvas is a chart. The
    // hazard tools read the click as a position in chart space; in an exterior
    // camera the same pixels mean a direction the lens is pointing, so a click
    // there would drop a squall at an arbitrary point of the strait with nothing
    // on screen to show it had happened. The rail is hidden in those views, but
    // the digit shortcuts still select a tool, so hiding the rail was never
    // enough on its own.
    if (!isChartView(state.pov)) return;

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

  // --- keyboard ------------------------------------------------------------
  //
  // Digits pick a chart tool and space runs the voyage. Both are for presenting:
  // reaching across to a toolbar mid-sentence costs more attention than it looks
  // like it does, and the tool rail advertises its own bindings so this is
  // discoverable rather than folklore.

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Never steal a keystroke from a field someone is typing in -- the vessel
      // panel is full of number inputs, and "1" belongs to them while focused.
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (target &&
          (target.isContentEditable ||
            ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)))
      ) {
        return;
      }

      const byKey = TOOLS.find((entry) => entry.key === event.key);
      if (byKey) {
        setTool(byKey.id);
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        toggleVoyage();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-900/40 px-3 py-2">
        <button
          onClick={() => setLeftOpen((v) => !v)}
          title="Toggle the control panel"
          aria-expanded={leftOpen}
          className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        >
          <PanelIcon side="left" />
          <span className="sr-only">Toggle control panel</span>
        </button>

        <div className="flex items-baseline gap-2.5">
          <span className="text-sm font-semibold tracking-tight">
            Marine<span className="text-orange-500">-AI</span>
          </span>
          <span className="hidden text-[11px] text-slate-500 lg:inline">
            {snapshot?.vessel.name ?? "—"} &middot; Iloilo Strait
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <TimeScaleSwitch
            value={snapshot?.timeScale ?? 20}
            onChange={(v) => mutate((state) => (state.timeScale = v))}
          />
          <MapStyleSwitch value={mapStyle} onChange={chooseMapStyle} />
          <PovSwitch
            value={snapshot?.pov ?? "north-up"}
            onChange={(pov) => mutate((state) => (state.pov = pov))}
          />
          <button
            onClick={swapPorts}
            disabled={snapshot?.running}
            className="rounded border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          >
            Reverse
          </button>
          {/* Deep inspection, deliberately behind a click. The captain's screen
              stays at three zones; this is for the engineer at the dock. */}
          <button
            onClick={() => setXrayOpen(true)}
            title="Engine telemetry and diagnostics"
            className="rounded border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
          >
            Engine
          </button>
          <button
            onClick={toggleVoyage}
            className="rounded bg-orange-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-600"
          >
            {snapshot?.arrived ? "New voyage" : snapshot?.running ? "Pause" : "Start voyage"}
          </button>
          <button
            onClick={() => setRightOpen((v) => !v)}
            title="Toggle the bridge display"
            aria-expanded={rightOpen}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            <PanelIcon side="right" />
            <span className="sr-only">Toggle bridge display</span>
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        <aside
          className={`shrink-0 overflow-hidden border-r border-slate-800 bg-slate-900/60 transition-[width] duration-200 ${
            leftOpen ? "w-72" : "w-0 border-r-0"
          }`}
        >
          <div className="h-full w-72">
            <ControlPanel
              state={stateRef}
              snapshot={snapshot}
              onMutate={mutate}
              onSyncForecast={syncForecast}
            />
          </div>
        </aside>

        <section className="relative min-w-0 flex-1" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={endDrag}
            onMouseLeave={endDrag}
            className="block h-full w-full"
            style={{
              cursor: !snapshot || !isChartView(snapshot.pov)
                ? "default"
                : tool === "pointer"
                  ? "grab"
                  : "crosshair",
            }}
          />

          {snapshot && isChartView(snapshot.pov) && <ToolRail tool={tool} onChange={setTool} />}

          <CompassRose
            headingDeg={snapshot?.headingDeg ?? 0}
            pov={snapshot?.pov ?? "north-up"}
            onResetNorth={() => mutate((state) => (state.pov = "north-up"))}
          />

          {/* Time compression is stated on the chart itself, not only in the
              header control that sets it. A crossing that takes seventeen
              minutes in reality must never appear to take one, and the place
              someone is looking while it happens is the map. */}
          {snapshot && snapshot.timeScale > 1 && (
            <div className="pointer-events-none absolute right-3 top-3 rounded border border-amber-900/60 bg-slate-900/85 px-2 py-1 font-mono text-[10px] text-amber-400 backdrop-blur">
              {snapshot.timeScale}&times; real time
            </div>
          )}

          {/* CC BY 4.0 and ODbL both require attribution, so this is a licence
              condition rather than a courtesy. It stays on screen in every view. */}
          <p className="absolute bottom-2 left-3 right-3 max-w-[46rem] text-[10px] leading-snug text-slate-500">
            Imagery: Sentinel-2 cloudless by EOX &mdash; modified Copernicus Sentinel data 2025
            (CC BY 4.0). Coastline: Natural Earth (public domain). Aids to navigation: &copy;
            OpenStreetMap contributors via OpenSeaMap (ODbL). Forecast: Open-Meteo
            (CC BY 4.0). Not for navigation. Simulated telemetry &mdash; no hardware.
          </p>
        </section>

        <aside
          className={`shrink-0 overflow-hidden border-l border-slate-800 bg-slate-900/60 transition-[width] duration-200 ${
            rightOpen ? "w-96" : "w-0 border-l-0"
          }`}
        >
          <div className="h-full w-96">
            <TelemetryPanel snapshot={snapshot} />
          </div>
        </aside>
      </main>

      {xrayOpen && <EngineXRay snapshot={snapshot} onClose={() => setXrayOpen(false)} />}
    </div>
  );
}

/**
 * Time compression, as steps.
 *
 * The reference simulator puts this in the header as a dropdown, which is the
 * right instinct -- it is reached for mid-sentence while presenting -- but a
 * dropdown is two clicks and a menu. A segmented control is one click and the
 * current value is readable without opening anything.
 */
function TimeScaleSwitch({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div
      className="flex items-center rounded border border-slate-700 p-0.5"
      role="group"
      aria-label="Time compression"
    >
      {TIME_SCALES.map((scale) => (
        <button
          key={scale}
          onClick={() => onChange(scale)}
          aria-pressed={value === scale}
          title={scale === 1 ? "Real time" : `${scale} times real time`}
          className={`rounded px-2 py-1 font-mono text-[11px] ${
            value === scale
              ? "bg-slate-700 text-white"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {scale}&times;
        </button>
      ))}
    </div>
  );
}

function PanelIcon({ side }: { side: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" strokeWidth="1.2" />
      <line
        x1={side === "left" ? "6" : "10"}
        y1="2.5"
        x2={side === "left" ? "6" : "10"}
        y2="13.5"
        strokeWidth="1.2"
      />
    </svg>
  );
}

/**
 * Satellite, muted, or drawn chart.
 *
 * Every option renders from the three sources already in the repository -- one
 * Sentinel-2 composite, one Natural Earth coastline, and one OpenSeaMap seamark
 * extract. No option fetches a tile from a third party, which is the whole
 * reason this control is safe to ship: `docs/DEVIATIONS.md` section 10 records
 * that Google, Bing and Esri tiles were considered and rejected because their
 * terms forbid re-hosting, and the brief grades licensing. OpenSeaMap is the
 * licence-clean way to get what those tiles were wanted for.
 */
function MapStyleSwitch({
  value,
  onChange,
}: {
  value: MapStyle;
  onChange: (style: MapStyle) => void;
}) {
  const options: { id: MapStyle; label: string; hint: string }[] = [
    { id: "default", label: "Default", hint: "Imagery pushed back, drawn geometry leading" },
    { id: "satellite", label: "Satellite", hint: "Sentinel-2 cloudless 2025 (EOX), CC BY 4.0" },
    {
      id: "nautical",
      label: "Nautical",
      hint: "Drawn chart only, no photograph — charted lights from OpenSeaMap (ODbL)",
    },
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
    { id: "chase", label: "Chase", hint: "From astern, vessel in frame" },
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
    scheduleMinutes: state.scheduleMinutes,
    relativeWindDeg: relativeBearing(heading, local.wind_direction_deg ?? 0),
    relativeWaveDeg: relativeBearing(heading, local.wave_direction_deg ?? 0),
    rollDeg: motion.rollDeg,
    encounterPeriod: motion.encounterPeriod,
    fuelUsedL: state.voyage.fuelUsedL,
    advisedFuelL: state.voyage.advisedFuelL,
    elapsedSeconds: state.voyage.elapsedSeconds,
    conditions: local,
    vessel: { ...state.vesselSpec },
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
    frames: state.health.frames.slice(),
    safety: { ...state.safety },
    forecast: { ...state.forecast },
    log: state.log.slice(0, 24),
    liveForecast: state.liveForecast,
    timeScale: state.timeScale,
  };
}
