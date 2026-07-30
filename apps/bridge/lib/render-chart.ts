// Chart renderer: north-up, course-up, and follow-cam.
//
// All three are the same drawing under a different camera transform, which is
// why they cost almost nothing to offer and why vessel state stays continuous
// when the captain switches between them.
//
//   north-up    the chart convention. North is up, the boat rotates.
//   course-up   the wheelhouse convention. The bow is up, the chart rotates.
//   follow      north-up, zoomed and centred on the vessel.
//
// Course-up is not decoration. It is how a captain actually navigates: what is
// on your left on the screen is on your left through the windscreen. Offering it
// is the difference between an interface designed by someone who has watched a
// bridge and one that has not.

import type { Vec } from "./nautical";
import type { Hazard } from "./environment";

export type ChartView = "north-up" | "course-up" | "follow";

export interface ChartScene {
  width: number;
  height: number;
  /** Sentinel-2 composite for the chart window, or null before it loads. */
  basemap: HTMLImageElement | null;
  coastline: Vec[][];
  baseline: Vec[];
  route: Vec[];
  ports: { position: Vec; name: string }[];
  vessel: { position: Vec; headingRad: number };
  obstacles: Hazard[];
  storms: Hazard[];
  windParticles: { x: number; y: number; life: number; maxLife: number }[];
  swellParticles: { x: number; y: number; life: number }[];
  rainParticles: { x: number; y: number; length: number }[];
  windDirectionDeg: number;
  windSpeedKn: number;
  waveHeightM: number;
  gloom: number;
  view: ChartView;
  running: boolean;
  diverted: boolean;
}

const SEA = "#071a2b";
const LAND = "#16281f";
const LAND_EDGE = "#2f4a3a";
const ROUTE = "#f97316";

export function drawChart(ctx: CanvasRenderingContext2D, scene: ChartScene): void {
  const { width: w, height: h, view } = scene;

  ctx.save();
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = SEA;
  ctx.fillRect(0, 0, w, h);

  const zoom = view === "follow" ? 2.2 : 1;
  if (view !== "north-up") {
    ctx.translate(w / 2, h / 2);
    ctx.scale(zoom, zoom);
    if (view === "course-up") {
      // Rotate the world so the bow points up the screen.
      ctx.rotate(-scene.vessel.headingRad - Math.PI / 2);
    }
    ctx.translate(-scene.vessel.position.x, -scene.vessel.position.y);
  }

  drawBasemap(ctx, scene);
  drawGrid(ctx, scene);
  drawCoastline(ctx, scene);
  drawSwell(ctx, scene);
  drawWind(ctx, scene);
  drawHazards(ctx, scene);
  drawTracks(ctx, scene);
  drawPorts(ctx, scene);
  drawVessel(ctx, scene);

  ctx.restore();

  drawRain(ctx, scene);
  if (scene.gloom > 0) {
    ctx.fillStyle = `rgba(6, 14, 26, ${scene.gloom})`;
    ctx.fillRect(0, 0, w, h);
  }
  drawNorthArrow(ctx, scene);
}

function drawBasemap(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  if (!scene.basemap) return;
  // Drawn slightly dimmed. Full-brightness daylight imagery under a dark
  // instrument panel destroys the contrast the readouts depend on, and
  // PRODUCT.md treats night vision as a safety asset rather than a preference.
  ctx.save();
  ctx.globalAlpha = 0.88;
  ctx.drawImage(scene.basemap, 0, 0, scene.width, scene.height);
  ctx.restore();

  ctx.fillStyle = "rgba(2, 10, 22, 0.42)";
  ctx.fillRect(0, 0, scene.width, scene.height);
}

function drawGrid(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  const { width: w, height: h } = scene;
  ctx.strokeStyle = "rgba(148, 197, 255, 0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -w; x < w * 2; x += 60) {
    ctx.moveTo(x, -h);
    ctx.lineTo(x, h * 2);
  }
  for (let y = -h; y < h * 2; y += 60) {
    ctx.moveTo(-w, y);
    ctx.lineTo(w * 2, y);
  }
  ctx.stroke();
}

