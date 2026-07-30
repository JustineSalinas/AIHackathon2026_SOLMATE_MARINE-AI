"""Tests for the rule-based safety cutoffs.

Three of these carry more weight than the rest.

`test_stopped_engine_does_not_trip_pressure_or_charging_rules` is the false-alarm
test. A safety layer that fires two criticals on every healthy boat sitting at
the wharf would be silenced by the crew within a week, and a silenced alarm
protects nobody.

`test_absent_sensor_is_skipped_not_assumed_safe` is the honesty test. The
contract has `skipped_rules` precisely so a modular retrofit missing a channel
cannot read as a healthy engine.

`test_evaluation_is_deterministic` is the claim the whole module exists to
support: the profile calls the AI-authority boundary non-negotiable and promises
deterministic, auditable behaviour under fault.
"""

from __future__ import annotations

from datetime import UTC, datetime

from packages.contracts.safety import Severity
from packages.contracts.telemetry import (
    ElectroMechanicalFrame,
    TelemetryFrame,
    ThrottlingFrame,
)
from services.safety import RULES, evaluate

TS = datetime(2026, 7, 26, 6, 0, tzinfo=UTC)

# A warm, healthy engine at cruise. Matches the demo vessel's operating point.
HEALTHY = dict(
    coolant_temp_c=82.0,
    oil_pressure_kpa=350.0,
    battery_voltage_v=13.8,
    exhaust_gas_temp_c=380.0,
)


def frame(*, rpm: float | None = 1900.0, **overrides) -> TelemetryFrame:
    values = {**HEALTHY, **overrides}
    return TelemetryFrame(
        vessel_id="MV-DEMO-01",
        ts=TS,
        throttling=ThrottlingFrame(engine_rpm=rpm),
        electro_mechanical=ElectroMechanicalFrame(**values),
    )


# --- Nominal ----------------------------------------------------------------


def test_healthy_engine_raises_nothing():
    state = evaluate(frame())
    assert state.severity is Severity.NOMINAL
    assert state.active == []
    assert state.evaluated_rules == len(RULES)
    assert state.skipped_rules == []


# --- Over-temperature -------------------------------------------------------


def test_coolant_warning_then_critical():
    warning = evaluate(frame(coolant_temp_c=99.0))
    assert warning.severity is Severity.WARNING
    assert warning.active[0].rule_id == "coolant_overtemp"

    critical = evaluate(frame(coolant_temp_c=108.0))
    assert critical.severity is Severity.CRITICAL
    assert critical.active[0].rule_id == "coolant_overtemp"


def test_cutoff_carries_the_numbers_it_judged_on():
    """A cutoff a captain cannot check is a cutoff a captain will not trust."""
    state = evaluate(frame(coolant_temp_c=108.0))
    cutoff = state.active[0]
    assert cutoff.observed == 108.0
    assert cutoff.threshold == 105.0
    assert cutoff.unit == "C"
    assert "108" in cutoff.message_en
    assert cutoff.message_fil and cutoff.message_fil != cutoff.message_en


# --- Low oil pressure -------------------------------------------------------


def test_low_oil_pressure_trips_and_over_pressure_does_not():
    """The profile says 'over-pressure'; the failure mode is the low side.

    Documented as a deviation. This test pins the corrected behaviour so nobody
    'fixes' it back to match the document.
    """
    assert evaluate(frame(oil_pressure_kpa=80.0)).severity is Severity.CRITICAL
    assert evaluate(frame(oil_pressure_kpa=180.0)).severity is Severity.WARNING
    assert evaluate(frame(oil_pressure_kpa=600.0)).severity is Severity.NOMINAL


# --- Battery ----------------------------------------------------------------


def test_battery_low_and_high_both_trip():
    assert evaluate(frame(battery_voltage_v=11.8)).severity is Severity.CRITICAL
    assert evaluate(frame(battery_voltage_v=12.4)).severity is Severity.WARNING
    # A failed regulator is the one genuine over-voltage case.
    assert evaluate(frame(battery_voltage_v=16.0)).severity is Severity.CRITICAL


# --- Engine state -----------------------------------------------------------


def test_stopped_engine_does_not_trip_pressure_or_charging_rules():
    """At the wharf, zero oil pressure and a resting battery are correct."""
    state = evaluate(frame(rpm=0.0, oil_pressure_kpa=0.0, battery_voltage_v=12.4))
    assert state.severity is Severity.NOMINAL
    assert state.active == []


def test_stopped_engine_still_checks_coolant():
    """A hot soak after shutdown is real, and the sensor still reads."""
    state = evaluate(frame(rpm=0.0, coolant_temp_c=110.0))
    assert state.severity is Severity.CRITICAL
    assert state.active[0].rule_id == "coolant_overtemp"


def test_unknown_rpm_skips_the_rules_that_need_it():
    """With no RPM channel we cannot tell stopped from running, so we do not guess."""
    state = evaluate(frame(rpm=None))
    assert "oil_pressure_low" in state.skipped_rules
    assert "battery_voltage_low" in state.skipped_rules
    assert state.severity is Severity.NOMINAL


# --- Degraded inputs --------------------------------------------------------


def test_absent_sensor_is_skipped_not_assumed_safe():
    bare = TelemetryFrame(
        vessel_id="v",
        ts=TS,
        throttling=ThrottlingFrame(engine_rpm=1900.0),
        electro_mechanical=ElectroMechanicalFrame(coolant_temp_c=82.0),
    )
    state = evaluate(bare)
    assert state.evaluated_rules == 1
    assert "oil_pressure_low" in state.skipped_rules
    assert "exhaust_overtemp" in state.skipped_rules
    assert state.severity is Severity.NOMINAL


def test_no_engine_data_evaluates_nothing():
    state = evaluate(TelemetryFrame(vessel_id="v", ts=TS))
    assert state.evaluated_rules == 0
    assert len(state.skipped_rules) == len(RULES)
    assert state.severity is Severity.NOMINAL


# --- Ordering and determinism ----------------------------------------------


def test_critical_outranks_warning_in_the_active_list():
    """The display shows the top of this list; a warning must never bury a
    critical."""
    state = evaluate(frame(coolant_temp_c=99.0, oil_pressure_kpa=80.0))
    assert state.severity is Severity.CRITICAL
    assert state.active[0].severity is Severity.CRITICAL
    assert state.active[0].rule_id == "oil_pressure_low"
    assert state.active[-1].severity is Severity.WARNING


def test_evaluation_is_deterministic():
    f = frame(coolant_temp_c=101.0, oil_pressure_kpa=150.0)
    first = evaluate(f, now=TS)
    for _ in range(25):
        assert evaluate(f, now=TS).model_dump() == first.model_dump()


def test_safety_never_imports_a_model():
    """The AI-authority boundary, enforced rather than described.

    If someone ever reaches for the fuel map or the anomaly detector to make a
    cutoff 'smarter', this fails -- which is the point. A learned safety path is
    the one thing this system promised never to ship.
    """
    import services.safety.rules as module

    source = module.__file__
    assert source is not None
    with open(source, encoding="utf-8") as handle:
        text = handle.read()

    for forbidden in (
        "services.speed",
        "services.maintenance",
        "services.advisory",
        "onnxruntime",
        "numpy",
        "anthropic",
    ):
        assert forbidden not in text, f"safety rules must not depend on {forbidden}"
