// Where the sun is, for a given instant and position on the earth.
//
// This exists because the helm view lights the sea, and light that comes from an
// arbitrary direction is the thing that makes a rendered ocean look rendered. The
// glitter path has to run from the viewer toward the sun's true bearing, the sky
// has to warm toward the sun's true azimuth, and at 05:40 -- the hour PRODUCT.md
// keeps returning to, because it is when the first Iloilo-Jordan crossings
// actually run -- the sun has to be low and in the east, not overhead.
//
// It is also cheap honesty. The same instinct that keeps a fabricated wind term
// out of the fuel model keeps a fabricated sun out of the horizon: this is the
// standard NOAA solar position approximation, good to about a tenth of a degree,
// which is far better than a 70-degree field of view can show.

import { DEG } from "./nautical";

export interface SunPosition {
  /** Degrees above the horizon. Negative when the sun has set. */
  elevationDeg: number;
  /** Compass bearing of the sun, degrees true. */
  azimuthDeg: number;
  /** 0 at night, 1 in full day, ramped across twilight. The single number most
   *  of the renderer actually wants. */
  daylight: number;
  /** 1 near sunrise/sunset, 0 when the sun is high. Drives the warm colours. */
  goldenness: number;
}

/**
 * Solar elevation and azimuth by the NOAA approximation.
 *
 * Works entirely in UTC, so there is no timezone to get wrong -- the longitude
 * carries the difference. `atMs` is epoch milliseconds.
 */
export function sunPosition(atMs: number, latitude: number, longitude: number): SunPosition {
  const date = new Date(atMs);

  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000);
  const hours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;

  // Fractional year, radians.
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hours - 12) / 24);

  // Equation of time, minutes. The sun is not a good clock; this is by how much.
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  // Solar declination, radians.
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // True solar time, minutes past midnight, then the hour angle.
  //
  // The wrap is load-bearing, not tidiness. East of Greenwich the longitude term
  // pushes true solar time past 1440 minutes, so the raw hour angle can come out
  // near +266 degrees when the real angle is -94. Elevation survives that
  // unscathed because it only ever sees cos(ha), which is periodic -- but the
  // east/west test below reads the sign, so an unwrapped angle rises in the west.
  let hourAngleDeg = (hours * 60 + eqTime + 4 * longitude) / 4 - 180;
  hourAngleDeg = ((hourAngleDeg % 360) + 360) % 360;
  if (hourAngleDeg > 180) hourAngleDeg -= 360;
  const hourAngle = hourAngleDeg * DEG;

  const lat = latitude * DEG;
  const cosZenith =
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const elevationDeg = 90 - zenith / DEG;

  // Azimuth from north, clockwise. Guarded against the poles and the exact
  // zenith, where the denominator vanishes and the bearing is undefined.
  //
  // The NOAA relation solves for (180 - azimuth), not azimuth. Dropping that
  // step puts the sun on the wrong side of the sky -- it rose in the west, which
  // is exactly the sort of error a pretty gradient will happily hide.
  const sinZenith = Math.sin(zenith);
  let azimuthDeg: number;
  if (Math.abs(sinZenith) < 1e-6) {
    azimuthDeg = 180;
  } else {
    const cosArg =
      (Math.sin(lat) * Math.cos(zenith) - Math.sin(decl)) / (Math.cos(lat) * sinZenith);
    azimuthDeg = 180 - Math.acos(Math.min(1, Math.max(-1, cosArg))) / DEG;
    // Before local solar noon the sun is in the east; after it, the west.
    if (hourAngleDeg > 0) azimuthDeg = 360 - azimuthDeg;
  }
  azimuthDeg = ((azimuthDeg % 360) + 360) % 360;

  // Civil twilight is about -6 degrees; the sky is not black the instant the
  // disc touches the horizon, and a hard cut there looks like a bug.
  const daylight = clamp01((elevationDeg + 6) / 12);
  // Peaks as the sun nears the horizon from either side.
  const goldenness = clamp01(1 - Math.abs(elevationDeg) / 14) * clamp01((elevationDeg + 8) / 8);

  return { elevationDeg, azimuthDeg, daylight, goldenness };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
