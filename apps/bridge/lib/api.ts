// Client for the Marine-AI advisory API.
//
// This file is the only place the display learns anything about fuel, power, or
// achievable speed. Nothing in the browser computes physics.
//
// That rule is deliberate and worth stating where someone will read it. There is
// one fuel model in this system, it lives in services/speed/, it is trained
// against held-out engine wear states and covered by tests. A JavaScript
// reimplementation -- however faithful on the day it is written -- becomes a
// second model the moment either side is edited, and the version on stage would
// silently diverge from the version the tests defend.
//
// The cost of the rule is latency, and it is paid for by `curve`: the API
// returns the whole speed/burn relationship for the current conditions, so the
// 60fps loop interpolates real model output locally instead of guessing.

import type {
  AdviseRequest,
  AdviseResponse,
  CurvePoint,
  MaintenanceRequest,
  MaintenanceStatus,
  RouteRequest,
  RouteResponse,
  SafetyRequest,
  SafetyState,
  VoyageRecord,
} from "./contracts";

export type { AdviseRequest, AdviseResponse, CurvePoint };

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiUnavailable extends Error {}

/** POST a request body to the advisory API, or fail as `ApiUnavailable`.
 *
 *  Every module's failure is the same failure from the display's point of view:
 *  the panel ages its last known value rather than blanking or inventing one.
 *  Sharing the transport keeps that guarantee identical across all three. */
async function post<Req, Res>(path: string, body: Req, signal?: AbortSignal): Promise<Res> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw new ApiUnavailable(`advisory service unreachable (${path})`, { cause });
  }
  if (!response.ok) {
    throw new ApiUnavailable(`advisory service returned ${response.status} for ${path}`);
  }
  return (await response.json()) as Res;
}

export function advise(body: AdviseRequest, signal?: AbortSignal): Promise<AdviseResponse> {
  return post<AdviseRequest, AdviseResponse>("/advise", body, signal);
}

/** Plan a route. Unlike `/advise` this is not a per-second call: a route is
 *  planned at the dock and re-planned when the voyage changes, which is also why
 *  the contract marks route as not computed at the edge. */
export function planRoute(body: RouteRequest, signal?: AbortSignal): Promise<RouteResponse> {
  return post<RouteRequest, RouteResponse>("/route", body, signal);
}

/** Score a window of engine telemetry for anomalies. */
export function checkHealth(
  body: MaintenanceRequest,
  signal?: AbortSignal,
): Promise<MaintenanceStatus> {
  return post<MaintenanceRequest, MaintenanceStatus>("/maintenance", body, signal);
}

/** Run the rule-based safety cutoffs against one frame.
 *
 *  Called every second, on the newest frame rather than a window: a cutoff has
 *  to fire on the reading in front of it. This is the one call in the client
 *  that consults no model at all. */
export function checkSafety(body: SafetyRequest, signal?: AbortSignal): Promise<SafetyState> {
  return post<SafetyRequest, SafetyState>("/safety", body, signal);
}

/** Store a completed crossing.
 *
 *  The write side of Problem 3: the monthly emissions report is an aggregate
 *  over these, so a voyage that finishes without being recorded is a voyage that
 *  never happened as far as the operator's evidence is concerned. Re-posting the
 *  same `voyage_id` replaces rather than duplicates, so a retry after a dropped
 *  connection cannot inflate a fuel total. */
export function recordVoyage(body: VoyageRecord, signal?: AbortSignal): Promise<VoyageRecord> {
  return post<VoyageRecord, VoyageRecord>("/voyages", body, signal);
}

/** URL of the monthly CSV export, for a plain download link.
 *
 *  Deliberately a URL rather than a fetch: the browser's own download handling
 *  gives the operator a file in their downloads folder, which is what
 *  "exportable evidence" has to mean for someone emailing it to an LGU. */
export function emissionsCsvUrl(vesselId: string, year: number, month: number): string {
  const params = new URLSearchParams({
    vessel_id: vesselId,
    year: String(year),
    month: String(month),
  });
  return `${BASE_URL}/emissions/report.csv?${params}`;
}

/**
 * Speed the vessel makes at a given RPM, read off the model's own curve.
 *
 * Between API calls the throttle still has to feel live, so the curve is
 * interpolated rather than re-derived. Both RPM and speed increase monotonically
 * along it, which makes a linear search safe and a binary search unnecessary at
 * this size.
 *
 * Returns null when there is no curve yet -- the caller must then show the
 * vessel as stationary rather than inventing a speed, which is precisely the
 * failure this whole rewrite exists to remove.
 */
export function speedForRpm(curve: CurvePoint[] | null, rpm: number): number | null {
  if (!curve || curve.length === 0) return null;
  if (rpm <= curve[0].rpm) return curve[0].speed_kn * (rpm / Math.max(1, curve[0].rpm));

  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (rpm <= b.rpm) {
      const span = b.rpm - a.rpm;
      const t = span <= 0 ? 0 : (rpm - a.rpm) / span;
      return a.speed_kn + (b.speed_kn - a.speed_kn) * t;
    }
  }
  return curve[curve.length - 1].speed_kn;
}

/** Burn at a given RPM, interpolated from the same curve. */
export function burnForRpm(curve: CurvePoint[] | null, rpm: number): number | null {
  if (!curve || curve.length === 0) return null;
  if (rpm <= curve[0].rpm) return curve[0].litres_per_hour;

  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (rpm <= b.rpm) {
      const span = b.rpm - a.rpm;
      const t = span <= 0 ? 0 : (rpm - a.rpm) / span;
      return a.litres_per_hour + (b.litres_per_hour - a.litres_per_hour) * t;
    }
  }
  return curve[curve.length - 1].litres_per_hour;
}

/** Throttle percent -> RPM. The captain's control is a lever, not a tachometer. */
export function rpmForThrottle(throttlePct: number, ratedRpm: number): number {
  return (Math.max(0, Math.min(100, throttlePct)) / 100) * ratedRpm;
}
