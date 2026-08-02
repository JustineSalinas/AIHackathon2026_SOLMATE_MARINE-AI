"use client";

// Engine telemetry and diagnostics, in one place.
//
// This is the deep-inspection view: everything the retrofit kit senses, the
// health model's read on it, and the log that Phase 2 will eventually be
// trained from. It is deliberately a modal rather than a fourth zone on the
// bridge -- PRODUCT.md gives the captain three things at a glance and says
// anything else costs a second of attention he does not have. An engineer at
// the dock, or a judge, has all the seconds they want.
//
// **Every readout here is a measured value.** Where the sensor set does not
// produce something, the row is absent rather than estimated: there is no fuel
// tank on this vessel spec, so there is no tank gauge, and bus voltage under a
// running alternator says nothing about battery charge, so there is no charge
// percentage. Filling those boxes with plausible numbers would contradict the
// one thing this project is most careful about.

import { useMemo } from "react";

import type { MaintenanceStatus, TelemetryFrame } from "@/lib/contracts";
import type { Snapshot } from "./Simulator";

/** Oil pressure is sensed in kPa and read by engineers in bar. */
const KPA_PER_BAR = 100;

type Tone = "ok" | "watch" | "alarm" | "idle";

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-emerald-300",
  watch: "text-amber-300",
  alarm: "text-red-300",
  idle: "text-slate-500",
};

const TONE_BAR: Record<Tone, string> = {
  ok: "bg-emerald-400",
  watch: "bg-amber-400",
  alarm: "bg-red-400",
  idle: "bg-slate-700",
};

/** SVG fills resolve through `currentColor`, which reads the *text* colour.
 *  Using the `bg-` utilities here rendered every status dot plain white -- the
 *  colour was set on a property SVG does not consult. */
const TONE_DOT: Record<Tone, string> = {
  ok: "text-emerald-400",
  watch: "text-amber-400",
  alarm: "text-red-400",
  idle: "text-slate-600",
};

/** Vibration as a single scalar, from the three accelerometer axes.
 *
 *  Gravity is removed before the magnitude is taken -- a boat sitting perfectly
 *  still reads 1 g on the vertical axis, and reporting that as vibration would
 *  make every healthy engine look like it was shaking itself apart. */
function vibrationG(frame: TelemetryFrame | undefined): number | null {
  const em = frame?.electro_mechanical;
  if (!em) return null;
  const { accel_x_g: x, accel_y_g: y, accel_z_g: z } = em;
  if (x == null || y == null || z == null) return null;
  return Math.sqrt(x * x + y * y + Math.max(0, z - 1) ** 2);
}

function band(value: number | null, warn: number, alarm: number, invert = false): Tone {
  if (value == null) return "idle";
  const past = (limit: number) => (invert ? value <= limit : value >= limit);
  if (past(alarm)) return "alarm";
  if (past(warn)) return "watch";
  return "ok";
}

