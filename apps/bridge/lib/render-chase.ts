// The chase camera: the vessel seen from astern and above.
//
// This is the one view in which the boat itself is on screen, and that is the
// whole reason it exists. Every other view answers a navigational question --
// where am I on the chart, what is ahead of the bow. This one answers a
// different and unashamedly presentational one: what does the advice look like
// happening to a boat. A throttle change in the helm view is a number moving; in
// this view the wake shortens and the hull settles, and that is the frame worth
// putting in a screencast.
//
// It reuses `drawSeascape` wholesale. Nothing about the sky, the sun, the
// shoreline or the sea is reimplemented here, so the two exterior views cannot
// disagree about where the light is coming from -- see the note on that export.
//
// The one genuinely new idea is the camera mount. See `cameraAttitude`.

import { DEG, clamp } from "./nautical";
import {
  type HelmScene,
  type SunOnScreen,
  type VesselMotion,
  MAX_PITCH_DEG,
  drawHud,
  drawSeascape,
  drawWeatherOverlay,
  horizonYFor,
  projectSun,
  vesselMotion,
} from "./render-helm";

/**
 * How much of the vessel's motion the camera inherits.
 *
 * This is the number that decides whether the view reads as third-person at all,
 * and getting it wrong in either direction collapses the effect.
 *
 * At 1.0 the camera is welded to the boat: the boat is then motionless in frame
 * and the horizon swings instead, which is exactly the helm view with a hull
 * pasted in the middle. At 0.0 the camera is on a perfect gimbal: the horizon is
 * dead level, the boat rolls against it, and it reads as a drone shot rather
 * than a chase -- correct-looking but oddly detached, because nothing connects
 * the lens to the vessel.
 *
 * A real chase shot is from a boat or a drone station-keeping astern, and it
 * picks up a damped, lagging fraction of the subject's motion. A quarter is
 * enough to feel tethered and little enough that the boat visibly works against
 * the horizon.
 */
const CAMERA_FOLLOW = 0.25;

/** Seconds of lag between the vessel's motion and the camera's. A mount that
 *  responded instantly would be a rigid mount; the lag is what makes the two
 *  read as separate objects. */
const CAMERA_LAG_S = 0.45;

/**
 * The camera's own roll and pitch.
 *
 * Sampled from the vessel's motion a little in the past and scaled down: the
 * mount is soft and it is behind, so it does both less and later. Because
 * `vesselMotion` is a closed-form function of time rather than an integrator,
 * "a little in the past" is free -- re-evaluate it at t - lag. That also means
 * the camera never drifts or needs resetting when the view is switched away and
 * back, which a stateful smoothing filter would.
 */
function cameraAttitude(scene: HelmScene, vessel: VesselMotion): VesselMotion {
  const lagged = vesselMotion({ ...scene, timeSeconds: scene.timeSeconds - CAMERA_LAG_S });
  return {
    rollDeg: lagged.rollDeg * CAMERA_FOLLOW,
    pitchDeg: lagged.pitchDeg * CAMERA_FOLLOW,
    encounterPeriod: vessel.encounterPeriod,
  };
}

export function drawChase(ctx: CanvasRenderingContext2D, scene: HelmScene): void {
  const { width: w, height: h } = scene;
  const vessel = vesselMotion(scene);
  const camera = cameraAttitude(scene, vessel);

  ctx.save();
  ctx.clearRect(0, 0, w, h);

  const horizonY = horizonYFor(scene, camera.pitchDeg);
  const solar = projectSun(scene, horizonY);

  drawSeascape(ctx, scene, camera, solar, horizonY);
  drawWeatherOverlay(ctx, scene);

  // What the boat does that the camera did not. Drawing the hull at the
  // difference rather than at its absolute attitude is what puts the motion into
  // the vessel instead of into the world -- the horizon stays nearly level and
  // the boat works against it, which is the whole point of watching from astern.
  drawVesselFromAstern(
    ctx,
    scene,
    {
      rollDeg: vessel.rollDeg - camera.rollDeg,
      pitchDeg: vessel.pitchDeg - camera.pitchDeg,
      encounterPeriod: vessel.encounterPeriod,
    },
    solar,
    horizonY,
  );

  drawHud(ctx, scene, vessel, solar);
  ctx.restore();
}