function drawCoastline(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  const { coastline, width: w, height: h } = scene;
  if (coastline.length === 0) return;

  // Natural Earth coastline is a LINE dataset, not polygons. Stroking it is both
  // correct and the nautical chart convention; filling open polylines would
  // invent landmasses that are not in the data.
  for (const ring of coastline) {
    if (ring.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(ring[0].x * w, ring[0].y * h);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x * w, ring[i].y * h);

    // Over satellite imagery the shoreline is already visible, so this is a
    // thin cartographic edge rather than a drawn landmass.
    if (!scene.basemap) {
      ctx.strokeStyle = LAND;
      ctx.lineWidth = 14;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }
    ctx.strokeStyle = scene.basemap ? "rgba(125, 211, 252, 0.45)" : LAND_EDGE;
    ctx.lineWidth = scene.basemap ? 1.2 : 2;
    ctx.stroke();
  }
}

function drawSwell(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  if (scene.waveHeightM <= 0.05) return;
  ctx.lineWidth = 1.5;
  for (const p of scene.swellParticles) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7 + scene.waveHeightM * 3, 0, Math.PI);
    ctx.strokeStyle = `rgba(56, 189, 248, ${p.life * 0.30})`;
    ctx.stroke();
  }
}

function drawWind(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  const rad = scene.windDirectionDeg * (Math.PI / 180);
  // Wind blows FROM its compass direction, so the streak travels the reciprocal.
  const vx = Math.sin(rad);
  const vy = -Math.cos(rad);
  const length = 10 + Math.min(26, scene.windSpeedKn * 0.8);

  ctx.lineWidth = 1.6;
  for (const p of scene.windParticles) {
    const alpha = Math.sin((p.life / p.maxLife) * Math.PI) * 0.35;
    if (alpha <= 0.02) continue;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - vx * length, p.y - vy * length);
    ctx.strokeStyle = `rgba(186, 230, 253, ${alpha})`;
    ctx.stroke();
  }
}

function drawHazards(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  for (const o of scene.obstacles) {
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(234, 179, 8, 0.18)";
    ctx.fill();
    ctx.strokeStyle = "#eab308";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  for (const s of scene.storms) {
    const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.radius);
    grad.addColorStop(0, "rgba(56, 130, 246, 0.45)");
    grad.addColorStop(1, "rgba(56, 130, 246, 0)");
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }
}

