"""Condition-normalised predictive maintenance.

The claim this feature lives or dies on is one sentence: the same sensor reading
means different things in different weather. `test_same_reading_opposite_verdict`
is that sentence as an assertion, and if it ever fails the panel is back to being
a threshold alarm with extra steps.

The rest guard the places a condition-monitoring system quietly starts lying:
extrapolating past the weather it has seen, quoting a prognosis without an
uncertainty, and letting an import claim to have taught it something it did not.
"""

from __future__ import annotations

import math
import random
from datetime import UTC, datetime, timedelta

import pytest

from packages.contracts.maintenance import MaintenancePhase, MaintenanceStatus
from packages.contracts.pdm import ComponentHealth, HealthStatus, VesselSystem
from packages.contracts.telemetry import TelemetryFrame
from services.maintenance.assess import assess
from services.maintenance.components import PARTS, PARTS_BY_SYSTEM
from services.maintenance.history import parse_history_csv, refit_from_history
from services.maintenance.normalize import fit_condition_models

RATED = 2800.0


def _frame(i: int, *, load: float, wave: float, heading: float, wind: float, vib: float) -> TelemetryFrame:
    rng = random.Random(i)
    return TelemetryFrame(
        vessel_id="V", ts=datetime.now(UTC) + timedelta(seconds=i * 10), source="simulator",
        throttling={"engine_rpm": RATED * load, "engine_torque_nm": 300.0,
                    "wind_speed_kn": 12.0, "wind_direction_deg": wind},
        routing={"heading_deg": heading, "wave_height_m": wave, "speed_over_ground_kn": 8.0},
        electro_mechanical={
            "coolant_temp_c": 60 + load * 22 + rng.random() * 1.5,
            "oil_pressure_kpa": 250 + load * 180 + rng.random() * 4,
            "exhaust_gas_temp_c": 150 + load * 300 + wave * 8 + rng.random() * 4,
            "battery_voltage_v": 13.9 + rng.random() * 0.08,
            "oil_particulate_ppm": 11 + rng.random() * 0.8,
            "exhaust_nox_ppm": 240 + load * 600 + rng.random() * 10,
            "accel_x_g": vib * (rng.random() * 2 - 1),
            "accel_y_g": vib * (rng.random() * 2 - 1),
            "accel_z_g": 1.0 + vib * (rng.random() * 2 - 1)},
    )


def _vib(load: float, wave: float, heading: float, wind: float) -> float:
    """Vibration rises with load AND with how abeam the sea is. The confounder."""
    rel = math.radians((wind - heading) % 360)
    return 0.02 + load * 0.05 + wave * 0.02 * abs(math.sin(rel))


@pytest.fixture(scope="module")
def models():
    """Healthy history across varied weather, in coherent blocks."""
    rng = random.Random(5)
    frames, i = [], 0
    for _ in range(40):
        load, wave = 0.35 + rng.random() * 0.5, rng.random() * 2.2
        heading, wind = rng.random() * 360, rng.random() * 360
        v = _vib(load, wave, heading, wind)
        for _ in range(25):
            frames.append(_frame(i, load=load, wave=wave, heading=heading, wind=wind, vib=v))
            i += 1
    return fit_condition_models(frames, rated_rpm=RATED)


def _assess(window, models, **kw):
    return assess(window, models, vessel_id="V", rated_rpm=RATED,
                  wear_hours=kw.pop("wear_hours", 2600), run_hours=2100,
                  severity_index=1.2, hours_per_day=8, baseline_confidence=0.62, **kw)


def _residual(report, system, channel):
    sysa = next(s for s in report.systems if s.system is system)
    return next(r for r in sysa.residuals if r.channel == channel)


