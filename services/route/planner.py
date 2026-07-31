"""The route optimizer: two points and a schedule in, the cheapest lawful track out.

This is the Route Optimization product, and its one non-negotiable design rule is
in the contract's own docstring: the litres a route is scored on come from the
*same* fuel model that drives Speed Optimization. There is no second cost model
here. A candidate track is broken into short legs; each leg's conditions are read
from the forecast; each leg is costed by handing that sea state, that heading and
that distance to `services/speed/optimizer.optimise_throttle`, exactly as the
throttle advisor does. The route's burn is the sum. `test_route.py` asserts a
one-leg route agrees with the throttle optimizer to the litre, because if those
two ever diverge the product is quietly running two different fuel models and the
shared-cost-basis claim in the deck is false.

The optimisation itself is a brute-force sweep over a handful of candidate
tracks, for the same reason `optimise_throttle` sweeps speeds rather than solving:
the search is small, the cost function is milliseconds, and a sweep cannot land in
a local minimum or fail to converge on stage. The candidates are the direct
great-circle route and a fan of laterally-offset alternatives that bow around the
weather and current band. The winner is the cheapest one that clears the seabed
and the sea state.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from packages.contracts.route import RouteRecommendation, Waypoint
from services.route.bathymetry import AnalyticBathymetry, Bathymetry
from services.route.forecast import AnalyticFieldForecast, SeaForecast
from services.route.geo import (
    LatLon,
    densify,
    destination,
    haversine_nm,
    initial_bearing_deg,
    midpoint,
    path_length_nm,
)
from services.speed.fuel import EngineSpec, FuelMap
from services.speed.optimizer import optimise_throttle
from services.speed.resistance import SeaState, VesselHull

DEFAULT_OFFSETS_NM = (0.0, 2.0, -2.0, 4.0, -4.0, 6.0, -6.0)
"""Perpendicular offsets of the mid-route control point, in nautical miles.
Zero is the direct great-circle track. The sweep is deliberately coarse and
symmetric -- enough to find the cheap side of a weather band without pretending
to a resolution the forecast does not have."""

DEPTH_SAFETY_MARGIN_M = 1.0
"""Water a vessel needs under its keel beyond its own draft. A metre is a working
minimum for calm coastal water; it exists so the planner rejects a track before
the depth sounder does."""

MAX_WAVE_HEIGHT_M = 2.5
"""Significant wave height above which a leg is refused. Not a survival limit --
these are passenger boats, and the constraint is comfort and schedule integrity,
not the edge of seaworthiness."""

MAX_LEG_NM = 2.0
"""Densification target. Short enough that one heading and one sea state per leg
is a fair approximation; see `geo.densify`."""


@dataclass(frozen=True)
class LegCost:
    """One densified leg, fully costed through the shared fuel model."""

    start: LatLon
    end: LatLon
    distance_nm: float
    heading_deg: float
    sea: SeaState
    rpm: float
    speed_kn: float
    litres: float
    confidence: float
    min_depth_m: float
    planned_minutes: float
    #: Minutes this leg actually takes at `speed_kn`. Equal to `planned_minutes`
    #: when the schedule is holdable and larger when it is not -- which is the
    #: whole difference the display needs, and which used to be computed here and
    #: dropped on the floor. `inf` where the hull makes no way at all.
    achievable_minutes: float


@dataclass(frozen=True)
class CostedRoute:
    """A candidate track after evaluation. Richer than the wire contract on
    purpose: the flattener below takes what the display needs and the rest is
    kept for the simulator and the tests."""

    control_points: list[LatLon]
    legs: list[LegCost]
    total_distance_nm: float
    total_burn_l: float
    total_minutes: float
    #: Sum of the legs' achievable minutes. `inf` if any leg makes no way.
    total_achievable_minutes: float
    min_depth_m: float
    max_wave_m: float
    depth_feasible: bool
    weather_feasible: bool
    schedule_feasible: bool
    confidence: float


def _candidate_tracks(
    origin: LatLon, dest: LatLon, offsets_nm: tuple[float, ...]
) -> list[list[LatLon]]:
    """The direct track and its laterally-offset alternatives.

    Each non-zero offset steps the great-circle midpoint out at a right angle to
    the direct track and routes through that displaced point, bowing the whole
    path to one side of the rhumb the captain would otherwise steer.
    """
    direct_bearing = initial_bearing_deg(origin, dest)
    mid = midpoint(origin, dest)
    tracks: list[list[LatLon]] = []
    for offset in offsets_nm:
        if offset == 0.0:
            tracks.append([origin, dest])
        else:
            side = (direct_bearing + 90.0) % 360.0
            shifted = destination(mid, side, offset)
            tracks.append([origin, shifted, dest])
    return tracks


def _cost_track(
    control_points: list[LatLon],
    *,
    hull: VesselHull,
    spec: EngineSpec,
    fuel_map: FuelMap,
    forecast: SeaForecast,
    bathymetry: Bathymetry,
    depart: datetime,
    minutes_available: float | None,
    added_load_kg: float,
    egt_excess_ratio: float | None,
) -> CostedRoute:
    """Break a track into legs and cost every one through the shared fuel model."""
    vertices = densify(control_points, max_leg_nm=MAX_LEG_NM)
    total_distance = path_length_nm(vertices)

    # A single required speed-over-ground meets the schedule across the whole
    # track; the per-leg optimiser then finds the cheapest throttle that holds it
    # in each leg's own conditions. Sharing one SOG is what a captain actually
    # does -- set a cruise and let the water vary the throttle.
    required_sog = None
    if minutes_available is not None and minutes_available > 0:
        required_sog = total_distance / (minutes_available / 60.0)

    keel_clearance = hull.draft_m + DEPTH_SAFETY_MARGIN_M
    legs: list[LegCost] = []
    cumulative_minutes = 0.0
    schedule_feasible = True

    for a, b in zip(vertices, vertices[1:], strict=False):
        leg_nm = haversine_nm(a, b)
        if leg_nm <= 0:
            continue
        heading = initial_bearing_deg(a, b)
        mid = midpoint(a, b)

        # Query the forecast at the time the vessel is *planned* to reach the leg,
        # not the time it actually would at leg speed. Planning against the
        # schedule keeps the forecast query stable and the multi-horizon nature of
        # the forecast real: later legs are read further into the future.
        eta = depart + timedelta(minutes=cumulative_minutes)
        sea = forecast.at(mid, eta)

        leg_minutes = (leg_nm / required_sog * 60.0) if required_sog else None
        advice = optimise_throttle(
            hull,
            spec,
            fuel_map,
            sea,
            heading,
            distance_remaining_nm=leg_nm,
            minutes_available=leg_minutes,
            added_load_kg=added_load_kg,
            egt_excess_ratio=egt_excess_ratio,
        )
        opt = advice.recommended
        litres = opt.litres_for_distance(leg_nm)
        speed = opt.speed_kn
        if not advice.feasible:
            schedule_feasible = False

        depth = min(bathymetry.depth_m(a), bathymetry.depth_m(b), bathymetry.depth_m(mid))
        actual_minutes = 60.0 * leg_nm / speed if speed > 0 else float("inf")
        cumulative_minutes += leg_minutes if leg_minutes is not None else actual_minutes

        legs.append(
            LegCost(
                start=a,
                end=b,
                distance_nm=leg_nm,
                heading_deg=heading,
                sea=sea,
                rpm=opt.rpm,
                speed_kn=speed,
                litres=litres,
                confidence=opt.burn.confidence,
                min_depth_m=depth,
                achievable_minutes=actual_minutes,
                planned_minutes=leg_minutes if leg_minutes is not None else actual_minutes,
            )
        )

    total_burn = sum(leg.litres for leg in legs)
    total_minutes = sum(leg.planned_minutes for leg in legs)
    total_achievable = sum(leg.achievable_minutes for leg in legs)
    min_depth = min((leg.min_depth_m for leg in legs), default=keel_clearance)
    max_wave = max((leg.sea.wave_height_m for leg in legs), default=0.0)
    confidence = (
        sum(leg.confidence for leg in legs) / len(legs) if legs else 0.0
    )

    return CostedRoute(
        control_points=control_points,
        legs=legs,
        total_distance_nm=total_distance,
        total_burn_l=total_burn,
        total_minutes=total_minutes,
        total_achievable_minutes=total_achievable,
        min_depth_m=min_depth,
        max_wave_m=max_wave,
        depth_feasible=min_depth >= keel_clearance,
        weather_feasible=max_wave <= MAX_WAVE_HEIGHT_M,
        schedule_feasible=schedule_feasible,
        confidence=confidence,
    )


@dataclass(frozen=True)
class RoutePlan:
    """The optimizer's full answer before it is flattened to the contract."""

    chosen: CostedRoute
    baseline: CostedRoute
    depth_constrained: bool
    weather_constrained: bool
    notes: tuple[str, ...]
    forecast_source: str

    @property
    def savings_l(self) -> float:
        return self.baseline.total_burn_l - self.chosen.total_burn_l


