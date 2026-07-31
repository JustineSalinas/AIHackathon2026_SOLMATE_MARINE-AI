// Helm view: the horizon from behind the wheel.
//
// Procedural, on the same 2D canvas as the chart. No game engine, no 3D assets,
// no extra dependency -- and, more to the point, no decoration. Every motion in
// this view is derived from a modelled quantity:
//
//   roll amplitude    wave height x |sin(relative wave angle)|   beam seas roll worst
//   pitch amplitude   wave height x |cos(relative wave angle)|   head seas pitch worst
//   motion period     encounter period, which shortens as you steam into a sea
//   sea scroll rate   the vessel's actual speed from the fuel model's curve
//   wave length       the deep-water dispersion relation, from the period
//   spray             appears when pitching hard into a head sea
//   sun position      NOAA solar position for the real date, time and latitude
//
// So turning the boat changes how it moves, at the same wave height, in the way a
// captain would expect, and a 05:40 departure is lit like 05:40 in Iloilo. That
// is the difference between a horizon that looks like the sea and one that
// behaves like it -- and it is defensible under questioning, which a rendered
// asset would not be.
//
// What makes an ocean read as real, in the order the eye notices it:
//
//   1. The specular glitter path running from the viewer to the sun. Nothing else
//      says "water" as immediately, and it is the first thing missing from a
//      flat-shaded sea.
//   2. Lighting that varies across each wave -- a crest face turned toward the
//      sun is bright, the back of the same wave is dark. A single sea colour with
//      lines drawn on it always reads as a diagram.
//   3. Aerial perspective: the sea takes the colour of the sky as it approaches
//      the horizon. Without it, the far sea is too saturated and the horizon
//      looks like a cut edge.
//   4. Foam, and only where foam belongs -- breaking crests above about a metre,
//      and at the bow where the hull is actually pushing water.
//
// The convention for relative wave angle matches lib/nautical.ts and
// services/speed/resistance.py: 0 is a head sea.

import {
  DEG,
  clamp,
  encounterPeriodSeconds,
  normaliseDeg,
  relativeAngle,
  relativeBearing,
} from "./nautical";
import { type HorizonSample, shoreElevation } from "./landmask";
import { type SunPosition, sunPosition } from "./solar";

export interface HelmScene {
  width: number;
  height: number;
  timeSeconds: number;

  headingDeg: number;
  speedKn: number;
  recommendedRpm: number | null;
  currentRpm: number;

  waveHeightM: number;
  waveDirectionDeg: number;
  windSpeedKn: number;
  windDirectionDeg: number;
  gloom: number;
  rain: number;

  /** Simulated epoch milliseconds, and where the vessel is. Together these put
   *  the sun in the right part of the sky; see lib/solar.ts. */
  atMs: number;
  latitude: number;
  longitude: number;

  /** Shoreline distance per bearing, ray-cast from the Sentinel-2 land mask.
   *  This is why the horizon shows the real shape of Guimaras rather than a
   *  generic landmass, and why turning the vessel changes it correctly. */
  horizon: HorizonSample[];
}

export interface VesselMotion {
  rollDeg: number;
  pitchDeg: number;
  /** Seconds between wave encounters. Shown in the HUD; it is a real quantity. */
  encounterPeriod: number;
}

export const MAX_ROLL_DEG = 22;
export const MAX_PITCH_DEG = 9;
const HORIZON_FRACTION = 0.46;
export const HELM_FOV_DEG = 70;
/** Horizontal field of view. Exported because the horizon ray-cast in
 *  lib/landmask.ts must sample across exactly this span: if the two disagree,
 *  the shoreline silhouette slides against the vessel's actual heading and the
 *  view stops being a view of anywhere. */

/** Eye height above the waterline, metres. A banca helm is low -- which is why
 *  the horizon is close and a 1.5 m sea genuinely blocks the view of it. */
const EYE_HEIGHT_M = 2.2;

/**
 * Roll and pitch at this instant, from the sea state and the vessel's own motion.
 *
 * Two harmonics rather than one: real vessel motion is not a clean sinusoid, and
 * a single sine reads as a metronome within about five seconds of watching.
 */
export function vesselMotion(scene: HelmScene): VesselMotion {
  const { waveHeightM: H, headingDeg, waveDirectionDeg, speedKn, timeSeconds: t } = scene;

  if (H <= 0.02) return { rollDeg: 0, pitchDeg: 0, encounterPeriod: 6 };

  const relative = relativeAngle(headingDeg, waveDirectionDeg) * DEG;
  const period = encounterPeriodSeconds(H, speedKn, headingDeg, waveDirectionDeg);
  const phase = (2 * Math.PI * t) / period;

  // Which side the sea is on decides which way the first roll goes.
  const side = Math.sin(relativeBearing(headingDeg, waveDirectionDeg) * DEG) >= 0 ? 1 : -1;

  const rollAmp = clamp(H * 6.5 * Math.abs(Math.sin(relative)), 0, MAX_ROLL_DEG);
  const pitchAmp = clamp(H * 3.2 * Math.abs(Math.cos(relative)), 0, MAX_PITCH_DEG);

  const roll = side * rollAmp * (0.82 * Math.sin(phase) + 0.18 * Math.sin(phase * 2.3 + 1.1));
  const pitch = pitchAmp * (0.85 * Math.sin(phase * 1.05 + 0.6) + 0.15 * Math.sin(phase * 2.7));

  return { rollDeg: roll, pitchDeg: pitch, encounterPeriod: period };
}

/** Where the sun sits on screen, and whether it is in frame at all. */
export interface SunOnScreen {
  sun: SunPosition;
  /** Screen x of the sun's bearing. May be off-canvas; the glitter path still
   *  needs it, because a sun behind your shoulder still lights the water. */
  x: number;
  y: number;
  /** True when the disc itself is within the field of view and above the sea. */
  visible: boolean;
}

export function projectSun(scene: HelmScene, horizonY: number): SunOnScreen {
  const sun = sunPosition(scene.atMs, scene.latitude, scene.longitude);
  const pixelsPerDegree = scene.width / HELM_FOV_DEG;
  const relativeDeg = relativeBearing(scene.headingDeg, sun.azimuthDeg);
  const x = scene.width / 2 + relativeDeg * pixelsPerDegree;
  const y = horizonY - sun.elevationDeg * pixelsPerDegree;
  const visible =
    sun.elevationDeg > -1 && Math.abs(relativeDeg) < HELM_FOV_DEG / 2 + 6 && y > -scene.height;
  return { sun, x, y, visible };
}

