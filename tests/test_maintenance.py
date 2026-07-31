"""Tests for Phase 1 predictive maintenance.

Two things are load-bearing here. First, `test_phase1_status_never_names_a_component`
-- the contract's cold-start fairness rule is only real if the detector actually
produces statuses that satisfy it, every time. Second,
`test_broken_correlation_is_caught_by_the_multivariate_detector` -- the whole
reason there are two detectors and not one is the joint fault that no single
channel reveals; if that stops being caught, the PCA half is dead weight.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from packages.contracts.maintenance import MaintenancePhase
from packages.contracts.telemetry import (
    ElectroMechanicalFrame,
    TelemetryFrame,
    ThrottlingFrame,
)
from services.advisory.guard import MAX_CHARS, rejection_reason
from services.maintenance.baseline import (
    VesselBaseline,
    extract_features,
    synthetic_healthy_baseline,
)
from services.maintenance.detector import detect

BASELINE = synthetic_healthy_baseline()
TS0 = datetime(2026, 7, 23, 6, 0, tzinfo=UTC)

# Healthy operating point for the demo engine (matches baseline._HEALTHY_MEAN).
HEALTHY = dict(coolant=82.0, oil=350.0, batt=13.8, egt=380.0, part=15.0, nox=600.0, vib=0.05)


def make_window(
    n: int = 30, *, seed: int = 1, rpm: float | None = None, **channels
) -> list[TelemetryFrame]:
    """A window of `n` frames one second apart at the given channel means.

    Channel means default to the healthy operating point; pass any of coolant,
    oil, batt, egt, part, nox, vib to move one. Small seeded noise is added so the
    window has realistic within-window spread and the vibration RMS is non-zero.

    `rpm` adds a throttling block. Left out by default, because the health
    detector reads only the electro-mechanical channels and a window without load
    data is a legitimate retrofit -- the duty tests opt in.
    """
    vals = {**HEALTHY, **channels}
    rng = np.random.default_rng(seed)
    axis_sigma = vals["vib"] / np.sqrt(3.0)
    frames = []
    for i in range(n):
        em = ElectroMechanicalFrame(
            coolant_temp_c=vals["coolant"] + rng.normal(0, 0.3),
            oil_pressure_kpa=vals["oil"] + rng.normal(0, 2.0),
            battery_voltage_v=vals["batt"] + rng.normal(0, 0.03),
            exhaust_gas_temp_c=vals["egt"] + rng.normal(0, 2.5),
            oil_particulate_ppm=max(0.0, vals["part"] + rng.normal(0, 0.5)),
            exhaust_nox_ppm=max(0.0, vals["nox"] + rng.normal(0, 8.0)),
            accel_x_g=rng.normal(0, axis_sigma),
            accel_y_g=rng.normal(0, axis_sigma),
            accel_z_g=1.0 + rng.normal(0, axis_sigma),  # 1 g gravity, de-meaned out
        )
        # `throttling` defaults to an empty block, so it is omitted rather than
        # passed as None when no RPM is asked for.
        extra = {"throttling": ThrottlingFrame(engine_rpm=rpm)} if rpm is not None else {}
        frames.append(
            TelemetryFrame(
                vessel_id="MV-DEMO-01",
                ts=TS0 + timedelta(seconds=i),
                electro_mechanical=em,
                **extra,
            )
        )
    return frames


# --- Baseline ---------------------------------------------------------------


def test_baseline_confidence_grows_with_run_hours():
    rows = np.tile(np.arange(7.0), (5, 1)) + np.random.default_rng(0).normal(0, 1, (5, 7))
    cold = VesselBaseline.fit(rows, observed_hours=10)
    warm = synthetic_healthy_baseline(observed_hours=1000)
    assert cold.baseline_confidence < warm.baseline_confidence
    assert 0.0 <= cold.baseline_confidence <= 1.0


def test_fit_needs_at_least_two_samples():
    with pytest.raises(ValueError):
        VesselBaseline.fit(np.zeros((1, 7)), observed_hours=100)


def test_extract_features_masks_absent_channels():
    frame = TelemetryFrame(vessel_id="v", ts=TS0)  # empty electro-mechanical
    _, present = extract_features([frame])
    assert not present.any()


# --- Healthy vs anomalous ---------------------------------------------------


def test_healthy_window_is_not_flagged():
    status = detect(make_window(), BASELINE, vessel_id="MV-DEMO-01")
    assert status.phase is MaintenancePhase.PHASE_1_COLD_START
    assert not status.is_anomalous
    assert status.anomaly_score < 0.6
    assert "normal range" in status.advisory_en
    assert status.advisory_fil


def test_coolant_spike_is_flagged_and_ranked_first():
    """A coolant temperature five sigma high must flag, and lead the strip."""
    status = detect(make_window(coolant=97.0), BASELINE, vessel_id="MV-DEMO-01")
    assert status.is_anomalous
    assert status.anomaly_score >= 0.6
    top = status.streams[0]
    assert top.stream == "electro_mechanical.coolant_temp_c"
    assert top.z_score > 3.0
    assert "coolant" in status.advisory_en.lower()


def test_advisory_names_a_stream_never_a_component_or_imperative():
    status = detect(make_window(oil=250.0), BASELINE, vessel_id="MV-DEMO-01")
    text = status.advisory_en.lower()
    # Phase 1 may name the stream, never a part, a date, or an order.
    for banned in ("impeller", "bearing", "replace", "days", "will fail", "reduce"):
        assert banned not in text


def test_phase1_status_never_names_a_component():
    """Whatever the detector sees, the status it emits satisfies the contract's
    cold-start validator -- no component, no date, no RUL."""
    status = detect(make_window(coolant=100.0, oil=200.0), BASELINE, vessel_id="MV-DEMO-01")
    assert status.likely_component is None
    assert status.recommended_maintenance_date is None
    assert status.remaining_useful_life_days is None
    assert status.required_parts is None


# --- The two detectors do different jobs ------------------------------------


def test_broken_correlation_is_caught_by_the_multivariate_detector():
    """Coolant and exhaust temperature normally rise together with load. A window
    where coolant is high while EGT is low keeps both within a few sigma per
    channel, but is a joint pattern a healthy engine never produces -- the PCA
    reconstruction detector must score it above the same-size aligned move."""
    # Aligned: both move up together (along the healthy load direction).
    aligned = detect(make_window(coolant=88.0, egt=430.0), BASELINE, vessel_id="v")
    # Broken: coolant up, EGT down (orthogonal to the load direction).
    broken = detect(make_window(coolant=88.0, egt=330.0), BASELINE, vessel_id="v")
    assert broken.anomaly_score > aligned.anomaly_score


def test_contribution_percentages_sum_to_about_100():
    status = detect(make_window(coolant=95.0), BASELINE, vessel_id="v")
    total = sum(s.contribution_pct for s in status.streams)
    assert total == pytest.approx(100.0, abs=0.5)


def test_drifting_stream_reports_a_trend():
    """A coolant that is already high across the whole window reads as a drift,
    not a spike, and carries a trend duration."""
    status = detect(make_window(n=40, coolant=95.0), BASELINE, vessel_id="v")
    coolant = next(s for s in status.streams if s.stream.endswith("coolant_temp_c"))
    assert coolant.trend_minutes is not None and coolant.trend_minutes > 0


# --- Degraded inputs --------------------------------------------------------


def test_no_engine_health_data_is_reported_honestly():
    frames = [TelemetryFrame(vessel_id="v", ts=TS0 + timedelta(seconds=i)) for i in range(10)]
    status = detect(frames, BASELINE, vessel_id="v")
    assert not status.is_anomalous
    assert status.anomaly_score == 0.0
    assert status.streams == []
    assert "no engine-health" in status.advisory_en.lower()


def test_observed_hours_override_drives_confidence():
    status = detect(make_window(), BASELINE, vessel_id="v", observed_hours=5.0)
    assert status.observed_hours == 5.0


# --- Duty cycle -------------------------------------------------------------
#
# The load-bearing test in this section is
# `test_duty_never_moves_the_anomaly_score`. Exposure and fault are two different
# claims, and the moment working an engine hard starts raising an anomaly score,
# every busy crossing lights the strip and the crew learns to ignore it.

RATED = 2800.0
CRUISE_RPM = 1680.0  # 0.60 of rating -> the 'cruise' band
OVERLOAD_RPM = 2750.0  # 0.98 of rating -> the 'overload' band


def test_duty_is_omitted_without_a_rated_rpm():
    status = detect(make_window(rpm=OVERLOAD_RPM), BASELINE, vessel_id="v")
    assert status.duty is None


def test_duty_is_omitted_when_frames_carry_no_load_channel():
    status = detect(make_window(), BASELINE, vessel_id="v", rated_rpm=RATED)
    assert status.duty is None


def test_duty_is_omitted_rather_than_reported_as_zero_severity():
    """A single frame spans no interval, so no running hours accumulate.

    Reporting that as severity 0.0 would read as *gentler than idle* on a scale
    whose lightest band is 0.35 -- an absent measurement dressed as a good one.
    """
    status = detect(make_window(n=1, rpm=CRUISE_RPM), BASELINE, vessel_id="v", rated_rpm=RATED)
    assert status.duty is None


def test_duty_names_the_band_the_engine_ran_in():
    status = detect(make_window(rpm=CRUISE_RPM), BASELINE, vessel_id="v", rated_rpm=RATED)
    assert status.duty is not None
    assert status.duty.dominant_band == "cruise"
    assert status.duty.severity_index == pytest.approx(1.0, abs=1e-3)
    assert status.duty.running_hours > 0


def test_hard_running_raises_severity_and_is_said_out_loud():
    status = detect(make_window(rpm=OVERLOAD_RPM), BASELINE, vessel_id="v", rated_rpm=RATED)
    assert status.duty is not None
    assert status.duty.dominant_band == "overload"
    assert status.duty.severity_index > 2.0
    assert "overload" in status.advisory_en.lower()
    assert "2.6" in status.advisory_en


def test_cruise_running_says_nothing_about_duty():
    """The exposure note must not fire on an ordinary working day.

    A line that appears on every crossing is a line nobody reads, and this one
    shares the advisory with real anomalies.
    """
    status = detect(make_window(rpm=CRUISE_RPM), BASELINE, vessel_id="v", rated_rpm=RATED)
    assert status.duty is not None and status.duty.severity_index == pytest.approx(1.0, abs=1e-3)
    assert "cruise" not in status.advisory_en.lower()
    assert "wearing" not in status.advisory_en.lower()


def test_duty_never_moves_the_anomaly_score():
    """Working an engine hard is exposure, not a fault. Same frames, same score.

    The only difference between these two calls is whether the caller supplied a
    rating -- that is, whether duty could be computed at all. If the scores ever
    diverge, duty has leaked into the detector.
    """
    frames = make_window(rpm=OVERLOAD_RPM)
    with_duty = detect(frames, BASELINE, vessel_id="v", rated_rpm=RATED)
    without = detect(frames, BASELINE, vessel_id="v")
    assert with_duty.duty is not None and without.duty is None
    assert with_duty.anomaly_score == without.anomaly_score
    assert with_duty.is_anomalous == without.is_anomalous


def test_duty_clause_yields_to_an_actual_finding():
    """A deviating stream owns the sentence; exposure steps aside.

    Both at once ran past the advisory guard's length limit, and a captain
    reading about wear rates while the coolant walks away is being asked to
    triage two things to act on one.
    """
    status = detect(
        make_window(n=40, coolant=95.0, rpm=OVERLOAD_RPM),
        BASELINE,
        vessel_id="v",
        rated_rpm=RATED,
    )
    assert status.is_anomalous
    assert status.duty is not None and status.duty.severity_index > 2.0
    assert "coolant" in status.advisory_en.lower()
    assert "wearing" not in status.advisory_en.lower()


def test_duty_survives_missing_engine_health_channels():
    """An RPM pickup with no coolant probe is a real retrofit, not an error."""
    frames = [
        TelemetryFrame(
            vessel_id="v",
            ts=TS0 + timedelta(seconds=i),
            throttling=ThrottlingFrame(engine_rpm=OVERLOAD_RPM),
        )
        for i in range(10)
    ]
    status = detect(frames, BASELINE, vessel_id="v", rated_rpm=RATED)
    assert status.streams == []
    assert status.duty is not None and status.duty.dominant_band == "overload"
    assert "no engine-health" in status.advisory_en.lower()
    assert "overload" in status.advisory_en.lower()


def test_duty_does_not_promote_the_status_out_of_phase_1():
    status = detect(make_window(rpm=OVERLOAD_RPM), BASELINE, vessel_id="v", rated_rpm=RATED)
    assert status.phase is MaintenancePhase.PHASE_1_COLD_START
    assert status.likely_component is None
    assert status.remaining_useful_life_days is None
    assert status.recommended_maintenance_date is None


@pytest.mark.parametrize("rpm", [400.0, 900.0, CRUISE_RPM, 2100.0, OVERLOAD_RPM])
@pytest.mark.parametrize("coolant", [82.0, 95.0])
def test_every_advisory_branch_fits_the_advisory_guard(rpm: float, coolant: float):
    """Every sentence this detector can emit must be rewritable by Claude.

    `guard.MAX_CHARS` is applied to the *rewrite*, so a template that overruns it
    cannot be rephrased at all -- the guard rejects every candidate as too long
    and `advisory_source` silently pins to "template" forever. That failure is
    invisible from the outside, which is why it is pinned here rather than
    noticed later.
    """
    status = detect(
        make_window(n=40, coolant=coolant, rpm=rpm), BASELINE, vessel_id="v", rated_rpm=RATED
    )
    for sentence in (status.advisory_en, status.advisory_fil):
        assert len(sentence) <= MAX_CHARS, f"{len(sentence)} chars: {sentence}"
        assert rejection_reason(sentence, sentence) is None