/**
 * The banca, from behind and slightly above.
 *
 * Drawn in the same idiom as the helm view's foredeck: procedural, lit from the
 * sun's real bearing, and reacting to speed and sea rather than being a static
 * sprite. The outrigger floats bob a quarter-cycle out of phase with the hull,
 * for the same reason they do in the helm view -- that phase offset is why an
 * outrigger boat feels steadier than its beam suggests, and it is visible from
 * this angle in a way it is not from the helm.
 */
function drawVesselFromAstern(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  attitude: VesselMotion,
  solar: SunOnScreen,
  horizonY: number,
) {
  const { width: w, height: h, timeSeconds: t } = scene;
  const day = solar.sun.daylight;
  const moving = scene.speedKn > 0.5;
  const lit = day > 0.3;

  // Where the boat sits in frame, and how big it is.
  //
  // One scale handle rather than separate width and height terms, because the
  // first attempt derived the hull's beam from the canvas width and its length
  // from the canvas height, and the two disagreed: on a wide window the boat
  // came out nearly as tall as it was wide and read as a dome rather than a
  // stern. A hull seen from directly astern is emphatically WIDE AND LOW -- that
  // proportion is most of what identifies it -- so every dimension below is a
  // fraction of one number and the shape holds at any aspect ratio.
  const cx = w / 2;
  const waterline = horizonY + (h - horizonY) * 0.58;
  const S = Math.min(w * 0.30, h * 0.52);

  const hullHalf = S * 0.27; // half the beam at the gunwale
  const gunwale = S * 0.115; // transom height, waterline to rail
  // How much deck is visible over the transom. Small on purpose: the camera sits
  // only a little above the rail, so almost the whole deck is hidden behind it.
  // A generous value here was what made the first attempt read as a box -- a
  // large lit quadrilateral above the transom is a lorry cab, not a boat.
  const recede = S * 0.075;
  const floatX = S * 0.56; // outrigger float, out from centreline
  const cabinHalf = S * 0.125;
  const cabinH = S * 0.15;

  ctx.save();

  if (moving) drawWake(ctx, scene, cx, waterline, hullHalf, h);

  // The hull's own attitude, about a point on the waterline so the boat rolls
  // on the sea rather than about its masthead.
  ctx.translate(cx, waterline);
  ctx.rotate(attitude.rollDeg * DEG);
  ctx.translate(0, (attitude.pitchDeg / MAX_PITCH_DEG) * S * 0.10);

  // Contact shadow. Without it the hull reads as a decal laid on top of the
  // sea; a boat displaces water and darkens the surface it sits in, and this one
  // ellipse is most of what makes it look afloat rather than pasted on.
  ctx.beginPath();
  ctx.ellipse(0, S * 0.012, hullHalf * 1.15, S * 0.045, 0, 0, Math.PI * 2);
  ctx.fillStyle = lit ? "rgba(16, 34, 54, 0.34)" : "rgba(4, 10, 20, 0.42)";
  ctx.fill();

  // --- outriggers, drawn first so the hull overlaps them --------------------
  // The floats ride the sea a quarter-cycle out of phase with the hull, which is
  // why an outrigger boat feels steadier than its beam suggests. From astern
  // that phase offset is directly visible, where from the helm it is not.
  const bob = Math.sin((2 * Math.PI * t) / attitude.encounterPeriod + Math.PI / 2);
  const floatDip = bob * clamp(scene.waveHeightM * 4, 0, S * 0.05);

  for (const side of [-1, 1] as const) {
    const fx = side * floatX;
    const fy = -floatDip * side * 0.5;

    // Two booms per side, splayed fore and aft as they are rigged. They leave
    // the gunwale close to level and dip only slightly to the float. An earlier
    // version arced them well above the rail, which read as handlebars: a real
    // boom is a straight bamboo pole lashed across the deck, and its apparent
    // curve from astern is slight.
    ctx.strokeStyle = lit ? "rgba(191, 161, 110, 0.95)" : "rgba(112, 102, 84, 0.9)";
    ctx.lineWidth = Math.max(2, S * 0.015);
    ctx.lineCap = "round";
    for (const fore of [0, 1]) {
      const back = fore * S * 0.05;
      ctx.beginPath();
      ctx.moveTo(side * hullHalf * 0.80, -gunwale * 0.86 - back);
      ctx.quadraticCurveTo(
        side * (hullHalf + floatX) * 0.52,
        -gunwale * 0.62 - back * 0.8,
        fx,
        fy - S * 0.022 - back * 0.5,
      );
      ctx.stroke();
    }

    // The bamboo float. Foreshortened by the viewing angle into a short spindle
    // rather than the long log the helm view shows broadside.
    ctx.save();
    ctx.translate(fx, fy);
    ctx.beginPath();
    ctx.ellipse(0, 0, S * 0.075, S * 0.042, 0, 0, Math.PI * 2);
    const floatFill = ctx.createLinearGradient(0, -S * 0.042, 0, S * 0.042);
    floatFill.addColorStop(0, lit ? "#dccb9e" : "#8b8168");
    floatFill.addColorStop(1, lit ? "#96865f" : "#54503e");
    ctx.fillStyle = floatFill;
    ctx.fill();
    ctx.strokeStyle = "rgba(60, 52, 38, 0.75)";
    ctx.lineWidth = 1;
    ctx.stroke();

    if (moving) {
      ctx.beginPath();
      ctx.ellipse(0, S * 0.035, S * 0.10, S * 0.022, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(240, 250, 255, ${clamp(scene.speedKn / 22, 0, 0.6)})`;
      ctx.fill();
    }
    ctx.restore();
  }

  // --- the hull -------------------------------------------------------------
  // Two faces: the deck running away from us, then the transom facing us. Drawn
  // in that order so the near face overlaps the far one.
  const sunLeft = solar.x < cx;
  const hi = lit ? 242 : 168;
  const lo = lit ? 186 : 124;
  const near = (v: number) => `rgb(${v}, ${v}, ${v + 4})`;

  // Deck: the sliver of sole visible over the transom rail, curving up toward
  // the bow as a sheer line does.
  ctx.beginPath();
  ctx.moveTo(-hullHalf * 0.97, -gunwale);
  ctx.quadraticCurveTo(0, -gunwale - recede * 1.5, hullHalf * 0.97, -gunwale);
  ctx.quadraticCurveTo(0, -gunwale - recede * 0.35, -hullHalf * 0.97, -gunwale);
  ctx.closePath();
  ctx.fillStyle = lit ? "rgba(120, 132, 148, 0.98)" : "rgba(48, 58, 74, 0.98)";
  ctx.fill();

  // Transom: the flat stern face. Curved sides and a rounded forefoot rather
  // than a trapezoid -- a fiberglass hull has no hard chines at the waterline,
  // and the straight-edged version read as folded card.
  ctx.beginPath();
  ctx.moveTo(-hullHalf, -gunwale);
  ctx.lineTo(hullHalf, -gunwale);
  ctx.quadraticCurveTo(hullHalf * 0.94, -gunwale * 0.18, hullHalf * 0.62, 0);
  ctx.quadraticCurveTo(0, S * 0.028, -hullHalf * 0.62, 0);
  ctx.quadraticCurveTo(-hullHalf * 0.94, -gunwale * 0.18, -hullHalf, -gunwale);
  ctx.closePath();
  const hull = ctx.createLinearGradient(-hullHalf, 0, hullHalf, 0);
  hull.addColorStop(0, near(sunLeft ? hi : lo));
  hull.addColorStop(0.5, near(Math.round((hi + lo) / 2)));
  hull.addColorStop(1, near(sunLeft ? lo : hi));
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.strokeStyle = "rgba(24, 34, 52, 0.9)";
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Boot stripe, in the advisory's own orange. Trim, and it gives the eye a
  // horizontal to read the roll against. Follows the hull's curve rather than
  // cutting straight across it.
  ctx.beginPath();
  ctx.moveTo(-hullHalf * 0.93, -gunwale * 0.40);
  ctx.quadraticCurveTo(0, -gunwale * 0.12, hullHalf * 0.93, -gunwale * 0.40);
  ctx.strokeStyle = "rgba(249, 115, 22, 0.9)";
  ctx.lineWidth = Math.max(1.5, S * 0.013);
  ctx.stroke();

  // --- cabin ----------------------------------------------------------------
  const cabinBase = -gunwale - recede * 0.16;
  ctx.beginPath();
  ctx.moveTo(-cabinHalf, cabinBase);
  ctx.lineTo(cabinHalf, cabinBase);
  ctx.lineTo(cabinHalf * 0.88, cabinBase - cabinH);
  ctx.lineTo(-cabinHalf * 0.88, cabinBase - cabinH);
  ctx.closePath();
  const cab = ctx.createLinearGradient(-cabinHalf, 0, cabinHalf, 0);
  cab.addColorStop(0, lit ? (sunLeft ? "#eef2f6" : "#b9c2cd") : "#5b6779");
  cab.addColorStop(1, lit ? (sunLeft ? "#b9c2cd" : "#eef2f6") : "#485466");
  ctx.fillStyle = cab;
  ctx.fill();
  ctx.strokeStyle = "rgba(24, 34, 52, 0.85)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // The helmsman, seen from behind. A shoulder line and a head -- enough to read
  // as occupied, and at this size anything more becomes noise.
  ctx.fillStyle = lit ? "rgba(44, 58, 80, 0.92)" : "rgba(22, 30, 45, 0.92)";
  ctx.beginPath();
  ctx.ellipse(0, cabinBase - cabinH * 0.30, cabinHalf * 0.42, cabinH * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, cabinBase - cabinH * 0.60, cabinH * 0.16, 0, Math.PI * 2);
  ctx.fill();

  // Roof, overhanging on both sides as these boats are built.
  ctx.beginPath();
  ctx.moveTo(-cabinHalf * 1.22, cabinBase - cabinH);
  ctx.lineTo(cabinHalf * 1.22, cabinBase - cabinH);
  ctx.lineTo(cabinHalf * 1.10, cabinBase - cabinH - S * 0.028);
  ctx.lineTo(-cabinHalf * 1.10, cabinBase - cabinH - S * 0.028);
  ctx.closePath();
  ctx.fillStyle = lit ? "rgba(214, 222, 232, 0.97)" : "rgba(72, 84, 102, 0.97)";
  ctx.fill();
  ctx.strokeStyle = "rgba(24, 34, 52, 0.85)";
  ctx.stroke();

  ctx.restore();
}

/**
 * The wake: two diverging shoulders and the churned water between them.
 *
 * It runs from under the transom toward the camera and widens as it comes, which
 * is the opposite of how it is usually drawn and the correct way round when the
 * camera is astern -- the wake is between the boat and the lens, so its near end
 * is its widest and its oldest.
 *
 * Its length tracks speed, not throttle. That distinction earns its place: when
 * the advisory is taken and the throttle comes back, the wake visibly shortens
 * over the following seconds rather than snapping, because the hull takes that
 * long to slow. It is the only place on the display where the lag between an
 * instruction and its effect is shown rather than stated.
 */
function drawWake(
  ctx: CanvasRenderingContext2D,
  scene: HelmScene,
  cx: number,
  waterline: number,
  hullHalf: number,
  h: number,
) {
  const strength = clamp(scene.speedKn / 12, 0, 1.2);
  const reach = (h - waterline) * clamp(0.5 + strength * 0.5, 0, 1.05);
  const spread = hullHalf * (1.5 + strength * 2.4);

  ctx.save();

  // Churned water: a wedge widening toward the camera, brightest under the
  // transom and fading out as it is left behind. The first attempt drew this as
  // two thin strokes, which read as rails painted on the sea rather than as
  // water; broken water is a FIELD of foam, so the fill carries the effect and
  // the edges only sharpen it.
  // The outer edges bow outward rather than running dead straight to the corners
  // of the frame. Straight edges read as a ramp or a road painted on the sea;
  // the divergence of a real wake is a curve.
  const wedge = (inset: number) => {
    ctx.beginPath();
    ctx.moveTo(cx - hullHalf * 0.85 * inset, waterline);
    ctx.lineTo(cx + hullHalf * 0.85 * inset, waterline);
    ctx.quadraticCurveTo(
      cx + spread * 0.62 * inset,
      waterline + reach * 0.5,
      cx + spread * inset,
      waterline + reach,
    );
    ctx.lineTo(cx - spread * inset, waterline + reach);
    ctx.quadraticCurveTo(
      cx - spread * 0.62 * inset,
      waterline + reach * 0.5,
      cx - hullHalf * 0.85 * inset,
      waterline,
    );
    ctx.closePath();
  };

  wedge(1);
  const churn = ctx.createLinearGradient(0, waterline, 0, waterline + reach);
  churn.addColorStop(0, `rgba(244, 252, 255, ${clamp(strength * 0.5, 0, 0.6)})`);
  churn.addColorStop(0.45, `rgba(228, 244, 255, ${clamp(strength * 0.22, 0, 0.26)})`);
  churn.addColorStop(1, "rgba(214, 236, 255, 0)");
  ctx.fillStyle = churn;
  ctx.fill();

  // Foam texture, clipped to the wedge so no fleck strays onto flat water.
  // Deterministic, so it does not boil from frame to frame -- the same reason
  // the helm view's glitter is hashed rather than random. Both the along-wake
  // and across-wake positions are jittered, because a regular lattice of dots
  // reads as printed texture rather than as broken water.
  ctx.save();
  wedge(1);
  ctx.clip();
  const rows = 11;
  for (let i = 1; i <= rows; i += 1) {
    const jitterF = (i / rows) + (hash(i * 3.7) - 0.5) * (0.5 / rows);
    const f = clamp(jitterF, 0, 1);
    const y = waterline + reach * f;
    const halfWidth = hullHalf * 0.85 + (spread - hullHalf * 0.85) * f;
    const alpha = clamp(strength * 0.45 * (1 - f) ** 1.25, 0, 0.5);
    if (alpha < 0.02) continue;
    const count = 4 + i * 2;
    for (let j = 0; j < count; j += 1) {
      const r = hash(i * 31.7 + j * 7.3);
      const dy = (hash(j * 5.1 + i * 2.3) - 0.5) * reach * 0.05;
      const x = cx + (r * 2 - 1) * halfWidth * 0.94;
      const rr = h * 0.0035 * (0.5 + f * 2.0) * (0.5 + hash(j * 13.1 + i) * 1.1);
      ctx.beginPath();
      ctx.ellipse(x, y + dy, rr * 2.1, rr * 0.65, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha * (0.55 + hash(j * 2.9 + i * 1.7) * 0.75)})`;
      ctx.fill();
    }
  }
  ctx.restore();

  // The two shoulders, where the water is actually breaking. Faded out at the
  // near end so they do not terminate in a hard line across the frame.
  for (const side of [-1, 1] as const) {
    const grad = ctx.createLinearGradient(0, waterline, 0, waterline + reach);
    grad.addColorStop(0, `rgba(255, 255, 255, ${clamp(strength * 0.5, 0, 0.6)})`);
    grad.addColorStop(0.7, `rgba(255, 255, 255, ${clamp(strength * 0.22, 0, 0.3)})`);
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.beginPath();
    ctx.moveTo(cx + side * hullHalf * 0.85, waterline);
    ctx.quadraticCurveTo(
      cx + side * spread * 0.62,
      waterline + reach * 0.5,
      cx + side * spread,
      waterline + reach,
    );
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(2, h * 0.0045 * (0.6 + strength));
    ctx.lineCap = "round";
    ctx.stroke();
  }

  // Prop wash directly under the transom, the whitest water in frame.
  ctx.beginPath();
  ctx.ellipse(cx, waterline + reach * 0.06, hullHalf * 0.78, reach * 0.07, 0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 255, 255, ${clamp(strength * 0.6, 0, 0.7)})`;
  ctx.fill();

  ctx.restore();
}

/** Deterministic pseudo-random in [0,1). The foam must be stable from frame to
 *  frame; Math.random() would make it boil. Same relation the helm view uses. */
function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}