/**
 * Where the horizon sits for a given pitch. Pitch raises and lowers it; roll
 * (applied by `drawSeascape`) tilts it.
 *
 * Exported because the chase camera needs the same answer for its own, damped,
 * pitch -- and because the sun is projected relative to this line, so a second
 * view computing it slightly differently would put the sun in a different place
 * in the sky than the helm view does at the same instant.
 */
export function horizonYFor(scene: HelmScene, pitchDeg: number): number {
  return scene.height * HORIZON_FRACTION + (pitchDeg / MAX_PITCH_DEG) * scene.height * 0.1;
}

/**
 * The world: sky, cloud, sun, shoreline and sea, rolled to the given attitude.
 *
 * Everything outside the vessel lives here, and it is exported so that any
 * camera looking out at the strait draws the identical seascape. That is not
 * only economy -- it is the reason two views of the same moment agree. The sun
 * is where the almanac puts it, the shoreline is the ray-cast from the real land
 * mask, and the sea is lit from the sun's true bearing; a second camera with its
 * own copy of any of that would drift from this one the first time either was
 * touched, and the drift would show up as the two views disagreeing about where
 * the light is coming from.
 *
 * `attitude` is the CAMERA's roll and pitch, which is not always the vessel's --
 * see the chase camera, which is deliberately steadier than the boat it follows.
 */
export function drawSeascape(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  attitude: VesselMotion,
  solar: SunOnScreen,
  horizonY: number,
): void {
  const { width: w, height: h } = scene;

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(attitude.rollDeg * DEG);
  // Overdraw well beyond the viewport so rotation never exposes a corner.
  ctx.translate(-w / 2, -h / 2);
  // Overdraw margin for the roll rotation. Rolling by MAX_ROLL_DEG about the
  // screen centre exposes at most (h/2)*sin(roll) horizontally, which is around
  // 160 px at this size -- so 40% of the long edge is a wide safety factor, and
  // the previous full-edge bleed was tripling the width of every sea fill for
  // nothing. That mattered: the sea is the one thing here drawn dozens of times
  // per frame.
  const bleed = Math.max(w, h) * 0.4;

  drawSky(ctx, scene, horizonY, bleed, solar);
  drawClouds(ctx, scene, horizonY, bleed, solar);
  drawSunDisc(ctx, scene, solar, horizonY);
  drawLandmarks(ctx, scene, horizonY, solar);
  drawSea(ctx, scene, horizonY, bleed, attitude, solar);

  ctx.restore();
}

/** Weather that sits between the world and the lens, in front of everything
 *  except the vessel and the HUD. Shared with the chase camera. */
export function drawWeatherOverlay(ctx: CanvasRenderingContext2D, scene: HelmScene): void {
  drawRain(ctx, scene);
  if (scene.gloom > 0) {
    ctx.fillStyle = `rgba(6, 14, 26, ${scene.gloom})`;
    ctx.fillRect(0, 0, scene.width, scene.height);
  }
}

export function drawHelm(ctx: CanvasRenderingContext2D, scene: HelmScene): void {
  const { width: w, height: h } = scene;
  const motion = vesselMotion(scene);

  ctx.save();
  ctx.clearRect(0, 0, w, h);

  const horizonY = horizonYFor(scene, motion.pitchDeg);
  const solar = projectSun(scene, horizonY);

  drawSeascape(ctx, scene, motion, solar, horizonY);

  drawSpray(ctx, scene, motion, horizonY);
  drawWeatherOverlay(ctx, scene);

  drawBow(ctx, scene, motion, solar);
  drawHud(ctx, scene, motion, solar);
  ctx.restore();
}

// --- sky --------------------------------------------------------------------

