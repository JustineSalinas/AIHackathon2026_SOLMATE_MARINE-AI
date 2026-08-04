"""How much of each component's design life this engine has spent.

The third thing in the maintenance module, and deliberately not the same as
either of its neighbours. `detector.py` watches condition and says which stream
is deviating right now. `duty.py` accumulates exposure. This file spends that
exposure against a published design life and says how much is left.

None of the three feeds another. A design life that moved because an anomaly
fired would be a prediction wearing a service manual's clothes, and this build
has no labelled failure history to predict from.

**Wear-hours, not run-hours.**

An hour at overload takes more out of a shaft than an hour at cruise. `duty.py`
already quantifies exactly that: its severity index is weighted wear-hours per
running hour, cruise fixed at 1.0, idle 0.35, overload 2.6. Multiply run-hours by
that index and you have wear-hours -- the component's real age rather than its
clock age -- and `DutyCycle.weighted_hours` is documented in that file as "the
denominator a Phase 2 RUL model would use". This is that denominator, put to work
without waiting for the RUL model.

The consequence is the product's Problem 1 -> Problem 2 story made concrete:

    shaft design life        8000 wear-hours
    boat run at cruise       reached after 8000 run-hours
    boat run at overload     reached after 3077 run-hours

Nobody is penalised by a model. The maker's life is read against the exposure the
vessel actually logged, and the arithmetic is one division.

**Why this may name a part when the detector may not.** `MaintenanceStatus`
forbids `likely_component` in Phase 1 because there it would be a forecast from
failure history the vessel does not have. Naming a part here is a lookup against
a published interval, which is a different kind of statement -- so it lives in a
different contract, and the Phase 1 validator is untouched. See the note above
`ComponentLife` in packages/contracts/maintenance.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from packages.contracts.maintenance import (
    ComponentCondition,
    ComponentLife,
    ComponentLifeReport,
)

MONITOR_FRACTION = 1 / 3
"""Below a third of design life left, a component reads MONITOR rather than
HEALTHY. Far enough out that a part can be sourced to a provincial port without
the boat waiting on it, which is the failure this threshold exists to prevent."""

RENEW_SOON_FRACTION = 0.10
"""Below a tenth, it reads RENEW SOON. Ordering time, not alarm time."""

DAYS_PER_MONTH = 30.0
"""Calendar month used for the months-remaining projection. Stated rather than
derived: a figure quoted to an operator in months should not depend on which
month it happens to be."""


@dataclass(frozen=True)
class MonitoredComponent:
    """One line of the maker's component life table."""

    component_id: str
    label_en: str
    label_fil: str
    system: str
    design_life_wear_hours: float


COMPONENT_LIFE_TABLE: tuple[MonitoredComponent, ...] = (
    MonitoredComponent(
        "shaft", "Propeller shaft and stern tube", "Shaft at stern tube",
        "propulsion", 8000.0,
    ),
    MonitoredComponent(
        "propeller", "Propeller", "Propela",
        "propulsion", 10000.0,
    ),
    MonitoredComponent(
        "rudder", "Rudder bearings", "Bearing ng timon",
        "propulsion", 12000.0,
    ),
    MonitoredComponent(
        "engine", "Engine to major overhaul", "Makina bago mag-overhaul",
        "engine", 10000.0,
    ),
    MonitoredComponent(
        "cooling", "Raw-water cooling circuit", "Sistema ng cooling",
        "engine", 6000.0,
    ),
    MonitoredComponent(
        "fuel_system", "Fuel injection system", "Sistema ng iniksyon ng krudo",
        "fuel", 6000.0,
    ),
    MonitoredComponent(
        "electrical", "Alternator and starting circuit", "Alternator at starter",
        "electrical", 5000.0,
    ),
)
"""Class-typical design lives for a small marine diesel vessel, in wear-hours.

**Class-typical, not vessel-specific**, and the display says so. These are the
lives a 200-300 HP marine diesel installation in coastal passenger service is
commonly given; a specific engine's manual overrides every line. They are
committed here as a table for the same reason engine reference figures are
committed in `apps/console/app.ts` rather than fetched: a number that feeds a
maintenance decision must be inspectable and identical on every run, and a
language model asked to recall a design life will confidently invent one.

`system` maps each component onto a block of the vessel diagram, so the drawing
carries the score rather than decorating it."""


def _condition(remaining: float, design_life: float) -> ComponentCondition:
    if remaining < 0:
        return ComponentCondition.BEYOND_DESIGN_LIFE
    fraction = remaining / design_life
    if fraction <= RENEW_SOON_FRACTION:
        return ComponentCondition.RENEW_SOON
    if fraction <= MONITOR_FRACTION:
        return ComponentCondition.MONITOR
    return ComponentCondition.HEALTHY


