"use client";

// Chrome that sits on top of the chart canvas: the tool rail and the compass.
//
// Both are lifted from the reference simulator and both are changed on the way
// in. Its tool rail is a column of bare glyphs with no labels and no keyboard
// path, which is fine for the person who built it and opaque to everyone else --
// so this one names every tool, binds each to a digit, and says what the tool
// does to the chart when you pick it. Its compass is decorative; this one shows
// the vessel's actual heading against the chart's orientation, which is the
// question a compass on a chart is there to answer.

import { type PovMode, isChartView } from "@/lib/simulation";

export type Tool = "pointer" | "obstacle" | "storm";

export const TOOLS: {
  id: Tool;
  label: string;
  key: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "pointer",
    label: "Select",
    key: "1",
    hint: "Drag a port to move it. Click a hazard to clear it.",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
        <path d="M3 1.5l9.5 5.8-4.1.9-2.2 4L3 1.5z" />
      </svg>
    ),
  },
  {
    id: "obstacle",
    label: "Obstacle",
    key: "2",
    hint: "Mark an obstruction. The route is re-shaped around it.",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
        <path d="M8 1.5l6.5 12h-13L8 1.5zm0 4.2v4.1h.01V5.7H8zm0 5.3v1.3h.01V11H8z" />
      </svg>
    ),
  },
  {
    id: "storm",
    label: "Weather cell",
    key: "3",
    hint: "Place a squall. Local wind and sea rise inside it.",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
        <path d="M4.6 10.5a3 3 0 01.3-6 4 4 0 017.5 1.2 2.6 2.6 0 01-.4 5.2H4.6zm4.6 1l-2.4 3.8h1.8l-1 2.2 3.2-4.2h-1.9l1.1-1.8H9.2z" />
      </svg>
    ),
  },
];

/**
 * The tool rail.
 *
 * Vertical, on the left edge of the chart, one row per tool. The label sits in a
 * flyout rather than always-on so the rail stays narrow, but it is on hover and
 * on focus -- a rail you can only learn by clicking things is a rail nobody
 * learns during a five-minute demo.
 */
export function ToolRail({
  tool,
  onChange,
}: {
  tool: Tool;
  onChange: (tool: Tool) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Chart tools"
      aria-orientation="vertical"
      className="absolute left-3 top-3 flex flex-col gap-1 rounded-lg border border-slate-700/80 bg-slate-900/85 p-1 shadow-lg backdrop-blur"
    >
      {TOOLS.map((entry) => {
        const active = tool === entry.id;
        return (
          <button
            key={entry.id}
            onClick={() => onChange(entry.id)}
            aria-pressed={active}
            className={`group relative flex h-8 w-8 items-center justify-center rounded transition-colors ${
              active
                ? "bg-orange-500 text-white"
                : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            }`}
          >
            {entry.icon}
            <span className="sr-only">{entry.label}</span>
            <span
              role="tooltip"
              className="pointer-events-none absolute left-full top-0 z-10 ml-2 hidden w-52 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-left shadow-xl group-hover:block group-focus-visible:block"
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium text-slate-100">{entry.label}</span>
                <kbd className="rounded bg-slate-800 px-1 font-mono text-[9px] text-slate-400">
                  {entry.key}
                </kbd>
              </span>
              <span className="mt-0.5 block text-[10px] leading-snug text-slate-400">
                {entry.hint}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The compass.
 *
 * The card rotates to the chart's orientation and the needle points to the
 * vessel's heading, so the two things a helmsman actually wants off a compass --
 * which way is north, and which way am I pointing -- are both answerable without
 * reading a number. Clicking it returns the chart to north-up, which is the
 * conventional way out of a rotated view.
 *
 * In the exterior camera views (helm, chase) there is no chart to orient, so it
 * does not render.
 */
export function CompassRose({
  headingDeg,
  pov,
  onResetNorth,
}: {
  headingDeg: number;
  pov: PovMode;
  onResetNorth: () => void;
}) {
  if (!isChartView(pov)) return null;

  // How far the chart itself is rotated. Course-up and follow put the bow at the
  // top of the screen, so north swings round by the reciprocal of the heading.
  const chartRotation = pov === "north-up" ? 0 : -headingDeg;
  // The needle is drawn in chart space, so it needs the heading relative to
  // whatever the card is already showing.
  const needleRotation = headingDeg + chartRotation;

  return (
    <button
      onClick={onResetNorth}
      title={
        pov === "north-up"
          ? `Heading ${Math.round(headingDeg)}° · chart is north-up`
          : `Heading ${Math.round(headingDeg)}° · click for north-up`
      }
      className="absolute bottom-14 left-3 h-20 w-20 rounded-full border border-slate-700/80 bg-slate-900/80 shadow-lg backdrop-blur transition-colors hover:border-slate-500"
    >
      <span className="sr-only">
        Heading {Math.round(headingDeg)} degrees. Reset chart to north-up.
      </span>
      <svg viewBox="-50 -50 100 100" className="h-full w-full">
        {/* The card. Rotates with the chart. */}
        <g transform={`rotate(${chartRotation})`}>
          <circle r="42" className="fill-none stroke-slate-700" strokeWidth="1" />
          {Array.from({ length: 36 }, (_, i) => {
            const major = i % 9 === 0;
            return (
              <line
                key={i}
                x1="0"
                y1="-42"
                x2="0"
                y2={major ? "-34" : "-38"}
                transform={`rotate(${i * 10})`}
                className={major ? "stroke-slate-400" : "stroke-slate-700"}
                strokeWidth={major ? 1.5 : 1}
              />
            );
          })}
          <text y="-24" textAnchor="middle" className="fill-slate-300 text-[13px] font-semibold">
            N
          </text>
          <text y="30" textAnchor="middle" className="fill-slate-500 text-[11px]">
            S
          </text>
          <text x="27" y="4" textAnchor="middle" className="fill-slate-500 text-[11px]">
            E
          </text>
          <text x="-27" y="4" textAnchor="middle" className="fill-slate-500 text-[11px]">
            W
          </text>
        </g>

        {/* The needle. Points where the bow points. */}
        <g transform={`rotate(${needleRotation})`}>
          <path d="M0,-30 L6,8 L0,3 L-6,8 Z" className="fill-orange-500" />
        </g>
        <circle r="2.5" className="fill-slate-900 stroke-slate-500" strokeWidth="1" />
      </svg>
    </button>
  );
}
