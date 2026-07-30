// Simulator state and the per-frame step.
//
// Kept out of React deliberately. This mutates at 60fps; putting it in component
// state would re-render the whole tree sixty times a second to move a boat four
// pixels. React owns the panels, this owns the vessel, and the two meet at a
// throttled snapshot.
//
// The important rule: this file never computes fuel, power, or achievable speed.
// It reads them from the API response held in `api.response`. Where a value is
// not available yet, the vessel is shown as stopped rather than moving at an
// invented speed -- which was precisely the flaw in the prototype this replaces.

import type {
  AdviseResponse,
  MaintenanceStatus,
  RouteResponse,
  SafetyState,
  TelemetryFrame,
} from "./contracts";
import { speedForRpm } from "./api";
import { type FaultState, emulateFrame } from "./telemetry";
import type { EnvironmentInputs, Hazard } from "./environment";
import { WEATHER, conditionsAt } from "./environment";
import { type Vec, angleDelta, clamp } from "./nautical";
import { baselineTrack, pathLength, pointAlong, shapeRoute } from "./router";
import type { ChartView } from "./render-chart";

export type PovMode = ChartView | "helm";

export interface ChartData {
  bounds: { min_lat: number; max_lat: number; min_lon: number; max_lon: number };
  chart_width_nm: number;
  chart_height_nm: number;
  crossing_nm: number;
  ports: { name: string; x: number; y: number }[];
  coastline: number[][][];
  attribution: string;
  scale_caveat: string;
  /** Present once `python -m data.build_chart` has fetched the Sentinel-2
   *  composite. Absent is a supported state: the display then draws the vector
   *  chart alone and the helm view shows an empty horizon. */
  basemap?: {
    image: string;
    landmask: string;
    mask_width: number;
    mask_height: number;
    source: string;
    attribution: string;
    caveat: string;
  };
}

export interface Port {
  position: Vec;
  name: string;
}

export type GeoBounds = ChartData["bounds"];

/** Bounds used when `chart.json` is absent. The Iloilo Strait box the chart
 *  builder itself uses, so a degraded display still plans real routes over real
 *  water rather than a coordinate at sea off Africa. */
export const DEFAULT_BOUNDS: GeoBounds = {
  min_lat: 10.58,
  max_lat: 10.78,
  min_lon: 122.46,
  max_lon: 122.72,
};

/** Screen-normalised chart position -> WGS84. Canvas y runs south. */
export function toLatLon(state: SimState, position: Vec): { latitude: number; longitude: number } {
  const b = state.bounds;
  return {
    latitude: b.max_lat - position.y * (b.max_lat - b.min_lat),
    longitude: b.min_lon + position.x * (b.max_lon - b.min_lon),
  };
}

/** Philippine Standard Time is UTC+8 all year -- there is no DST to handle. */
const PHT_OFFSET_HOURS = 8;

/** The first Iloilo-Jordan crossing of the day, and the scene PRODUCT.md keeps
 *  returning to: 05:40, one hand on the throttle, spray on the screen.
 *
 *  It is also the right default for a demo. Opening at whatever hour the judge
 *  happens to click is not reproducible, and half the time it would be dark. */
export const DEFAULT_DEPARTURE_PHT = 5 + 40 / 60;

/** Epoch milliseconds for a given hour of *today*, Philippine time. */
export function phtClock(hoursDecimal: number, reference: number = Date.now()): number {
  const now = new Date(reference + PHT_OFFSET_HOURS * 3_600_000);
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    Math.floor(hoursDecimal) - PHT_OFFSET_HOURS,
    Math.round((hoursDecimal % 1) * 60),
  );
}

/** How many emulated engine frames the health window holds.
 *
 *  One frame per simulated second, so this is a two-minute window in vessel
 *  time. The detector's trend arm halves the window to compare early against
 *  late, and needs at least four frames to say anything at all. */
export const HEALTH_WINDOW_FRAMES = 120;

export interface LogEntry {
  id: number;
  time: string;
  message: string;
  kind: "info" | "warn" | "alert" | "advisory";
}

export interface SimState {
  width: number;
  height: number;
  timeSeconds: number;

  running: boolean;
  arrived: boolean;
  direction: 1 | -1;
  pov: PovMode;