def resolve_component_life(
    *,
    vessel_id: str,
    wear_hours: float,
    severity_index: float | None = None,
    hours_per_day: float | None = None,
    wear_hours_at_last_renewal: dict[str, float] | None = None,
    generated_at: datetime | None = None,
) -> ComponentLifeReport:
    """Spend this engine's exposure against the component life table.

    `wear_hours_at_last_renewal` maps a component_id to the wear-hour reading when
    it was last renewed. A component missing from the map counts from zero, which
    is correct for a new install and the safe reading for an unknown history: it
    errs towards renewing early.

    `severity_index` and `hours_per_day` are only needed to turn wear-hours into
    calendar months. Without either, `months_remaining` is None on every component
    rather than filled from an assumed working pattern -- a boat that runs two
    hours a day and one that runs twelve do not share a service calendar, and
    guessing which is exactly the error this module exists to avoid.
    """
    now = generated_at or datetime.now(UTC)
    wear_hours = max(0.0, float(wear_hours))

    can_project = (
        severity_index is not None and severity_index > 0
        and hours_per_day is not None and hours_per_day > 0
    )
    # Wear-hours accrued per calendar month at the vessel's stated pattern. An
    # hour on the clock costs `severity_index` wear-hours, so a hard-worked boat
    # burns through a design life in fewer calendar months at the same hours/day.
    wear_per_month = (
        float(hours_per_day) * DAYS_PER_MONTH * float(severity_index) if can_project else None
    )

    last = wear_hours_at_last_renewal or {}
    components: list[ComponentLife] = []

    for spec in COMPONENT_LIFE_TABLE:
        consumed = max(0.0, wear_hours - float(last.get(spec.component_id, 0.0)))
        remaining = spec.design_life_wear_hours - consumed
        months = (remaining / wear_per_month) if (wear_per_month and remaining > 0) else None

        components.append(
            ComponentLife(
                component_id=spec.component_id,
                label_en=spec.label_en,
                label_fil=spec.label_fil,
                system=spec.system,
                design_life_wear_hours=spec.design_life_wear_hours,
                wear_hours_consumed=round(consumed, 2),
                wear_hours_remaining=round(remaining, 2),
                # Clamped at zero. A component past its life is out of life, not
                # negatively healthy, and a negative bar would render as a full one.
                life_score=round(max(0.0, min(1.0, remaining / spec.design_life_wear_hours)), 4),
                percent_consumed=round(100.0 * consumed / spec.design_life_wear_hours, 1),
                months_remaining=round(months, 1) if months is not None else None,
                condition=_condition(remaining, spec.design_life_wear_hours),
            )
        )

    # Least life first: the component a mechanic should look at leads the list.
    components.sort(key=lambda c: c.wear_hours_remaining)

    beyond = [c for c in components if c.condition is ComponentCondition.BEYOND_DESIGN_LIFE]
    weakest = components[0] if components else None
    advisory_en, advisory_fil = _advisory(weakest, len(beyond), can_project)

    return ComponentLifeReport(
        vessel_id=vessel_id,
        generated_at=now,
        wear_hours=round(wear_hours, 2),
        severity_index=round(float(severity_index), 4) if can_project else None,
        hours_per_day=round(float(hours_per_day), 2) if can_project else None,
        components=components,
        weakest=weakest,
        beyond_design_life_count=len(beyond),
        advisory_en=advisory_en,
        advisory_fil=advisory_fil,
    )


def _advisory(
    weakest: ComponentLife | None,
    beyond_count: int,
    can_project: bool,
) -> tuple[str, str]:
    """One sentence for the bridge, in both languages.

    Statement, never an order -- the rule `services/advisory/guard.py` enforces on
    the throttle line. "Shaft has about four months left" is a reading a skipper
    plans around; "Replace the shaft" is an instruction from a console that is not
    in command.
    """
    if weakest is None:
        return ("No component life table configured.", "Walang nakatakdang talaan ng bahagi.")

    if beyond_count:
        plural = "s" if beyond_count > 1 else ""
        return (
            f"{beyond_count} component{plural} past published design life — "
            f"{weakest.label_en} by {abs(weakest.wear_hours_remaining):.0f} wear-hours.",
            f"{beyond_count} bahagi ang lampas na sa itinakdang haba ng buhay — "
            f"{weakest.label_fil} nang {abs(weakest.wear_hours_remaining):.0f} wear-hours.",
        )

    pct = round(weakest.life_score * 100)
    if weakest.months_remaining is not None:
        return (
            f"Shortest life: {weakest.label_en} at {pct}% remaining, "
            f"about {weakest.months_remaining:.0f} months at this duty.",
            f"Pinakamaikling buhay: {weakest.label_fil}, {pct}% ang natitira, "
            f"mga {weakest.months_remaining:.0f} buwan sa ganitong bigat ng takbo.",
        )

    # No months, and the reason matters. Blaming missing duty data when duty was
    # supplied sends an operator looking for an input problem that is not there --
    # the component has simply reached its published life, which is the one case
    # where a horizon is genuinely not a number.
    if can_project:
        return (
            f"Shortest life: {weakest.label_en} has reached its published design life.",
            f"Pinakamaikling buhay: {weakest.label_fil} ay umabot na sa itinakdang haba ng buhay.",
        )

    return (
        f"Shortest life: {weakest.label_en} at {pct}% remaining. "
        f"Months cannot be projected without duty and running hours per day.",
        f"Pinakamaikling buhay: {weakest.label_fil}, {pct}% ang natitira. "
        f"Hindi matantiya ang buwan kung walang datos ng takbo kada araw.",
    )
