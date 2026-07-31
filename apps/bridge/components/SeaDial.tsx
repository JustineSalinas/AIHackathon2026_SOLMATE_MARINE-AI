"use client";

// Where the wind and the sea are, relative to the bow.
//
// This is the reference simulator's best idea and the one thing it had that this
// display did not. It carries two small badges, each a rotating arrow with a
// worded bearing, and they answer in one glance the question that two columns of
// degrees make you do arithmetic for: what sea am I in?
//
// Three things are different here. Its two badges are separate widgets, so wind
// at 40 degrees and sea at 130 look unrelated when the angle *between* them is
// the thing that decides whether the boat is comfortable -- this is one dial with
// both marks on it. Its arrows rotate but nothing states what they rotate
// against, so the reading depends on remembering that the boat is notionally
// pointing up -- this draws the hull. And its four 90-degree buckets call a sea
// 40 degrees off the bow a "Head Sea"; this uses the conventional sectors, which
// is `bearingSector` in lib/nautical.ts.
//
// Nothing here is a model. It is the bearing arithmetic the panel already had,
// drawn instead of tabulated, and the added-resistance figure it hints at still
// comes from the API like every other number on this screen.

import { bearingSector } from "@/lib/nautical";

// Two concentric tracks, in the -50..50 viewBox below: wind outside, sea inside.
//
// They are separated by radius rather than sharing one ring because wind and sea
// agree far more often than they differ -- a wind-driven sea runs with the wind,
// and the panel's own defaults have both arriving from 045. On a single ring the
// marks then sit exactly on top of each other and the one underneath is not
// merely hard to read, it is invisible, which is worse than the two separate
// badges this replaced. Concentric tracks cannot occlude at any angle, and the
// case where the two do coincide is the common one that has to look right.
const WIND_RING = 40;
const SEA_RING = 28;

export function RelativeSeaDial({
  relativeWindDeg,
  relativeWaveDeg,
  windSpeedKn,
  waveHeightM,
}: {
  relativeWindDeg: number;
  relativeWaveDeg: number;
  windSpeedKn: number;
  waveHeightM: number;
}) {
  const wind = bearingSector(relativeWindDeg);
  const sea = bearingSector(relativeWaveDeg);

  return (
    <div className="flex items-center gap-3">
      <svg
        viewBox="-50 -50 100 100"
        className="h-[104px] w-[104px] shrink-0"
        role="img"
        aria-label={
          `Wind from the ${wind.label}, ${windSpeedKn.toFixed(0)} knots. ` +
          `Sea from the ${sea.label}, ${waveHeightM.toFixed(1)} metres.`
        }
      >
        {/* The card. Bow-up always: this dial is read relative to the vessel,
            never to north, and the compass rose on the chart is the instrument
            that answers the north question. */}
        <circle r={WIND_RING + 5} className="fill-slate-950/60 stroke-slate-800" strokeWidth="1" />
        <circle r={SEA_RING - 4} className="fill-none stroke-slate-800/70" strokeWidth="0.75" />
        {[0, 90, 180, 270].map((tick) => (
          <line
            key={tick}
            x1="0"
            y1={-(WIND_RING + 5)}
            x2="0"
            y2={-(WIND_RING + 1)}
            transform={`rotate(${tick})`}
            className="stroke-slate-700"
            strokeWidth="1.5"
          />
        ))}

        {/* The hull, pointing up. Drawn rather than implied so the marks below
            have something to be relative *to*. */}
        <path
          d="M0,-15 C4.5,-8 6,1 5.5,11 L-5.5,11 C-6,1 -4.5,-8 0,-15 Z"
          className="fill-slate-800 stroke-slate-600"
          strokeWidth="1.2"
        />
        <line x1="0" y1="-11" x2="0" y2="8" className="stroke-slate-600" strokeWidth="1" />

        {/* Wind and sea, each an arrow on its own track pointing inward -- toward
            the boat, because that is the direction the weather is travelling.
            Both inputs are the direction the wind and waves come FROM, which is
            the convention lib/nautical.ts documents and the server shares. */}
        <Mark deg={relativeWindDeg} radius={WIND_RING} className="fill-sky-400" />
        <Mark deg={relativeWaveDeg} radius={SEA_RING} className="fill-cyan-300" />
      </svg>

      <dl className="min-w-0 space-y-1.5 text-[11px]">
        <Reading
          swatch="bg-sky-400"
          term="Wind"
          bearing={`${Math.round(relativeWindDeg)}°`}
          sector={wind.label}
          magnitude={`${windSpeedKn.toFixed(0)} kn`}
          headOn={wind.headOn}
        />
        <Reading
          swatch="bg-cyan-300"
          term="Sea"
          bearing={`${Math.round(relativeWaveDeg)}°`}
          sector={sea.label}
          magnitude={`${waveHeightM.toFixed(1)} m`}
          headOn={sea.headOn}
        />
      </dl>
    </div>
  );
}

/** One arrow on its track, pointing in at the hull.
 *
 *  SVG rotates clockwise, and a point at (0, -r) starts at the top, so a plain
 *  `rotate(relativeDeg)` puts 90 degrees on the starboard side without any sign
 *  correction -- which is the same convention `relativeBearing` returns. */
function Mark({
  deg,
  radius,
  className,
}: {
  deg: number;
  radius: number;
  className: string;
}) {
  return (
    <g transform={`rotate(${deg})`}>
      <path d={`M0,${-radius + 8} L4.2,${-radius} L-4.2,${-radius} Z`} className={className} />
    </g>
  );
}

function Reading({
  swatch,
  term,
  bearing,
  sector,
  magnitude,
  headOn,
}: {
  swatch: string;
  term: string;
  bearing: string;
  sector: string;
  magnitude: string;
  headOn: boolean;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-sm ${swatch}`} aria-hidden />
        <span className="text-slate-500">{term}</span>
        <span className="font-mono text-slate-300">{bearing}</span>
        <span className="font-mono text-slate-500">{magnitude}</span>
      </dt>
      {/* Toned, not alarmed. A head sea is the expensive one to push through, so
          it is worth the eye landing on it -- but it is a condition, not a
          fault, and the amber vocabulary on this panel belongs to cutoffs. */}
      <dd className={`ml-3.5 ${headOn ? "text-slate-200" : "text-slate-500"}`}>{sector}</dd>
    </div>
  );
}
