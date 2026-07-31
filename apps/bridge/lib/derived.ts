// Quantities the display works out for itself.
//
// Everything here is arithmetic on numbers that are already on the screen --
// vector sums, ratios, unit changes. Nothing in this file is a model, and
// nothing in it invents an input. That distinction is the whole reason the file
// exists separately: a panel that mixes model output with derived arithmetic and
// labels neither is a panel a judge cannot audit, so the display keeps them
// apart and says which is which.
//
// The rule applied throughout: if a quantity needs data we do not have, it is
// absent from this file and the panel says why. A readout that has shown "--"
// since launch is worse than no readout, because it trains the eye to skip a
// region of the screen and teaches nothing about what the system knows.

import type { AdviseResponse } from "./contracts";

/** Marine gas oil at 15 C. Matches services/speed/fuel.py exactly -- if these
 *  two ever disagree the display and the server would report different SFOCs
 *  for the same burn. */
export const FUEL_DENSITY_KG_PER_L = 0.845;

const DEG = Math.PI / 180;

export interface SetAndDrift {
  /** Knots of current pushing across the vessel's track. Signed: + is to starboard. */
  crossTrackKn: number;
  /** Knots of current along the track. + helps, - opposes. This is the only
   *  component the fuel model uses. */
  alongTrackKn: number;
  /** Crab angle: degrees between where the bow points and where the vessel goes.
   *  Signed the same way as crossTrackKn. */
  crabDeg: number;
  /** Resulting course over ground, compass degrees. */
  courseOverGroundDeg: number;
  /** Resulting speed over ground, knots. */
  speedOverGroundKn: number;
}

/**
 * Set and drift, by vector sum.
 *
 * A vessel pointing at its destination in a cross-current does not travel toward
 * its destination, and the difference has a name at sea: crab. The server does
 * not compute this -- `speed_through_water_kn` there projects the current onto
 * the track and keeps the along-track part only, because that is the component
 * that changes what the hull costs to push. The cross-track part costs nothing
 * in fuel and everything in navigation, which is exactly why it belongs on the
 * display rather than in the fuel model.
 *
 * `currentTowardDeg` is where the water flows TO, matching the contract.
 */
export function setAndDrift(
  headingDeg: number,
  speedThroughWaterKn: number,
  currentSpeedKn: number,
  currentTowardDeg: number,
): SetAndDrift {
  // Angle of the current relative to the bow. 0 is dead ahead (a following
  // current pushing the way we point), 180 is dead on the nose.
  const relative = (((currentTowardDeg - headingDeg) % 360) + 540) % 360 - 180;
  const alongTrackKn = currentSpeedKn * Math.cos(relative * DEG);
  const crossTrackKn = currentSpeedKn * Math.sin(relative * DEG);

  const forward = speedThroughWaterKn + alongTrackKn;
  const speedOverGroundKn = Math.hypot(forward, crossTrackKn);
  const crabDeg = forward === 0 && crossTrackKn === 0
    ? 0
    : Math.atan2(crossTrackKn, forward) / DEG;

  return {
    crossTrackKn,
    alongTrackKn,
    crabDeg,
    courseOverGroundDeg: (((headingDeg + crabDeg) % 360) + 360) % 360,
    speedOverGroundKn,
  };
}

export interface EngineDuty {
  /** Shaft power as a fraction of the engine's continuous rating. */
  loadFraction: number;
  /** Grams of fuel per kilowatt-hour actually being achieved right now.
   *  Null below any useful load, where the figure is dominated by the idle
   *  floor and means nothing. */
  sfocGPerKwh: number | null;
  /** How far the realised SFOC sits above the engine's best point, as a
   *  fraction. This is the number the throttle advisory is really moving. */
  aboveBestPoint: number | null;
}

/**
 * What the engine is being asked to do, and what that is costing per unit of
 * work.
 *
 * Both figures come straight out of the API response -- shaft kilowatts and
 * litres per hour -- turned into the units an engineer reads. The server
 * computes the same effective BSFC internally; this recomputes it from the two
 * published numbers rather than asking for a third, so if the display and the
 * server ever disagreed it would be visible rather than papered over.
 */
export function engineDuty(
  response: AdviseResponse | null,
  ratedKw: number,
  bestBsfcGPerKwh: number,
): EngineDuty | null {
  if (!response) return null;
  const shaftKw = response.power.total_kw;
  const burnLph = response.recommendation.current_burn_lph;
  const loadFraction = ratedKw > 0 ? shaftKw / ratedKw : 0;

  // Below a few percent of rating the idle floor sets the burn, and fuel per
  // unit of work runs away to numbers that are arithmetically true and
  // operationally meaningless. Reporting nothing is the honest answer there.
  if (burnLph == null || shaftKw < ratedKw * 0.03) {
    return { loadFraction, sfocGPerKwh: null, aboveBestPoint: null };
  }

  const sfocGPerKwh = (burnLph * FUEL_DENSITY_KG_PER_L * 1000) / shaftKw;
  return {
    loadFraction,
    sfocGPerKwh,
    aboveBestPoint: bestBsfcGPerKwh > 0 ? sfocGPerKwh / bestBsfcGPerKwh - 1 : null,
  };
}