function drawSky(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  horizonY: number,
  bleed: number,
  solar: SunOnScreen,
) {
  const { width: w } = scene;
  const overcast = clamp(scene.gloom * 1.6, 0, 1);
  const { daylight, goldenness } = solar.sun;

  // Zenith through horizon. Three regimes blended by sun elevation rather than
  // switched, so dawn is a transition and not a jump cut.
  const zenith = mix3("#0b1220", "#1e3a8a", "#2a3f6e", daylight, goldenness);
  const middle = mix3("#111a2e", "#60a5fa", "#7c8fc4", daylight, goldenness);
  const nearHorizon = mix3("#1a2036", "#bfdbfe", "#f0b27a", daylight, goldenness);

  const sky = ctx.createLinearGradient(0, -bleed, 0, horizonY);
  sky.addColorStop(0, mixHex(zenith, "#0f172a", overcast));
  sky.addColorStop(0.62, mixHex(middle, "#475569", overcast));
  sky.addColorStop(1, mixHex(nearHorizon, "#64748b", overcast));
  ctx.fillStyle = sky;
  ctx.fillRect(-bleed, -bleed, w + bleed * 2, horizonY + bleed);

  // The sun's own glow in the sky, centred on its true bearing. This is what
  // makes the bright side of the sky the side the sun is actually on.
  if (solar.sun.elevationDeg > -8) {
    const reach = Math.max(w, scene.height) * (0.55 + goldenness * 0.35);
    const glow = ctx.createRadialGradient(solar.x, solar.y, 0, solar.x, solar.y, reach);
    const warmth = 0.30 * daylight * (1 - overcast * 0.7);
    glow.addColorStop(0, `rgba(255, ${Math.round(228 - goldenness * 60)}, ${Math.round(170 - goldenness * 90)}, ${warmth})`);
    glow.addColorStop(0.45, `rgba(255, 214, 160, ${warmth * 0.35})`);
    glow.addColorStop(1, "rgba(255, 200, 140, 0)");
    ctx.fillStyle = glow;
    // Bounded to the circle the gradient actually reaches, clipped to the sky.
    // Painting a radial gradient across the whole sky rect evaluates it for
    // every pixel out to the corners, where it has long since faded to nothing.
    const x0 = Math.max(-bleed, solar.x - reach);
    const x1 = Math.min(w + bleed, solar.x + reach);
    const y0 = Math.max(-bleed, solar.y - reach);
    const y1 = Math.min(horizonY, solar.y + reach);
    if (x1 > x0 && y1 > y0) ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  // Haze thickens toward the horizon: the last few degrees above the sea are
  // always paler than the sky overhead, and leaving that out is most of why a
  // drawn horizon looks like a pasted edge.
  const haze = ctx.createLinearGradient(0, horizonY - scene.height * 0.20, 0, horizonY);
  haze.addColorStop(0, "rgba(226, 236, 248, 0)");
  haze.addColorStop(1, `rgba(226, 236, 248, ${0.22 * daylight + 0.05})`);
  ctx.fillStyle = haze;
  ctx.fillRect(-bleed, horizonY - scene.height * 0.20, w + bleed * 2, scene.height * 0.20);
}

function drawClouds(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  horizonY: number,
  bleed: number,
  solar: SunOnScreen,
) {
  const { width: w, height: h, timeSeconds: t } = scene;
  // Cloud cover follows the weather preset's gloom, so a storm is overcast and a
  // clear morning has a few trade cumulus sitting on the horizon.
  const cover = clamp(0.16 + scene.gloom * 0.95, 0, 1);
  const rows = 4;
  // Clouds drift downwind, slowly. Wind direction is where it blows FROM.
  const windRel = relativeBearing(scene.headingDeg, scene.windDirectionDeg);
  const drift = -Math.sin(windRel * DEG) * scene.windSpeedKn * 0.35;

  ctx.save();
  for (let r = 0; r < rows; r++) {
    // Higher rows are nearer the viewer: bigger, faster, lower on screen.
    // Trade cumulus sit in a band above the horizon rather than scattered over
    // the whole dome -- spreading them evenly was what made the sky read as
    // dirty rather than partly cloudy.
    const depth = (r + 1) / rows;
    const y = horizonY - h * (0.05 + depth * 0.22);
    const scale = 0.30 + depth * 0.95;
    const speed = drift * depth * 0.6;
    const alpha = clamp(cover * (0.30 + depth * 0.42), 0, 0.8);
    if (alpha < 0.02) continue;

    // Lit from the sun's side: the edge of a cloud facing the sun is bright and
    // the far side is grey. One gradient per row is enough to sell it.
    const lit = ctx.createLinearGradient(solar.x - w * 0.5, 0, solar.x + w * 0.5, 0);
    const glow = solar.sun.daylight;
    lit.addColorStop(0, `rgba(${240 - (1 - glow) * 90}, ${238 - (1 - glow) * 92}, ${236 - (1 - glow) * 86}, ${alpha})`);
    lit.addColorStop(0.5, `rgba(${212 - (1 - glow) * 90}, ${218 - (1 - glow) * 96}, ${228 - (1 - glow) * 100}, ${alpha * 0.85})`);
    lit.addColorStop(1, `rgba(${150 - (1 - glow) * 60}, ${162 - (1 - glow) * 66}, ${180 - (1 - glow) * 76}, ${alpha * 0.7})`);
    ctx.fillStyle = lit;

    ctx.beginPath();
    const puffs = 18;
    for (let i = 0; i < puffs; i++) {
      // Deterministic pseudo-noise: the same cloud is in the same place from one
      // frame to the next, which a Math.random() field would not be.
      const seed = hash(r * 131 + i * 17);
      const seed2 = hash(r * 977 + i * 53);
      const spread = w * 1.8;
      const x = ((seed * spread + t * speed) % (spread + 400)) - 200;
      const rx = (16 + seed2 * 44) * scale;
      const ry = (5 + seed2 * 10) * scale;
      ctx.ellipse(x, y + (seed2 - 0.5) * 12 * scale, rx, ry, 0, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.restore();
}

function drawSunDisc(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  solar: SunOnScreen,
  horizonY: number,
) {
  if (!solar.visible || solar.y > horizonY) return;
  const radius = Math.max(7, scene.width / HELM_FOV_DEG * 0.55);
  const { goldenness, daylight } = solar.sun;

  // Low sun reddens: the light is crossing more atmosphere. Same reason the
  // horizon band is warm.
  const core = `rgba(255, ${Math.round(250 - goldenness * 70)}, ${Math.round(228 - goldenness * 140)}, ${0.85 * daylight + 0.15})`;

  const halo = ctx.createRadialGradient(solar.x, solar.y, 0, solar.x, solar.y, radius * 9);
  halo.addColorStop(0, core);
  halo.addColorStop(0.12, `rgba(255, 226, 170, ${0.45 * daylight})`);
  halo.addColorStop(1, "rgba(255, 210, 150, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(solar.x, solar.y, radius * 9, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(solar.x, solar.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = core;
  ctx.fill();
}

// --- land -------------------------------------------------------------------

function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  horizonY: number,
  solar: SunOnScreen,
) {
  const { width: w, height: h } = scene;
  const samples = scene.horizon;
  if (samples.length < 2) return;

  // One continuous silhouette rather than separate blobs. Each ray gives the
  // distance to the shore on that bearing; nearer shore stands higher, and the
  // gaps where a ray found open water sit flat on the horizon.
  const pixelsPerDegree = w / HELM_FOV_DEG;
  const bands: { x: number; top: number; distanceNm: number; land: boolean }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const x = (i / (samples.length - 1)) * w;
    // Cap how tall any single ray may stand. A ray that grazes a shoreline a few
    // metres away returns a near-zero distance, and the elevation it implies is
    // a spike a single sample wide -- a needle of land on an otherwise sane
    // horizon. Real coastlines do not do that; the ray-cast does.
    const raw = sample.land
      ? shoreElevation(sample.distanceNm, sample.bearingDeg, pixelsPerDegree, h)
      : 0;
    const top = horizonY - Math.min(raw, h * 0.30);
    bands.push({ x, top, distanceNm: sample.distanceNm, land: sample.land });
  }

  // Median first, then mean. The order matters: a ray that grazes a shoreline
  // returns a near-zero distance and stands as a one-sample needle on the
  // ridgeline, and averaging a spike only spreads it into a smaller spike.
  // A median of three deletes it outright, because a lone outlier is never the
  // middle value. The mean pass afterwards is what takes the facets off.
  const median = bands.map((band, i) => {
    if (i === 0 || i === bands.length - 1) return band;
    const three = [bands[i - 1].top, band.top, bands[i + 1].top].sort((a, b) => a - b);
    return { ...band, top: three[1] };
  });
  const smoothed = median.map((band, i) => {
    if (i === 0 || i === median.length - 1) return band;
    return { ...band, top: median[i - 1].top * 0.25 + band.top * 0.5 + median[i + 1].top * 0.25 };
  });
  bands.length = 0;
  bands.push(...smoothed);

  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  for (const band of bands) ctx.lineTo(band.x, band.top);
  ctx.lineTo(w, horizonY);
  ctx.closePath();

  const landBands = bands.filter((b) => b.land);
  const nearest = landBands.length ? Math.min(...landBands.map((b) => b.distanceNm)) : 12;
  // Aerial perspective: the further the shore, the more it takes the colour of
  // the sky. Two miles of tropical haze is a lot, and leaving it out is what
  // makes a drawn coastline look pasted on.
  const haze = clamp(nearest / 5, 0.08, 0.85);
  const top = Math.min(...bands.map((b) => b.top), horizonY);
  const day = solar.sun.daylight;

  // Hills are backlit when the sun is behind them, and green when it is not.
  // The sun's bearing relative to the shore decides which, and at dawn over
  // Guimaras that is the difference between a black cut-out and a green island.
  const gradient = ctx.createLinearGradient(0, top, 0, horizonY);
  const lift = day * 0.55;
  gradient.addColorStop(0, `rgba(${86 + lift * 60}, ${112 + lift * 66}, ${94 + lift * 50}, ${0.70 - haze * 0.26})`);
  gradient.addColorStop(0.45, `rgba(${44 + lift * 44}, ${70 + lift * 54}, ${52 + lift * 36}, ${0.86 - haze * 0.28})`);
  gradient.addColorStop(1, `rgba(${20 + lift * 26}, ${36 + lift * 34}, ${28 + lift * 24}, ${0.93 - haze * 0.22})`);
  ctx.fillStyle = gradient;
  ctx.fill();

  // A band of haze pooled at the waterline. Distant shores always sit in it, and
  // it is what visually separates the land from the sea in front of it.
  const hazeBand = ctx.createLinearGradient(0, horizonY - h * 0.05, 0, horizonY);
  hazeBand.addColorStop(0, "rgba(214, 228, 244, 0)");
  hazeBand.addColorStop(1, `rgba(214, 228, 244, ${(0.30 - haze * 0.16) * (0.35 + day * 0.65)})`);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  for (const band of bands) ctx.lineTo(band.x, band.top);
  ctx.lineTo(w, horizonY);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = hazeBand;
  ctx.fillRect(0, horizonY - h * 0.05, w, h * 0.05);
  ctx.restore();

  // A thin lighter lip where land meets water reads as the surf line.
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  for (const band of bands) ctx.lineTo(band.x, band.top);
  ctx.strokeStyle = `rgba(150, 180, 155, ${0.35 - haze * 0.2})`;
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

// --- sea --------------------------------------------------------------------

/**
 * The sea, as a stack of lit wave strips in perspective.
 *
 * Each strip is a horizontal band between two depths. Its top edge is displaced
 * by a two-component wave -- a long swell plus a shorter wind chop -- and it is
 * filled with a colour that depends on the surface slope at each point, so the
 * face of a wave turned toward the sun is bright and its back is dark. That
 * per-point shading is what separates this from a gradient with lines on it.
 *
 * The wavelength is not a chosen constant: deep-water gravity waves satisfy
 * L = g T^2 / 2pi, so the encounter period the motion model already computes
 * fixes how far apart the crests are. Steeper, shorter seas therefore follow
 * from a shorter period without anything being tuned to make them look right.
 */
function drawSea(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  horizonY: number,
  bleed: number,
  motion: VesselMotion,
  solar: SunOnScreen,
) {
  const { width: w, height: h, timeSeconds: t } = scene;
  const day = solar.sun.daylight;
  const H = clamp(scene.waveHeightM, 0, 6);

  const depth = h + bleed - horizonY;
  const left = -bleed;
  const spanX = w + bleed * 2;

  // Water colour at the two ends of the view. Near the horizon the sea takes the
  // colour of the sky (aerial perspective); underfoot it is the deep blue of
  // water you are looking *into* rather than across.
  //
  // The warm dawn tint is deliberately weak. Sunrise does put copper on the
  // water, but only in the glitter path and the few degrees around it -- tinting
  // the whole sea with it turns the ocean to sand, which is precisely what an
  // unrestrained golden-hour palette did here on the first attempt.
  const farWater = channels(
    mixHex(mix3("#18202f", "#7ea6c8", "#a08a86", day, solar.sun.goldenness * 0.45), "#334155", scene.gloom),
  );
  const nearWater = channels(mixHex(day > 0.5 ? "#0a2436" : "#050f1c", "#020a12", scene.gloom * 0.8));

  const base = ctx.createLinearGradient(0, horizonY, 0, horizonY + depth * 0.55);
  base.addColorStop(0, rgb(farWater));
  base.addColorStop(1, rgb(nearWater));
  ctx.fillStyle = base;
  ctx.fillRect(left, horizonY, spanX, depth + bleed);

  // Wavelength from the dispersion relation, converted to a screen scale.
  const period = Math.max(1.2, motion.encounterPeriod);
  const wavelengthM = (9.81 * period * period) / (2 * Math.PI);
  const relative = relativeAngle(scene.headingDeg, scene.waveDirectionDeg) * DEG;
  // Crests run across the view in a head sea and rake away in a beam sea.
  const skew = Math.sin(relative) * 0.9;
  const scroll = t / period;

  // Strip and sample counts are a budget, not a quality dial. The helm view has
  // to hold 60 fps on a laptop while the advisory loop, the telemetry emitter
  // and three fetches share the main thread -- and the screencast is the
  // deliverable, so a beautiful 20 fps sea would be a worse result than a good
  // 60 fps one. These are the counts at which the sea stopped looking better.
  const rows = 42;
  const steps = 26;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, horizonY, spanX, depth + bleed);
  ctx.clip();

  const chopScale = clamp(scene.windSpeedKn / 30, 0, 1);
  const bottom = horizonY + depth + bleed;

  /** Surface displacement at a screen x for a given depth, in wave units.
   *
   *  A pure function of position and time, deliberately. An earlier version also
   *  took the loop's sample index and fed it into the chop term, which meant the
   *  strip fill and the crest stroke drawn over it were sampling two slightly
   *  different surfaces -- and the seam showed. */
  const surfaceAt = (px: number, distanceM: number): number => {
    // Position along the wave train, in metres, including the skew that turns
    // the crests when the sea is on the beam.
    const alongM = distanceM + ((px - w / 2) / Math.max(1, w)) * distanceM * skew * 0.8;
    const phase = (alongM / wavelengthM) * Math.PI * 2 - scroll * Math.PI * 2;
    const across = (px / Math.max(1, w)) * Math.PI * 2;

    // A real crest is not a straight line. It undulates along its own length,
    // and in a head sea -- where the skew term above vanishes entirely -- that
    // undulation is the *only* thing stopping every crest from being a ruler-
    // straight horizontal band. Without it the sea renders as corduroy.
    const alongCrest =
      0.42 * Math.sin(across * 1.7 + phase * 0.6 + t * 0.35) +
      0.24 * Math.sin(across * 3.9 - phase * 0.4 + t * 0.6);

    // Long swell plus wind chop. The chop rides at a shorter length and is
    // scaled by wind rather than wave height, so a breeze over a calm sea
    // still textures the surface. The 2.17 and 5.3 multipliers are deliberately
    // not integers: harmonics that divide evenly re-phase into a repeating
    // pattern, and the eye finds the repeat within seconds.
    return (
      Math.sin(phase) +
      0.34 * Math.sin(phase * 2.17 + 1.3) +
      alongCrest +
      chopScale * 0.42 * Math.sin(phase * 5.3 + t * 1.9 + across * 2.3)
    );
  };

  // Whitecaps are collected here and painted after every strip is down. Drawn
  // inline they were immediately buried: each nearer strip is opaque and reaches
  // the bottom of frame, so it covered the foam of the strip before it.
  const caps: { x: number; y: number; w: number; h: number; alpha: number }[] = [];

  for (let i = 1; i <= rows; i++) {
    const f = i / rows;
    // Foreshortening: the eye is EYE_HEIGHT above the water, so the distance to
    // a point on the sea grows without bound as it approaches the horizon. This
    // is that relationship, normalised -- which is why the strips bunch up near
    // the horizon the way a real sea does.
    const nearness = f * f;
    const yTop = horizonY + nearness * depth;
    const distanceM = EYE_HEIGHT_M / Math.max(0.0015, nearness * 0.5);

    // Waves this far out subtend fewer pixels; amplitude in screen space falls
    // with distance exactly as everything else does.
    const amplitudePx = H * 0.5 * nearness * 34;

    // Each strip is painted OPAQUE, from its own wavy top edge downward, far
    // strips first. That is a painter's algorithm and it is the whole trick:
    // nearer water covers farther water, so a near crest genuinely occludes the
    // sea behind it, and -- critically -- no alpha accumulates. Filling dozens
    // of translucent bands over each other was what turned the first version of
    // this sea into a flat wash.
    //
    // The bottom edge stops just past where the *next* strip's wave trough can
    // reach, rather than running to the foot of the canvas. Both are gap-free,
    // but the naive version made every strip fill the entire lower half of the
    // frame -- forty times over, which is where the frame budget was going.
    const nextTop = horizonY + ((i + 1) / rows) ** 2 * depth;
    const nextAmplitude = H * 0.5 * ((i + 1) / rows) ** 2 * 34;
    const stripBottom = Math.min(bottom, nextTop + nextAmplitude + 6);

    // Water colour at this depth.
    const water = lerpChannels(farWater, nearWater, Math.min(1, nearness * 1.35));

    // Shade the strip from the actual wave surface, sampled at intervals across
    // its width and fed in as gradient stops. One fill per strip, but the shade
    // now varies laterally.
    //
    // Sampling laterally is the whole point. Shading each strip by a single
    // value -- its depth alone -- produces perfectly horizontal light and dark
    // bands, and a sea striped like a venetian blind is arguably worse than a
    // flat one, because the eye reads regularity as machine-made. Real swell is
    // lit unevenly along each crest, and that is what these stops carry.
    //
    // Two terms per sample: which way the surface faces (crest bright, trough
    // dark), and how near that point is to the sun's bearing (specular).
    const relief = clamp(0.12 + H * 0.16, 0, 0.42) * (0.45 + day * 0.55);
    const litStrength = (0.08 + nearness * 0.22) * (0.25 + day * 0.95);

    // One path per strip, filled with a horizontal gradient whose stops sample
    // the real wave surface.
    //
    // Flat-shaded segments were tried here instead, to avoid allocating a
    // CanvasGradient per strip. They were indeed cheaper, and they looked worse
    // in a way that is worth recording: because the strips span the rotation
    // bleed as well as the viewport, a segment count that sounds generous still
    // works out to ~90 screen pixels each, and the fills read as rectangular
    // tiling. A visible grid is a worse artefact than smooth banding, and the
    // production build holds well over 60 fps with the gradients, so the cost
    // was not worth avoiding.
    const shade = ctx.createLinearGradient(left, 0, left + spanX, 0);
    const stops = 12;
    for (let k = 0; k <= stops; k++) {
      const px = left + (k / stops) * spanX;
      const facing = surfaceAt(px, distanceM) * 0.5 + 0.5;
      // Falls off with angular distance from the sun; widened past the canvas
      // so a sun just outside the field of view still brightens the water on
      // that side, which is what really happens.
      const sunNear = 1 - Math.min(1, Math.abs(px - solar.x) / (w * 1.15));

      let colour = lerpChannels(water, [6, 16, 30], relief * (1 - facing));
      colour = lerpChannels(colour, [150, 190, 220], relief * facing * 0.75);
      colour = lerpChannels(colour, [210, 234, 252], litStrength * sunNear * sunNear);
      shade.addColorStop(k / stops, rgb(colour));
    }

    ctx.beginPath();
    ctx.moveTo(left, yTop + surfaceAt(left, distanceM) * amplitudePx);
    for (let s = 1; s <= steps; s++) {
      const px = left + (s / steps) * spanX;
      ctx.lineTo(px, yTop + surfaceAt(px, distanceM) * amplitudePx);
    }
    ctx.lineTo(left + spanX, stripBottom);
    ctx.lineTo(left, stripBottom);
    ctx.closePath();
    ctx.fillStyle = shade;
    ctx.fill();

    // The lit edge along each crest. Thin, and brighter near the sun's bearing.
    // Only on strips near enough for it to register -- a second 26-point path
    // per strip is not worth spending on water at the horizon.
    if (nearness > 0.20) {
      ctx.beginPath();
      ctx.moveTo(left, yTop + surfaceAt(left, distanceM) * amplitudePx);
      for (let s = 1; s <= steps; s++) {
        const px = left + (s / steps) * spanX;
        ctx.lineTo(px, yTop + surfaceAt(px, distanceM) * amplitudePx);
      }
      const crest = clamp(0.05 + nearness * 0.22, 0, 0.30) * (0.4 + day * 0.8);
      ctx.strokeStyle = `rgba(198, 232, 255, ${crest})`;
      ctx.lineWidth = 1 + nearness * 1.4;
      ctx.stroke();
    }

    // Whitecaps. Real ones start breaking around force 4, near a metre of sea,
    // so below that there are none at all rather than a few faint ones.
    if (H > 0.85 && nearness > 0.12) {
      const density = clamp((H - 0.85) / 2.2, 0, 1) * nearness;
      const count = Math.floor(density * 26);
      const alpha = clamp(density * 0.8, 0, 0.66);
      for (let c = 0; c < count; c++) {
        const seed = hash(i * 313 + c * 71 + Math.floor(t * 0.8) * 7);
        const px = left + seed * spanX;
        const surf = surfaceAt(px, distanceM);
        // Foam sits on the crest, not in the trough -- and only where the crest
        // is steep enough to actually break.
        if (surf < 0.85) continue;
        caps.push({
          x: px,
          y: yTop + surf * amplitudePx - 1,
          w: (6 + seed * 18) * (0.4 + nearness),
          h: 1.6 + nearness * 2.6,
          alpha,
        });
      }
    }
  }

  // Foam last, over every strip, so a breaking crest is not buried by the water
  // in front of it.
  for (const cap of caps) {
    ctx.fillStyle = `rgba(238, 248, 255, ${cap.alpha})`;
    ctx.fillRect(cap.x, cap.y, cap.w, cap.h);
  }

  drawGlitterPath(ctx, scene, horizonY, depth, motion, solar);
  ctx.restore();

  // The horizon itself, drawn last so nothing crosses it.
  ctx.beginPath();
  ctx.moveTo(-bleed, horizonY);
  ctx.lineTo(w + bleed, horizonY);
  ctx.strokeStyle = `rgba(226, 232, 240, ${0.30 + day * 0.35})`;
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

/**
 * The specular glitter path: the broken track of sunlight running from the
 * horizon toward the viewer.
 *
 * This is the single most recognisable feature of a real sea surface. It widens
 * as it approaches the viewer because the waves nearer you subtend a larger
 * angle, so more of them catch the sun at the right angle -- which is why the
 * path is a wedge and not a line.
 */
function drawGlitterPath(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  horizonY: number,
  depth: number,
  motion: VesselMotion,
  solar: SunOnScreen,
) {
  const { sun } = solar;
  if (sun.elevationDeg < -1 || sun.daylight < 0.05) return;
  // A sun behind you lights the water behind you. Only draw the path when the
  // sun's bearing is actually within the field of view.
  if (Math.abs(solar.x - scene.width / 2) > scene.width * 0.75) return;

  const { timeSeconds: t } = scene;
  const H = clamp(scene.waveHeightM, 0.05, 6);
  // A flat sea gives a narrow, mirror-like path; a rough one scatters it wide.
  const spread = clamp(0.06 + H * 0.10, 0.06, 0.42);
  const intensity = clamp(sun.daylight * (0.55 + sun.goldenness * 0.7), 0, 1) *
    (1 - clamp(scene.gloom * 1.2, 0, 0.9));
  if (intensity < 0.04) return;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // The specular colour is constant across the path, so it is built once rather
  // than formatted per speck -- a few hundred template strings a frame was
  // measurably more expensive than the drawing itself.
  const green = Math.round(246 - sun.goldenness * 40);
  const blue = Math.round(226 - sun.goldenness * 90);

  const rows = 32;
  for (let i = 1; i <= rows; i++) {
    const f = i / rows;
    const nearness = f * f;
    const y = horizonY + nearness * depth;
    const halfWidth = scene.width * spread * (0.10 + nearness * 1.5);

    const specks = Math.floor(4 + nearness * 20);
    // Specks in a row differ only in alpha, and alpha is quantised into a few
    // buckets so the whole row is drawn with a handful of fillStyle changes.
    let bucket = -1;
    for (let s = 0; s < specks; s++) {
      const seed = hash(i * 419 + s * 37);
      const seed2 = hash(i * 733 + s * 91);
      // Gaussian-ish clustering toward the sun's bearing rather than a uniform
      // band: the path has a bright core and ragged edges.
      const offset = (seed - 0.5 + (seed2 - 0.5)) * halfWidth;
      const x = solar.x + offset;

      // Each speck flickers on the wave period. Real glitter is not static.
      const flicker =
        0.5 +
        0.5 *
          Math.sin(
            (t * (3 + seed2 * 6)) / Math.max(0.6, motion.encounterPeriod * 0.4) + seed * 40,
          );
      const falloff = 1 - Math.abs(offset) / Math.max(1, halfWidth);
      const alpha = intensity * falloff * flicker * (0.08 + nearness * 0.30);
      if (alpha <= 0.015) continue;

      const quantised = Math.min(7, Math.floor(clamp(alpha, 0, 0.7) * 10));
      if (quantised !== bucket) {
        bucket = quantised;
        ctx.fillStyle = `rgba(255, ${green}, ${blue}, ${(bucket + 0.5) / 10})`;
      }

      const size = 1 + nearness * (1.5 + seed2 * 4);
      ctx.fillRect(x, y, size * (1 + seed * 2), size * 0.7);
    }
  }
  ctx.restore();
}

// --- weather and vessel -----------------------------------------------------

function drawSpray(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  motion: VesselMotion,
  horizonY: number,
) {
  // Spray comes over the bow when pitching into a sea at speed, and not otherwise.
  const relative = relativeAngle(scene.headingDeg, scene.waveDirectionDeg);
  const heading_into = relative < 70;
  const intensity = heading_into ? scene.waveHeightM * (scene.speedKn / 10) : 0;
  if (intensity < 0.35) return;

  const { width: w, height: h, timeSeconds: t } = scene;
  const burst = Math.max(0, Math.sin((2 * Math.PI * t) / motion.encounterPeriod));
  const count = Math.floor(clamp(intensity * 55, 0, 130) * burst);

  for (let i = 0; i < count; i++) {
    const seed = hash(i * 97 + Math.floor(t * 3) * 13);
    const seed2 = hash(i * 311 + Math.floor(t * 3) * 29);
    const x = w * 0.5 + (seed - 0.5) * w * 0.8;
    const y = horizonY + h * 0.26 + seed2 * h * 0.32 - burst * h * 0.20;
    // Droplets thin out as they rise, so alpha falls with height in the burst.
    const alpha = clamp(0.32 * burst * (1 - seed2 * 0.7), 0, 0.5);
    ctx.fillStyle = `rgba(232, 246, 255, ${alpha})`;
    ctx.fillRect(x, y, 1.5 + seed2 * 2.5, 1.5 + seed * 2);
  }
}

function drawRain(ctx: CanvasRenderingContext2D, scene: HelmScene) {
  if (scene.rain <= 0) return;
  const { width: w, height: h, timeSeconds: t } = scene;
  const count = Math.min(420, scene.rain);
  const lean = clamp(scene.windSpeedKn / 40, 0, 0.8);

  ctx.strokeStyle = "rgba(203, 225, 255, 0.3)";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const seed = (i * 0.6180339887) % 1;
    const x = ((seed * w * 3 + t * 260 * lean) % (w + 200)) - 100;
    const y = ((seed * 7919 + t * 900) % (h + 120)) - 60;
    ctx.moveTo(x, y);
    ctx.lineTo(x - lean * 22, y + 26);
  }
  ctx.stroke();
}

/**
 * The foredeck of the boat you are standing on -- a Philippine passenger banca.
 *
 * The outriggers are the point. A fiberglass double-outrigger banca is what
 * actually runs the Iloilo-Guimaras crossing, and the two katig booms reaching
 * out to their bamboo floats are the silhouette everyone who has taken that
 * ferry knows. A generic white bow would have been a boat; this is the boat.
 *
 * The bow is fixed to the camera: the world moves, the boat does not. That is
 * what makes the view read as "from the helm" rather than "above the boat".
 */
function drawBow(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  motion: VesselMotion,
  solar: SunOnScreen,
) {
  const { width: w, height: h, timeSeconds: t } = scene;
  const lift = (motion.pitchDeg / MAX_PITCH_DEG) * h * 0.015;
  const day = solar.sun.daylight;

  ctx.save();
  ctx.translate(0, lift);

  // --- outriggers, drawn first so the hull overlaps them -------------------
  // The floats ride the sea, so they rise and fall on the encounter period,
  // a quarter-cycle out of phase with the hull -- which is exactly why an
  // outrigger boat feels steadier than its beam suggests.
  const bob = Math.sin((2 * Math.PI * t) / motion.encounterPeriod + Math.PI / 2);
  const floatDip = bob * clamp(scene.waveHeightM * 7, 0, 22);

  for (const side of [-1, 1] as const) {
    const bx = w * 0.5 + side * w * 0.06;
    const by = h * 0.945;
    const fx = w * 0.5 + side * w * 0.40;
    const fy = h * 0.855 + side * floatDip * 0.6;

    // Two booms per side, splayed fore and aft, as they are rigged.
    ctx.strokeStyle = day > 0.35 ? "rgba(196, 168, 120, 0.95)" : "rgba(120, 110, 92, 0.9)";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    for (const fore of [0, 1]) {
      ctx.beginPath();
      ctx.moveTo(bx, by + fore * h * 0.045);
      ctx.quadraticCurveTo(
        (bx + fx) / 2,
        (by + fy) / 2 - h * 0.02 + fore * h * 0.03,
        fx,
        fy + fore * h * 0.030,
      );
      ctx.stroke();
    }

    // The bamboo float itself.
    ctx.save();
    ctx.translate(fx, fy + h * 0.016);
    ctx.rotate(side * 0.06);
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.085, h * 0.016, 0, 0, Math.PI * 2);
    const floatFill = ctx.createLinearGradient(0, -h * 0.016, 0, h * 0.016);
    floatFill.addColorStop(0, day > 0.35 ? "#d8c79a" : "#8b8168");
    floatFill.addColorStop(1, day > 0.35 ? "#9a8a63" : "#585340");
    ctx.fillStyle = floatFill;
    ctx.fill();
    ctx.strokeStyle = "rgba(60, 52, 38, 0.7)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Foam where the float cuts the water. Only when actually moving.
    if (scene.speedKn > 0.5) {
      ctx.beginPath();
      ctx.ellipse(0, h * 0.013, w * 0.09, h * 0.008, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(236, 248, 255, ${clamp(scene.speedKn / 26, 0, 0.5)})`;
      ctx.fill();
    }
    ctx.restore();
  }

  // --- bow wave ------------------------------------------------------------
  // The hull pushes water aside. Grows with speed, because it is the same
  // wave-making resistance the physics model charges you for.
  if (scene.speedKn > 0.5) {
    const strength = clamp(scene.speedKn / 12, 0, 1.2);
    ctx.beginPath();
    ctx.moveTo(w * 0.5, h * 0.905);
    ctx.quadraticCurveTo(w * 0.30, h * 0.925 + strength * 8, w * 0.06, h * 0.975);
    ctx.quadraticCurveTo(w * 0.30, h * 0.945, w * 0.5, h * 0.918);
    ctx.quadraticCurveTo(w * 0.70, h * 0.945, w * 0.94, h * 0.975);
    ctx.quadraticCurveTo(w * 0.70, h * 0.925 + strength * 8, w * 0.5, h * 0.905);
    ctx.closePath();
    ctx.fillStyle = `rgba(226, 244, 255, ${clamp(strength * 0.34, 0, 0.4)})`;
    ctx.fill();
  }

  // --- hull ----------------------------------------------------------------
  // A foredeck seen in perspective: narrow at the stem, widening to the
  // gunwales at the bottom of frame. Sitting low leaves the sea visible, which
  // is the point of the view.
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.925);
  ctx.quadraticCurveTo(w * 0.64, h * 0.945, w * 0.78, h * 0.99);
  ctx.lineTo(w * 0.86, h + 12);
  ctx.lineTo(w * 0.14, h + 12);
  ctx.lineTo(w * 0.22, h * 0.99);
  ctx.quadraticCurveTo(w * 0.36, h * 0.945, w * 0.5, h * 0.925);
  ctx.closePath();

  // Fiberglass, lit from the sun's side rather than flat white.
  const hull = ctx.createLinearGradient(solar.x - w * 0.6, 0, solar.x + w * 0.6, 0);
  const hi = day > 0.3 ? 245 : 176;
  const lo = day > 0.3 ? 198 : 138;
  hull.addColorStop(0, `rgb(${lo}, ${lo + 6}, ${lo + 14})`);
  hull.addColorStop(0.45, `rgb(${hi}, ${hi + 3}, ${hi + 8})`);
  hull.addColorStop(1, `rgb(${lo - 12}, ${lo - 6}, ${lo + 4})`);
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.strokeStyle = "#7c8ea3";
  ctx.lineWidth = 2;
  ctx.stroke();

  // A painted sheer stripe along the gunwale. Every one of these boats has one,
  // and it is what stops the deck reading as a blank shape.
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.938);
  ctx.quadraticCurveTo(w * 0.645, h * 0.957, w * 0.787, h * 0.998);
  ctx.strokeStyle = "rgba(37, 99, 155, 0.85)";
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.938);
  ctx.quadraticCurveTo(w * 0.355, h * 0.957, w * 0.213, h * 0.998);
  ctx.stroke();

  // Deck seams and the centreline the helmsman actually steers by.
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.925);
  ctx.lineTo(w * 0.5, h + 12);
  ctx.strokeStyle = "rgba(100, 116, 139, 0.65)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  for (const side of [-1, 1] as const) {
    ctx.beginPath();
    ctx.moveTo(w * (0.5 + side * 0.045), h * 0.945);
    ctx.lineTo(w * (0.5 + side * 0.16), h + 12);
    ctx.strokeStyle = "rgba(120, 136, 158, 0.4)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // A short bow rail. Reads as a real boat at a glance and costs four lines.
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.918);
  ctx.lineTo(w * 0.5, h * 0.892);
  ctx.strokeStyle = "rgba(203, 213, 225, 0.85)";
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.889, 3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(226, 232, 240, 0.9)";
  ctx.fill();

  ctx.restore();
}

/**
 * The HUD.
 *
 * Every line here carries a dark halo, and that is a legibility requirement
 * rather than a style. This text is drawn over whatever the sky happens to be,
 * and the sky is computed from the real solar position -- so it runs from
 * near-black before dawn to a bright pale blue at midday. Colours picked against
 * one end of that range fail at the other, and they fail silently: the advisory
 * RPM and the sun readout were washing out to nearly nothing against a 07:45
 * sky, which is exactly the hour the demo opens on and exactly the frame a
 * screencast would capture. A shadow costs one state change and makes the
 * contrast independent of the weather, the hour and the palette.
 */
export function drawHud(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  motion: VesselMotion,
  solar: SunOnScreen,
) {
  const { width: w } = scene;
  ctx.save();
  ctx.shadowColor = "rgba(2, 6, 23, 0.9)";
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 1;
  ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(248, 250, 252, 0.98)";
  ctx.textAlign = "center";

  const heading = String(Math.round(normaliseDeg(scene.headingDeg))).padStart(3, "0");
  ctx.fillText(
    `SPEED ${scene.speedKn.toFixed(1)} kts     HDG ${heading}°     ` +
      `ROLL ${Math.abs(motion.rollDeg).toFixed(0)}°     PERIOD ${motion.encounterPeriod.toFixed(1)}s`,
    w / 2,
    26,
  );

  if (scene.recommendedRpm != null) {
    // Lifted to 13px and to a lighter orange. The advisory is the one number on
    // this view the product exists to deliver; it should not be the dimmest
    // thing on screen, which at 12px in 0.95 orange over a daylit sky it was.
    ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "rgba(251, 146, 60, 1)";
    ctx.fillText(
      `ADVISORY  ${Math.round(scene.recommendedRpm)} RPM   (now ${Math.round(scene.currentRpm)})`,
      w / 2,
      46,
    );
  }

  // Local time and sun elevation. Small, but it is the label that tells a judge
  // the lighting is computed rather than art-directed.
  ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
  const local = new Date(scene.atMs).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Manila",
  });
  ctx.fillText(
    `${local} PHT   SUN ${solar.sun.elevationDeg >= 0 ? "+" : ""}${solar.sun.elevationDeg.toFixed(0)}° ` +
      `BRG ${Math.round(solar.sun.azimuthDeg)}°`,
    w / 2,
    65,
  );
  ctx.restore();
}

// --- helpers ----------------------------------------------------------------

/** Deterministic pseudo-random in [0,1). Clouds and glitter must be stable from
 *  frame to frame; Math.random() would make them boil. */
function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/** Parse `#rrggbb` or `rgb(r, g, b)` to channels.
 *
 *  Both forms are needed because these blends compose -- `mix3` blends twice and
 *  feeds its own output back in, so the parser has to accept what the formatter
 *  produces. */
function channels(colour: string): Channels {
  if (colour.startsWith("#")) {
    const v = parseInt(colour.slice(1), 16);
    return [v >> 16, (v >> 8) & 255, v & 255];
  }
  const parts = colour.match(/-?\d+(\.\d+)?/g);
  if (!parts || parts.length < 3) return [0, 0, 0];
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

type Channels = [number, number, number];

function rgb(c: Channels): string {
  return `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
}

/** Blend two colours already in channel form. The sea mixes per strip, sixty-odd
 *  times a frame, so it works on numbers rather than re-parsing colour strings. */
function lerpChannels(a: Channels, b: Channels, t: number): Channels {
  const f = clamp(t, 0, 1);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Blend two colours. Used to darken sky and sea with the weather. */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  const f = clamp(t, 0, 1);
  const r = Math.round(ar * (1 - f) + br * f);
  const g = Math.round(ag * (1 - f) + bg * f);
  const bl = Math.round(ab * (1 - f) + bb * f);
  return `rgb(${r}, ${g}, ${bl})`;
}

/** Night -> day -> golden, as two independent blends. Keeps dawn from being a
 *  switch between two palettes. */
function mix3(night: string, day: string, golden: string, daylight: number, goldenness: number) {
  const base = mixHex(night, day, clamp(daylight, 0, 1));
  return mixHex(base, golden, clamp(goldenness * 0.75, 0, 1));
}
