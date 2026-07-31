"use client";

// The simulator's input surface: vessel, environment, engine and operator
// controls, grouped the way someone driving a demo reaches for them.
//
// This panel is for whoever is driving the demo. It is emphatically NOT the
// bridge display -- PRODUCT.md gives the captain two seconds and a single
// number, and thirty controls is the opposite of that. See TelemetryPanel for
// the part a captain would actually see.
//
// Two things here are load-bearing rather than convenient. The vessel block
// edits the single spec that both /advise and /route read, so the hull can be
// changed and the advice can be watched to move -- a demo whose boat cannot
// change is a demo about one boat. And the forecast block shows where its
// numbers came from, because "live weather" is the easiest claim in the
// simulator to make and the hardest to check.

import { useState, type ReactNode, type RefObject } from "react";

import { WEATHER, type WeatherPreset } from "@/lib/environment";
import { beaufort, douglasSea } from "@/lib/derived";
import { FAULTS, type FaultKind } from "@/lib/telemetry";
import type { SimState } from "@/lib/simulation";
import { phtClock, placeVesselAtStart, rebuildRoute, setEnv } from "@/lib/simulation";
import {
  HULL_CLASSES,
  VESSEL_PRESETS,
  type HullClass,
  blockCoefficient,
  hullSpeedKn,
  kwToHp,
  hpToKw,
  vesselWarnings,
} from "@/lib/vessel";
import type { Snapshot } from "./Simulator";