def plan_route(
    origin: LatLon,
    dest: LatLon,
    *,
    hull: VesselHull,
    spec: EngineSpec,
    fuel_map: FuelMap,
    forecast: SeaForecast | None = None,
    bathymetry: Bathymetry | None = None,
    depart: datetime | None = None,
    minutes_available: float | None = None,
    added_load_kg: float = 0.0,
    egt_excess_ratio: float | None = None,
    offsets_nm: tuple[float, ...] = DEFAULT_OFFSETS_NM,
) -> RoutePlan:
    """Cheapest depth- and weather-feasible track from `origin` to `dest`.

    The baseline is always the direct great-circle route -- what the captain
    steers without the system -- costed through the identical fuel model, so
    `savings_l` is a like-for-like difference and not an artefact of comparing two
    different cost models. A negative saving (the direct route was already best)
    is returned honestly, matching the contract.
    """
    forecast = forecast or AnalyticFieldForecast()
    bathymetry = bathymetry or AnalyticBathymetry()
    depart = depart or datetime.now(UTC)

    def cost(points: list[LatLon]) -> CostedRoute:
        return _cost_track(
            points,
            hull=hull,
            spec=spec,
            fuel_map=fuel_map,
            forecast=forecast,
            bathymetry=bathymetry,
            depart=depart,
            minutes_available=minutes_available,
            added_load_kg=added_load_kg,
            egt_excess_ratio=egt_excess_ratio,
        )

    tracks = _candidate_tracks(origin, dest, offsets_nm)
    costed = [cost(t) for t in tracks]
    baseline = costed[0]  # offset 0.0 is the direct track, by construction

    feasible = [c for c in costed if c.depth_feasible and c.weather_feasible]
    notes: list[str] = []

    if feasible:
        chosen = min(feasible, key=lambda c: c.total_burn_l)
    else:
        # Nothing clears both constraints. Rather than return no route, fall back
        # to the least-bad track and say plainly what it violates -- an advisory
        # system that goes silent in bad conditions is worse than one that warns.
        chosen = min(costed, key=lambda c: c.total_burn_l)
        notes.append("no candidate cleared both depth and weather; showing the least-bad track")

    # A constraint "bit" if some rejected candidate was cheaper or shorter than
    # the track we ended up choosing -- i.e. the constraint actually cost us fuel.
    rejected_on_depth = [c for c in costed if not c.depth_feasible]
    rejected_on_weather = [c for c in costed if not c.weather_feasible]
    depth_constrained = any(
        c.total_burn_l < chosen.total_burn_l for c in rejected_on_depth
    )
    weather_constrained = any(
        c.total_burn_l < chosen.total_burn_l for c in rejected_on_weather
    )
    if depth_constrained:
        notes.append("a shorter track was rejected on charted depth")
    if weather_constrained:
        notes.append("a cheaper track was rejected on forecast wave height")
    if not chosen.schedule_feasible:
        notes.append("the engine cannot hold the required speed in these conditions; arrival late")

    return RoutePlan(
        chosen=chosen,
        baseline=baseline,
        depth_constrained=depth_constrained,
        weather_constrained=weather_constrained,
        notes=tuple(notes),
        forecast_source=getattr(forecast, "source", "unknown"),
    )