  ports: [Port, Port];
  coastline: Vec[][];
  chartWidthNm: number;
  crossingNm: number;
  bounds: GeoBounds;

  route: Vec[];
  baseline: Vec[];
  diverted: boolean;

  vessel: {
    progress: number;
    position: Vec;
    headingRad: number;
    speedKn: number;
  };

  throttlePct: number;
  ratedRpm: number;
  /** Demo time compression. 1 is real time. Always shown on screen: a crossing
   *  that takes 17 minutes in reality must not silently appear to take one. */
  timeScale: number;
  passengers: number;
  cargoKg: number;
  egtExcess: number;
  scheduleMinutes: number;
  /** Injected engine fault, for demonstrating the Phase 1 anomaly detector. */
  fault: FaultState;
  /** This engine's run-hours. Sets the detector's cold-start confidence. */
  engineHours: number;

  env: EnvironmentInputs;
  liveForecast: boolean;

  obstacles: Hazard[];
  storms: Hazard[];

  particles: {
    wind: { x: number; y: number; life: number; maxLife: number }[];
    swell: { x: number; y: number; life: number }[];
    rain: { x: number; y: number; length: number }[];
  };

  // Three modules, three independent freshness clocks. They are deliberately not
  // merged: speed is a per-second advisory, route is planned at the dock, and
  // health is scored over a rolling window. One shared "last updated" would make
  // a three-minute-old route look as stale as a three-minute-old throttle
  // number, and PRODUCT.md's rule is to never hide the age of advice -- which
  // means showing each panel's real age, not a lowest common denominator.
  api: {
    response: AdviseResponse | null;
    error: string | null;
    lastRequestAt: number;
    ageSeconds: number;
  };

  routePlan: {
    response: RouteResponse | null;
    error: string | null;
    lastRequestAt: number;
    ageSeconds: number;
    /** True while a plan is in flight. Route requests are not per-second, so the
     *  display says "planning" rather than silently showing the previous track. */
    planning: boolean;
  };

  health: {
    status: MaintenanceStatus | null;
    error: string | null;
    lastRequestAt: number;
    ageSeconds: number;
    /** Rolling window of emulated engine frames, oldest first. */
    frames: TelemetryFrame[];
    /** Simulated-clock milliseconds at which the next frame is due. */
    nextFrameAtMs: number;
  };

  // Safety is kept separate from health, and that separation is the product
  // argument, not a code convention. Health is a learned model that can be
  // wrong; safety is a threshold that cannot. They must never share a state
  // field, because the moment they do, someone will let the model suppress the
  // alarm.
  safety: {
    state: SafetyState | null;
    error: string | null;
    lastRequestAt: number;
    ageSeconds: number;
  };

  /** Simulated epoch milliseconds. Advances with time compression, so telemetry
   *  timestamps and the detector's trend window read in vessel time. */
  simClockMs: number;

  voyage: {
    /** Burned at the throttle the captain is actually holding. */
    fuelUsedL: number;
    /** What the same voyage would have burned had the advisory been followed.
     *  The counterfactual, kept separate so "saved" is always a difference
     *  between two named quantities rather than an unanchored claim. */
    advisedFuelL: number;
    elapsedSeconds: number;
  };

  log: LogEntry[];
  logCounter: number;
}

export const DEFAULT_ENV: EnvironmentInputs = {
  windSpeedKn: 12,
  windDirectionDeg: 45,
  currentSpeedKn: 1.2,
  currentDirectionDeg: 180,
  waveHeightM: 0.6,
  waveDirectionDeg: 45,
  weather: "clear",
};

