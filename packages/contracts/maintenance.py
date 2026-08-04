"""AI Predictive Maintenance output contract.

This model enforces the technical profile's cold-start fairness commitment as a
*validation rule*, not a convention. A Phase 1 unit -- any vessel with less than
roughly 24 months of labelled maintenance history -- physically cannot emit a
component name or a replacement date through this contract. The validator
rejects it.

The reason it is a validator and not a code review guideline: the failure mode
being guarded against is a well-meaning UI change, three days before a demo,
that surfaces a Phase 2 field because it happened to be non-null. Making it
unrepresentable is cheaper than remembering.
"""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator


class MaintenancePhase(StrEnum):
    """Maturity of this vessel's model. Not a global setting -- it is per vessel."""

    PHASE_1_COLD_START = "phase_1_cold_start"
    """Months 0-24. Unsupervised anomaly detection. Can say 'something is off' and
    which sensor stream is deviating. Cannot name a component or a date."""

    PHASE_2_MATURE = "phase_2_mature"
    """After ~24 months of labelled failure history. Supervised RUL per component."""


class AnomalyStream(BaseModel):
    """One sensor stream that is deviating from its learned baseline."""

    model_config = ConfigDict(extra="forbid")

    stream: str = Field(description="Field path, e.g. 'electro_mechanical.coolant_temp_c'.")
    label_en: str = Field(description="Plain language. 'Engine coolant temperature', not the path.")
    label_fil: str

    reconstruction_error: float = Field(
        ge=0,
        description="PCA reconstruction residual for this stream -- a linear "
        "autoencoder's error. See docs/DEVIATIONS.md for why PCA, not a deep net.",
    )
    z_score: float = Field(description="Deviation from the learned baseline, in sigmas.")
    contribution_pct: float = Field(
        ge=0,
        le=100,
        description="Share of the total anomaly score. Ranks the strip on the display.",
    )
    trend_minutes: float | None = Field(
        None,
        ge=0,
        description="How long this stream has been deviating. "
        "Drift reads differently from a spike.",
    )


class DutyCycleSummary(BaseModel):
    """How hard the engine was worked over the scored window.

    The profile (§3.3) names this the "literal data link between Problem 1
    (inefficiency) and Problem 2 (accelerated wear)": throttle badly and you do
    not merely burn more fuel, you spend the engine faster. This is that link
    reported as a number.

    **This is the window, not the engine's life.** `/maintenance` is stateless and
    is handed a minute or two of frames, so `running_hours` here is a fraction of
    an hour and means only "the span these frames cover". The profile's
    *cumulative* run-hours per band need an accumulator that outlives a request;
    that is not built (see docs/DEVIATIONS.md). What survives the window honestly
    is `severity_index`, which is normalised by running hours and so is a rate --
    comparable between a two-minute window and a two-year history.

    Nothing here is a Phase 2 claim. Exposure is arithmetic on telemetry the
    vessel already sent; it names no component and predicts no failure.
    """

    model_config = ConfigDict(extra="forbid")

    running_hours: float = Field(
        ge=0,
        description="Engine-running hours integrated in THIS window. Not a lifetime total.",
    )
    hours_by_band: dict[str, float] = Field(
        description="Running hours per load band within this window, keyed by band name."
    )
    severity_index: float = Field(
        ge=0,
        description="Weighted wear-hours per running hour. 1.0 is a window spent at "
        "cruise; above 1.0 is harder use. A rate, so it is window-length independent.",
    )
    weighted_hours: float = Field(
        ge=0, description="Wear-equivalent hours for this window: running hours x band weight."
    )
    dominant_band: str = Field(description="Band with the most hours; ties break toward harder.")
    dominant_label_en: str
    dominant_label_fil: str


class MaintenanceStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vessel_id: str
    generated_at: datetime
    phase: MaintenancePhase

    # --- Phase 1 and Phase 2 both populate these ---
    anomaly_score: float = Field(
        ge=0,
        le=1,
        description="0 nominal, 1 strongly anomalous. Ensemble of a robust per-stream "
        "z-score and a PCA reconstruction error; see docs/DEVIATIONS.md.",
    )
    is_anomalous: bool
    streams: list[AnomalyStream] = Field(
        default_factory=list, description="Ranked by contribution_pct, descending."
    )

    observed_hours: float = Field(
        ge=0, description="Run-hours of history behind this model. Drives the phase transition."
    )
    baseline_confidence: float = Field(
        ge=0,
        le=1,
        description="How well-established this vessel's normal is. Low early in Phase 1.",
    )

    duty: DutyCycleSummary | None = Field(
        None,
        description="Engine exposure over this window. None when the caller did not "
        "supply a rated RPM, since load is meaningless without a rating to divide by.",
    )

    # --- Phase 2 only. Must be None in Phase 1; see the validator below. ---
    likely_component: str | None = None
    likely_component_fil: str | None = None
    recommended_maintenance_date: date | None = None
    remaining_useful_life_days: float | None = Field(None, ge=0)
    rul_confidence_interval_days: tuple[float, float] | None = None
    required_parts: list[str] | None = None
    estimated_downtime_hours: float | None = Field(None, ge=0)

    advisory_en: str
    advisory_fil: str
    advisory_source: str = "template"

    @model_validator(mode="after")
    def _phase_1_cannot_claim_components(self) -> MaintenanceStatus:
        """A cold-start unit may not name a part or a date. Enforced, not trusted."""
        if self.phase is not MaintenancePhase.PHASE_1_COLD_START:
            return self

        phase_2_only = {
            "likely_component": self.likely_component,
            "likely_component_fil": self.likely_component_fil,
            "recommended_maintenance_date": self.recommended_maintenance_date,
            "remaining_useful_life_days": self.remaining_useful_life_days,
            "rul_confidence_interval_days": self.rul_confidence_interval_days,
            "required_parts": self.required_parts,
            "estimated_downtime_hours": self.estimated_downtime_hours,
        }
        populated = sorted(name for name, value in phase_2_only.items() if value is not None)
        if populated:
            raise ValueError(
                "Phase 1 (cold start) cannot make component-level claims. "
                f"Remove these fields or promote the vessel to Phase 2: {', '.join(populated)}. "
                "This is the profile's stated fairness commitment to operators, "
                "not an incidental constraint."
            )
        return self


