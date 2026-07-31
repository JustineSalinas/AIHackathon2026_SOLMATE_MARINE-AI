// The simulator's electro-mechanical sensor emulation.
//
// `/maintenance` scores a window of TelemetryFrames against the vessel's learned
// normal. This file is what produces those frames in the demo -- it stands in
// for the retrofit kit's engine loom, and nothing else in the display invents
// sensor readings.
//
// The numbers here are not decorative. They mirror `_HEALTHY_MEAN` and
// `_HEALTHY_SIGMA` in services/maintenance/baseline.py, including the
// `load_gain` structure, because the detector's PCA half models the *joint*
// normal: coolant and exhaust temperature rise together with engine load on a
// healthy engine. Emulating each channel independently would put every frame off
// the learned manifold and the demo would alarm continuously on a healthy boat,
// which is exactly the false-positive failure the ensemble exists to avoid.
//
// Two consequences worth knowing before touching the constants:
//
//   * Opening the throttle moves coolant and EGT *along* the learned direction,
//     so it correctly raises no alarm. That is the demo beat that shows the
//     detector understands correlation rather than thresholds.
//   * Moving one stream alone -- the fault injector below, or the engine-wear
//     slider raising EGT while coolant stays put -- moves off the manifold and
//     is caught. The wear slider doing this is the Problem 1 -> Problem 2 link
//     made visible: the same signal that prices the fuel penalty is the signal
//     the health model sees.
//
// If baseline.py's healthy constants change, change them here too. They are
// duplicated across the language boundary and there is no generator for them.

import type { TelemetryFrame } from "./contracts";

/** Healthy centre of each channel. Mirrors `_HEALTHY_MEAN`. */
const HEALTHY = {
  coolantC: 82.0,
  oilPressureKpa: 350.0,
  batteryV: 13.8,
  egtC: 380.0,
  oilParticulatePpm: 15.0,
  noxPpm: 600.0,
  vibrationG: 0.05,
};

/** Healthy spread of each channel. Mirrors `_HEALTHY_SIGMA`. */
const SIGMA = {
  coolantC: 3.0,
  oilPressureKpa: 20.0,
  batteryV: 0.3,
  egtC: 25.0,
  oilParticulatePpm: 5.0,
  noxPpm: 80.0,
  vibrationG: 0.015,
};

/** How each channel responds to engine load. Mirrors `load_gain`. */
const LOAD_GAIN = {
  coolantC: 0.6,
  oilPressureKpa: -0.2,
  batteryV: 0.0,
  egtC: 0.7,
  oilParticulatePpm: 0.1,
  noxPpm: 0.3,
  vibrationG: 0.2,
};

/** Independent per-channel noise, as a fraction of sigma. Mirrors the `* 0.6`. */
const NOISE = 0.6;

/** Throttle the healthy baseline was characterised at, and the span of one
 *  standard deviation of load either side of it. */
const CRUISE_PCT = 70;
const LOAD_PCT_PER_SIGMA = 20;

export type FaultKind = "none" | "coolant" | "oil_pressure" | "vibration" | "battery";

export const FAULTS: { id: FaultKind; label: string; hint: string }[] = [
  { id: "none", label: "Healthy", hint: "Every channel on its learned manifold" },
  { id: "coolant", label: "Coolant creep", hint: "Coolant rises, load flat — cooling fault" },
  { id: "oil_pressure", label: "Oil pressure sag", hint: "Pressure falls at unchanged load" },
  { id: "vibration", label: "Vibration rise", hint: "Shaft or mount, IMU energy up" },
  { id: "battery", label: "Charging fault", hint: "Bus voltage drifting down" },
];

export interface FaultState {
  kind: FaultKind;
  /** Displacement of the affected stream, in healthy sigmas. */
  sigmas: number;
}