export function createState(chart: ChartData | null): SimState {
  const ports: [Port, Port] = chart
    ? [
        { position: { x: chart.ports[0].x, y: chart.ports[0].y }, name: chart.ports[0].name },
        { position: { x: chart.ports[1].x, y: chart.ports[1].y }, name: chart.ports[1].name },
      ]
    : [
        { position: { x: 0.16, y: 0.34 }, name: "Iloilo City" },
        { position: { x: 0.78, y: 0.62 }, name: "Jordan, Guimaras" },
      ];

  return {
    width: 0,
    height: 0,
    timeSeconds: 0,
    running: false,
    arrived: false,
    direction: 1,
    pov: "north-up",

    ports,
    coastline: (chart?.coastline ?? []).map((ring) => ring.map(([x, y]) => ({ x, y }))),
    chartWidthNm: chart?.chart_width_nm ?? 15,
    crossingNm: chart?.crossing_nm ?? 2.8,
    bounds: chart?.bounds ?? DEFAULT_BOUNDS,

    route: [],
    baseline: [],
    diverted: false,

    vessel: { progress: 0, position: { x: 0, y: 0 }, headingRad: 0, speedKn: 0 },

    throttlePct: 70,
    ratedRpm: 2800,
    timeScale: 20,
    passengers: 40,
    cargoKg: 1500,
    egtExcess: 1.0,
    scheduleMinutes: 22,
    fault: { kind: "none", sigmas: 0 },
    // Enough history that the baseline is established (~0.8 confidence) but far
    // short of the labelled failure history Phase 2 would require. The detector
    // is honest about both ends of that.
    engineHours: 480,

    env: { ...DEFAULT_ENV },
    liveForecast: false,

    obstacles: [],
    storms: [],

    particles: { wind: [], swell: [], rain: [] },

    api: { response: null, error: null, lastRequestAt: 0, ageSeconds: 0 },
    routePlan: { response: null, error: null, lastRequestAt: 0, ageSeconds: 0, planning: false },
    health: {
      status: null,
      error: null,
      lastRequestAt: 0,
      ageSeconds: 0,
      frames: [],
      nextFrameAtMs: 0,
    },
    safety: { state: null, error: null, lastRequestAt: 0, ageSeconds: 0 },
    simClockMs: phtClock(DEFAULT_DEPARTURE_PHT),
    voyage: { fuelUsedL: 0, advisedFuelL: 0, elapsedSeconds: 0 },

    log: [],
    logCounter: 0,
  };
}

export function addLog(state: SimState, message: string, kind: LogEntry["kind"] = "info"): void {
  state.logCounter += 1;
  state.log.unshift({
    id: state.logCounter,
    time: new Date().toLocaleTimeString("en-GB", { hour12: false }),
    message,
    kind,
  });
  if (state.log.length > 60) state.log.length = 60;
}

export function startPort(state: SimState): Port {
  return state.direction === 1 ? state.ports[0] : state.ports[1];
}

export function endPort(state: SimState): Port {
  return state.direction === 1 ? state.ports[1] : state.ports[0];
}

/** Local current as a screen-space vector, for the route shaper. */
function currentVector(state: SimState) {
  return (x: number, y: number): Vec => {
    const local = conditionsAt(
      state.width ? x / state.width : 0.5,
      x,
      y,
      state.env,
      state.storms,
      state.obstacles,
    );
    // Current flows TOWARD its compass direction.
    const rad = (local.current_direction_deg ?? 0) * (Math.PI / 180);
    const speed = local.current_speed_kn ?? 0;
    return { x: Math.sin(rad) * speed, y: -Math.cos(rad) * speed };
  };
}

export function rebuildRoute(state: SimState): void {
  if (state.width === 0 || state.height === 0) return;

  // Always the full track, berth to berth. An earlier version re-anchored it to
  // the vessel's current position each frame, which broke the meaning of
  // `progress`: the fraction indexes the whole crossing, so indexing it into a
  // path that started where the vessel already was moved the vessel forward
  // again every frame, and it shot across the strait in seconds.
  const from = startPort(state).position;
  const to = endPort(state).position;

  const result = shapeRoute(
    from,
    to,
    state.width,
    state.height,
    [...state.obstacles, ...state.storms],
    currentVector(state),
  );
  state.route = result.path;
  state.diverted = result.diverted;
  state.baseline = baselineTrack(startPort(state).position, endPort(state).position);
}

export function placeVesselAtStart(state: SimState): void {
  rebuildRoute(state);
  state.vessel.progress = 0;
  state.arrived = false;
  state.voyage = { fuelUsedL: 0, advisedFuelL: 0, elapsedSeconds: 0 };

  if (state.route.length > 1) {
    const { point, headingRad } = pointAlong(state.route, 0);
    state.vessel.position = point;
    state.vessel.headingRad = headingRad;
  }
}

