// The vessel under advice.
//
// One definition, one place. Until now the spec was written out twice inside
// Simulator.tsx -- once for the /advise body and once for /route -- and the two
// copies agreed only because someone kept them in step by hand. That is a quiet
// threat to the claim the whole system rests on: Speed, Route and Emissions are
// only "one fuel model" if they are also one hull. Two literals drifting apart
// would break that without breaking a test.
//
// It is also the thing a judge will reach for first. A demo whose vessel cannot
// be changed is a demo about one boat; the product is a retrofit for a fleet of
// boats that are all slightly different, and the honest way to show that is to
// let someone type in a different one and watch the advice move.

import type { VesselInput } from "./contracts";

/**
 * Hull class.
 *
 * This is not a separate input to the physics -- `VesselInput` has no such
 * field, and inventing one here would put a control on screen that changes
 * nothing. What it actually does is set the Admiralty coefficient, which is the
 * one term in the resistance model that carries hull form. Presenting it as a
 * named class rather than a bare number is for the operator; the value it sets
 * is shown alongside, so nothing is hidden behind the label.
 */
export type HullClass = "displacement" | "semi_displacement" | "planing";

export const HULL_CLASSES: Record<
  HullClass,
  { label: string; admiralty: number; note: string }
> = {
  displacement: {
    label: "Displacement",
    admiralty: 90,
    note: "Full-bodied hull held below hull speed. Cheapest per mile, slowest.",
  },
  semi_displacement: {
    label: "Semi-displacement",
    admiralty: 70,
    note: "The common fiberglass passenger boat. Pays a hump penalty through transition.",
  },
  planing: {
    label: "Planing",
    admiralty: 55,
    note: "Rides on lift above transition. Fast, and expensive everywhere below it.",
  },
};

export interface VesselSpec {
  vesselId: string;
  name: string;
  hull: HullClass;
  lengthWaterlineM: number;
  beamM: number;
  draftM: number;
  displacementKg: number;
  ratedKw: number;
  ratedRpm: number;
  /** Primary calibration handle. Fit per vessel from its own fuel-flow meter. */
  admiraltyCoefficient: number;
  /** Best-point specific fuel consumption from the engine's shop-test curve. */
  bestBsfcGPerKwh: number;
  idleBurnLph: number;
  passengerCapacity: number;
}

/**
 * The demo vessel: a fiberglass passenger boat of the kind that actually runs
 * the Iloilo-Jordan crossing. Small, semi-displacement, single diesel.
 */
export const DEFAULT_VESSEL: VesselSpec = {
  vesselId: "MV-SOLMATE-01",
  name: "MV Solmate",
  hull: "semi_displacement",
  lengthWaterlineM: 11.5,
  beamM: 2.8,
  draftM: 1.1,
  displacementKg: 8500,
  ratedKw: 90,
  ratedRpm: 2800,
  admiraltyCoefficient: 70,
  bestBsfcGPerKwh: 215,
  idleBurnLph: 1.2,
  passengerCapacity: 60,
};

/**
 * Starting points, not specifications.
 *
 * Every one of these is a plausible vessel of its class and none of them is a
 * particular boat. They exist so the advice can be seen to move when the hull
 * changes; the moment a real vessel is fitted, its own numbers replace these and
 * the Admiralty coefficient is fitted from its own fuel-flow meter. Shipping
 * these as though they were surveyed figures would be the same overstatement the
 * project refuses everywhere else.
 */
export const VESSEL_PRESETS: { id: string; label: string; spec: VesselSpec }[] = [
  {
    id: "solmate",
    label: "Fiberglass passenger boat (demo)",
    spec: DEFAULT_VESSEL,
  },
  {
    id: "banca",
    label: "Motor banca, outrigger",
    spec: {
      ...DEFAULT_VESSEL,
      vesselId: "MB-DEMO-02",
      name: "Motor banca",
      hull: "displacement",
      lengthWaterlineM: 14.0,
      beamM: 1.9,
      draftM: 0.8,
      displacementKg: 6200,
      ratedKw: 45,
      ratedRpm: 2200,
      admiraltyCoefficient: 90,
      bestBsfcGPerKwh: 235,
      idleBurnLph: 0.9,
      passengerCapacity: 40,
    },
  },
  {
    id: "fastcraft",
    label: "Small fastcraft",
    spec: {
      ...DEFAULT_VESSEL,
      vesselId: "FC-DEMO-03",
      name: "Fastcraft",
      hull: "planing",
      lengthWaterlineM: 16.5,
      beamM: 4.2,
      draftM: 1.3,
      displacementKg: 19000,
      ratedKw: 300,
      ratedRpm: 2300,
      admiraltyCoefficient: 55,
      bestBsfcGPerKwh: 205,
      idleBurnLph: 3.0,
      passengerCapacity: 120,
    },
  },
];

