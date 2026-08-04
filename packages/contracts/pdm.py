"""Predictive maintenance output contract, shaped to ISO 13374.

ISO 13374-1 defines six data-processing blocks for condition monitoring, and this
module is their output shapes. Naming them explicitly is not decoration: it means
a marine engineer can see which block produced a number on screen, and it forces
the design to keep them separate rather than collapsing "we noticed something"
into "we predict a failure".

    DA  Data Acquisition       sensor channels, cloud sea state, operator entries
    DM  Data Manipulation      condition-normalised residuals (services/maintenance/normalize.py)
    SD  State Detection        residual crosses a zone -> an anomaly record
    HA  Health Assessment      life score per component
    PA  Prognostic Assessment  weeks to failure, with a stated tolerance
    AG  Advisory Generation    what the operator should consider doing

**On the Phase 1 boundary.** `packages/contracts/maintenance.py` forbids a
cold-start vessel from naming a component or a repair date through
`MaintenanceStatus`, because there such a claim is a forecast from failure history
the vessel does not have. This is a separate contract, and it may name both --
but only because every figure it carries is traceable: a published design life, a
measured exposure, and a residual against this vessel's own learned normal. The
tolerance is what makes the prognosis honest rather than a guess dressed as a
number, so `weeks_to_failure` may not be set without it.

The Phase 1 validator is untouched. A test asserts it still rejects what it
always rejected.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator


class VesselSystem(StrEnum):
    """The four systems the vessel diagram is divided into."""

    PROPULSION = "propulsion"
    """Propeller, shaft, stern tube, rudder and steering gear."""

    ENGINE = "engine"
    """Prime mover: cylinders, cooling, lubrication, valve train."""

    FUEL = "fuel"
    """Tanks, filtration, delivery and injection."""

    ELECTRICAL = "electrical"
    """Generation, storage, starting and distribution."""


class HealthStatus(StrEnum):
    """ISO 13374 state-detection zones, in the words a crew would use.

    The standard speaks of "alert" and "alarm" zones; these are the same idea at
    the granularity a passenger-boat operator can act on.
    """

    NORMAL = "normal"
    """Behaving as this vessel normally does under these conditions."""

    ELEVATED = "elevated"
    """Deviating, but within what the sea state and load explain. Watch it."""

    DEGRADED = "degraded"
    """Deviating beyond what conditions explain. A real change of state."""

    SEVERE = "severe"
    """Large, sustained deviation, or a component past its design life."""


class DataQuality(StrEnum):
    """ISO 13374 requires DA, DM and SD to declare data quality, not assume it."""

    GOOD = "good"
    BAD = "bad"
    UNDETERMINED = "undetermined"
    """Not enough history to judge. The honest state early in a vessel's life."""


class ChannelResidual(BaseModel):
    """One sensor channel after the operating condition has been divided out.

    The DM block's output, and the reason this system can tell a working engine
    from a failing one. Raw vibration is high in a head sea and high with a worn
    bearing; the residual is high only for the bearing.
    """

    model_config = ConfigDict(extra="forbid")

    channel: str = Field(description="Internal stream key, e.g. 'vibration_rms_g'.")
    local_id: str = Field(
        description="ISO 19848 style DataChannelID, e.g. '/main-engine/vibration/rms'. "
        "Carried so an uploaded dataset and a live frame can name the same thing."
    )
    label_en: str
    label_fil: str

    measured: float
    expected: float = Field(
        description="What this vessel normally reads at THIS load and THIS sea state, "
        "from its own history. Not a manufacturer figure."
    )
    residual_sigma: float = Field(
        description="Deviation from expected, in standard deviations of the residual. "
        "This is the number the state detector scores -- never the raw reading."
    )
    condition_explained: bool = Field(
        description="True when the raw reading is unusual but the residual is not: "
        "the vessel is working hard, not failing."
    )


class AnomalyRecord(BaseModel):
    """A state-detection event, timestamped, for the operator's log."""

    model_config = ConfigDict(extra="forbid")

    observed_at: datetime
    channel: str
    label_en: str
    residual_sigma: float
    status: HealthStatus
    run_hours: float = Field(ge=0)
    note_en: str = Field(
        description="Why this was recorded rather than dismissed -- normally the "
        "conditions it could not be explained by."
    )
    note_fil: str