/** Vessel heading as a compass bearing. Canvas x is east, y is south. */
export function headingDeg(state: SimState): number {
  const deg = (state.vessel.headingRad * 180) / Math.PI + 90;
  return ((deg % 360) + 360) % 360;
}

export function currentRpm(state: SimState): number {
  return (state.throttlePct / 100) * state.ratedRpm;
}

/** Distance still to run, in nautical miles. */
export function distanceRemainingNm(state: SimState): number {
  return Math.max(0.05, state.crossingNm * (1 - state.vessel.progress));
}

export function localConditions(state: SimState) {
  const { position } = state.vessel;
  const nx = state.width ? clamp(position.x / state.width, 0, 1) : 0.5;
  return conditionsAt(nx, position.x, position.y, state.env, state.storms, state.obstacles);
}

/**
 * Advance the simulation.
 *
 * Speed comes from `speedForRpm` against the API's performance curve -- real
 * model output, interpolated. When there is no curve the vessel does not move,
 * which is the honest behaviour: with no model there is no speed to claim.
 */
export function step(state: SimState, realDt: number): void {
  // Wall-clock drives animation; simulated time drives the voyage. Separating
  // them is what lets a 17-minute crossing be watched in under a minute without
  // the sea appearing to move at twenty times its actual speed.
  const dt = realDt * state.timeScale;
  state.timeSeconds += realDt;
  state.simClockMs += dt * 1000;
  stepParticles(state, realDt);
  stepTelemetry(state);

  const now = performance.now();
  if (state.api.lastRequestAt) {
    state.api.ageSeconds = (now - state.api.lastRequestAt) / 1000;
  }
  if (state.routePlan.lastRequestAt) {
    state.routePlan.ageSeconds = (now - state.routePlan.lastRequestAt) / 1000;
  }
  if (state.health.lastRequestAt) {
    state.health.ageSeconds = (now - state.health.lastRequestAt) / 1000;
  }
  if (state.safety.lastRequestAt) {
    state.safety.ageSeconds = (now - state.safety.lastRequestAt) / 1000;
  }

  const curve = state.api.response?.curve ?? null;
  const speed = speedForRpm(curve, currentRpm(state));
  state.vessel.speedKn = state.running ? (speed ?? 0) : 0;

  if (!state.running || state.arrived) return;

  // Two totals, both real: what is being burned, and what following the
  // advisory would have burned. Their difference is the only savings figure
  // this system ever shows, and both sides of it are named.
  const burn = state.api.response?.recommendation.current_burn_lph ?? null;
  const advised = state.api.response?.recommendation.predicted_burn_lph ?? null;
  if (burn != null) state.voyage.fuelUsedL += (burn * dt) / 3600;
  if (advised != null) state.voyage.advisedFuelL += (advised * dt) / 3600;
  state.voyage.elapsedSeconds += dt;

  const total = pathLength(state.route);
  if (total <= 0) return;

  // Progress is measured in real distance: knots -> nm -> fraction of crossing.
  // The `* dt` is load-bearing: without it the vessel advances once per frame
  // rather than once per second, and a 17-minute crossing finishes in six.
  const nmPerSecond = state.vessel.speedKn / 3600;
  state.vessel.progress = clamp(
    state.vessel.progress + (nmPerSecond * dt) / Math.max(0.05, state.crossingNm),
    0,
    1,
  );

  const { point, headingRad } = pointAlong(state.route, state.vessel.progress);
  state.vessel.position = point;
  // Ease the heading so the vessel turns like a boat, not a cursor. This one
  // uses wall-clock time: turn rate is a visual smoothing constant, and scaling
  // it with the compression factor would make every turn snap instantly.
  state.vessel.headingRad +=
    angleDelta(state.vessel.headingRad, headingRad) * Math.min(1, realDt * 2.5);

  if (state.vessel.progress >= 1) {
    state.arrived = true;
    state.running = false;
    addLog(state, `Arrived at ${endPort(state).name}.`, "info");
  }
}