# --- Flattening the plan into the wire contract -----------------------------


def _waypoints_from(route: CostedRoute, depart: datetime) -> list[Waypoint]:
    """One `Waypoint` per control point, with the leg into it summarised.

    The densified legs are the planner's working resolution; the captain's display
    wants the corners. Each control point after the first carries the distance,
    ETA, mean throttle, forecast and shallowest depth of the run that reaches it.
    """
    control = route.control_points
    # Map each control point to the index in the leg list where it falls, by
    # matching the densified vertices back to the control corners.
    waypoints: list[Waypoint] = []
    leg_idx = 0
    cumulative_min = 0.0
    n_legs = len(route.legs)

    for ci, point in enumerate(control):
        if ci == 0:
            waypoints.append(
                Waypoint(latitude=point.lat, longitude=point.lon, eta=depart)
            )
            continue

        # Consume densified legs until their running endpoint reaches this corner.
        seg_dist = 0.0
        seg_minutes = 0.0
        rpms: list[float] = []
        min_depth = float("inf")
        last_sea: SeaState | None = None
        target = haversine_nm(control[ci - 1], point)
        while leg_idx < n_legs and seg_dist < target - 1e-6:
            leg = route.legs[leg_idx]
            seg_dist += leg.distance_nm
            seg_minutes += leg.planned_minutes
            rpms.append(leg.rpm)
            min_depth = min(min_depth, leg.min_depth_m)
            last_sea = leg.sea
            leg_idx += 1

        cumulative_min += seg_minutes
        waypoints.append(
            Waypoint(
                latitude=point.lat,
                longitude=point.lon,
                eta=depart + timedelta(minutes=cumulative_min),
                leg_distance_nm=seg_dist,
                recommended_rpm=(sum(rpms) / len(rpms)) if rpms else None,
                forecast_wind_kn=last_sea.wind_speed_kn if last_sea else None,
                forecast_wave_height_m=last_sea.wave_height_m if last_sea else None,
                forecast_current_kn=last_sea.current_speed_kn if last_sea else None,
                min_depth_m=None if min_depth == float("inf") else min_depth,
            )
        )
    return waypoints


