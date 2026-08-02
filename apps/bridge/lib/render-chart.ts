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
import { lightIntensity, type Seamark } from "./seamarks";

export type ChartView = "north-up" | "course-up" | "follow";

/**
 * How the chart is painted underneath the route.
 *
 * Three answers to the same question, because three different people ask it.
 * `satellite` is what the imagery actually shows; `nautical` is the drawn chart
 * a mariner reads, with no photograph at all; `default` sits between them,
 * imagery pushed back far enough that the drawn geometry carries the meaning.
 *
 * All three render from the *same three sources* -- one Sentinel-2 composite,
 * one Natural Earth coastline, and one OpenSeaMap seamark extract. Nothing here
 * fetches a tile from anywhere, which is what keeps the licence position simple:
 * everything on screen is CC BY 4.0, ODbL or public domain, attributed on the
 * page. The seamarks are a build-time extract committed to the repository for
 * the same reason -- see the top of `data/build_seamarks.py`.
 */
export type MapStyle = "default" | "satellite" | "nautical";

export interface ChartScene {
  width: number;
  height: number;
  /** Sentinel-2 composite for the chart window, or null before it loads. */
  basemap: HTMLImageElement | null;
  coastline: Vec[][];
  /** Charted aids to navigation. Empty is a supported state. */
  seamarks: Seamark[];
  /** Real wall-clock ms, for light phase only. See `lightIntensity`. */
  clockMs: number;
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
  style: MapStyle;
  running: boolean;
  diverted: boolean;
}

/**
 * Height of the licence attribution the page lays over the bottom of the chart.
 *
 * That paragraph is HTML, not canvas, so nothing drawn here can see it: the two
 * Sinapsapan lights sit within a fraction of a percent of the southern edge of
 * the window, and their labels landed inside the attribution text. Reserved as a
 * strip rather than measured, because the alternative is the renderer reaching
 * into the DOM for a layout it does not own.
 */
const ATTRIBUTION_STRIP = 38;

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
  drawSeamarks(ctx, scene);
  drawTracks(ctx, scene);
  drawPorts(ctx, scene);
  drawVessel(ctx, scene);

  ctx.restore();

  drawRain(ctx, scene);
  if (scene.gloom > 0) {
    ctx.fillStyle = `rgba(6, 14, 26, ${scene.gloom})`;
    ctx.fillRect(0, 0, w, h);
  }
  drawInset(ctx, scene);
  drawNorthArrow(ctx, scene);
}

/**
 * A small always-north-up overview, top right.
 *
 * It earns its space only in the zoomed and rotated views: once the chart is
 * following the vessel at 2.2x with the bow pointing up the screen, there is no
 * longer anything on it that says where in the strait you are. The inset is the
 * answer to that -- the whole crossing, unrotated, with the vessel on it.
 *
 * Suppressed in north-up, where it would be a smaller copy of the chart already
 * filling the screen.
 */