function drawTracks(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  const { width: w, height: h } = scene;

  if (scene.baseline.length > 1) {
    ctx.beginPath();
    ctx.moveTo(scene.baseline[0].x * w, scene.baseline[0].y * h);
    for (const p of scene.baseline.slice(1)) ctx.lineTo(p.x * w, p.y * h);
    ctx.strokeStyle = "rgba(226, 232, 240, 0.30)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (scene.route.length > 1) {
    ctx.beginPath();
    ctx.moveTo(scene.route[0].x, scene.route[0].y);
    for (const p of scene.route.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = ROUTE;
    ctx.lineWidth = 3;
    ctx.shadowBlur = 10;
    ctx.shadowColor = ROUTE;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

function drawPorts(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  const { width: w, height: h } = scene;
  for (const port of scene.ports) {
    const x = port.position.x * w;
    const y = port.position.y * h;

    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = "#ef4444";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();

    if (!scene.running) {
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(239, 68, 68, 0.5)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Counter-rotate labels so text stays upright in course-up.
    ctx.save();
    ctx.translate(x, y + 22);
    if (scene.view === "course-up") ctx.rotate(scene.vessel.headingRad + Math.PI / 2);
    ctx.font = "12px ui-sans-serif, system-ui";
    ctx.textAlign = "center";
    const tw = ctx.measureText(port.name).width;
    ctx.fillStyle = "rgba(2, 6, 23, 0.75)";
    ctx.fillRect(-tw / 2 - 5, -12, tw + 10, 18);
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(port.name, 0, 1);
    ctx.restore();
  }
}

/**
 * The vessel, drawn as what it actually is: a double-outrigger passenger banca.
 *
 * The previous marker was a plain arrowhead. That is the conventional chart
 * symbol and there is nothing wrong with it, but this display is also the demo,
 * and the boat that runs Iloilo-Jordan is a fiberglass banca with two katig
 * booms and bamboo floats. Drawing it is what makes the screen recognisably
 * about *this* crossing rather than a generic vessel on a generic strait.
 *
 * It stays a navigation symbol as well as a picture: the hull is drawn to a
 * fixed screen size rather than to scale, because a 12 m boat on a 15 nm chart
 * is a third of a pixel and a symbol you cannot see is not a symbol. The wake
 * behind it is the only part that carries information -- it appears when the
 * vessel is actually making way.
 */
function drawVessel(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  const { position, headingRad } = scene.vessel;
  // Follow view is already zoomed 2.2x by the camera; shrink the symbol there so
  // it stays a boat on the water rather than growing into a boat on the screen.
  const scale = scene.view === "follow" ? 0.62 : 1;

  ctx.save();
  ctx.translate(position.x, position.y);
  ctx.rotate(headingRad);
  ctx.scale(scale, scale);

  // Wake first, so the hull sits on top of it. Length follows the fact of moving
  // rather than a speed we do not have here.
  if (scene.running) {
    const wake = ctx.createLinearGradient(-10, 0, -46, 0);
    wake.addColorStop(0, "rgba(226, 244, 255, 0.42)");
    wake.addColorStop(1, "rgba(226, 244, 255, 0)");
    ctx.beginPath();
    ctx.moveTo(-8, -3.5);
    ctx.lineTo(-46, -11);
    ctx.lineTo(-46, 11);
    ctx.lineTo(-8, 3.5);
    ctx.closePath();
    ctx.fillStyle = wake;
    ctx.fill();
  }

  // Outrigger booms and floats. Drawn before the hull so the hull overlaps them.
  ctx.strokeStyle = "rgba(214, 190, 140, 0.95)";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  for (const side of [-1, 1] as const) {
    for (const along of [4.5, -4.5]) {
      ctx.beginPath();
      ctx.moveTo(along, side * 1.8);
      ctx.lineTo(along, side * 10.5);
      ctx.stroke();
    }
    // The bamboo float: a thin spindle parallel to the hull.
    ctx.beginPath();
    ctx.ellipse(0, side * 10.5, 9.5, 1.9, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(226, 205, 155, 0.95)";
    ctx.fill();
    ctx.strokeStyle = "rgba(90, 74, 44, 0.8)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.strokeStyle = "rgba(214, 190, 140, 0.95)";
    ctx.lineWidth = 1.6;
  }

  // Hull: pointed stem, straight run aft to a squared transom.
  ctx.beginPath();
  ctx.moveTo(13, 0);
  ctx.quadraticCurveTo(7, -3.6, -1, -4.2);
  ctx.lineTo(-9, -3.6);
  ctx.lineTo(-9.5, 3.6);
  ctx.lineTo(-1, 4.2);
  ctx.quadraticCurveTo(7, 3.6, 13, 0);
  ctx.closePath();
  ctx.fillStyle = "#f3f7fb";
  ctx.shadowBlur = 10;
  ctx.shadowColor = "rgba(255,255,255,0.55)";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Cabin roof, and the sheer stripe these boats are always painted with.
  ctx.beginPath();
  ctx.rect(-6.5, -2.6, 8.5, 5.2);
  ctx.fillStyle = "rgba(37, 99, 155, 0.92)";
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(12, 0);
  ctx.quadraticCurveTo(6, -2.2, -9, -2.6);
  ctx.strokeStyle = "rgba(37, 99, 155, 0.75)";
  ctx.lineWidth = 1.1;
  ctx.stroke();

  ctx.restore();
}

function drawRain(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  if (scene.rainParticles.length === 0) return;
  const rad = scene.windDirectionDeg * (Math.PI / 180);
  const vx = Math.sin(rad);
  const vy = -Math.cos(rad);

  ctx.beginPath();
  ctx.strokeStyle = "rgba(200, 220, 255, 0.28)";
  ctx.lineWidth = 1.2;
  for (const p of scene.rainParticles) {
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - vx * p.length, p.y - vy * p.length);
  }
  ctx.stroke();
}

function drawNorthArrow(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  const cx = scene.width - 44;
  const cy = scene.height - 44;
  const rotation = scene.view === "course-up" ? -scene.vessel.headingRad - Math.PI / 2 : 0;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalAlpha = 0.65;

  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(226, 232, 240, 0.5)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.rotate(rotation);
  ctx.beginPath();
  ctx.moveTo(0, -18);
  ctx.lineTo(5, 4);
  ctx.lineTo(0, 0);
  ctx.lineTo(-5, 4);
  ctx.closePath();
  ctx.fillStyle = "#f97316";
  ctx.fill();

  ctx.font = "bold 9px ui-sans-serif, system-ui";
  ctx.fillStyle = "#e2e8f0";
  ctx.textAlign = "center";
  ctx.fillText("N", 0, -22);
  ctx.restore();
}
