// Charted aids to navigation: the lights and harbour features the chart draws.
//
// Built by `python -m data.build_seamarks` into `public/seamarks.json` from
// OpenSeaMap (OpenStreetMap contributors, ODbL). The fetch happens at build
// time, never here -- see the note at the top of `render-chart.ts` for why that
// boundary is worth keeping.
//
// The interesting part of this file is `lightIntensity`. Each light arrives with
// its real character, colour and period, so the display can flash it the way the
// chart says it flashes rather than picking something that looks nautical.

/** A light's charted characteristic, enough to reproduce its rhythm. */
export interface SeamarkLight {
  /** Chart notation, ready to letter: "Fl R 5s", "Fl(3) W 6s". */
  label: string;
  /** Fl, LFl, Oc, Iso, Q, F... whatever OpenSeaMap carries. */
  character: string;
  /** Render colour for the flash, resolved from the charted light colour. */
  colour: string;
  period_s: number;
  /** Flashes per group. 1 for a plain single-flashing light. */
  group: number;
}

export interface Seamark {
  id: string;
  /** Raw `seamark:type`, kept so nothing is lost in classification. */
  type: string;
  /** The shape the chart draws: light, buoy, beacon, harbour, rescue, other. */
  category: string;
  lat: number;
  lon: number;
  /** Normalised chart coordinates, x east and y south, matching the coastline. */
  x: number;
  y: number;
  name?: string;
  light?: SeamarkLight;
  harbour_category?: string;
}

export interface SeamarkData {
  source: string;
  attribution: string;
  licence: string;
  fetched: string;
  caveat: string;
  marks: Seamark[];
}

const FLASH_ON_S = 0.5;
const FLASH_GAP_S = 1.0;

/**
 * How brightly a light is showing right now, 0 to 1.
 *
 * Returns a smooth pulse rather than a boolean so the flash blooms and fades on
 * the canvas; a square wave at 60 fps reads as a glitch rather than a light.
 *
 * **`atMs` is REAL wall-clock time, deliberately, not simulated time.** A light
 * is identified by counting its period against a watch, and the display offers
 * up to 60x time compression -- driving these off the simulated clock would turn
 * every light into a strobe at the exact moment someone is presenting, and
 * "Fl R 5s" lettered beside a light flashing eighty times a minute is worse than
 * not animating it at all.
 */
export function lightIntensity(light: SeamarkLight, atMs: number): number {
  const character = light.character.toUpperCase();
  const period = light.period_s > 0 ? light.period_s : 5;
  const t = (atMs / 1000) % period;

  // Fixed lights burn continuously; there is no phase to compute.
  if (character === "F") return 1;

  // Isophase: equal light and dark. Occulting: light interrupted by brief dark,
  // which is the photographic negative of a flash and is drawn as one.
  if (character.startsWith("ISO")) return t < period / 2 ? pulse(t / (period / 2)) : 0;
  if (character.startsWith("OC")) return 1 - flashTrain(t, period, light.group, 0.7);

  // Quick flashing runs at roughly one flash a second regardless of the period
  // tagged on it, which is what makes it read as "quick".
  if (character.startsWith("Q")) return flashTrain(t % 1, 1, 1, 0.3);

  // Everything else -- Fl, LFl, FFl and anything unmapped -- is a flash train.
  // Long-flashing gets a visibly longer flash, which is the only thing that
  // distinguishes it from a plain flash on screen.
  return flashTrain(t, period, light.group, character.startsWith("LFL") ? 1.4 : FLASH_ON_S);
}

/**
 * A group of `count` flashes at the start of a period, then darkness.
 *
 * `Fl(3) 6s` is three flashes and a long gap, not three evenly spaced flashes:
 * the dark interval is what the eye counts against. If the group will not fit in
 * the period the spacing compresses rather than overflowing into the next cycle,
 * so a mistagged light degrades to something ugly instead of something wrong.
 */
function flashTrain(t: number, period: number, count: number, onSeconds: number): number {
  const flashes = Math.max(1, count);
  let slot = onSeconds + FLASH_GAP_S;
  if (flashes * slot > period * 0.85) slot = (period * 0.85) / flashes;

  for (let i = 0; i < flashes; i++) {
    const start = i * slot;
    const on = Math.min(onSeconds, slot * 0.6);
    if (t >= start && t < start + on) return pulse((t - start) / on);
  }
  return 0;
}

/** Smooth 0 -> 1 -> 0 across a normalised flash. */
function pulse(u: number): number {
  return Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
}

/**
 * Load the seamark extract.
 *
 * Absent is a supported state, exactly as the basemap is: the chart then draws
 * its coastline with no aids on it, which is a poorer chart rather than a broken
 * one. Returns null rather than throwing so a missing file cannot take the
 * display down mid-demo.
 */
export async function loadSeamarks(url = "/seamarks.json"): Promise<SeamarkData | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = (await response.json()) as SeamarkData;
    return Array.isArray(data?.marks) ? data : null;
  } catch {
    return null;
  }
}