/** Simulated clock -> hours past midnight, Philippine time. */
function hoursPht(ms: number): number {
  const d = new Date(ms + 8 * 3_600_000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function formatPht(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours % 1) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} PHT`;
}

interface Props {
  state: RefObject<SimState>;
  snapshot: Snapshot | null;
  onMutate: (fn: (state: SimState) => void) => void;
  onSyncForecast: () => void;
}

export default function ControlPanel({ state, snapshot, onMutate, onSyncForecast }: Props) {
  const s = state.current;
  const vessel = s.vesselSpec;
  const warnings = vesselWarnings(vessel);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-1 overflow-y-auto p-3">
        {/* ---------- 1. the vessel ---------- */}
        <Group title="Vessel" step={1} defaultOpen={false}>
          <label className="block">
            <FieldLabel>Load a starting point</FieldLabel>
            <select
              value={VESSEL_PRESETS.find((p) => p.spec.vesselId === vessel.vesselId)?.id ?? "custom"}
              onChange={(e) =>
                onMutate((st) => {
                  const preset = VESSEL_PRESETS.find((p) => p.id === e.target.value);
                  if (preset) st.vesselSpec = { ...preset.spec };
                })
              }
              className={selectClass}
            >
              {VESSEL_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Edited</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Waterline"
              unit="m"
              value={vessel.lengthWaterlineM}
              step={0.1}
              onChange={(v) => onMutate((st) => (st.vesselSpec.lengthWaterlineM = v))}
            />
            <NumberField
              label="Beam"
              unit="m"
              value={vessel.beamM}
              step={0.1}
              onChange={(v) => onMutate((st) => (st.vesselSpec.beamM = v))}
            />
            <NumberField
              label="Draft"
              unit="m"
              value={vessel.draftM}
              step={0.05}
              onChange={(v) => onMutate((st) => (st.vesselSpec.draftM = v))}
            />
            <NumberField
              label="Displacement"
              unit="kg"
              value={vessel.displacementKg}
              step={100}
              onChange={(v) => onMutate((st) => (st.vesselSpec.displacementKg = v))}
            />
            {/* Operators here quote engines in horsepower and the physics is in
                kilowatts, so the field takes HP and the converted value is shown
                rather than silently assumed. */}
            <NumberField
              label="Rated power"
              unit="hp"
              value={Math.round(kwToHp(vessel.ratedKw))}
              step={5}
              hint={`${vessel.ratedKw.toFixed(0)} kW`}
              onChange={(v) => onMutate((st) => (st.vesselSpec.ratedKw = hpToKw(v)))}
            />
            <NumberField
              label="Rated speed"
              unit="rpm"
              value={vessel.ratedRpm}
              step={50}
              onChange={(v) => onMutate((st) => (st.vesselSpec.ratedRpm = v))}
            />
          </div>

          <label className="block">
            <FieldLabel>Hull class</FieldLabel>
            <select
              value={vessel.hull}
              onChange={(e) =>
                onMutate((st) => {
                  const hull = e.target.value as HullClass;
                  st.vesselSpec.hull = hull;
                  st.vesselSpec.admiraltyCoefficient = HULL_CLASSES[hull].admiralty;
                })
              }
              className={selectClass}
            >
              {Object.entries(HULL_CLASSES).map(([id, hull]) => (
                <option key={id} value={id}>
                  {hull.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] leading-snug text-slate-500">
              {HULL_CLASSES[vessel.hull].note}
            </p>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Admiralty coeff."
              unit=""
              value={vessel.admiraltyCoefficient}
              step={1}
              onChange={(v) => onMutate((st) => (st.vesselSpec.admiraltyCoefficient = v))}
            />
            <NumberField
              label="Best BSFC"
              unit="g/kWh"
              value={vessel.bestBsfcGPerKwh}
              step={5}
              onChange={(v) => onMutate((st) => (st.vesselSpec.bestBsfcGPerKwh = v))}
            />
          </div>

          {/* Derived from the fields above, not typed. Shown because it is the
              fastest way to catch a mistyped hull: a passenger boat with a block
              coefficient of 0.95 is a barge.

              Both figures say "light" because the displacement field is the
              empty boat -- passengers and cargo are added by the server, not
              folded in here. Unlabelled, the block coefficient reads as
              improbably fine against the textbook bands, which are quoted at the
              load waterline. */}
          <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5">
            <Derived label="Block coeff. (light)" value={blockCoefficient(vessel).toFixed(3)} />
            <Derived label="Hull speed" value={`${hullSpeedKn(vessel).toFixed(1)} kn`} />
            <Derived
              label="Power / tonne (light)"
              value={`${((vessel.ratedKw * 1000) / Math.max(1, vessel.displacementKg)).toFixed(0)} W/kg`}
            />
          </div>
          <p className="text-[10px] leading-snug text-slate-500">
            Both are quoted light. Displacement here is the empty hull; the{" "}
            {s.passengers} passengers and {s.cargoKg.toFixed(0)} kg of cargo set
            below are added to it by the resistance model, not by this box.
          </p>

          {warnings.map((warning) => (
            <p
              key={warning}
              className="rounded border border-amber-900/60 bg-amber-950/30 px-2 py-1 text-[10px] leading-snug text-amber-300"
            >
              {warning}
            </p>
          ))}

          <p className="text-[10px] leading-snug text-slate-500">
            The Admiralty coefficient is the calibration handle: on a fitted vessel
            it is solved from the boat&rsquo;s own fuel-flow meter rather than
            picked from a class. These presets are plausible starting points, not
            surveyed figures.
          </p>
        </Group>

        {/* ---------- 2. the operator's controls ---------- */}
        <Group title="Helm & schedule" step={2} defaultOpen>
          <Slider
            label="Throttle"
            value={s.throttlePct}
            min={0}
            max={100}
            step={1}
            format={(v) =>
              `${v.toFixed(0)}%  ·  ${((v / 100) * vessel.ratedRpm).toFixed(0)} rpm`
            }
            onChange={(v) => onMutate((st) => (st.throttlePct = v))}
          />
          <Slider
            label="Scheduled crossing"
            value={s.scheduleMinutes}
            min={8}
            max={60}
            step={1}
            format={(v) => `${v.toFixed(0)} min`}
            onChange={(v) => onMutate((st) => (st.scheduleMinutes = v))}
          />
          <Slider
            label="Time of day"
            value={hoursPht(s.simClockMs)}
            min={0}
            max={23.75}
            step={0.25}
            format={formatPht}
            onChange={(v) =>
              onMutate((st) => {
                st.simClockMs = phtClock(v);
                // Re-anchor the telemetry emitter, or a jump backwards would
                // stall the health window until the clock caught up again.
                st.health.nextFrameAtMs = st.simClockMs;
              })
            }
          />
          <p className="text-[10px] leading-snug text-slate-500">
            Drives the sun in the helm view — real solar position for Iloilo, not
            a lighting preset. 05:40 is the first crossing of the day.
          </p>

          <Slider
            label="Passengers"
            value={s.passengers}
            min={0}
            max={vessel.passengerCapacity}
            step={1}
            format={(v) => `${v.toFixed(0)} of ${vessel.passengerCapacity}`}
            onChange={(v) => onMutate((st) => (st.passengers = v))}
          />
          <Slider
            label="Cargo"
            value={s.cargoKg}
            min={0}
            max={6000}
            step={100}
            format={(v) => `${v.toFixed(0)} kg`}
            onChange={(v) => onMutate((st) => (st.cargoKg = v))}
          />
        </Group>

        {/* ---------- 3. the sea ---------- */}
        <Group title="Environment" step={3} defaultOpen>
          <ForecastSource
            snapshot={snapshot}
            enabled={s.liveForecast}
            onToggle={(v) =>
              onMutate((st) => {
                st.liveForecast = v;
                // Real data wins. Letting a synthetic walk run underneath a live
                // pull would put invented movement behind the LIVE badge, and
                // that badge is the whole point of the block above.
                if (v) st.drift.enabled = false;
              })
            }
            onSync={onSyncForecast}
          />

          <DriftToggle
            enabled={s.drift.enabled}
            blocked={s.liveForecast}
            onToggle={(v) =>
              onMutate((st) => {
                st.drift.enabled = v;
                // Re-anchor on the way in, so the walk starts from wherever the
                // sliders are now rather than from where they were last time.
                if (v) {
                  st.drift.anchor = { ...st.env };
                  st.drift.nextAtMs = 0;
                }
              })
            }
          />

          <label className="block">
            <FieldLabel>Condition</FieldLabel>
            <select
              value={s.env.weather}
              onChange={(e) =>
                onMutate((st) => setEnv(st, "weather", e.target.value as WeatherPreset))
              }
              className={selectClass}
            >
              {Object.entries(WEATHER).map(([id, profile]) => (
                <option key={id} value={id}>
                  {profile.label}
                </option>
              ))}
            </select>
          </label>

          <Slider
            label="Wind speed"
            value={s.env.windSpeedKn}
            min={0}
            max={50}
            step={1}
            format={(v) => `${v.toFixed(0)} kn · F${beaufort(v).force}`}
            onChange={(v) => onMutate((st) => setEnv(st, "windSpeedKn", v))}
          />
          <Bearing
            label="Wind from"
            value={s.env.windDirectionDeg}
            onChange={(v) => onMutate((st) => setEnv(st, "windDirectionDeg", v))}
          />
          <Slider
            label="Wave height"
            value={s.env.waveHeightM}
            min={0}
            max={4}
            step={0.1}
            format={(v) => `${v.toFixed(1)} m · ${douglasSea(v).label}`}
            onChange={(v) => onMutate((st) => setEnv(st, "waveHeightM", v))}
          />
          <Bearing
            label="Waves from"
            value={s.env.waveDirectionDeg}
            onChange={(v) => onMutate((st) => setEnv(st, "waveDirectionDeg", v))}
          />
          <Slider
            label="Current speed"
            value={s.env.currentSpeedKn}
            min={0}
            max={5}
            step={0.1}
            format={(v) => `${v.toFixed(1)} kn`}
            onChange={(v) => onMutate((st) => setEnv(st, "currentSpeedKn", v))}
          />
          <Bearing
            label="Current toward"
            value={s.env.currentDirectionDeg}
            onChange={(v) => onMutate((st) => setEnv(st, "currentDirectionDeg", v))}
          />
          <p className="text-[10px] leading-snug text-slate-500">
            These are the base values. The strait modulates them by position —
            both shores shelter, the channel accelerates current — so different
            tracks genuinely cost different amounts.
          </p>
        </Group>

        {/* ---------- 4. the engine ---------- */}
        <Group title="Engine condition" step={4} defaultOpen={false}>
          <Slider
            label="Exhaust temp vs healthy"
            value={s.egtExcess}
            min={1.0}
            max={1.08}
            step={0.005}
            format={(v) => `+${((v - 1) * 100).toFixed(1)}%`}
            onChange={(v) => onMutate((st) => (st.egtExcess = v))}
          />
          <p className="text-[10px] leading-snug text-slate-500">
            Exhaust running hot at the same load is the wear signature. The fuel
            penalty is predicted by the model trained on UCI CBM — and the same
            signal moves the health panel, which is the Problem 1 → Problem 2 link.
          </p>

          <label className="block">
            <FieldLabel>Inject fault</FieldLabel>
            <select
              value={s.fault.kind}
              onChange={(e) =>
                onMutate((st) => {
                  st.fault.kind = e.target.value as FaultKind;
                  if (st.fault.kind !== "none" && st.fault.sigmas < 0.5) st.fault.sigmas = 3;
                })
              }
              className={selectClass}
            >
              {FAULTS.map((fault) => (
                <option key={fault.id} value={fault.id} title={fault.hint}>
                  {fault.label}
                </option>
              ))}
            </select>
          </label>
          {s.fault.kind !== "none" && (
            <Slider
              label="Severity"
              value={s.fault.sigmas}
              min={0}
              max={8}
              step={0.5}
              format={(v) => `${v.toFixed(1)}σ`}
              onChange={(v) => onMutate((st) => (st.fault.sigmas = v))}
            />
          )}
          <p className="text-[10px] leading-snug text-slate-500">
            Opening the throttle raises coolant and exhaust together and is{" "}
            <em>not</em> an anomaly — that is the correlation the detector learned.
            Moving one stream alone is.
          </p>
        </Group>

        {/* ---------- 5. scenario ---------- */}
        <Group title="Scenario" step={5} defaultOpen={false}>
          <button
            onClick={() =>
              onMutate((st) => {
                st.obstacles = [];
                st.storms = [];
                rebuildRoute(st);
              })
            }
            className={buttonClass}
          >
            Clear hazards
          </button>
          <button
            onClick={() =>
              onMutate((st) => {
                st.running = false;
                placeVesselAtStart(st);
              })
            }
            className={buttonClass}
          >
            Reset voyage
          </button>
        </Group>
      </div>

      <footer className="shrink-0 border-t border-slate-800 px-3 py-2">
        <div className="flex items-baseline justify-between text-[10px]">
          <span className="text-slate-500">Zone</span>
          <span className="font-mono text-slate-300">{snapshot?.zone ?? "—"}</span>
        </div>
      </footer>
    </div>
  );
}

/**
 * Synthetic weather movement.
 *
 * This exists for the demo that has no network, which on a conference floor is
 * most of them: with Open-Meteo off, every condition is pinned exactly where the
 * sliders were left, and a display whose inputs never move cannot show the one
 * thing worth showing -- that the recommendation follows the sea.
 *
 * The wording is deliberate and is the whole reason this is a separate block
 * from the forecast above rather than a third checkbox inside it. It says
 * "invented", it never says live, and it cannot run at the same time as a real
 * pull. A viewer who reads only the toggle label still knows which of the two
 * they are looking at.
 */
function DriftToggle({
  enabled,
  blocked,
  onToggle,
}: {
  enabled: boolean;
  blocked: boolean;
  onToggle: (value: boolean) => void;
}) {
  return (
    <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
      <label className={`flex items-center justify-between ${blocked ? "" : "cursor-pointer"}`}>
        <span className={`text-[11px] font-medium ${blocked ? "text-slate-600" : "text-slate-300"}`}>
          Drift the conditions
        </span>
        <input
          type="checkbox"
          checked={enabled && !blocked}
          disabled={blocked}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-3.5 w-3.5 accent-orange-500 disabled:opacity-40"
        />
      </label>
      <p className="mt-1 text-[10px] leading-snug text-slate-500">
        {blocked
          ? "Unavailable while the live forecast is on — real values are not overwritten with invented ones."
          : enabled
            ? "Invented movement, not a forecast. Wind, sea and current wander around the slider positions so the advisory can be watched tracking them."
            : "Off — the sliders hold still. Turn on to make the sea move without a network."}
      </p>
    </div>
  );
}

/**
 * Where the environment numbers came from.
 *
 * The reference simulator this borrows from shows a cache badge and the
 * coordinates it asked for. This shows the coordinates that *answered*:
 * Open-Meteo snaps a request to its nearest model cell, and the offset between
 * the two is real, usually a kilometre or so, and exactly the sort of thing a
 * demo quietly hides. Showing the cell, the observation timestamp and the age
 * costs three lines and turns a claim into evidence.
 */
function ForecastSource({
  snapshot,
  enabled,
  onToggle,
  onSync,
}: {
  snapshot: Snapshot | null;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  onSync: () => void;
}) {
  const forecast = snapshot?.forecast;
  const meta = forecast?.meta ?? null;
  const ageSeconds = meta ? (forecast?.ageSeconds ?? 0) : null;
  // Open-Meteo's current conditions refresh on roughly a quarter-hour cadence,
  // so anything past fifteen minutes is genuinely old rather than merely not
  // the newest possible.
  const stale = ageSeconds != null && ageSeconds > 900;

  const partial = meta ? !(meta.atmosphere && meta.marine) : false;

  return (
    <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
      <label className="flex cursor-pointer items-center justify-between">
        <span className="text-[11px] font-medium text-slate-300">Open-Meteo Marine</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-3.5 w-3.5 accent-orange-500"
        />
      </label>

      {!enabled ? (
        <p className="mt-1 text-[10px] leading-snug text-slate-500">
          Off — the sliders below are the conditions. Nothing on screen is claiming
          to be a live forecast.
        </p>
      ) : forecast?.error ? (
        <p className="mt-1 text-[10px] leading-snug text-red-300">
          {forecast.error} — holding the last known conditions.
        </p>
      ) : meta ? (
        <div className="mt-1.5 space-y-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wider ${
                stale
                  ? "bg-amber-950/60 text-amber-300"
                  : partial
                    ? "bg-sky-950/60 text-sky-300"
                    : "bg-emerald-950/60 text-emerald-300"
              }`}
            >
              {stale ? "STALE" : partial ? "PARTIAL" : "LIVE"}
            </span>
            <span className="font-mono text-[10px] text-slate-400">
              {ageSeconds == null
                ? "—"
                : ageSeconds < 60
                  ? `${ageSeconds.toFixed(0)}s ago`
                  : `${Math.floor(ageSeconds / 60)}m ago`}
            </span>
            <button
              onClick={onSync}
              disabled={forecast?.syncing}
              className="ml-auto rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              {forecast?.syncing ? "Syncing…" : "Sync"}
            </button>
          </div>

          <Derived
            label="Grid cell"
            value={
              meta.gridLatitude != null && meta.gridLongitude != null
                ? `${meta.gridLatitude.toFixed(2)}°N ${meta.gridLongitude.toFixed(2)}°E`
                : "—"
            }
          />
          {meta.gustKn != null && (
            <Derived label="Peak gust" value={`${meta.gustKn.toFixed(0)} kn`} />
          )}
          {partial && (
            <p className="text-[10px] leading-snug text-sky-300">
              {meta.atmosphere
                ? "Wind refreshed; the marine endpoint did not answer, so sea state is unchanged."
                : "Sea state refreshed; the atmospheric endpoint did not answer, so wind is unchanged."}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-1 text-[10px] text-slate-500">Waiting for the first pull…</p>
      )}
    </div>
  );
}

