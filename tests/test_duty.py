"""Tests for the derived features the profile calls the Problem 1 -> Problem 2 link.

`test_thrashed_engine_scores_worse_than_a_gently_run_one` is the whole point: if
running hard did not raise the severity index, the feature would not encode the
link it exists to encode.

`test_severity_is_a_rate_not_a_total` guards the design decision underneath it --
an old engine run gently must be able to score better than a young one thrashed,
or the index is just a proxy for age and an operator can do nothing with it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from packages.contracts.telemetry import TelemetryFrame, ThrottlingFrame
from services.maintenance.duty import (
    LOAD_BANDS,
    SEVERITY_WEIGHTS,
    DutyCycle,
    band_for,
    duty_cycle,
    load_fraction,
)

TS = datetime(2026, 7, 26, 6, 0, tzinfo=UTC)
RATED = 2800.0


def frames(rpm: float, count: int, *, torque: float | None = None, step: int = 1):
    return [
        TelemetryFrame(
            vessel_id="v",
            ts=TS + timedelta(seconds=i * step),
            throttling=ThrottlingFrame(engine_rpm=rpm, engine_torque_nm=torque),
        )
        for i in range(count)
    ]


# --- Bands ------------------------------------------------------------------


def test_bands_cover_the_whole_range_without_gaps():
    for value in [i / 100 for i in range(101)]:
        assert band_for(value) in SEVERITY_WEIGHTS


def test_bands_are_named_as_an_operator_would():
    assert band_for(0.05) == "idle"
    assert band_for(0.6) == "cruise"
    assert band_for(0.95) == "overload"
    # Clamped rather than crashing on an out-of-range reading.
    assert band_for(-1.0) == "idle"
    assert band_for(2.0) == "overload"


def test_all_bands_have_a_weight():
    assert {name for name, _, _ in LOAD_BANDS} == set(SEVERITY_WEIGHTS)


def test_idle_is_gentler_than_cruise_but_not_free():
    """Extended low-load running glazes bores; a weight of zero would let a boat
    idle all day and report a perfect duty cycle."""
    assert 0 < SEVERITY_WEIGHTS["idle"] < SEVERITY_WEIGHTS["cruise"]


def test_overload_costs_more_than_proportionally():
    """The mechanism by which Problem 1 causes Problem 2."""
    assert SEVERITY_WEIGHTS["overload"] > 2 * SEVERITY_WEIGHTS["cruise"] * 0.8


# --- Load fraction ----------------------------------------------------------


def test_load_from_rpm_alone():
    frame = frames(1400.0, 1)[0]
    assert load_fraction(frame, RATED) == pytest.approx(0.5)


def test_torque_is_used_when_present():
    """The profile says torque is the stronger predictor; it must actually change
    the answer, or reading it is theatre."""
    rpm_only = load_fraction(frames(2800.0, 1)[0], RATED)
    lugging = load_fraction(frames(2800.0, 1, torque=60.0)[0], RATED)
    assert lugging is not None and rpm_only is not None
    assert lugging < rpm_only


def test_absent_throttling_contributes_nothing():
    assert load_fraction(TelemetryFrame(vessel_id="v", ts=TS), RATED) is None


# --- Accumulation -----------------------------------------------------------


def test_run_hours_accumulate_into_the_right_band():
    cycle = duty_cycle(frames(1680.0, 3601), rated_rpm=RATED)  # 0.6 -> cruise
    assert cycle.hours_by_band["cruise"] == pytest.approx(1.0, abs=1e-3)
    assert cycle.total_hours == pytest.approx(1.0, abs=1e-3)
    assert cycle.hours_by_band["overload"] == 0.0


def test_thrashed_engine_scores_worse_than_a_gently_run_one():
    thrashed = duty_cycle(frames(2750.0, 3601), rated_rpm=RATED)
    gentle = duty_cycle(frames(1400.0, 3601), rated_rpm=RATED)
    assert thrashed.severity_index > gentle.severity_index


def test_severity_is_a_rate_not_a_total():
    """Ten hours at cruise and one hour at cruise score the same."""
    short = duty_cycle(frames(1680.0, 601), rated_rpm=RATED)
    long = duty_cycle(frames(1680.0, 3601), rated_rpm=RATED)
    assert short.severity_index == pytest.approx(long.severity_index, abs=1e-3)
    assert long.weighted_hours > short.weighted_hours


def test_a_life_at_cruise_scores_one():
    cycle = duty_cycle(frames(1680.0, 3601), rated_rpm=RATED)
    assert cycle.severity_index == pytest.approx(SEVERITY_WEIGHTS["cruise"], abs=1e-3)


def test_empty_history_is_zero_not_an_error():
    cycle = DutyCycle()
    assert cycle.severity_index == 0.0
    assert duty_cycle([], rated_rpm=RATED).total_hours == 0.0


def test_a_gap_between_voyages_is_not_booked_as_run_hours():
    """Three days at the wharf must not appear as three days of running.

    The frame either side of the gap loses its own interval too, which is why
    this asserts a bound rather than equality with the ungapped run: an interval
    that cannot be trusted is dropped, not guessed at.
    """
    gapped = [
        *frames(1680.0, 5),
        TelemetryFrame(
            vessel_id="v",
            ts=TS + timedelta(days=3),
            throttling=ThrottlingFrame(engine_rpm=1680.0),
        ),
    ]
    total = duty_cycle(gapped, rated_rpm=RATED).total_hours
    assert total < 10 / 3600.0, "the three-day gap was integrated as run-hours"
    assert total > 0


def test_a_backwards_clock_is_dropped():
    out_of_order = [
        TelemetryFrame(
            vessel_id="v",
            ts=TS + timedelta(seconds=offset),
            throttling=ThrottlingFrame(engine_rpm=1680.0),
        )
        for offset in (0, -30)
    ]
    assert duty_cycle(out_of_order, rated_rpm=RATED).total_hours == 0.0


def test_negative_interval_is_rejected():
    with pytest.raises(ValueError):
        DutyCycle().accumulate(0.5, -1.0)