class ComponentHealth(BaseModel):
    """One component: how much life it has left, and when it runs out.

    `life_score` is the HA block. `weeks_to_failure` is the PA block. They are
    different claims and are kept as different fields on purpose: a component can
    be worn and predictable, or nearly new and deteriorating fast.
    """

    model_config = ConfigDict(extra="forbid")

    component_id: str
    label_en: str
    label_fil: str
    system: VesselSystem
    criticality: int = Field(
        ge=1, le=3,
        description="1 is highest. Drives ordering, so the part that strands a boat "
        "is read first rather than the part with the smallest number.",
    )

    life_score: float = Field(ge=0, le=1, description="Fraction of service life remaining.")
    design_life_wear_hours: float = Field(gt=0)
    wear_hours_consumed: float = Field(ge=0)

    weeks_to_failure: float | None = Field(
        None, ge=0,
        description="Projected weeks until this component reaches end of service life "
        "at the current duty and condition. None when it cannot be projected -- never "
        "a filled-in guess.",
    )
    weeks_tolerance: float | None = Field(
        None, ge=0,
        description="Plus or minus, in weeks. Widens with low baseline confidence and "
        "high residual variance, so a young engine honestly reports a wider window.",
    )

    status: HealthStatus
    contributing_channels: list[str] = Field(
        default_factory=list,
        description="Which residuals moved this component's score. An operator asking "
        "'why?' gets channels, not a black box.",
    )
    condition_factor: float = Field(
        1.0, gt=0,
        description="How much faster or slower than nominal this component is ageing, "
        "from its residuals. 1.0 is exactly as designed.",
    )

    @model_validator(mode="after")
    def _a_prognosis_needs_a_tolerance(self) -> ComponentHealth:
        """A number of weeks without a tolerance is a guess wearing a decimal point.

        ISO 13374's prognostic block predicts remaining life; it does not predict
        it exactly, and a projection stated without its uncertainty invites an
        operator to plan against a precision the data cannot support.
        """
        if self.weeks_to_failure is not None and self.weeks_tolerance is None:
            raise ValueError(
                "weeks_to_failure requires weeks_tolerance. A prognosis without a "
                "stated uncertainty is not a prognosis this system is allowed to make."
            )
        return self


class SystemAssessment(BaseModel):
    """One of the four systems, fully assessed. HA + SD + AG for that system."""

    model_config = ConfigDict(extra="forbid")

    system: VesselSystem
    label_en: str
    label_fil: str

    status: HealthStatus
    life_score: float = Field(ge=0, le=1, description="Weakest component governs.")

    components: list[ComponentHealth]
    residuals: list[ChannelResidual]
    anomalies: list[AnomalyRecord]

    analysis_en: str = Field(
        description="What the data says, including when it says the vessel is merely "
        "working hard. The AG block's reading of SD and HA together."
    )
    analysis_fil: str
    recommended_action_en: str = Field(
        description="Statement, never an order. An advisory system that gives commands "
        "is a system that has taken command."
    )
    recommended_action_fil: str


class PdmReport(BaseModel):
    """The whole vessel: four systems, assessed together.

    Carries its provenance rather than implying it. `data_quality` is the ISO 13374
    requirement that acquisition and detection declare how much they trust their own
    inputs; `baseline_confidence` and `history_rows` say how much of this vessel's
    normal has actually been learned.
    """

    model_config = ConfigDict(extra="forbid")

    vessel_id: str
    generated_at: datetime

    run_hours: float = Field(ge=0)
    wear_hours: float = Field(ge=0)
    severity_index: float | None = None

    systems: list[SystemAssessment]
    overall_status: HealthStatus
    data_quality: DataQuality

    baseline_confidence: float = Field(
        ge=0, le=1,
        description="How well this vessel's normal is established. Low early in life, "
        "and every tolerance widens to match.",
    )
    history_rows: int = Field(
        0, ge=0,
        description="Rows of historical data the condition models were fitted on, "
        "including any uploaded dataset. Zero means the models are priors, not fits.",
    )
    conforms_to: str = "ISO 13374-1 (DA/DM/SD/HA/PA/AG); channel IDs after ISO 19848"


class HistoryImportSummary(BaseModel):
    """What an uploaded historical dataset actually contributed.

    Reported rather than assumed. A file that parsed but mapped no recognised
    channels has improved nothing, and saying so is the difference between a
    feature and a placebo.
    """

    model_config = ConfigDict(extra="forbid")

    rows_received: int = Field(ge=0)
    rows_accepted: int = Field(ge=0)
    rows_rejected: int = Field(ge=0)
    channels_mapped: list[str]
    channels_unrecognised: list[str] = Field(
        default_factory=list,
        description="Column headers that matched no known channel or ISO 19848 LocalID. "
        "Listed so a mis-named column is visible rather than silently dropped.",
    )
    span_hours: float | None = Field(
        None, ge=0, description="Run-hours covered by the accepted rows, if derivable."
    )
    conditions_covered: dict[str, float] = Field(
        default_factory=dict,
        description="Spread of operating conditions in the upload. A residual model can "
        "only normalise for conditions it has seen: a dataset recorded entirely in calm "
        "water cannot teach it what rough weather looks like.",
    )
    models_refitted: list[str] = Field(default_factory=list)
    message_en: str
    message_fil: str