export interface PowerSplit {
  calmKw: number;
  windKw: number;
  waveKw: number;
  totalKw: number;
  /** Each as a share of total, for the bar. */
  calmPct: number;
  windPct: number;
  wavePct: number;
}

/**
 * Where the shaft power is going.
 *
 * This is the honest version of a "windage drag" readout: rather than a lone
 * number with no denominator, it is the actual three-way split the resistance
 * model produced, so the weather's share can be read against the hull's own.
 * When the split moves as the weather slider moves, the physics is visibly
 * doing work -- which is the claim the technical profile makes and the thing a
 * judge will want to watch happen.
 */
export function powerSplit(response: AdviseResponse | null): PowerSplit | null {
  if (!response) return null;
  const { calm_water_kw: calmKw, wind_kw: windKw, wave_kw: waveKw, total_kw: totalKw } =
    response.power;
  const denominator = totalKw > 0 ? totalKw : 1;
  return {
    calmKw,
    windKw,
    waveKw,
    totalKw,
    calmPct: (calmKw / denominator) * 100,
    windPct: (windKw / denominator) * 100,
    wavePct: (waveKw / denominator) * 100,
  };
}

/**
 * A signed figure whose sign disappears when the figure does.
 *
 * `(0).toFixed(2)` with a sign glyph pasted on the front gives "−0.00", which
 * on a bridge display is a small lie told confidently: it states a direction for
 * a quantity that has none, and the reader has to work out that the sign is an
 * artefact rather than a measurement. It shows up wherever a delta is genuinely
 * zero, which for the route planner is the common case in benign weather -- the
 * direct track IS the cheapest track, the saving is exactly nothing, and the
 * panel should say nothing rather than say "minus nothing".
 *
 * The glyphs are passed in because the sign convention is not the value's. A
 * positive saving is a fall in fuel and reads as a minus, so that caller hands
 * in inverted glyphs. Rounding is done before the sign is chosen, so the glyph
 * can never contradict the digits shown next to it.
 */
export function signedToFixed(
  value: number,
  digits: number,
  signs: { positive: string; negative: string } = { positive: "+", negative: "−" },
): string {
  const rounded = Number(value.toFixed(digits));
  const magnitude = Math.abs(rounded).toFixed(digits);
  if (rounded === 0) return magnitude;
  return (rounded > 0 ? signs.positive : signs.negative) + magnitude;
}

/** Beaufort force for a wind speed in knots. A scale operators actually speak
 *  in, and a useful sanity check on a slider that otherwise reads as a bare
 *  number. */
export function beaufort(windKn: number): { force: number; label: string } {
  const limits = [1, 3, 6, 10, 16, 21, 27, 33, 40, 47, 55, 63];
  const labels = [
    "Calm",
    "Light air",
    "Light breeze",
    "Gentle breeze",
    "Moderate breeze",
    "Fresh breeze",
    "Strong breeze",
    "Near gale",
    "Gale",
    "Strong gale",
    "Storm",
    "Violent storm",
    "Hurricane",
  ];
  let force = 0;
  while (force < limits.length && windKn >= limits[force]) force += 1;
  return { force, label: labels[force] };
}

export interface SchedulePressure {
  /** The ETA budget the operator asked for, minutes. */
  targetMinutes: number;
  /** What the planner says the crossing will actually take, minutes. */
  feasibleMinutes: number;
  /** How far past the budget that lands. Positive is late. */
  shortfallMinutes: number;
}

/**
 * Target crossing time against the one the planner can actually achieve.
 *
 * `schedule_feasible` is a bare boolean, and a display that renders it as
 * "cannot be held" tells a captain that a problem exists while withholding the
 * only two numbers that would let him do anything about it: how late, and how
 * fast the boat can actually go. The reference simulator is better than this
 * display was here -- it states "Actual Feasible ETA" beside the target.
 *
 * Both figures are the planner's, not this file's. `achievable_minutes` sums
 * each leg's time at its own optimised speed; the subtraction below is the only
 * arithmetic performed.
 *
 * The trap this function exists to avoid: **`eta` is not the achievable
 * arrival**. When a schedule is requested, the planner costs every leg at the
 * required speed-over-ground and accumulates those planned minutes, so `eta`
 * reproduces the requested arrival exactly whether or not the hull can hold it.
 * Subtracting `eta - generated_at` therefore yields the budget back and a
 * shortfall of zero on precisely the routes that miss their schedule -- which is
 * what an earlier version of this displayed. Read `achievable_minutes`.
 */
export function schedulePressure(
  achievableMinutes: number | null | undefined,
  targetMinutes: number,
): SchedulePressure | null {
  if (achievableMinutes == null || !Number.isFinite(achievableMinutes)) return null;

  return {
    targetMinutes,
    feasibleMinutes: achievableMinutes,
    shortfallMinutes: achievableMinutes - targetMinutes,
  };
}

/** Douglas sea state from significant wave height, in metres. */
export function douglasSea(waveM: number): { state: number; label: string } {
  const limits = [0.1, 0.5, 1.25, 2.5, 4, 6, 9, 14];
  const labels = [
    "Glassy",
    "Rippled",
    "Smooth",
    "Slight",
    "Moderate",
    "Rough",
    "Very rough",
    "High",
    "Very high",
  ];
  let state = 0;
  while (state < limits.length && waveM >= limits[state]) state += 1;
  return { state, label: labels[state] };
}