function drawInset(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  if (scene.view === "north-up") return;

  const R = Math.max(52, Math.min(78, scene.width * 0.062));
  const cx = scene.width - R - 22;
  const cy = R + 22;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();

  // Same sources as the main chart, painted flat and unrotated.
  ctx.fillStyle = SEA;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  if (showsImagery(scene)) {
    ctx.globalAlpha = 0.6;
    ctx.drawImage(scene.basemap!, cx - R, cy - R, R * 2, R * 2);
    ctx.globalAlpha = 1;
  }

  const px = (v: Vec) => ({ x: cx - R + v.x * R * 2, y: cy - R + v.y * R * 2 });

  ctx.lineWidth = 1;
  ctx.strokeStyle = showsImagery(scene) ? "rgba(125, 211, 252, 0.5)" : LAND_EDGE;
  for (const ring of scene.coastline) {
    if (ring.length < 2) continue;
    ctx.beginPath();
    const first = px(ring[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < ring.length; i++) {
      const p = px(ring[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  if (scene.route.length > 1) {
    ctx.beginPath();
    const first = px(scene.route[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < scene.route.length; i++) {
      const p = px(scene.route[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = ROUTE;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  const v = px(scene.vessel.position);
  ctx.beginPath();
  ctx.arc(v.x, v.y, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = "#fbbf24";
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(148, 197, 255, 0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = "rgba(203, 232, 255, 0.75)";
  ctx.font = "600 9px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText("N", cx, cy - R + 11);
}

/** Is the photograph being shown at all, in this style? */
function showsImagery(scene: ChartScene): boolean {
  return scene.basemap !== null && scene.style !== "nautical";
}

function drawBasemap(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  if (!showsImagery(scene)) return;
  // Drawn dimmed in every style. Full-brightness daylight imagery under a dark
  // instrument panel destroys the contrast the readouts depend on, and
  // PRODUCT.md treats night vision as a safety asset rather than a preference.
  // `default` pushes it back further still, so the drawn route and coastline
  // carry the meaning and the photograph is only context.
  const satellite = scene.style === "satellite";
  ctx.save();
  ctx.globalAlpha = satellite ? 0.88 : 0.42;
  ctx.drawImage(scene.basemap!, 0, 0, scene.width, scene.height);
  ctx.restore();

  ctx.fillStyle = satellite ? "rgba(2, 10, 22, 0.42)" : "rgba(4, 16, 30, 0.62)";
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

    // Over the photograph the shoreline is already visible, so the coastline is
    // a thin cartographic edge. Without it -- the nautical style, or a chart
    // that loaded no imagery -- the same polyline has to carry the land itself,
    // stroked heavily enough to read as a shore.
    const overImagery = showsImagery(scene);
    if (!overImagery) {
      ctx.strokeStyle = LAND;
      ctx.lineWidth = 14;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }
    ctx.strokeStyle = overImagery ? "rgba(125, 211, 252, 0.45)" : LAND_EDGE;
    ctx.lineWidth = overImagery ? 1.2 : 2;
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

/**
 * Charted aids to navigation, drawn in the chart's own symbology.
 *
 * These are real: eight lit marks from OpenSeaMap inside this window, including
 * the red and green jetty lights the Iloilo departure runs between and the red
 * light on Jordan Wharf at the other end. Each flashes at its charted period, so
 * "Fl R 5s" lettered beside a light is a description of what the screen is doing
 * rather than a caption.
 *
 * Drawn in EVERY map style, including satellite. Aids to navigation are the last
 * thing that should vanish from a chart, and a mark that disappears when the
 * captain switches to imagery reads as a bug however it is justified. Over the
 * photograph they need their own contrast, which is why every symbol and label
 * carries a dark halo -- the same lesson the helm HUD learned against a daylight
 * sky.
 */
function drawSeamarks(ctx: CanvasRenderingContext2D, scene: ChartScene) {
  if (scene.seamarks.length === 0) return;
  const { width: w, height: h } = scene;

  // Symbols are navigation marks, not scenery, so they hold a readable size
  // rather than growing with the follow camera's 2.2x.
  const scale = scene.view === "follow" ? 0.6 : 1;

  // Label placement is decluttered in SCREEN space, because course-up rotates
  // the world while labels stay upright: two marks 6 px apart stay 6 px apart
  // under rotation, but their axis-aligned label boxes do not. The Iloilo jetty
  // pair is 184 m apart -- about six pixels on this chart -- so without this
  // their labels overprint each other on the most important part of the route.
  const transform = ctx.getTransform();
  const toScreen = (x: number, y: number) => ({
    x: transform.a * x + transform.c * y + transform.e,
    y: transform.b * x + transform.d * y + transform.f,
  });
  const placed: Box[] = [];

  // Port names are drawn AFTER these and would simply paint over them, so their
  // boxes are reserved first: a seamark label then steps aside instead of being
  // overprinted. Measured with the font `drawPorts` actually uses, at the offset
  // it actually draws, so the two cannot drift apart.
  ctx.font = "12px ui-sans-serif, system-ui";
  for (const port of scene.ports) {
    const width = ctx.measureText(port.name).width + 10;
    // The 22 px drop is applied BEFORE projecting, because `drawPorts` shifts in
    // world space and only then counter-rotates. Offsetting the projected point
    // instead is a different place entirely once the chart turns -- which is how
    // "Iloilo City" came to overprint "Iloilo Jetty G" in course-up.
    const anchor = toScreen(port.position.x * w, port.position.y * h + 22);
    placed.push({ x: anchor.x - width / 2, y: anchor.y - 12, w: width, h: 18 });
  }

  // Furniture drawn after the chart transform is released, and therefore over
  // any label underneath it. These are already screen coordinates.
  placed.push({ x: w - 66, y: h - 66, w: 44, h: 44 }); // north arrow
  if (scene.view !== "north-up") {
    const R = Math.max(52, Math.min(78, w * 0.062)); // the overview inset
    placed.push({ x: w - R * 2 - 22, y: 22, w: R * 2, h: R * 2 });
  }

  for (const mark of scene.seamarks) {
    const x = mark.x * w;
    const y = mark.y * h;
    const intensity = mark.light ? lightIntensity(mark.light, scene.clockMs) : 0;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    // The flare first, so the symbol sits inside its own glow.
    if (mark.light && intensity > 0.01) {
      const radius = 6 + intensity * 20;
      const flare = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      flare.addColorStop(0, withAlpha(mark.light.colour, 0.85 * intensity));
      flare.addColorStop(0.45, withAlpha(mark.light.colour, 0.3 * intensity));
      flare.addColorStop(1, withAlpha(mark.light.colour, 0));
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = flare;
      ctx.fill();
    }

    ctx.shadowColor = "rgba(2, 6, 23, 0.9)";
    ctx.shadowBlur = 4;
    drawSeamarkSymbol(ctx, mark, intensity);
    ctx.shadowBlur = 0;
    ctx.restore();

    // --- label ---------------------------------------------------------------
    const lines = [mark.name, mark.light?.label].filter(Boolean) as string[];
    if (lines.length === 0) continue;

    ctx.font = "600 9px ui-monospace, monospace";
    const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const boxW = textWidth + 8;
    const boxH = lines.length * 10 + 4;

    // Four placements, tried in order, before a label is given up on. The
    // Iloilo jetty pair is the reason this is not just "below": the red and
    // green channel lights are 184 m apart, which is six pixels here, and they
    // are the single most demo-relevant marks on the chart. One below and one
    // above keeps both readable where a single offset would silently drop the
    // green one.
    const gap = 11 * scale;
    const candidates: [number, number][] = [
      [0, gap],
      [0, -(boxH + gap)],
      [boxW / 2 + gap, -boxH / 2],
      [-(boxW / 2 + gap), -boxH / 2],
    ];

    let offset: [number, number] | null = null;
    for (const [dx, dy] of candidates) {
      const anchor = toScreen(x + dx, y + dy);
      const box = { x: anchor.x - boxW / 2, y: anchor.y, w: boxW, h: boxH };
      // Fully inside the drawable area, or the label is drawn half under
      // something -- which is what clipped the coastguard station's name off the
      // right edge and dropped Sinapsapan's into the attribution line.
      const clear =
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.w <= w &&
        box.y + box.h <= h - ATTRIBUTION_STRIP;
      if (!clear || placed.some((other) => overlaps(box, other))) continue;
      placed.push(box);
      offset = [dx, dy];
      break;
    }
    if (!offset) continue;

    ctx.save();
    ctx.translate(x + offset[0], y + offset[1]);
    // Keep lettering upright when the chart rotates, exactly as port names do.
    if (scene.view === "course-up") ctx.rotate(scene.vessel.headingRad + Math.PI / 2);
    ctx.textAlign = "center";

    ctx.fillStyle = "rgba(2, 6, 23, 0.72)";
    ctx.fillRect(-boxW / 2, 0, boxW, boxH);

    lines.forEach((line, index) => {
      const isCharacteristic = index === lines.length - 1 && Boolean(mark.light);
      // The characteristic is lettered in the light's own colour, which is how a
      // chart distinguishes the red channel mark from the green one at a glance.
      ctx.fillStyle = isCharacteristic && mark.light ? mark.light.colour : "rgba(203, 232, 255, 0.9)";
      ctx.fillText(line, 0, 9 + index * 10);
    });
    ctx.restore();
  }
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** `#rrggbb` -> `rgba(...)`. The light colours arrive from the builder as hex. */
function withAlpha(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The mark itself, at the origin of an already-translated context. */
function drawSeamarkSymbol(ctx: CanvasRenderingContext2D, mark: Seamark, intensity: number) {
  const ink = "rgba(226, 240, 255, 0.92)";

  switch (mark.category) {
    case "light": {
      // A lit mark stays visible between flashes: the ring is the charted
      // position, the fill is whether it is showing right now.
      ctx.beginPath();
      ctx.arc(0, 0, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = mark.light
        ? withAlpha(mark.light.colour, 0.25 + 0.75 * intensity)
        : ink;
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      break;
    }
    case "harbour": {
      // Anchor: shank, crossbar, and the curve of the arms.
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(0, 4);
      ctx.moveTo(-3.4, -2.6);
      ctx.lineTo(3.4, -2.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 2.2, 4.2, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -6, 1.5, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "rescue": {
      ctx.beginPath();
      ctx.arc(0, 0, 4.4, 0, Math.PI * 2);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-2.4, 0);
      ctx.lineTo(2.4, 0);
      ctx.moveTo(0, -2.4);
      ctx.lineTo(0, 2.4);
      ctx.strokeStyle = "rgba(248, 113, 113, 0.95)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      break;
    }
    case "beacon": {
      // Beacons are fixed to the seabed: a triangle on a stalk.
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, 5);
      ctx.lineTo(0, -1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(3.2, -1);
      ctx.lineTo(-3.2, -1);
      ctx.closePath();
      ctx.stroke();
      break;
    }
    default: {
      // Buoys and anything unclassified: a floating diamond.
      ctx.beginPath();
      ctx.moveTo(0, -4.2);
      ctx.lineTo(3.4, 0);
      ctx.lineTo(0, 4.2);
      ctx.lineTo(-3.4, 0);
      ctx.closePath();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      break;
    }
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
