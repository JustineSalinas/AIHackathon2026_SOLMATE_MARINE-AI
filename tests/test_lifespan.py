"""Component design life against accumulated wear.

There is no model here to be accurate about, so the claims worth testing are the
two places a life table can quietly mislead: reading a design life against the
wrong clock, and inventing a calendar it was never given.

The last test is the important one. It asserts the boundary that lets this module
name a component at all -- and that the anomaly detector next door still cannot.
"""

from __future__ import annotations

import pytest

from packages.contracts.maintenance import (
    ComponentCondition,
    MaintenancePhase,
    MaintenanceStatus,
)
from services.maintenance.lifespan import COMPONENT_LIFE_TABLE, resolve_component_life


def _part(report, component_id):
    return next(c for c in report.components if c.component_id == component_id)


def test_life_score_is_unspent_fraction_of_design_life():
    """Shaft life is 8000 wear-hours, so 2000 spent leaves three quarters."""
    r = resolve_component_life(vessel_id="V", wear_hours=2000, severity_index=1.0, hours_per_day=6)
    shaft = _part(r, "shaft")

    assert shaft.design_life_wear_hours == pytest.approx(8000.0)
    assert shaft.life_score == pytest.approx(0.75)
    assert shaft.percent_consumed == pytest.approx(25.0)
    assert shaft.condition is ComponentCondition.HEALTHY


def test_hard_duty_spends_design_life_sooner_in_run_hours():
    """The whole reason life is counted in wear-hours.

    Two boats with the same hours on the clock, one worked at cruise and one at
    overload, must not have the same shaft life left. If this ever stops holding,
    the severity index is decorative.
    """
    run_hours = 4000
    cruise = _part(
        resolve_component_life(vessel_id="V", wear_hours=run_hours * 1.0,
                               severity_index=1.0, hours_per_day=6), "shaft")
    overload = _part(
        resolve_component_life(vessel_id="V", wear_hours=run_hours * 2.6,
                               severity_index=2.6, hours_per_day=6), "shaft")

    assert cruise.life_score > overload.life_score
    assert cruise.condition is ComponentCondition.HEALTHY
    assert overload.condition is ComponentCondition.BEYOND_DESIGN_LIFE


def test_life_score_clamps_at_zero_rather_than_going_negative():
    """A component past its life is out of life, not negatively healthy.

    A negative score would render as a full bar on any width-percentage gauge,
    which is the one way this readout could show a spent part as a healthy one.
    """
    r = resolve_component_life(vessel_id="V", wear_hours=50000, severity_index=1.0, hours_per_day=6)

    assert all(c.life_score == 0.0 for c in r.components)
    assert all(c.wear_hours_remaining < 0 for c in r.components)
    assert r.beyond_design_life_count == len(COMPONENT_LIFE_TABLE)


def test_months_are_not_invented_without_duty_and_a_working_pattern():
    """A boat running two hours a day and one running twelve share no calendar."""
    no_pattern = resolve_component_life(vessel_id="V", wear_hours=2000, severity_index=1.0)
    no_duty = resolve_component_life(vessel_id="V", wear_hours=2000, hours_per_day=6)

    for r in (no_pattern, no_duty):
        assert r.severity_index is None
        assert r.hours_per_day is None
        assert all(c.months_remaining is None for c in r.components)
        assert "cannot be projected" in r.advisory_en


def test_months_remaining_uses_the_stated_working_pattern():
    """6000 wear-hours left, 6 h/day at cruise, is 6000 / (6*30*1.0) months."""
    r = resolve_component_life(vessel_id="V", wear_hours=2000, severity_index=1.0, hours_per_day=6)
    shaft = _part(r, "shaft")

    assert shaft.wear_hours_remaining == pytest.approx(6000.0)
    assert shaft.months_remaining == pytest.approx(6000 / (6 * 30 * 1.0), abs=0.1)


def test_unknown_renewal_history_errs_towards_renewing_early():
    """A component absent from the map counts from zero, not from now."""
    unknown = _part(resolve_component_life(vessel_id="V", wear_hours=9000,
                                           severity_index=1.0, hours_per_day=6), "shaft")
    renewed = _part(resolve_component_life(vessel_id="V", wear_hours=9000,
                                           severity_index=1.0, hours_per_day=6,
                                           wear_hours_at_last_renewal={"shaft": 9000.0}), "shaft")

    assert unknown.condition is ComponentCondition.BEYOND_DESIGN_LIFE
    assert renewed.condition is ComponentCondition.HEALTHY
    assert renewed.life_score == pytest.approx(1.0)


def test_weakest_component_leads_the_list():
    r = resolve_component_life(vessel_id="V", wear_hours=3000, severity_index=1.0, hours_per_day=6)

    assert r.weakest is r.components[0]
    assert r.components == sorted(r.components, key=lambda c: c.wear_hours_remaining)


def test_advisory_states_and_never_orders():
    """Same rule the advisory guard enforces: a console does not give commands."""
    for wear in (500, 5000, 9000, 40000):
        r = resolve_component_life(vessel_id="V", wear_hours=wear, severity_index=1.3, hours_per_day=8)
        first = r.advisory_en.split()[0].lower().strip(",.")
        assert first not in {"replace", "renew", "change", "stop", "dock", "service", "check"}
        assert r.advisory_fil


def test_every_component_row_is_usable():
    """Guards the committed table: a zero design life divides by zero downstream."""
    ids = [c.component_id for c in COMPONENT_LIFE_TABLE]
    assert len(ids) == len(set(ids)), "component_id must be unique"
    for c in COMPONENT_LIFE_TABLE:
        assert c.design_life_wear_hours > 0
        assert c.label_en and c.label_fil
        assert c.system in {"propulsion", "engine", "fuel", "electrical"}


def test_naming_a_component_here_does_not_unlock_it_in_phase_1():
    """The boundary this whole split exists to hold.

    ComponentLifeReport may name a part and quote months, because it is a lookup
    against a published design life. MaintenanceStatus still may not, because
    there it would be a forecast from failure history the vessel does not have.
    If the validator is ever loosened to accommodate this feature, this fails.
    """
    report = resolve_component_life(vessel_id="V", wear_hours=2500,
                                    severity_index=1.0, hours_per_day=6)
    assert report.weakest is not None
    assert report.weakest.label_en          # a part is named
    assert report.weakest.months_remaining  # and a horizon quoted

    with pytest.raises(ValueError, match="cannot make component-level claims"):
        MaintenanceStatus(
            vessel_id="V",
            generated_at="2026-08-04T00:00:00Z",
            phase=MaintenancePhase.PHASE_1_COLD_START,
            anomaly_score=0.2,
            is_anomalous=False,
            baseline_confidence=0.5,
            observed_hours=5000.0,
            streams=[],
            likely_component="Propeller shaft",   # still forbidden there
            advisory_en="x",
            advisory_fil="y",
        )