def route_advisory_sentences(plan: RoutePlan) -> tuple[str, str]:
    """(English, Filipino) plain-language route advisory. Never imperative.

    Follows the same rule as the throttle advisory in PRODUCT.md: state the
    delta, never give an order. "The offshore track saves 18 L" -- the captain
    decides.
    """
    saved = plan.savings_l
    detour = plan.chosen.total_distance_nm - plan.baseline.total_distance_nm

    if abs(saved) < 0.5:
        return (
            "The direct track is already the cheapest route in this weather.",
            "Ang tuwirang ruta na ang pinakamatipid sa panahong ito.",
        )
    if saved < 0:
        return (
            f"The direct track is {abs(saved):.0f} L cheaper here; no detour pays.",
            f"Mas mura ng {abs(saved):.0f} L ang tuwirang ruta; walang detour na sulit.",
        )
    extra = f" for {detour:.1f} nm further" if detour > 0.1 else ""
    return (
        f"The planned track saves {saved:.0f} L{extra}, holding the same arrival.",
        f"Ang planadong ruta ay nakakatipid ng {saved:.0f} L{extra}, sa parehong dating.",
    )


def _route_confidence(plan: RoutePlan) -> float:
    """0-1. The leg fuel confidences, discounted when the forecast is the
    analytic field rather than a trained, data-backed model."""
    base = plan.chosen.confidence
    if plan.forecast_source == "analytic_field":
        base *= 0.75
    return round(max(0.0, min(1.0, base)), 3)


def as_route_recommendation(
    plan: RoutePlan,
    *,
    vessel_id: str,
    voyage_id: str | None = None,
    depart: datetime | None = None,
    generated_at: datetime | None = None,
) -> RouteRecommendation:
    """Flatten a `RoutePlan` into the wire contract the display consumes."""
    depart = depart or datetime.now(UTC)
    waypoints = _waypoints_from(plan.chosen, depart)
    eta = waypoints[-1].eta or depart
    en, fil = route_advisory_sentences(plan)

    # `inf` is not representable in JSON, and a leg that admits no forward speed
    # has no crossing time rather than a very large one. Say None and let the
    # display say so in words.
    achievable = plan.chosen.total_achievable_minutes
    achievable_minutes = achievable if math.isfinite(achievable) else None

    return RouteRecommendation(
        vessel_id=vessel_id,
        voyage_id=voyage_id,
        generated_at=generated_at or datetime.now(UTC),
        waypoints=waypoints,
        total_distance_nm=plan.chosen.total_distance_nm,
        eta=eta,
        achievable_minutes=achievable_minutes,
        predicted_burn_l=plan.chosen.total_burn_l,
        baseline_distance_nm=plan.baseline.total_distance_nm,
        baseline_burn_l=plan.baseline.total_burn_l,
        savings_l=plan.savings_l,
        depth_constrained=plan.depth_constrained,
        weather_constrained=plan.weather_constrained,
        constraint_notes=list(plan.notes),
        forecast_source=plan.forecast_source,
        model_confidence=_route_confidence(plan),
        advisory_en=en,
        advisory_fil=fil,
        advisory_source="template",
    )