def test_same_reading_opposite_verdict(models):
    """The whole feature, as one assertion.

    Identical vibration. In a 2.1 m beam sea it is the boat working; in flat calm
    at low load it is the machinery. A system that scores raw values cannot tell
    these apart, which is why it either misses faults or cries wolf every time the
    weather turns.
    """
    beam = [_frame(5000 + k, load=0.82, wave=2.1, heading=0.0, wind=90.0,
                   vib=_vib(0.82, 2.1, 0.0, 90.0)) for k in range(30)]
    same_level = _vib(0.82, 2.1, 0.0, 90.0)
    calm = [_frame(6000 + k, load=0.42, wave=0.15, heading=0.0, wind=10.0,
                   vib=same_level) for k in range(30)]

    r_beam = _residual(_assess(beam, models), VesselSystem.PROPULSION, "vibration_rms_g")
    r_calm = _residual(_assess(calm, models), VesselSystem.PROPULSION, "vibration_rms_g")

    # Near-identical measurement...
    assert r_calm.measured == pytest.approx(r_beam.measured, rel=0.25)
    # ...and a far larger expectation in the beam sea, because the sea explains it.
    assert r_beam.expected > r_calm.expected * 1.5
    # ...so the calm-water residual is dramatically worse.
    assert abs(r_calm.residual_sigma) > abs(r_beam.residual_sigma) * 2.0


def test_expectation_tracks_the_sea_not_just_the_throttle(models):
    """Beam seas must raise the expectation more than following seas of equal height.

    Roll excitation scales with wave height times how abeam the sea is. A model
    without that interaction under-predicts a beam sea and reports the shortfall
    as a mechanical fault -- which is exactly what an earlier fit did.
    """
    beam = [_frame(7000 + k, load=0.7, wave=2.0, heading=0.0, wind=90.0,
                   vib=_vib(0.7, 2.0, 0.0, 90.0)) for k in range(30)]
    following = [_frame(7100 + k, load=0.7, wave=2.0, heading=0.0, wind=180.0,
                        vib=_vib(0.7, 2.0, 0.0, 180.0)) for k in range(30)]

    e_beam = _residual(_assess(beam, models), VesselSystem.PROPULSION, "vibration_rms_g").expected
    e_follow = _residual(_assess(following, models), VesselSystem.PROPULSION, "vibration_rms_g").expected
    assert e_beam > e_follow


def test_a_prognosis_without_a_tolerance_is_rejected():
    """A number of weeks with no uncertainty invites planning against a precision
    the data cannot support. The contract refuses it."""
    with pytest.raises(ValueError, match="requires weeks_tolerance"):
        ComponentHealth(
            component_id="x", label_en="X", label_fil="X", system=VesselSystem.ENGINE,
            criticality=1, life_score=0.5, design_life_wear_hours=8000,
            wear_hours_consumed=4000, weeks_to_failure=12.0,
            weeks_tolerance=None, status=HealthStatus.NORMAL,
        )


def test_weeks_are_omitted_without_a_working_pattern(models):
    """A boat running two hours a day and one running twelve share no calendar."""
    window = [_frame(8000 + k, load=0.6, wave=1.0, heading=0.0, wind=45.0,
                     vib=_vib(0.6, 1.0, 0.0, 45.0)) for k in range(30)]
    report = assess(window, models, vessel_id="V", rated_rpm=RATED, wear_hours=2600,
                    run_hours=2100, severity_index=None, hours_per_day=None,
                    baseline_confidence=0.6)
    for system in report.systems:
        for c in system.components:
            assert c.weeks_to_failure is None
            assert c.weeks_tolerance is None


def test_tolerance_widens_when_the_baseline_is_thin(models):
    """An engine three days old should report a wide window and mean it."""
    window = [_frame(8100 + k, load=0.6, wave=1.0, heading=0.0, wind=45.0,
                     vib=_vib(0.6, 1.0, 0.0, 45.0)) for k in range(30)]
    known = _assess(window, models, wear_hours=2600)
    unknown = assess(window, models, vessel_id="V", rated_rpm=RATED, wear_hours=2600,
                     run_hours=2100, severity_index=1.2, hours_per_day=8,
                     baseline_confidence=0.05)

    def widest(report):
        return max(c.weeks_tolerance or 0 for s in report.systems for c in s.components)

    assert widest(unknown) > widest(known)