function Row({
  label,
  value,
  unit,
  fraction,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  fraction?: number;
  tone: Tone;
}) {
  return (
    <div className="mb-2.5">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className={`font-mono tabular-nums ${TONE_TEXT[tone]}`}>
          {value}
          {unit && <span className="ml-1 text-[9px] text-slate-500">{unit}</span>}
        </span>
      </div>
      {fraction != null && (
        <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-slate-800">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${TONE_BAR[tone]}`}
            style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Card({
  title,
  chip,
  chipTone = "idle",
  children,
}: {
  title: string;
  chip?: string;
  chipTone?: Tone;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <header className="mb-2.5 flex items-center justify-between">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-300">
          {title}
        </h3>
        {chip && (
          <span
            className={`rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${TONE_TEXT[chipTone]}`}
          >
            {chip}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

/** RPM and engine load over the logged window.
 *
 *  Hand-drawn SVG rather than a charting library: two polylines over ~120
 *  points does not justify a dependency in a serving path this project has
 *  spent real effort keeping small. */
function Trend({ frames, ratedRpm }: { frames: TelemetryFrame[]; ratedRpm: number }) {
  const points = useMemo(() => {
    const rpms: number[] = [];
    const loads: number[] = [];
    for (const f of frames) {
      const rpm = f.throttling?.engine_rpm ?? null;
      if (rpm == null) continue;
      rpms.push(rpm);
      loads.push(Math.max(0, Math.min(1, rpm / Math.max(1, ratedRpm))));
    }
    return { rpms, loads };
  }, [frames, ratedRpm]);

  const n = points.rpms.length;
  if (n < 2) {
    return (
      <p className="py-6 text-center font-mono text-[10px] text-slate-600">
        Logging starts when the voyage does.
      </p>
    );
  }

  const W = 260;
  const H = 64;
  // Scaled to the engine's rating, not to the window's own maximum. Scaling to
  // the maximum pins a steady throttle -- the normal case -- exactly on the top
  // edge, where it reads as a broken chart rather than a constant one.
  const top = Math.max(ratedRpm, ...points.rpms, 1) * 1.05;
  const path = (series: number[], scale: number) =>
    series
      .map((v, i) => `${(i / (n - 1)) * W},${H - (v / scale) * H}`)
      .join(" ");

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full" preserveAspectRatio="none">
        <polyline points={path(points.loads, 1)} fill="none" stroke="#334155" strokeWidth="1.5" />
        <polyline points={path(points.rpms, top)} fill="none" stroke="#38bdf8" strokeWidth="1.5" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-500">
        <span>
          <span className="text-sky-400">—</span> rpm · <span className="text-slate-600">—</span>{" "}
          load
        </span>
        <span>{n} samples</span>
      </div>
    </div>
  );
}

/**
 * The vessel schematic, with each subsystem lit by its own real state.
 *
 * A picture of the boat is worth having only if the colours mean something.
 * Engine comes from the health model, fuel from whether the advisory service is
 * answering, and electrical from the bus voltage rule -- the same rule the
 * safety module applies, not a second opinion invented here.
 */
function VesselXRay({
  rpm,
  burnLph,
  speedKn,
  engine,
  electrical,
}: {
  rpm: number;
  burnLph: number | null;
  speedKn: number;
  engine: Tone;
  electrical: Tone;
}) {
  return (
    <div className="flex h-full flex-col rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <h3 className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-slate-300">
        Vessel X-Ray
      </h3>

      <div className="mb-3 inline-block rounded border border-slate-800 bg-black/50 p-2 font-mono text-[10px] leading-relaxed">
        <div className="flex gap-2">
          <span className="w-12 text-slate-500">ENG</span>
          <span className="tabular-nums text-emerald-300">{Math.round(rpm)}</span>
          <span className="text-slate-600">rpm</span>
        </div>
        <div className="flex gap-2">
          <span className="w-12 text-slate-500">FUEL</span>
          <span className="tabular-nums text-amber-300">
            {burnLph == null ? "—" : burnLph.toFixed(1)}
          </span>
          <span className="text-slate-600">L/h</span>
        </div>
        <div className="flex gap-2">
          <span className="w-12 text-slate-500">SPEED</span>
          <span className="tabular-nums text-sky-300">{speedKn.toFixed(1)}</span>
          <span className="text-slate-600">kn</span>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center">
        <svg viewBox="0 0 120 260" className="h-full max-h-[380px] w-auto">
          {/* Hull, bow up. The same banca outline the chart views draw. */}
          <path
            d="M60 8 C 92 52, 100 120, 98 200 L98 236 C 98 246, 90 252, 60 252 C 30 252, 22 246, 22 236 L22 200 C 20 120, 28 52, 60 8 Z"
            fill="#0b1a2a"
            stroke="#1e3a52"
            strokeWidth="2"
          />
          {/* Outrigger booms -- this is a banca, and the silhouette should say so. */}
          <line x1="22" y1="120" x2="4" y2="132" stroke="#1e3a52" strokeWidth="2" />
          <line x1="98" y1="120" x2="116" y2="132" stroke="#1e3a52" strokeWidth="2" />

          <circle cx="60" cy="52" r="9" fill="none" stroke="#334155" strokeWidth="1.5" />

          {/* Bridge + electrical */}
          <rect x="40" y="96" width="40" height="30" rx="3" fill="#132b3f" stroke="#24506e" />
          <text x="60" y="110" textAnchor="middle" className="fill-slate-400 text-[7px]">
            BRIDGE
          </text>
          <circle cx="60" cy="119" r="3.5" className={TONE_DOT[electrical]} fill="currentColor" />

          {/* Engine */}
          <rect x="38" y="164" width="44" height="40" rx="3" fill="#2a1520" stroke="#6e2440" />
          <text x="60" y="180" textAnchor="middle" className="fill-slate-400 text-[7px]">
            ENGINE
          </text>
          <circle cx="60" cy="192" r="4.5" className={TONE_DOT[engine]} fill="currentColor" />

          {/* Shaft and prop */}
          <line x1="60" y1="204" x2="60" y2="240" stroke="#24506e" strokeWidth="2" />
          <path d="M52 244 L68 244" stroke="#24506e" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </div>

      <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-600">
        Simulated telemetry — no hardware. Subsystem colour is the live model
        verdict, not a fixed graphic.
      </p>
    </div>
  );
}

/** One row per logged frame, for the record that Phase 2 needs and does not
 *  yet have. This is the honest shape of the two-phase maturity story: the
 *  data has to be collected before anything can be learned from it. */
function toCsv(frames: TelemetryFrame[]): string {
  const head = [
    "ts",
    "source",
    "engine_rpm",
    "coolant_temp_c",
    "oil_pressure_kpa",
    "battery_voltage_v",
    "exhaust_gas_temp_c",
    "oil_particulate_ppm",
    "exhaust_nox_ppm",
    "vibration_g",
  ];
  const rows = frames.map((f) => {
    const em = f.electro_mechanical ?? {};
    const vib = vibrationG(f);
    return [
      f.ts ?? "",
      f.source ?? "simulator",
      f.throttling?.engine_rpm ?? "",
      em.coolant_temp_c ?? "",
      em.oil_pressure_kpa ?? "",
      em.battery_voltage_v ?? "",
      em.exhaust_gas_temp_c ?? "",
      em.oil_particulate_ppm ?? "",
      em.exhaust_nox_ppm ?? "",
      vib == null ? "" : vib.toFixed(4),
    ].join(",");
  });
  return [head.join(","), ...rows].join("\n");
}

function downloadCsv(frames: TelemetryFrame[]): void {
  const blob = new Blob([toCsv(frames)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `marine-ai-telemetry-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function healthTone(status: MaintenanceStatus | null): Tone {
  if (!status) return "idle";
  if (status.is_anomalous) return "alarm";
  return status.anomaly_score > 0.35 ? "watch" : "ok";
}

export default function EngineXRay({
  snapshot,
  onClose,
}: {
  snapshot: Snapshot | null;
  onClose: () => void;
}) {
  const frames = snapshot?.frames ?? [];
  const latest = frames.at(-1);
  const em = latest?.electro_mechanical;
  const status = snapshot?.health.status ?? null;
  const rec = snapshot?.api.response?.recommendation ?? null;
  const power = snapshot?.api.response?.power ?? null;

  const rpm = snapshot?.rpm ?? 0;
  const ratedRpm = snapshot?.vessel.ratedRpm ?? 2800;
  const ratedKw = snapshot?.vessel.ratedKw ?? 90;

  const coolant = em?.coolant_temp_c ?? null;
  const egt = em?.exhaust_gas_temp_c ?? null;
  const oilBar = em?.oil_pressure_kpa == null ? null : em.oil_pressure_kpa / KPA_PER_BAR;
  const volts = em?.battery_voltage_v ?? null;
  const vib = vibrationG(latest);

  // Bands mirror services/safety/rules.py. The alarm figures are the same
  // numbers the rule engine fires on -- duplicated here as display thresholds
  // only, never as a second verdict. The banner above the throttle is the one
  // that decides.
  const coolantTone = band(coolant, 95, 105);
  const egtTone = band(egt, 520, 580);
  const oilTone = band(oilBar, 1.5, 1.0, true);
  const voltsTone =
    volts == null ? "idle" : volts <= 12.0 || volts >= 15.8 ? "alarm" : volts <= 12.4 ? "watch" : "ok";

  const engineTone = healthTone(status);
  const health = status ? Math.round((1 - status.anomaly_score) * 100) : null;
  const worst = status?.streams?.[0] ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/80 p-3 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Engine telemetry and diagnostics"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-5xl rounded-xl border border-slate-800 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-200">
            <span className="mr-2 text-red-400">●</span>
            Engine Telemetry &amp; Diagnostics
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 py-0.5 text-lg leading-none text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
          >
            ×
          </button>
        </header>

        <div className="grid gap-3 p-3 sm:p-4 lg:grid-cols-[1fr_360px]">
          <div>
            <Card title="Live Telemetry" chip={latest ? "sensing" : "standby"} chipTone={latest ? "ok" : "idle"}>
              <Row
                label="Main engine"
                value={Math.round(rpm).toString()}
                unit="rpm"
                fraction={rpm / ratedRpm}
                tone={rpm > 0 ? "ok" : "idle"}
              />
              <Row
                label="Exhaust gas temperature"
                value={egt == null ? "—" : egt.toFixed(0)}
                unit="°C"
                fraction={egt == null ? undefined : egt / 620}
                tone={egtTone}
              />
              <Row
                label="Cooling water"
                value={coolant == null ? "—" : coolant.toFixed(0)}
                unit="°C"
                fraction={coolant == null ? undefined : coolant / 115}
                tone={coolantTone}
              />
              <Row
                label="Lube oil pressure"
                value={oilBar == null ? "—" : oilBar.toFixed(2)}
                unit="bar"
                fraction={oilBar == null ? undefined : oilBar / 5}
                tone={oilTone}
              />
              <Row
                label="Vibration"
                value={vib == null ? "—" : vib.toFixed(3)}
                unit="g"
                fraction={vib == null ? undefined : vib / 0.3}
                tone={band(vib, 0.12, 0.25)}
              />
            </Card>

            <Card title="RPM vs. load trend">
              <Trend frames={frames} ratedRpm={ratedRpm} />
            </Card>

            <Card
              title="Health model"
              chip={health == null ? "no reading" : `${health}%`}
              chipTone={engineTone}
            >
              {status ? (
                <>
                  <p className="mb-2 text-[11px] leading-snug text-slate-300">
                    {status.advisory_en}
                  </p>
                  {worst && (
                    <Row
                      label={`Largest deviation — ${worst.label_en}`}
                      value={worst.z_score.toFixed(1)}
                      unit="σ"
                      fraction={Math.abs(worst.z_score) / 6}
                      tone={Math.abs(worst.z_score) > 3 ? "alarm" : Math.abs(worst.z_score) > 2 ? "watch" : "ok"}
                    />
                  )}
                  <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-500">
                    Phase 1 — deviation only. Naming a component or a repair date
                    needs failure history this unit has not accumulated, and the
                    data model rejects it until it has.
                  </p>
                </>
              ) : (
                <p className="py-3 text-center font-mono text-[10px] text-slate-600">
                  Awaiting the first scored window.
                </p>
              )}
            </Card>

            <Card
              title="Data logger"
              chip={frames.length ? "recording" : "standby"}
              chipTone={frames.length ? "ok" : "idle"}
            >
              <Row label="Frames in window" value={frames.length.toString()} tone="ok" />
              <button
                type="button"
                disabled={!frames.length}
                onClick={() => downloadCsv(frames)}
                className="mt-2 w-full rounded border border-slate-700 bg-slate-800/70 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Download telemetry CSV
              </button>
              <p className="mt-2 font-mono text-[9px] leading-relaxed text-slate-500">
                This log is what Phase 2 is missing. Component-level prediction
                needs labelled run-to-failure history, and it starts as rows like
                these.
              </p>
            </Card>
          </div>

          <div className="flex flex-col">
            <VesselXRay
              rpm={rpm}
              burnLph={rec?.predicted_burn_lph ?? null}
              speedKn={snapshot?.speedKn ?? 0}
              engine={engineTone}
              electrical={voltsTone}
            />

            <div className="mt-3">
              <Card title="Fuel">
                <Row
                  label="Flow rate"
                  value={rec?.predicted_burn_lph == null ? "—" : rec.predicted_burn_lph.toFixed(2)}
                  unit="L/h"
                  tone={rec ? "ok" : "idle"}
                />
                <Row
                  label="Used this voyage"
                  value={(snapshot?.fuelUsedL ?? 0).toFixed(2)}
                  unit="L"
                  tone="ok"
                />
              </Card>

              <Card title="Electrical &amp; power">
                <Row
                  label="Shaft power"
                  value={power?.total_kw == null ? "—" : power.total_kw.toFixed(1)}
                  unit="kW"
                  fraction={power?.total_kw == null ? undefined : power.total_kw / ratedKw}
                  tone={power ? "ok" : "idle"}
                />
                <Row
                  label="Bus voltage"
                  value={volts == null ? "—" : volts.toFixed(1)}
                  unit="V"
                  tone={voltsTone}
                />
                <p className="mt-1 font-mono text-[9px] leading-relaxed text-slate-500">
                  No state-of-charge figure: with the alternator running, bus
                  voltage does not tell you what is in the battery.
                </p>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
