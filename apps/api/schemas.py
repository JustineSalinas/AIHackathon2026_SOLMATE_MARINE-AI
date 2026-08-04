"""Wire models for the advisory API.

Split from `main.py` so the request/response shape is readable on its own and so
`packages/contracts/export_schema.py` can emit TypeScript for it alongside the
shared contracts.

Note the division of labour. `packages/contracts` holds models that cross module
boundaries inside the system -- telemetry, recommendations, bridge state -- and
is the single source of truth for those. The models here are HTTP-level: what a
client must send, and the extra diagnostic detail the simulator wants but the
bridge display does not. `SpeedRecommendation` is imported, never redefined.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from packages.contracts.route import RouteRecommendation
from packages.contracts.speed import SpeedRecommendation
from packages.contracts.telemetry import TelemetryFrame

PASSENGER_MASS_KG = 70.0
"""Average mass added per passenger, including baggage.

Philippine adult mean body mass is nearer 60 kg; the balance is what people
carry onto a short-haul passenger boat. Load matters because displacement enters
the resistance model directly -- a full boat is a slower, thirstier boat, and
the profile lists passenger count as an operator input for exactly this reason."""


class VesselInput(BaseModel):
    """Hull and engine, from `VesselProfile` plus the hull-form fields the
    resistance model needs. One-time operator entry in production."""

    model_config = ConfigDict(extra="forbid")

    vessel_id: str = "MV-DEMO-01"

    length_waterline_m: float = Field(11.5, gt=0)
    beam_m: float = Field(2.8, gt=0)
    draft_m: float = Field(1.1, gt=0)
    displacement_kg: float = Field(8500.0, gt=0)

    rated_kw: float = Field(90.0, gt=0)
    rated_rpm: float = Field(2800.0, gt=0)

    admiralty_coefficient: float = Field(
        70.0, gt=0, description="Primary calibration handle; fit per vessel from its own runs."
    )
    best_bsfc_g_per_kwh: float = Field(215.0, gt=0)
    idle_burn_lph: float = Field(1.2, ge=0)


class SeaInput(BaseModel):
    """Conditions at the vessel.

    Sign convention matches `services/speed/resistance.py` and is repeated here
    because getting it backwards silently inverts every recommendation:
    wind blows FROM `wind_direction_deg`, current flows TOWARD
    `current_direction_deg`.
    """

    model_config = ConfigDict(extra="forbid")

    wind_speed_kn: float = Field(0.0, ge=0)
    wind_direction_deg: float = Field(0.0, ge=0, lt=360)
    current_speed_kn: float = Field(0.0, ge=0)
    current_direction_deg: float = Field(0.0, ge=0, lt=360)
    wave_height_m: float = Field(0.0, ge=0)
    wave_direction_deg: float | None = Field(None, ge=0, lt=360)


class AdviseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vessel: VesselInput = Field(default_factory=VesselInput)
    sea: SeaInput = Field(default_factory=SeaInput)

    heading_deg: float = Field(0.0, ge=0, lt=360)
    distance_remaining_nm: float = Field(2.0, gt=0)
    minutes_available: float | None = Field(
        None, gt=0, description="ETA constraint. None means optimise fuel per mile alone."
    )

    current_rpm: float | None = Field(None, ge=0)
    passenger_count: int = Field(0, ge=0)
    cargo_kg: float = Field(0.0, ge=0)

    egt_excess_ratio: float | None = Field(
        None,
        gt=0,
        description="Measured exhaust gas temperature over this vessel's own healthy "
        "baseline at the same load. 1.0 is as-new. None means engine condition unknown.",
    )
    php_per_litre: float | None = Field(70.0, gt=0)

    @property
    def added_load_kg(self) -> float:
        return self.passenger_count * PASSENGER_MASS_KG + self.cargo_kg


class LatLonInput(BaseModel):
    """A position an operator picks on a chart. Degrees, WGS84."""

    model_config = ConfigDict(extra="forbid")

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    name: str | None = None


class RouteRequest(BaseModel):
    """Two points and a schedule. The conditions are not sent: the route is
    planned against the forecast field along the track, not a single sea state
    the way `/advise` is -- that is the whole difference between the two products.
    """

    model_config = ConfigDict(extra="forbid")

    vessel: VesselInput = Field(default_factory=VesselInput)
    origin: LatLonInput
    destination: LatLonInput

    depart_at: datetime | None = Field(
        None, description="Departure time; the forecast is read forward from it. None means now."
    )
    minutes_available: float | None = Field(
        None,
        gt=0,
        description="ETA budget for the whole voyage. None optimises fuel per mile, no schedule.",
    )

    passenger_count: int = Field(0, ge=0)
    cargo_kg: float = Field(0.0, ge=0)
    egt_excess_ratio: float | None = Field(
        None,
        gt=0,
        description="Exhaust temperature over this vessel's healthy baseline. 1.0 is as-new.",
    )

    @property
    def added_load_kg(self) -> float:
        return self.passenger_count * PASSENGER_MASS_KG + self.cargo_kg


class MaintenanceRequest(BaseModel):
    """A window of recent telemetry to score for anomalies.

    The frame is the system's atomic unit (`packages/contracts/telemetry.py`), so
    the window is sent as frames rather than a bespoke reading shape -- the same
    objects the ingest path and the bridge already handle. Only the
    electro-mechanical channels are read; the rest may be absent.
    """

    model_config = ConfigDict(extra="forbid")

    vessel_id: str = "MV-DEMO-01"
    frames: list[TelemetryFrame] = Field(
        min_length=1, description="Recent frames, oldest first. A minute or two is plenty."
    )
    baseline_frames: list[TelemetryFrame] | None = Field(
        None,
        description="Frames the caller asserts are HEALTHY for this vessel. Supplied, "
        "the detector fits a baseline to this engine instead of scoring against the "
        "served reference engine -- which is the difference between 'deviating from "
        "its own normal' and 'not being the demo engine'. Omit to use the default.",
    )
    observed_hours: float | None = Field(
        None,
        ge=0,
        description="This vessel's run-hours, which set cold-start confidence. "
        "None uses the baseline's own history count.",
    )
    rated_rpm: float | None = Field(
        None,
        gt=0,
        description="Engine rated RPM, which turns the frames' RPM and torque into "
        "a load fraction and so enables the duty-cycle summary. None omits that "
        "section rather than assuming a rating.",
    )


class ComponentLifeRequest(BaseModel):
    """Engine exposure to resolve the component life table against.

    Note what this does NOT take: telemetry frames. Component life is arithmetic
    on accumulated wear, so it needs exposure and a renewal history, not a window
    of readings. Sending frames would invite the life table to start reacting to
    condition, which is the detector's job and a much stronger claim.
    """

    model_config = ConfigDict(extra="forbid")

    vessel_id: str = "MV-DEMO-01"
    wear_hours: float = Field(
        ge=0,
        description="Cumulative wear-equivalent hours: run-hours weighted by the load "
        "the engine was at, per services/maintenance/duty.py. The denominator of "
        "every figure in the response.",
    )
    severity_index: float | None = Field(
        None,
        gt=0,
        description="Duty severity, where 1.0 is a life spent at cruise. Needed only "
        "to convert wear-hours into calendar months.",
    )
    hours_per_day: float | None = Field(
        None,
        gt=0,
        description="Operator's stated typical running hours per day. Without it, and "
        "without severity, months remaining is omitted rather than filled from an "
        "assumed working pattern -- a boat running two hours a day and one running "
        "twelve do not share a service calendar.",
    )
    wear_hours_at_last_renewal: dict[str, float] | None = Field(
        None,
        description="Wear-hour reading when each component was last renewed, keyed by "
        "component_id. Absent means never renewed -- the safe reading for an unknown "
        "history, since it errs towards renewing early.",
    )


class SafetyRequest(BaseModel):
    """A single frame to check against the rule set.

    One frame, not a window. A cutoff must fire on the reading in front of it;
    see `services/safety/rules.py` for why averaging would be actively unsafe
    here even though it is correct for the anomaly detector next door.
    """

    model_config = ConfigDict(extra="forbid")

    vessel_id: str | None = None
    frame: TelemetryFrame


class PowerOut(BaseModel):
    """Itemised shaft power. Shown so a recommendation can explain itself --
    "you are punching a 1.4 m head sea" rather than an unexplained number."""

    total_kw: float
    calm_water_kw: float
    wind_kw: float
    wave_kw: float
    speed_through_water_kn: float
    environmental_penalty_pct: float


class WearOut(BaseModel):
    """Engine condition, priced. The Problem 1 -> Problem 2 link, per hour."""

    multiplier: float = Field(description="1.0 as-new; 1.08 means 8% more fuel for the same work.")
    penalty_lph: float
    penalty_php_per_hour: float | None = None


class EmissionsOut(BaseModel):
    co2_kg_per_hour: float
    co2_kg_per_nm: float | None = None


class CurvePoint(BaseModel):
    """One sample of the speed/burn curve.

    The whole curve is returned so the browser can interpolate between API calls
    at 60fps without reimplementing the physics. There is one fuel model in this
    system and it is in Python; the display consumes it and never recomputes it.
    """

    speed_kn: float
    rpm: float
    shaft_kw: float
    litres_per_hour: float


class AdviseResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recommendation: SpeedRecommendation
    power: PowerOut
    wear: WearOut
    emissions: EmissionsOut
    curve: list[CurvePoint]

    achievable_speed_kn: float | None = Field(
        None,
        description="Speed the vessel actually makes at current_rpm in these conditions. "
        "Not a function of throttle alone -- weather slows the boat.",
    )
    max_speed_kn: float = Field(description="Fastest this engine can drive this hull right now.")

    feasible: bool = Field(description="False when the schedule cannot be met at any throttle.")
    notes: list[str] = Field(default_factory=list)

    model_trained: bool = Field(
        description="False when no wear artifact is loaded; engine is then assumed healthy "
        "and confidence is reduced accordingly."
    )


class RouteResponse(BaseModel):
    """The route recommendation plus the two facts the display needs to caveat it.

    `RouteRecommendation` already carries the track, the burn, the honest baseline
    delta and the constraint flags. What it cannot say about itself is whether the
    engine could actually hold the schedule, or whether a trained wear model
    informed the burn -- both live here so the bridge can show them without
    re-deriving them."""

    model_config = ConfigDict(extra="forbid")

    recommendation: RouteRecommendation
    schedule_feasible: bool = Field(
        description="False when the engine cannot hold the required speed on some leg; "
        "the route is still the cheapest lawful track, but arrival will be late."
    )
    model_trained: bool = Field(
        description="False when no wear artifact is loaded; the fuel model then assumes a "
        "healthy engine."
    )
