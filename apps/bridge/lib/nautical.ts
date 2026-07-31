// Nautical geometry and vector helpers.
//
// The sign conventions here mirror services/speed/resistance.py exactly, and are
// restated rather than assumed because getting one backwards silently inverts
// every recommendation on the screen:
//
//   wind_direction_deg     the direction the wind blows FROM   (meteorological)
//   current_direction_deg  the direction the current flows TOWARD (oceanographic)
//   wave_direction_deg     the direction the waves come FROM, like wind
//
// Nothing in this file computes fuel, power, or speed. Those come from the API.
// See lib/api.ts for why the browser is not allowed to have opinions about physics.

export interface Vec {
  x: number;
  y: number;
}

export const vec = {
  add: (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y }),
  mul: (v: Vec, s: number): Vec => ({ x: v.x * s, y: v.y * s }),
  mag: (v: Vec): number => Math.hypot(v.x, v.y),
  dist: (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y),
  norm: (v: Vec): Vec => {
    const m = Math.hypot(v.x, v.y);
    return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
  },
  lerp: (a: Vec, b: Vec, t: number): Vec => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }),
};

export const DEG = Math.PI / 180;
export const KNOTS_TO_MS = 0.514444;
export const G = 9.81;

/** Wrap to [0, 360). */
export function normaliseDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Signed angle from the vessel's bow to a compass direction, in [0, 360).
 * 0 is dead ahead, 90 is the starboard beam, 180 astern.
 *
 * Mirrors `_relative_angle_deg` in resistance.py, but signed: the physics only
 * needs 0-180 because port and starboard cost the same fuel, while the display
 * must show which side a sea is on.
 */
export function relativeBearing(headingDeg: number, targetDeg: number): number {
  return normaliseDeg(targetDeg - headingDeg);
}

/** Unsigned 0-180 form, matching the Python model exactly. */
export function relativeAngle(headingDeg: number, targetDeg: number): number {
  const d = Math.abs(normaliseDeg(targetDeg - headingDeg + 180) - 180);
  return d;
}

/**
 * The sector a relative bearing falls in, named the way a crew names it.
 *
 * The reference simulator buckets the full circle into four 90-degree wedges, so
 * a sea 40 degrees off the bow and a sea dead ahead both read "Head Sea". Those
 * are not the same sea: the first rolls the boat and the second slams it, and
 * the added resistance they cost differs by more than the label admits. These
 * are the conventional sectors instead -- ahead and astern are narrow, because
 * "right ahead" means right ahead -- so the words track the physics rather than
 * flattening it.
 *
 * `side` is null only where the sector has no side to have: nothing is to port
 * or starboard of the bow itself.
 */
export interface BearingSector {
  /** Sector alone: "head", "bow", "beam", "quarter", "following". */
  sector: "head" | "bow" | "beam" | "quarter" | "following";
  side: "port" | "starboard" | null;
  /** Ready to print: "port bow", "head", "starboard quarter". */
  label: string;
  /** True where waves meet the hull close to end-on and drive the added
   *  resistance term hardest. Used to tone the readout, never to compute a
   *  number -- the resistance itself comes from the API. */
  headOn: boolean;
}

export function bearingSector(relativeDeg: number): BearingSector {
  const a = normaliseDeg(relativeDeg);
  // Fold to 0-180 and remember which side it came from. 0 is the bow, 180 the
  // stern, and the sectors are symmetric about the centreline.
  const off = a > 180 ? 360 - a : a;
  const side: "port" | "starboard" | null =
    off < 10 || off > 170 ? null : a > 180 ? "port" : "starboard";

  let sector: BearingSector["sector"];
  if (off < 10) sector = "head";
  else if (off < 80) sector = "bow";
  else if (off < 100) sector = "beam";
  else if (off < 170) sector = "quarter";
  else sector = "following";

  return {
    sector,
    side,
    label: side ? `${side} ${sector}` : sector,
    headOn: off < 45,
  };
}

/** Sector name alone, for places with no room for the side. */
export function bearingDescription(relativeDeg: number): string {
  return bearingSector(relativeDeg).label;
}

/**
 * Dominant wave period for a wind-driven sea, seconds.
 *
 * Short coastal fetches do not build long swell, so period is estimated from
 * significant wave height by the usual wind-sea approximation rather than being
 * taken as an independent input the operator would have no way to supply.
 */
export function wavePeriodSeconds(waveHeightM: number): number {
  return 4.0 * Math.sqrt(Math.max(0.15, waveHeightM));
}

/**
 * Encounter period: how often waves actually hit a vessel that is moving
 * through them, which is not the same as the wave period itself.
 *
 *   omega_e = omega - omega^2 * V * cos(mu) / g
 *
 * where mu is the angle between the vessel's heading and the direction the
 * waves are travelling. Steaming into a head sea meets crests sooner (shorter
 * period, harder motion); running with a following sea stretches them out.
 *
 * This is the standard encounter-frequency relation, and it is why the helm
 * view's motion changes when you turn the boat rather than only when the
 * weather changes.
 */
export function encounterPeriodSeconds(
  waveHeightM: number,
  speedKn: number,
  headingDeg: number,
  waveFromDeg: number,
): number {
  const T = wavePeriodSeconds(waveHeightM);
  const omega = (2 * Math.PI) / T;
  // Waves travel toward the reciprocal of the direction they come from.
  const travelDeg = normaliseDeg(waveFromDeg + 180);
  const mu = relativeAngle(headingDeg, travelDeg) * DEG;
  const v = Math.max(0, speedKn) * KNOTS_TO_MS;

  const omegaE = omega - (omega * omega * v * Math.cos(mu)) / G;
  // Following seas overtaken by the vessel drive omega_e through zero; clamp so
  // the renderer never divides by nothing.
  return (2 * Math.PI) / Math.max(0.25, Math.abs(omegaE));
}

/** Catmull-Rom through the given points, for a route that curves like a helm order. */
export function spline(points: Vec[], segments = 24): Vec[] {
  if (points.length < 2) return [...points];
  const pts = [points[0], ...points, points[points.length - 1]];
  const out: Vec[] = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return out;
}

/** Shortest signed turn from a to b, in radians, for smooth heading changes. */
export function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d < -Math.PI) d += Math.PI * 2;
  while (d > Math.PI) d -= Math.PI * 2;
  return d;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
