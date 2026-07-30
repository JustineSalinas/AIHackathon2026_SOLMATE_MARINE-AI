"""Voyage records and the monthly emissions report.

Problem 3's deliverable is not a number, it is **evidence**: something an
operator can hand to an LGU, MARINA, or a green-finance lender and have it hold
up. That changes what these models have to carry. A report that says "we avoided
412 kg of CO2" is worthless; a report that says what the figure was measured
against, how many voyages it covers, and which of those voyages had no valid
baseline is auditable.

So every model here is built around one idea: **the baseline is the claim.**
`BaselineMethod` is not metadata, it is the load-bearing field. A report with
`method="none"` reports fuel and CO2 and explicitly declines to report avoided
CO2, because with no baseline there is nothing to have avoided it against.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class BaselineMethod(StrEnum):
    """How "what the vessel would otherwise have burned" was established.

    Ordered by how much an auditor should trust it, best first.
    """

    OWN_PRIOR_ROUTE = "own_prior_route"
    """The vessel's own recorded burn on the same route before Marine-AI advice
    was followed. The only comparison an operator will believe and an auditor can
    check, and the one the technical profile promises."""

    COUNTERFACTUAL_MODEL = "counterfactual_model"
    """The fuel model's estimate of the same voyage at the throttle the captain
    actually held, against the advised throttle. Weaker than the above: it is a
    model comparing itself to itself, and the report says so."""

    NONE = "none"
    """No baseline. Fuel and CO2 are still reported; avoided CO2 is not."""


class VoyageRecord(BaseModel):
    """One completed crossing, as stored.

    Deliberately small and flat. This is the unit an emissions report aggregates
    and the unit a regulator would sample, so it holds the numbers and their
    provenance and nothing else -- no telemetry, no model internals.
    """

    model_config = ConfigDict(extra="forbid")

    voyage_id: str
    vessel_id: str

    departed_at: datetime
    arrived_at: datetime

    origin_name: str | None = None
    destination_name: str | None = None
    distance_nm: float = Field(ge=0)

    fuel_used_l: float = Field(ge=0, description="Actually burned, integrated from the fuel model.")
    baseline_fuel_l: float | None = Field(
        None,
        ge=0,
        description="What the same voyage would have burned without Marine-AI. "
        "None when no baseline could be established.",
    )
    baseline_method: BaselineMethod = BaselineMethod.NONE

    passenger_count: int = Field(0, ge=0)
    cargo_kg: float = Field(0.0, ge=0)

    source: str = Field(
        "simulator",
        description="Provenance. 'simulator' for every record in the hackathon build -- "
        "no hardware was used. Never silently defaults to 'sensor'.",
    )

    @property
    def duration_hours(self) -> float:
        return max(0.0, (self.arrived_at - self.departed_at).total_seconds() / 3600.0)


class EmissionsReportLine(BaseModel):
    """One voyage as it appears on the report."""

    model_config = ConfigDict(extra="forbid")

    voyage_id: str
    departed_at: datetime
    route: str
    distance_nm: float
    fuel_used_l: float
    co2_kg: float
    baseline_fuel_l: float | None = None
    co2_avoided_kg: float | None = None
    baseline_method: BaselineMethod


class EmissionsReport(BaseModel):
    """A month of voyages, totalled, with its own limitations attached.

    `caveats` is not decoration. Any voyage without a baseline is excluded from
    the avoided-CO2 total and named here, so the headline figure and the reason
    it is smaller than the voyage count travel together and cannot be separated
    by someone quoting the report.
    """

    model_config = ConfigDict(extra="forbid")

    vessel_id: str
    year: int
    month: int = Field(ge=1, le=12)
    generated_at: datetime

    voyages: int = Field(ge=0)
    distance_nm: float = Field(ge=0)
    fuel_used_l: float = Field(ge=0)
    co2_kg: float = Field(ge=0)

    co2_avoided_kg: float | None = Field(
        None,
        description="Against the stated baseline. May be NEGATIVE -- a month that burned "
        "more than baseline is a real month and is reported as such, never floored at zero. "
        "None when no voyage in the month had a baseline.",
    )
    voyages_with_baseline: int = Field(0, ge=0)
    baseline_method: BaselineMethod = BaselineMethod.NONE

    emission_factor_kg_per_l: float = Field(
        description="Tank-to-wake combustion factor used. A constant of chemistry, "
        "not a tuned parameter."
    )

    lines: list[EmissionsReportLine] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)

    advisory_only: bool = Field(
        True,
        description="Constant by design. This is an operational record, not a certified "
        "emissions inventory, and must not be presented as one.",
    )
