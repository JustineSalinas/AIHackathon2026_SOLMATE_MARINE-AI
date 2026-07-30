"""End-to-end tests for the advisory API.

These are the tests that stand between the demo and a repeat of the prototype's
central flaw: an interface where the weather sliders move the readouts and never
the boat. Every claim the bridge display makes is asserted here against a real
HTTP round trip.
"""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from apps.api.main import app

CALM = {"wind_speed_kn": 0.0, "wave_height_m": 0.0}
HEAD_SEA = {
    "wind_speed_kn": 20.0,
    "wind_direction_deg": 0.0,
    "wave_height_m": 1.5,
    "wave_direction_deg": 0.0,
}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def advise(client, **kwargs) -> dict:
    body = {"heading_deg": 0.0, "distance_remaining_nm": 2.0, **kwargs}
    r = client.post("/advise", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_health_declares_the_advisory_boundary(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["advisory_only"] is True


def test_advise_works_with_no_body_at_all(client):
    """Every field has a defensible default so the simulator can boot before the
    operator has entered a vessel profile."""
    r = client.post("/advise", json={})
    assert r.status_code == 200
    assert r.json()["recommendation"]["recommended_rpm"] > 0


def test_bad_input_is_rejected_not_coerced(client):
    assert client.post("/advise", json={"heading_deg": 999}).status_code == 422
    assert client.post("/advise", json={"distance_remaining_nm": -1}).status_code == 422
    assert client.post("/advise", json={"nonsense": True}).status_code == 422


# --- The claim the whole rewrite exists to make true ------------------------


def test_weather_slows_the_boat_at_the_same_throttle(client):
    """Same RPM, worse weather, slower boat.

    The prototype computed speed from the throttle slider alone. If this ever
    stops holding, the environmental controls are decorative again.
    """
    calm = advise(client, sea=CALM, current_rpm=2400.0)
    rough = advise(client, sea=HEAD_SEA, current_rpm=2400.0)

    assert rough["achievable_speed_kn"] < calm["achievable_speed_kn"]
    assert calm["achievable_speed_kn"] - rough["achievable_speed_kn"] > 0.3


def test_weather_raises_the_cost_of_holding_a_schedule(client):
    """Same distance, same deadline, worse weather -> more fuel per hour."""
    calm = advise(client, sea=CALM, minutes_available=20.0)
    rough = advise(client, sea=HEAD_SEA, minutes_available=20.0)

    assert (
        rough["recommendation"]["predicted_burn_lph"]
        > calm["recommendation"]["predicted_burn_lph"]
    )


def test_head_sea_is_itemised_so_the_advice_can_explain_itself(client):
    rough = advise(client, sea=HEAD_SEA, minutes_available=20.0)
    power = rough["power"]

    assert power["wave_kw"] > 0
    assert power["wind_kw"] > 0
    assert power["environmental_penalty_pct"] > 0
    assert power["total_kw"] == pytest.approx(
        power["calm_water_kw"] + power["wind_kw"] + power["wave_kw"], rel=0.01
    )


def test_following_sea_is_cheaper_than_head_sea(client):
    following = dict(HEAD_SEA, wind_direction_deg=180.0, wave_direction_deg=180.0)
    head = advise(client, sea=HEAD_SEA, minutes_available=25.0)
    follow = advise(client, sea=following, minutes_available=25.0)

    assert (
        follow["recommendation"]["predicted_burn_lph"]
        < head["recommendation"]["predicted_burn_lph"]
    )


def test_a_foul_current_shows_up_as_speed_through_water(client):
    """A vessel making 8 kn over ground against 2 kn of current is driving its
    hull at 10 kn, and paying 10-knot fuel for 8-knot progress."""
    foul = advise(
        client,
        sea={"current_speed_kn": 2.0, "current_direction_deg": 180.0},
        minutes_available=30.0,
    )
    rec = foul["recommendation"]
    assert rec["recommended_speed_kn"] > foul["power"]["speed_through_water_kn"] - 1e-6


# --- Load ------------------------------------------------------------------


def test_a_full_boat_is_a_thirstier_boat(client):
    empty = advise(client, minutes_available=20.0, passenger_count=0)
    full = advise(client, minutes_available=20.0, passenger_count=60)

    assert (
        full["recommendation"]["predicted_burn_lph"]
        > empty["recommendation"]["predicted_burn_lph"]
    )


# --- Engine condition: the Problem 1 -> Problem 2 link ----------------------


def test_a_worn_engine_costs_money_per_hour(client):
    healthy = advise(client, minutes_available=20.0, egt_excess_ratio=1.0)
    worn = advise(client, minutes_available=20.0, egt_excess_ratio=1.06)

    assert worn["wear"]["multiplier"] >= healthy["wear"]["multiplier"]
    assert worn["wear"]["penalty_lph"] >= healthy["wear"]["penalty_lph"]
    if worn["model_trained"]:
        assert worn["wear"]["multiplier"] > 1.0
        assert worn["wear"]["penalty_php_per_hour"] > 0


def test_unknown_engine_condition_assumes_health_and_lowers_confidence(client):
    unknown = advise(client, minutes_available=20.0)
    assert unknown["wear"]["multiplier"] == 1.0
    assert unknown["recommendation"]["model_confidence"] < 1.0
    assert any("assumed healthy" in n for n in unknown["notes"])


# --- Schedule --------------------------------------------------------------


def test_impossible_schedule_is_flagged_not_faked(client):
    hard = advise(
        client,
        sea={"wind_speed_kn": 40.0, "wind_direction_deg": 0.0, "wave_height_m": 3.0},
        distance_remaining_nm=20.0,
        minutes_available=15.0,
    )
    assert hard["feasible"] is False
    assert "late" in hard["recommendation"]["advisory_en"].lower()


def test_recommendation_never_exceeds_rated_power(client):
    hard = advise(client, sea=HEAD_SEA, distance_remaining_nm=20.0, minutes_available=15.0)
    assert hard["recommendation"]["recommended_rpm"] <= 2800.0 * 1.001
    assert hard["power"]["total_kw"] <= 90.0 * 1.001


def test_more_time_is_never_more_fuel(client):
    tight = advise(client, minutes_available=12.0)
    loose = advise(client, minutes_available=30.0)
    assert (
        loose["recommendation"]["predicted_burn_lph"]
        <= tight["recommendation"]["predicted_burn_lph"]
    )


# --- Contract guarantees the display depends on -----------------------------


def test_advisory_is_bilingual_and_never_imperative(client):
    body = advise(client, minutes_available=20.0, current_rpm=2600.0)
    rec = body["recommendation"]

    assert rec["advisory_en"] and rec["advisory_fil"]
    assert rec["advisory_en"] != rec["advisory_fil"]
    assert rec["advisory_source"] == "template"
    for banned in ("reduce", "increase", "slow down", "throttle back"):
        assert banned not in rec["advisory_en"].lower()


def test_savings_in_pesos_track_savings_in_litres(client):
    body = advise(client, minutes_available=20.0, current_rpm=2600.0, php_per_litre=70.0)
    rec = body["recommendation"]
    assert rec["savings_php_per_hour"] == pytest.approx(rec["savings_lph"] * 70.0)


def test_curve_is_returned_so_the_browser_never_computes_physics(client):
    body = advise(client, minutes_available=20.0)
    curve = body["curve"]

    assert len(curve) > 5
    speeds = [p["speed_kn"] for p in curve]
    assert speeds == sorted(speeds)
    assert all(p["litres_per_hour"] > 0 for p in curve)
    assert max(p["speed_kn"] for p in curve) <= body["max_speed_kn"] + 0.51


def test_emissions_come_from_the_same_burn_figure(client):
    body = advise(client, minutes_available=20.0)
    lph = body["recommendation"]["predicted_burn_lph"]
    assert body["emissions"]["co2_kg_per_hour"] == pytest.approx(lph * 2.68, rel=1e-6)


# --- Route Optimization -----------------------------------------------------

# A short coastal hop that crosses the analytic field's default wind/current
# band, so the optimiser has a real reason to bow the track.
ROUTE_BODY = {
    "origin": {"latitude": 10.75, "longitude": 123.0},
    "destination": {"latitude": 10.75, "longitude": 123.4},
    "minutes_available": 120.0,
}


def plan(client, **kwargs) -> dict:
    r = client.post("/route", json={**ROUTE_BODY, **kwargs})
    assert r.status_code == 200, r.text
    return r.json()


def test_route_returns_a_wellformed_track(client):
    body = plan(client)
    rec = body["recommendation"]
    assert len(rec["waypoints"]) >= 2
    assert rec["total_distance_nm"] > 0
    assert rec["predicted_burn_l"] > 0
    assert rec["eta"] is not None


def test_route_reports_its_forecast_source(client):
    """Whichever forecaster is behind `/route`, the response says which one --
    never silently claims a real forecast it did not make. `gbm_climatology`
    is the trained artifact committed to the repo; `analytic_field` is what a
    checkout without it falls back to. Either is a pass; a third value is not."""
    rec = plan(client)["recommendation"]
    assert rec["forecast_source"] in {"analytic_field", "gbm_climatology"}


def test_route_savings_are_baseline_minus_predicted(client):
    rec = plan(client)["recommendation"]
    assert rec["savings_l"] == pytest.approx(
        rec["baseline_burn_l"] - rec["predicted_burn_l"], rel=1e-9
    )


def test_route_advisory_is_bilingual_and_never_imperative(client):
    rec = plan(client)["recommendation"]
    assert rec["advisory_en"] and rec["advisory_fil"]
    assert rec["advisory_en"] != rec["advisory_fil"]
    for banned in ("steer", "turn to", "head for", "go around"):
        assert banned not in rec["advisory_en"].lower()


def test_route_bad_input_is_rejected_not_coerced(client):
    assert client.post("/route", json={}).status_code == 422  # origin/destination required
    assert (
        client.post(
            "/route",
            json={**ROUTE_BODY, "origin": {"latitude": 999, "longitude": 0}},
        ).status_code
        == 422
    )


# --- Predictive Maintenance (Phase 1) ---------------------------------------


def em_window(n=30, **channels) -> list[dict]:
    """A window of telemetry frames at healthy operating values, moving any named
    electro-mechanical channel."""
    healthy = {
        "coolant_temp_c": 82.0,
        "oil_pressure_kpa": 350.0,
        "battery_voltage_v": 13.8,
        "exhaust_gas_temp_c": 380.0,
        "oil_particulate_ppm": 15.0,
        "exhaust_nox_ppm": 600.0,
    }
    healthy.update(channels)
    frames = []
    for i in range(n):
        em = dict(healthy)
        # Vibration at the healthy baseline level (~0.05 g RMS): a sinusoid of
        # amplitude ~0.041 per axis gives var A^2/2, summing to ~0.05 g across the
        # three axes. Zero-amplitude accel would read as an (anomalously) dead
        # engine against a baseline that expects some vibration.
        a = 0.0408
        em |= {
            "accel_x_g": a * math.sin(i),
            "accel_y_g": a * math.sin(i + 2.0),
            "accel_z_g": 1.0 + a * math.sin(i + 4.0),
        }
        frames.append(
            {
                "vessel_id": "MV-DEMO-01",
                "ts": f"2026-07-23T06:00:{i:02d}+00:00",
                "electro_mechanical": em,
            }
        )
    return frames


def maint(client, **channels) -> dict:
    r = client.post("/maintenance", json={"frames": em_window(**channels)})
    assert r.status_code == 200, r.text
    return r.json()


def test_maintenance_healthy_window_is_nominal(client):
    body = maint(client)
    assert body["phase"] == "phase_1_cold_start"
    assert body["is_anomalous"] is False
    assert body["anomaly_score"] < 0.6


def test_maintenance_flags_a_coolant_spike_and_stays_phase1(client):
    body = maint(client, coolant_temp_c=98.0)
    assert body["is_anomalous"] is True
    assert body["streams"][0]["stream"] == "electro_mechanical.coolant_temp_c"
    assert "coolant" in body["advisory_en"].lower()
    # The cold-start fairness rule: no component, no date, no RUL, ever.
    assert body["likely_component"] is None
    assert body["recommended_maintenance_date"] is None
    assert body["remaining_useful_life_days"] is None


def test_maintenance_requires_at_least_one_frame(client):
    assert client.post("/maintenance", json={"frames": []}).status_code == 422


# --- POST /safety -----------------------------------------------------------


def safety(client, *, rpm=1900.0, **channels) -> dict:
    """Evaluate one frame against the rule set."""
    em = {
        "coolant_temp_c": 82.0,
        "oil_pressure_kpa": 350.0,
        "battery_voltage_v": 13.8,
        "exhaust_gas_temp_c": 380.0,
        **channels,
    }
    body = {
        "vessel_id": "MV-DEMO-01",
        "frame": {
            "vessel_id": "MV-DEMO-01",
            "ts": "2026-07-26T06:00:00+00:00",
            "throttling": {"engine_rpm": rpm},
            "electro_mechanical": em,
        },
    }
    response = client.post("/safety", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_safety_healthy_engine_is_nominal(client):
    body = safety(client)
    assert body["severity"] == "nominal"
    assert body["active"] == []
    assert body["evaluated_rules"] > 0


def test_safety_coolant_overtemp_is_critical(client):
    body = safety(client, coolant_temp_c=110.0)
    assert body["severity"] == "critical"
    assert body["active"][0]["rule_id"] == "coolant_overtemp"
    assert body["active"][0]["observed"] == 110.0
    assert body["active"][0]["message_fil"]


def test_safety_reports_skipped_rules_rather_than_assuming_safe(client):
    """A retrofit missing a channel must not read as a healthy engine."""
    response = client.post(
        "/safety",
        json={
            "frame": {
                "vessel_id": "v",
                "ts": "2026-07-26T06:00:00+00:00",
                "electro_mechanical": {"coolant_temp_c": 82.0},
            }
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert "oil_pressure_low" in body["skipped_rules"]
    assert body["severity"] == "nominal"


def test_safety_is_deterministic_across_requests(client):
    """The endpoint carries no state; the same frame answers the same way."""
    first = safety(client, coolant_temp_c=101.0)
    for _ in range(5):
        again = safety(client, coolant_temp_c=101.0)
        assert again["severity"] == first["severity"]
        assert [c["rule_id"] for c in again["active"]] == [
            c["rule_id"] for c in first["active"]
        ]


# --- Voyages and the emissions report ---------------------------------------


def _voyage(n: int, *, fuel: float, baseline: float | None = None) -> dict:
    return {
        "voyage_id": f"api-v{n}",
        "vessel_id": "MV-REPORT-01",
        "departed_at": f"2026-03-0{n}T06:00:00+00:00",
        "arrived_at": f"2026-03-0{n}T06:22:00+00:00",
        "origin_name": "Iloilo City",
        "destination_name": "Jordan, Guimaras",
        "distance_nm": 2.8,
        "fuel_used_l": fuel,
        "baseline_fuel_l": baseline,
        "baseline_method": "counterfactual_model" if baseline is not None else "none",
    }


def test_voyage_is_recorded_and_appears_in_the_report(client):
    assert client.post("/voyages", json=_voyage(1, fuel=8.0, baseline=10.0)).status_code == 201

    report = client.get(
        "/emissions/report", params={"vessel_id": "MV-REPORT-01", "year": 2026, "month": 3}
    ).json()
    assert report["voyages"] >= 1
    assert report["co2_kg"] > 0
    assert report["co2_avoided_kg"] is not None
    assert report["baseline_method"] == "counterfactual_model"
    assert report["advisory_only"] is True
    assert report["caveats"]


def test_report_for_an_empty_month_is_not_an_error(client):
    report = client.get(
        "/emissions/report", params={"vessel_id": "MV-NOBODY-99", "year": 2026, "month": 3}
    ).json()
    assert report["voyages"] == 0
    assert report["co2_avoided_kg"] is None


def test_emissions_csv_export_is_downloadable(client):
    client.post("/voyages", json=_voyage(2, fuel=9.0, baseline=11.0))
    response = client.get(
        "/emissions/report.csv",
        params={"vessel_id": "MV-REPORT-01", "year": 2026, "month": 3},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"]
    assert ".csv" in response.headers["content-disposition"]

    body = response.text
    assert "Marine-AI monthly emissions report" in body
    assert "api-v2" in body
    # The export must explain itself when detached from the app.
    assert "Not a certified emissions inventory" in body