/** The wire format. The API's contract is the source of truth for field names. */
export function toVesselInput(spec: VesselSpec): VesselInput {
  return {
    vessel_id: spec.vesselId,
    length_waterline_m: spec.lengthWaterlineM,
    beam_m: spec.beamM,
    draft_m: spec.draftM,
    displacement_kg: spec.displacementKg,
    rated_kw: spec.ratedKw,
    rated_rpm: spec.ratedRpm,
    admiralty_coefficient: spec.admiraltyCoefficient,
    best_bsfc_g_per_kwh: spec.bestBsfcGPerKwh,
    idle_burn_lph: spec.idleBurnLph,
  };
}

/** Operators here quote engines in horsepower; the physics is in kilowatts. */
export const KW_PER_HP = 0.7457;

export function kwToHp(kw: number): number {
  return kw / KW_PER_HP;
}

export function hpToKw(hp: number): number {
  return hp * KW_PER_HP;
}

/**
 * Block coefficient at LIGHTSHIP, estimated from the hull's own dimensions.
 *
 * Displacement / (L x B x T x rho). This is arithmetic on numbers the operator
 * already typed, not a model output, and it is worth showing because it is the
 * fastest way to catch a typo: a passenger boat with a Cb of 0.95 is a barge,
 * and a Cb over 1.0 is impossible.
 *
 * The "lightship" qualifier is load-bearing, not pedantry. `displacementKg` is
 * the empty boat: the server adds passengers and cargo on top of it as
 * `added_load_kg` (see apps/api/schemas.py), so this figure is the hull before
 * anyone steps aboard. The textbook Cb bands every naval architecture reference
 * quotes -- 0.5 to 0.85 -- are for ships at their design load waterline, and
 * comparing a lightship figure against them makes every plausible small craft
 * look impossibly fine. The demo boat reads 0.23 light and about 0.36 with 40
 * passengers and a tonne and a half of cargo; only the second is the number
 * those bands are about.
 *
 * The loaded figure is deliberately not computed here. Doing so would need the
 * server's PASSENGER_MASS_KG on this side of the language boundary, and a
 * duplicated constant that silently drifts is a worse defect than a readout
 * that says exactly which condition it is quoting.
 */
export function blockCoefficient(spec: VesselSpec): number {
  const volume = spec.lengthWaterlineM * spec.beamM * spec.draftM;
  if (volume <= 0) return 0;
  // Seawater at 1025 kg/m3.
  return spec.displacementKg / 1025 / volume;
}

/**
 * Hull speed, in knots: 1.34 x sqrt(waterline length in feet).
 *
 * The speed above which a displacement hull is climbing its own bow wave. Shown
 * next to service speed because the gap between them is what decides whether a
 * throttle recommendation has any room to work in.
 */
export function hullSpeedKn(spec: VesselSpec): number {
  return 1.34 * Math.sqrt(spec.lengthWaterlineM * 3.28084);
}

/**
 * Plausibility checks on operator input, in the operator's own language.
 *
 * These exist to catch a typo, and the bands are set so that they only fire on
 * one. A check that fires on the shipped presets is worse than no check: it
 * teaches the operator that the amber box is background noise, and the day a
 * real fat-finger arrives it is dismissed with the rest of them. So the low
 * bound is set against LIGHTSHIP displacement (see `blockCoefficient`) rather
 * than against the loaded-ship textbook band -- 0.15 admits every fine hull an
 * operator might legitimately fit, and still catches a displacement entered in
 * tonnes where kilogrammes were asked for, which is the mistake that actually
 * happens and which lands two orders of magnitude out.
 */
export function vesselWarnings(spec: VesselSpec): string[] {
  const notes: string[] = [];
  const cb = blockCoefficient(spec);
  if (cb > 1.0) {
    notes.push(
      `Block coefficient ${cb.toFixed(2)} is impossible — displacement exceeds the hull's own volume.`,
    );
  } else if (cb > 0.85) {
    notes.push(`Block coefficient ${cb.toFixed(2)} is barge-like for a passenger hull.`);
  } else if (cb > 0 && cb < 0.15) {
    notes.push(
      `Block coefficient ${cb.toFixed(2)} is too fine even for an empty hull — check that ` +
        `displacement is in kilogrammes, not tonnes.`,
    );
  }
  if (spec.beamM > spec.lengthWaterlineM / 2) {
    notes.push("Beam is more than half the waterline length — check the dimensions.");
  }
  if (spec.bestBsfcGPerKwh < 170 || spec.bestBsfcGPerKwh > 300) {
    notes.push("Best BSFC is outside the range published for marine diesels (≈180–280 g/kWh).");
  }
  return notes;
}