# ---------------------------------------------------------------------------
# Component life: how much of each component's design life this engine has
# spent, and how long is left at the duty it is actually being worked at.
#
# A SEPARATE model from MaintenanceStatus, and deliberately outside the
# validator above.
#
# That validator stops a Phase 1 unit naming a component or putting a date on
# it, because under condition monitoring such a claim is a prediction the vessel
# has not earned -- there is no labelled failure history behind it. What follows
# names components and quotes months, but it is not that claim. It is a design
# life published by the maker, divided by the exposure this engine has logged.
# "Shaft at 62% of design life, about four months left at this duty" is
# arithmetic a mechanic can redo on paper. "The shaft will fail in four months"
# is a forecast, and nothing here says it.
#
# Keeping the two models apart is what stops that distinction eroding. Folding
# these fields into MaintenanceStatus would have meant loosening the Phase 1
# validator, and a loosened validator is one UI change away from a cold-start
# vessel publishing a Phase 2 claim.
# ---------------------------------------------------------------------------


class ComponentCondition(StrEnum):
    """Where a component sits against its design life."""

    HEALTHY = "healthy"
    """More than a third of design life remaining."""

    MONITOR = "monitor"
    """Between 10% and a third remaining. Plan the part."""

    RENEW_SOON = "renew_soon"
    """Under 10% remaining. Order it now."""

    BEYOND_DESIGN_LIFE = "beyond_design_life"
    """Past the published life. Running on borrowed time, which is a statement
    about the schedule and not a prediction that it is about to break."""


class ComponentLife(BaseModel):
    """One monitored component, scored against its published design life."""

    model_config = ConfigDict(extra="forbid")

    component_id: str = Field(description="Stable key, e.g. 'shaft'.")
    label_en: str = Field(description="Plain language. 'Propeller shaft'.")
    label_fil: str
    system: str = Field(
        description="Which block of the vessel diagram this belongs to: "
        "propulsion, engine, fuel or electrical."
    )

    design_life_wear_hours: float = Field(
        gt=0,
        description="The maker's published life, denominated in WEAR-hours rather "
        "than run-hours. See ComponentLifeReport for why.",
    )
    wear_hours_consumed: float = Field(ge=0)
    wear_hours_remaining: float = Field(
        description="Negative once past the published life. Signed on purpose: "
        "'40 hours over' is a different instruction from '40 hours left'."
    )

    life_score: float = Field(
        ge=0,
        le=1,
        description="Fraction of design life still unspent. 1.0 is new, 0.0 is "
        "spent. Clamped at zero -- a component past its life is not 'negatively "
        "healthy', it is simply out of life.",
    )
    percent_consumed: float = Field(ge=0)

    months_remaining: float | None = Field(
        None,
        ge=0,
        description="Calendar months to the end of design life at the CURRENT duty "
        "and the operator's stated running hours per day. None when either is "
        "unknown, rather than assuming a working pattern the vessel may not have.",
    )
    condition: ComponentCondition


class ComponentLifeReport(BaseModel):
    """Every monitored component, resolved against this engine's exposure.

    **Life is counted in wear-hours, not run-hours.** An hour at overload damages
    a shaft more than an hour at cruise; that is the premise of
    `services/maintenance/duty.py`, whose severity index is weighted wear-hours
    per running hour with cruise fixed at 1.0. Multiplying run-hours by that index
    gives wear-hours, and denominating design lives in wear-hours is what turns
    the index from a number on a dashboard into a service life that moves.

    Nothing here is learned. The design lives are a committed table, the weights
    are stated in duty.py and can be argued with, and the rest is division. That
    is the right amount of machinery for a claim a mechanic has to be able to
    check against a manual -- and the reason this report can name a part when the
    anomaly detector next door cannot.
    """

    model_config = ConfigDict(extra="forbid")

    vessel_id: str
    generated_at: datetime

    wear_hours: float = Field(ge=0, description="Exposure the report was resolved against.")
    severity_index: float | None = Field(
        None,
        description="Duty severity from duty.py. 1.0 is a life spent at cruise. "
        "None when unknown, in which case months remaining cannot be stated.",
    )
    hours_per_day: float | None = Field(
        None,
        description="Operator's stated typical running hours per day. The bridge "
        "between wear-hours and a calendar month.",
    )

    components: list[ComponentLife]
    weakest: ComponentLife | None = Field(
        None, description="Least life remaining. None if the table is empty."
    )
    beyond_design_life_count: int = Field(ge=0)

    advisory_en: str
    advisory_fil: str