/** Box-Muller. The detector's scale is MAD-based, so the noise shape matters. */
function gaussian(): number {
  const u = Math.max(1e-9, Math.random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

export interface FrameInputs {
  vesselId: string;
  /** Simulated epoch milliseconds. Spaced in *vessel* time so the detector's
   *  trend window reads in the minutes a captain means, not wall-clock. */
  atMs: number;
  throttlePct: number;
  /** Shaft RPM for this frame. Passed in rather than derived from `throttlePct`
   *  here, because `currentRpm` in lib/simulation.ts already owns that relation
   *  against the vessel spec — recomputing it would be a second definition of
   *  the same number, which is the exact hazard the constants above carry. */
  engineRpm: number;
  /** The engine-wear slider. 1.0 as-new; raises EGT alone, off-manifold. */
  egtExcess: number;
  engineHours: number;
  fault: FaultState;
}

/**
 * One emulated frame of engine vital signs.
 *
 * `electro_mechanical` is always present: this is the demo's engine loom and it
 * is always wired. Frames without it are a legitimate contract state (a boat
 * whose engine channels are not installed) and the detector tolerates them, but
 * they are not what this simulator produces.
 */
export function emulateFrame(inputs: FrameInputs): TelemetryFrame {
  const { fault } = inputs;
  // Engine load as the baseline's latent variable: standardized about cruise.
  const load = Math.max(
    -2.5,
    Math.min(2.5, (inputs.throttlePct - CRUISE_PCT) / LOAD_PCT_PER_SIGMA),
  );

  // z-offset per channel: the shared load direction plus independent noise, then
  // whatever the injected fault displaces. Only the fault term is off-manifold.
  const z = (
    channel: keyof typeof HEALTHY,
    faultFor: FaultKind,
    direction: 1 | -1 = 1,
  ): number => {
    const base = load * LOAD_GAIN[channel] + gaussian() * NOISE;
    const injected = fault.kind === faultFor ? fault.sigmas * direction : 0;
    return base + injected;
  };

  const value = (channel: keyof typeof HEALTHY, zScore: number): number =>
    HEALTHY[channel] + zScore * SIGMA[channel];

  // Vibration is reported as three accelerometer axes, not as an RMS: the
  // baseline derives RMS from the per-axis variance across the window (see
  // `_vibration_rms`). So the fault has to widen the *spread* of the axes, not
  // shift their mean -- shifting the mean would be invisible to a variance.
  const vibrationG = Math.max(
    1e-4,
    value("vibrationG", z("vibrationG", "vibration")),
  );
  const perAxis = vibrationG / Math.sqrt(3);

  return {
    vessel_id: inputs.vesselId,
    ts: new Date(inputs.atMs).toISOString(),
    source: "simulator",
    // Load channels. The health detector ignores these -- it reads only
    // `electro_mechanical` -- but the duty-cycle summary is computed from them,
    // and torque is deliberately absent: this simulator has no torque model, and
    // inventing one would put a fabricated number into a wear figure. Without it
    // `load_fraction` falls back to RPM over rating, which is what we actually know.
    throttling: {
      engine_rpm: inputs.engineRpm,
      throttle_position_pct: inputs.throttlePct,
    },
    electro_mechanical: {
      coolant_temp_c: value("coolantC", z("coolantC", "coolant")),
      oil_pressure_kpa: value("oilPressureKpa", z("oilPressureKpa", "oil_pressure", -1)),
      battery_voltage_v: value("batteryV", z("batteryV", "battery", -1)),
      // The wear slider raises exhaust temperature at unchanged load. That is a
      // real off-manifold displacement, and the health model is meant to see it.
      exhaust_gas_temp_c: value("egtC", z("egtC", "none")) * inputs.egtExcess,
      oil_particulate_ppm: Math.max(0, value("oilParticulatePpm", z("oilParticulatePpm", "none"))),
      exhaust_nox_ppm: Math.max(0, value("noxPpm", z("noxPpm", "none"))),
      accel_x_g: gaussian() * perAxis,
      accel_y_g: gaussian() * perAxis,
      // Gravity sits on the vertical axis. The baseline de-means each axis before
      // taking its variance, so the 1 g offset is carried honestly rather than
      // omitted to make the arithmetic tidier.
      accel_z_g: 1.0 + gaussian() * perAxis,
      engine_hours: inputs.engineHours,
    },
  };
}