/**
 * Emit emulated engine frames into the rolling health window.
 *
 * One frame per simulated second, caught up in a bounded loop so a compressed
 * clock still produces a dense window rather than one frame per rendered fps
 * tick. The cap matters: at 60x compression a single 16 ms frame is a second of
 * vessel time, and an unbounded catch-up after a backgrounded tab would emit
 * thousands of frames and stall the loop.
 *
 * Frames accumulate whether or not the voyage is running -- the engine idles at
 * the dock, and engine health is exactly the thing a captain wants to know
 * before letting go of the lines.
 */
function stepTelemetry(state: SimState): void {
  if (state.health.nextFrameAtMs === 0) state.health.nextFrameAtMs = state.simClockMs;

  const { frames } = state.health;
  for (let emitted = 0; emitted < 8 && state.health.nextFrameAtMs <= state.simClockMs; emitted++) {
    frames.push(
      emulateFrame({
        vesselId: "MV-SOLMATE-01",
        atMs: state.health.nextFrameAtMs,
        throttlePct: state.throttlePct,
        egtExcess: state.egtExcess,
        engineHours: state.engineHours,
        fault: state.fault,
      }),
    );
    state.health.nextFrameAtMs += 1000;
  }
  if (frames.length > HEALTH_WINDOW_FRAMES) {
    frames.splice(0, frames.length - HEALTH_WINDOW_FRAMES);
  }
  // A long stall (backgrounded tab) leaves the emitter arbitrarily far behind
  // the clock. Snap it forward rather than spending the next many ticks at the
  // catch-up cap emitting frames timestamped in the past.
  if (state.simClockMs - state.health.nextFrameAtMs > 60_000) {
    state.health.nextFrameAtMs = state.simClockMs;
  }
}

function stepParticles(state: SimState, dt: number): void {
  const { width: w, height: h } = state;
  if (w === 0 || h === 0) return;

  const local = localConditions(state);
  const preset = WEATHER[state.env.weather];
  const windRad = (local.wind_direction_deg ?? 0) * (Math.PI / 180);
  const vx = Math.sin(windRad);
  const vy = -Math.cos(windRad);

  const wind = state.particles.wind;
  while (wind.length < 70) {
    const maxLife = 1.5 + Math.random() * 1.5;
    wind.push({ x: Math.random() * w, y: Math.random() * h, life: Math.random() * maxLife, maxLife });
  }
  const windSpeed = Math.max(4, local.wind_speed_kn ?? 0);
  for (const p of wind) {
    p.life -= dt;
    p.x += vx * windSpeed * dt * 4;
    p.y += vy * windSpeed * dt * 4;
    if (p.life <= 0 || p.x < -60 || p.x > w + 60 || p.y < -60 || p.y > h + 60) {
      p.life = p.maxLife;
      p.x = Math.random() * w;
      p.y = Math.random() * h;
    }
  }

  const swell = state.particles.swell;
  while (swell.length < 90) {
    swell.push({ x: Math.random() * w, y: Math.random() * h, life: Math.random() });
  }
  const waveRad = (local.wave_direction_deg ?? 0) * (Math.PI / 180);
  const wx = Math.sin(waveRad);
  const wy = -Math.cos(waveRad);
  const waveSpeed = Math.max(3, (local.wave_height_m ?? 0) * 10);
  for (const p of swell) {
    p.life -= dt * 0.12;
    p.x += wx * waveSpeed * dt * 3;
    p.y += wy * waveSpeed * dt * 3;
    if (p.life <= 0 || p.x < -40 || p.x > w + 40 || p.y < -40 || p.y > h + 40) {
      p.life = 1;
      p.x = Math.random() * w;
      p.y = Math.random() * h;
    }
  }

  const rain = state.particles.rain;
  while (rain.length < preset.rain) {
    rain.push({ x: Math.random() * w, y: Math.random() * h, length: 14 + Math.random() * 26 });
  }
  while (rain.length > preset.rain) rain.pop();
  const rainSpeed = Math.max(18, windSpeed) * 9;
  for (const p of rain) {
    p.x += vx * rainSpeed * dt;
    p.y += vy * rainSpeed * dt;
    if (p.x < -80) p.x = w + 80;
    if (p.x > w + 80) p.x = -80;
    if (p.y < -80) p.y = h + 80;
    if (p.y > h + 80) p.y = -80;
  }
}