def test_every_system_has_components_and_every_part_is_usable():
    assert set(PARTS_BY_SYSTEM) == set(VesselSystem)
    for system in VesselSystem:
        assert PARTS_BY_SYSTEM[system], f"{system} has no components"
    ids = [p.component_id for p in PARTS]
    assert len(ids) == len(set(ids))
    for p in PARTS:
        assert p.design_life_wear_hours > 0
        assert p.channel_weights, f"{p.component_id} is informed by no channel"
        assert p.failure_mode_en


def test_recommendations_state_and_never_order(models):
    """Same rule the advisory guard enforces on the throttle line."""
    window = [_frame(8200 + k, load=0.6, wave=1.0, heading=0.0, wind=45.0,
                     vib=_vib(0.6, 1.0, 0.0, 45.0)) for k in range(30)]
    for wear in (100, 4000, 9000, 30000):
        report = _assess(window, models, wear_hours=wear)
        for system in report.systems:
            first = system.recommended_action_en.split()[0].lower().strip(",.")
            assert first not in {"replace", "renew", "change", "stop", "dock", "service", "check"}
            assert system.recommended_action_fil


def test_import_maps_iso_19848_channel_ids():
    csv_text = (
        "timestamp,/main-engine/cooling/fresh-water/temperature,rpm\n"
        "2026-03-01T00:00:00Z,78.4,1900\n"
    )
    _, summary = parse_history_csv(csv_text)
    assert "coolant_temp_c" in summary.channels_mapped
    assert summary.rows_accepted == 1


def test_import_reports_headers_it_did_not_understand():
    """A mistyped column that vanishes silently is worse than one that fails loudly."""
    csv_text = "timestamp,coolant_temp_c,rpm,widget_pressure_xyz\n2026-03-01T00:00:00Z,78,1900,5\n"
    _, summary = parse_history_csv(csv_text)
    assert summary.channels_unrecognised == ["widget_pressure_xyz"]


def test_import_rejects_out_of_range_rows_rather_than_clamping():
    """A silently clamped outlier trains the condition model on a fiction."""
    csv_text = (
        "timestamp,coolant_temp_c,rpm\n"
        "2026-03-01T00:00:00Z,900,1900\n"      # outside the contract's range
        "2026-03-01T00:00:01Z,78,1900\n"
    )
    _, summary = parse_history_csv(csv_text)
    assert summary.rows_accepted == 1
    assert summary.rows_rejected == 1


def test_import_reports_the_conditions_it_actually_covered():
    """Ten thousand rows in flat calm do not teach a model about a head sea."""
    rows = ["timestamp,coolant_temp_c,rpm,wave_height_m,heading_deg,wind_from"]
    for i in range(600):
        rows.append(f"2026-03-01T00:{i//60:02d}:{i%60:02d}Z,78.0,1900,0.1,0,0")
    frames, summary = parse_history_csv("\n".join(rows))
    _, summary = refit_from_history(frames, rated_rpm=RATED, summary=summary)
    assert summary.conditions_covered.get("wave_height_range_m", 1.0) == pytest.approx(0.0, abs=1e-6)


def test_pdm_does_not_unlock_component_claims_in_phase_1(models):
    """The boundary this whole split exists to hold.

    A PdmReport may name a component and quote weeks, because every figure traces
    to a design life, a measured exposure or a residual against this vessel's own
    history. MaintenanceStatus still may not, because there it would be a forecast
    from failure history the vessel does not have.
    """
    window = [_frame(8300 + k, load=0.6, wave=1.0, heading=0.0, wind=45.0,
                     vib=_vib(0.6, 1.0, 0.0, 45.0)) for k in range(30)]
    report = _assess(window, models)
    assert any(c.label_en for s in report.systems for c in s.components)

    with pytest.raises(ValueError, match="cannot make component-level claims"):
        MaintenanceStatus(
            vessel_id="V", generated_at="2026-08-04T00:00:00Z",
            phase=MaintenancePhase.PHASE_1_COLD_START,
            anomaly_score=0.2, is_anomalous=False, baseline_confidence=0.5,
            observed_hours=2100.0, streams=[],
            likely_component="Stern tube bearing",
            advisory_en="x", advisory_fil="y",
        )
