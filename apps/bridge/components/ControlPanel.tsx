"use client";

// The simulator's input surface: sensor, environment, and operator controls,
// grouped the way the technical profile groups them.
//
// This panel is for whoever is driving the demo. It is emphatically NOT the
// bridge display -- PRODUCT.md gives the captain two seconds and a single
// number, and twenty sliders is the opposite of that. See TelemetryPanel for
// the part a captain would actually see.

import type { RefObject } from "react";

import { WEATHER, type WeatherPreset } from "@/lib/environment";
import { FAULTS, type FaultKind } from "@/lib/telemetry";
import type { SimState } from "@/lib/simulation";
import { phtClock, placeVesselAtStart, rebuildRoute } from "@/lib/simulation";
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
}

export default function ControlPanel({ state, snapshot, onMutate }: Props) {
  const s = state.current;

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-900/60">
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <Group title="Throttle">
          <Slider
            label="Throttle"
            value={s.throttlePct}
            min={0}
            max={100}
            step={1}
            format={(v) => `${v.toFixed(0)}%  ·  ${((v / 100) * s.ratedRpm).toFixed(0)} rpm`}
            onChange={(v) => onMutate((st) => (st.throttlePct = v))}
          />
          <Slider
            label="Time compression"
            value={s.timeScale}
            min={1}
            max={60}
            step={1}
            format={(v) => (v <= 1 ? "real time" : `${v.toFixed(0)}x real time`)}
            onChange={(v) => onMutate((st) => (st.timeScale = v))}
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
          <p className="text-[11px] leading-snug text-slate-500">
            Drives the sun in the helm view — real solar position for Iloilo, not
            a lighting preset. 05:40 is the first crossing of the day.
          </p>
        </Group>

        <Group title="Engine condition">
          <Slider
            label="Exhaust temp vs healthy"
            value={s.egtExcess}
            min={1.0}
            max={1.08}
            step={0.005}
            format={(v) => `+${((v - 1) * 100).toFixed(1)}%`}
            onChange={(v) => onMutate((st) => (st.egtExcess = v))}
          />
          <p className="text-[11px] leading-snug text-slate-500">
            Exhaust running hot at the same load is the wear signature. The fuel
            penalty is predicted by the model trained on UCI CBM — and the same
            signal moves the health panel, which is the Problem 1 → Problem 2 link.
          </p>
        </Group>

        <Group title="Engine fault">
          <label className="block">
            <span className="mb-1 block text-[11px] text-slate-400">Inject</span>
            <select
              value={s.fault.kind}
              onChange={(e) =>
                onMutate((st) => {
                  st.fault.kind = e.target.value as FaultKind;
                  if (st.fault.kind !== "none" && st.fault.sigmas < 0.5) st.fault.sigmas = 3;
                })
              }
              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs"
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
          <p className="text-[11px] leading-snug text-slate-500">
            Opening the throttle raises coolant and exhaust together and is{" "}
            <em>not</em> an anomaly — that is the correlation the detector learned.
            Moving one stream alone is.
          </p>
        </Group>

        <Group title="Weather">
          <label className="block">
            <span className="mb-1 block text-[11px] text-slate-400">Condition</span>
            <select
              value={s.env.weather}
              onChange={(e) =>
                onMutate((st) => (st.env.weather = e.target.value as WeatherPreset))
              }
              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs"
            >
              {Object.entries(WEATHER).map(([id, profile]) => (
                <option key={id} value={id}>
                  {profile.label}
                </option>
              ))}
            </select>
          </label>

          <Toggle
            label="Live Open-Meteo forecast"
            checked={s.liveForecast}
            onChange={(v) => onMutate((st) => (st.liveForecast = v))}
          />

          <Slider
            label="Wind speed"
            value={s.env.windSpeedKn}
            min={0}
            max={50}
            step={1}
            format={(v) => `${v.toFixed(0)} kn`}
            onChange={(v) => onMutate((st) => (st.env.windSpeedKn = v))}
          />
          <Slider
            label="Wind from"
            value={s.env.windDirectionDeg}
            min={0}
            max={359}
            step={1}
            format={(v) => `${v.toFixed(0)}°`}
            onChange={(v) => onMutate((st) => (st.env.windDirectionDeg = v))}
          />
          <Slider
            label="Wave height"
            value={s.env.waveHeightM}
            min={0}
            max={4}
            step={0.1}
            format={(v) => `${v.toFixed(1)} m`}
            onChange={(v) => onMutate((st) => (st.env.waveHeightM = v))}
          />
          <Slider
            label="Waves from"
            value={s.env.waveDirectionDeg}
            min={0}
            max={359}
            step={1}
            format={(v) => `${v.toFixed(0)}°`}
            onChange={(v) => onMutate((st) => (st.env.waveDirectionDeg = v))}
          />
          <Slider
            label="Current speed"
            value={s.env.currentSpeedKn}
            min={0}
            max={5}
            step={0.1}
            format={(v) => `${v.toFixed(1)} kn`}
            onChange={(v) => onMutate((st) => (st.env.currentSpeedKn = v))}
          />
          <Slider
            label="Current toward"
            value={s.env.currentDirectionDeg}
            min={0}
            max={359}
            step={1}
            format={(v) => `${v.toFixed(0)}°`}
            onChange={(v) => onMutate((st) => (st.env.currentDirectionDeg = v))}
          />
        </Group>

        <Group title="Load">
          <Slider
            label="Passengers"
            value={s.passengers}
            min={0}
            max={120}
            step={1}
            format={(v) => `${v.toFixed(0)}`}
            onChange={(v) =>
              onMutate((st) => {
                st.passengers = v;
              })
            }
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

        <Group title="Scenario">
          <button
            onClick={() =>
              onMutate((st) => {
                st.obstacles = [];
                st.storms = [];
                rebuildRoute(st);
              })
            }
            className="w-full rounded border border-slate-700 px-2 py-1.5 text-xs hover:bg-slate-800"
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
            className="w-full rounded border border-slate-700 px-2 py-1.5 text-xs hover:bg-slate-800"
          >
            Reset voyage
          </button>
        </Group>
      </div>

      <footer className="shrink-0 border-t border-slate-800 px-4 py-2">
        <p className="text-[10px] leading-snug text-slate-500">
          Zone: <span className="text-slate-300">{snapshot?.zone ?? "—"}</span>
        </p>
      </footer>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
        {title}
      </h2>
      {children}
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
      <span className="mb-1 flex items-baseline justify-between text-[11px]">
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

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between text-[11px] text-slate-400">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-orange-500"
      />
    </label>
  );
}
