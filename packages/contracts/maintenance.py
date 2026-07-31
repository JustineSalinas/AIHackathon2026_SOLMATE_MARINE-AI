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
