"""Tests for Route Optimization.

The load-bearing test here is `test_one_leg_route_agrees_with_the_throttle_optimizer`.
The route contract's central claim -- the thing that makes Route more than a
second, disconnected product -- is that a route is scored on the *same* fuel model
as Speed. If a single-leg route ever disagrees with `optimise_throttle` over the
same water and schedule, that claim is false and the two have silently become two
different cost models. The rest of the file guards the geodesy, the constraints,
and the honest-baseline delta.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from services.route.bathymetry import AnalyticBathymetry, Shoal
from services.route.forecast import AnalyticFieldForecast, SeaForecast, load_forecast
from services.route.geo import (
    LatLon,
    densify,
    destination,
    haversine_nm,
    initial_bearing_deg,
    midpoint,
    path_length_nm,
)
from services.route.planner import (
    DEFAULT_OFFSETS_NM,
    as_route_recommendation,
    plan_route,
)
from services.speed.fuel import EngineSpec, FuelMap
from services.speed.optimizer import optimise_throttle
from services.speed.resistance import SeaState, VesselHull

HULL = VesselHull(length_waterline_m=11.5, beam_m=2.8, draft_m=1.1, displacement_kg=8500.0)
SPEC = EngineSpec(rated_kw=90.0, rated_rpm=2800.0)
DEPART = datetime(2026, 7, 23, 6, 0, tzinfo=UTC)


@pytest.fixture
def fuel_map():
    return FuelMap(SPEC)


class ConstantForecast:
    """A single sea state everywhere and at every time. Lets a route be checked
    against the throttle optimizer on identical, uniform water."""

    source = "constant_test"

    def __init__(self, sea: SeaState):
        self._sea = sea

    def at(self, position: LatLon, when: datetime) -> SeaState:
        return self._sea


# --- Geodesy ----------------------------------------------------------------


def test_haversine_matches_a_known_distance():
    """One degree of latitude is 60 nautical miles by the definition of the unit."""
    a = LatLon(10.0, 123.0)
    b = LatLon(11.0, 123.0)
    assert haversine_nm(a, b) == pytest.approx(60.0, rel=1e-3)


def test_bearing_due_east_and_north():
    origin = LatLon(10.0, 123.0)
    assert initial_bearing_deg(origin, LatLon(10.0, 124.0)) == pytest.approx(90.0, abs=0.5)
    assert initial_bearing_deg(origin, LatLon(11.0, 123.0)) == pytest.approx(0.0, abs=0.01)


def test_destination_round_trips_with_haversine():
    origin = LatLon(10.5, 123.0)
    moved = destination(origin, 90.0, 5.0)
    assert haversine_nm(origin, moved) == pytest.approx(5.0, rel=1e-3)


def test_midpoint_is_equidistant():
    a, b = LatLon(10.0, 123.0), LatLon(10.0, 124.0)
    m = midpoint(a, b)
    assert haversine_nm(a, m) == pytest.approx(haversine_nm(b, m), rel=1e-3)


def test_densify_caps_leg_length_and_preserves_endpoints():
    a, b = LatLon(10.0, 123.0), LatLon(10.0, 124.0)  # ~59 nm
    vertices = densify([a, b], max_leg_nm=2.0)
    assert vertices[0] == a
    assert vertices[-1].lat == pytest.approx(b.lat) and vertices[-1].lon == pytest.approx(b.lon)
    legs = [haversine_nm(p, q) for p, q in zip(vertices, vertices[1:], strict=False)]
    assert max(legs) <= 2.0 + 1e-6
    assert path_length_nm(vertices) == pytest.approx(haversine_nm(a, b), rel=1e-4)


# --- The load-bearing integration test --------------------------------------


def test_one_leg_route_agrees_with_the_throttle_optimizer(fuel_map):
    """A direct route on uniform water must burn exactly what the throttle
    optimizer says for the same distance, schedule and conditions."""
    sea = SeaState(wind_speed_kn=14.0, wind_direction_deg=90.0, wave_height_m=0.8)
    origin = LatLon(10.6, 123.0)
    dest = LatLon(10.6, 123.5)  # due east, ~29.5 nm
    minutes = 180.0

    plan = plan_route(
        origin,
        dest,
        hull=HULL,
        spec=SPEC,
        fuel_map=fuel_map,
        forecast=ConstantForecast(sea),
        bathymetry=AnalyticBathymetry(offshore_depth_m=80.0, coast_lat=0.0),
        depart=DEPART,
        minutes_available=minutes,
        offsets_nm=(0.0,),  # direct route only
    )

    heading = plan.chosen.legs[0].heading_deg
    total = plan.chosen.total_distance_nm
    ref = optimise_throttle(
        HULL,
        SPEC,
        fuel_map,
        sea,
        heading,
        distance_remaining_nm=total,
        minutes_available=minutes,
    )
    ref_burn = ref.recommended.litres_for_distance(total)

    assert plan.chosen.total_burn_l == pytest.approx(ref_burn, rel=1e-6)


# --- The optimisation and its honesty ---------------------------------------


def test_offset_route_can_beat_the_direct_track_around_a_weather_band():
    """With a wind/current band across the direct track, some offset route should
    win on fuel -- otherwise the whole product is decorative.

    The route runs east-west along the band's centre latitude, so the planner's
    perpendicular (north-south) offsets can carry it out of the band; a route
    running straight through a latitude band could never be dodged sideways.
    """
    origin = LatLon(10.75, 123.0)
    dest = LatLon(10.75, 123.4)  # due east, along the default wind/current band
    plan = plan_route(
        origin,
        dest,
        hull=HULL,
        spec=SPEC,
        fuel_map=FuelMap(SPEC),
        forecast=AnalyticFieldForecast(),
        bathymetry=AnalyticBathymetry(coast_lat=0.0),  # deep everywhere
        depart=DEPART,
        minutes_available=240.0,
    )
    # The chosen track detours off the direct line...
    assert plan.chosen.total_distance_nm >= plan.baseline.total_distance_nm
    # ...and pays for the detour with lower burn.
    assert plan.savings_l > 0.0
    assert plan.chosen.total_burn_l < plan.baseline.total_burn_l


def test_negative_saving_is_reported_honestly(fuel_map):
    """On uniform water no detour can help; the direct route wins and the saving
    is zero or negative, never a fabricated positive."""
    sea = SeaState(wind_speed_kn=8.0, wind_direction_deg=90.0)
    plan = plan_route(
        LatLon(10.6, 123.0),
        LatLon(10.6, 123.4),
        hull=HULL,
        spec=SPEC,
        fuel_map=fuel_map,
        forecast=ConstantForecast(sea),
        bathymetry=AnalyticBathymetry(offshore_depth_m=80.0, coast_lat=0.0),
        depart=DEPART,
        minutes_available=150.0,
    )
    assert plan.savings_l <= 1e-6
    assert plan.chosen.total_distance_nm == pytest.approx(plan.baseline.total_distance_nm, rel=1e-9)


def test_a_shoal_makes_the_planner_route_around_it():
    """A shoal on the direct track must be rejected on depth, and the flag set."""
    origin = LatLon(10.60, 123.0)
    dest = LatLon(10.90, 123.0)
    shoal = Shoal(centre=midpoint(origin, dest), radius_nm=3.0, min_depth_m=0.5)
    plan = plan_route(
        origin,
        dest,
        hull=HULL,
        spec=SPEC,
        fuel_map=FuelMap(SPEC),
        forecast=AnalyticFieldForecast(),
        bathymetry=AnalyticBathymetry(coast_lat=0.0, shoals=[shoal]),
        depart=DEPART,
        minutes_available=240.0,
    )
    assert plan.depth_constrained
    # The chosen track clears the vessel's draft plus margin everywhere.
    assert plan.chosen.min_depth_m >= HULL.draft_m + 1.0


# --- The wire contract ------------------------------------------------------


def test_recommendation_is_wellformed_and_carries_the_forecast_source():
    plan = plan_route(
        LatLon(10.60, 123.0),
        LatLon(10.90, 123.0),
        hull=HULL,
        spec=SPEC,
        fuel_map=FuelMap(SPEC),
        forecast=AnalyticFieldForecast(),
        bathymetry=AnalyticBathymetry(coast_lat=0.0),
        depart=DEPART,
        minutes_available=240.0,
    )
    rec = as_route_recommendation(plan, vessel_id="bangka-01", depart=DEPART)

    assert rec.vessel_id == "bangka-01"
    assert len(rec.waypoints) >= 2
    assert rec.waypoints[0].eta == DEPART
    assert rec.eta >= DEPART
    assert rec.total_distance_nm > 0
    assert rec.predicted_burn_l > 0
    assert rec.forecast_source == "analytic_field"
    assert 0.0 <= rec.model_confidence <= 1.0
    # Savings on the contract equals baseline minus predicted, to the litre.
    assert rec.savings_l == pytest.approx(rec.baseline_burn_l - rec.predicted_burn_l, rel=1e-9)
    # Every intermediate waypoint carries its leg distance and forecast.
    for wp in rec.waypoints[1:]:
        assert wp.leg_distance_nm is not None and wp.leg_distance_nm > 0
        assert wp.forecast_wind_kn is not None


def test_offsets_include_the_direct_track_as_baseline():
    """The baseline must be the zero-offset direct track, by construction."""
    assert DEFAULT_OFFSETS_NM[0] == 0.0


def test_load_forecast_degrades_to_analytic_field_without_an_artifact(tmp_path):
    """Before anyone has run the trainer, planning still works.

    Passes an explicit, guaranteed-absent path rather than relying on the
    default `models/route_forecast/` being empty -- that directory's contents
    are committed (mirrors `models/fuel_degradation.onnx`), so on the real repo
    state this directory is *not* empty, same as `FuelMap.load`'s equivalent
    test constructs a bare `FuelMap` instead of asserting the committed
    `fuel_degradation.onnx` is somehow missing.
    """
    forecast = load_forecast(tmp_path / "does_not_exist")
    assert isinstance(forecast, SeaForecast)
    assert forecast.source == "analytic_field"


def test_load_forecast_loads_the_trained_artifact_when_present():
    """The other half of the same seam: what the committed artifact does.

    Written defensively (branch on which state we find), the same style
    `tests/test_api.py` already uses for `model_trained` -- this test still
    means something in a checkout that has not run the trainer.
    """
    forecast = load_forecast()
    assert isinstance(forecast, SeaForecast)
    assert forecast.source in {"analytic_field", "gbm_climatology"}
    if forecast.source == "gbm_climatology":
        # A learned instance must actually answer, not just report a label.
        sea = forecast.at(LatLon(10.68, 122.59), datetime(2026, 8, 1, tzinfo=UTC))
        assert sea.wind_speed_kn >= 0.0
        assert sea.wave_height_m >= 0.0
        assert sea.current_speed_kn >= 0.0
        assert 0.0 <= sea.wind_direction_deg < 360.0


def test_achievable_minutes_exceeds_the_schedule_when_it_cannot_be_held(fuel_map):
    """An impossible schedule must publish how long the crossing really takes.

    `eta` is the arrival that was *asked for*: legs are planned at the required
    speed-over-ground, so summing `planned_minutes` reproduces the budget exactly
    whether or not the hull can hold it. That made `schedule_feasible=False` a
    boolean with no magnitude attached, and the display could only say "cannot be
    held" without saying by how much.

    This pins the two apart: ask for a crossing far faster than the hull can
    manage, and `achievable_minutes` must exceed the budget while `eta` still
    lands on it.
    """
    sea = SeaState(wind_speed_kn=14.0, wind_direction_deg=90.0, wave_height_m=0.8)
    origin = LatLon(10.6, 123.0)
    dest = LatLon(10.6, 123.5)  # due east, ~29.5 nm
    impossible = 30.0  # ~59 kn required; this hull cannot do it

    plan = plan_route(
        origin,
        dest,
        hull=HULL,
        spec=SPEC,
        fuel_map=fuel_map,
        forecast=ConstantForecast(sea),
        bathymetry=AnalyticBathymetry(offshore_depth_m=80.0, coast_lat=0.0),
        depart=DEPART,
        minutes_available=impossible,
        offsets_nm=(0.0,),
    )

    assert not plan.chosen.schedule_feasible
    # The planned total is the budget; the achievable total is the truth.
    assert plan.chosen.total_minutes == pytest.approx(impossible, rel=1e-6)
    assert plan.chosen.total_achievable_minutes > impossible

    rec = as_route_recommendation(plan, vessel_id="MV-TEST", depart=DEPART)
    assert rec.achievable_minutes is not None
    assert rec.achievable_minutes > impossible
    # `eta` still reports the requested arrival, so the two must not be equal.
    eta_minutes = (rec.eta - DEPART).total_seconds() / 60.0
    assert eta_minutes == pytest.approx(impossible, rel=1e-6)
    assert rec.achievable_minutes > eta_minutes


def test_achievable_minutes_is_within_the_budget_when_the_schedule_is_comfortable(fuel_map):
    """The other side: a schedule the hull can hold is reported as held.

    Guards against "fixing" the field by always reporting something larger than
    the budget. Note the achievable time comes in *under* it rather than equal to
    it, and that is the optimizer working as designed: given a generous budget it
    picks the cheapest throttle that MEETS the schedule, and the cheapest such
    throttle usually beats it slightly. So this asserts a bound, not an equality
    -- an earlier version of this test asserted equality and failed at 590
    against 600, which was the test being wrong rather than the planner.
    """
    sea = SeaState(wind_speed_kn=6.0, wind_direction_deg=90.0, wave_height_m=0.3)
    plan = plan_route(
        LatLon(10.6, 123.0),
        LatLon(10.6, 123.5),
        hull=HULL,
        spec=SPEC,
        fuel_map=fuel_map,
        forecast=ConstantForecast(sea),
        bathymetry=AnalyticBathymetry(offshore_depth_m=80.0, coast_lat=0.0),
        depart=DEPART,
        minutes_available=600.0,  # ~3 kn required; trivially holdable
        offsets_nm=(0.0,),
    )

    assert plan.chosen.schedule_feasible
    rec = as_route_recommendation(plan, vessel_id="MV-TEST", depart=DEPART)
    assert rec.achievable_minutes is not None
    # Feasible means exactly this: the crossing fits inside the budget.
    assert rec.achievable_minutes <= plan.chosen.total_minutes + 1e-6
    assert rec.achievable_minutes > 0.0