const selectClass =
  "w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 " +
  "focus:border-orange-500 focus:outline-none";

const buttonClass =
  "w-full rounded border border-slate-700 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-800";

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="mb-1 block text-[11px] text-slate-400">{children}</span>;
}

/** A collapsible section. Collapsed by default for the blocks a demo does not
 *  touch every run, so the panel opens on what is actually being driven rather
 *  than on a wall of thirty controls. */
function Group({
  title,
  step,
  children,
  defaultOpen = true,
}: {
  title: string;
  step: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-slate-800/70 py-2 last:border-b-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-1 text-left"
        aria-expanded={open}
      >
        <span className="font-mono text-[10px] text-slate-600">{step}</span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
          {title}
        </span>
        <span
          className={`ml-auto text-slate-600 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          ›
        </span>
      </button>
      {open && <div className="mt-1.5 space-y-2.5">{children}</div>}
    </section>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-orange-400">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-orange-500"
      />
    </label>
  );
}

/**
 * A compass bearing, with the cardinal spelled out.
 *
 * "212°" is precise and, at a glance, unreadable; "212° SSW" is both. Wind and
 * sea direction are the two inputs on this panel most often set wrong by one
 * cardinal, and the error is invisible until the boat starts behaving oddly.
 */
function Bearing({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <Slider
      label={label}
      value={value}
      min={0}
      max={359}
      step={1}
      format={(v) => `${v.toFixed(0)}° ${cardinal(v)}`}
      onChange={onChange}
    />
  );
}

const POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

function cardinal(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

function NumberField({
  label,
  unit,
  value,
  step,
  hint,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  step: number;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block truncate text-[10px] text-slate-400" title={label}>
        {label}
        {unit && <span className="text-slate-600"> ({unit})</span>}
      </span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          // A half-typed number must not be pushed into the physics as NaN and
          // then sent to the API. Ignore until it parses.
          if (Number.isFinite(next)) onChange(next);
        }}
        className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-xs text-slate-100 focus:border-orange-500 focus:outline-none"
      />
      {hint && <span className="mt-0.5 block font-mono text-[9px] text-slate-600">{hint}</span>}
    </label>
  );
}

/** A read-only figure worked out from the fields above it. Visually distinct
 *  from an input so nobody tries to type into a result. */
function Derived({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[10px]">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-300">{value}</span>
    </div>
  );
}
