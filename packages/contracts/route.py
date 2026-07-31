"""AI Route Optimization output contract.

The route is scored by the *same* fuel model that drives Speed Optimization.
That shared cost basis is the strongest architectural claim in the technical
profile, so `predicted_burn_l` on this model and `predicted_burn_lph` on
`SpeedRecommendation` must both come from `services/speed/fuel.py`, costed
through `services/speed/optimizer.py`. An integration test asserts they agree.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

Latitude = Annotated[float, Field(ge=-90, le=90)]
Longitude = Annotated[float, Field(ge=-180, le=180)]


class Waypoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    latitude: Latitude
    longitude: Longitude
    name: str | None = None

    eta: datetime | None = None
    leg_distance_nm: float | None = Field(None, ge=0)
    recommended_rpm: float | None = Field(
        None,
        ge=0,
        description="Per-leg throttle. Route and speed are solved together, not separately.",
    )

    # Forecast along this leg, from the TFT
    forecast_wind_kn: float | None = Field(None, ge=0)
    forecast_wave_height_m: float | None = Field(None, ge=0)
    forecast_current_kn: float | None = None

    min_depth_m: float | None = Field(
        None, ge=0, description="Shallowest charted depth on the approach to this waypoint."
    )


class RouteRecommendation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vessel_id: str
    voyage_id: str | None = None
    generated_at: datetime

    waypoints: list[Waypoint] = Field(min_length=2)
    total_distance_nm: float = Field(ge=0)
    eta: datetime
    achievable_minutes: float | None = Field(
        None,
        ge=0,
        description=(
            "Crossing time the hull can actually achieve, summed from each leg's "
            "optimised speed. Always populated where a speed was found. When a "
            "schedule was requested, `eta` is the arrival that was ASKED FOR -- legs "
            "are planned at the required speed-over-ground -- so where "
            "schedule_feasible is False the two differ and THIS is the honest one. "
            "None only when some leg admits no forward speed at all, where a "
            "crossing time does not exist rather than being very large."
        ),
    )
    predicted_burn_l: float = Field(ge=0, description="Whole-route burn, same fuel model as Speed.")

    # The delta against the obvious alternative
    baseline_distance_nm: float | None = Field(
        None,
        ge=0,
        description="Great-circle direct route -- what the captain would otherwise steer.",
    )
    baseline_burn_l: float | None = Field(None, ge=0)
    savings_l: float | None = Field(
        None, description="baseline_burn_l - predicted_burn_l. May be negative; show it honestly."
    )

    # Constraints that shaped the answer -- shown so the captain can overrule knowingly
    depth_constrained: bool = Field(
        False, description="True if a shallower, shorter route was rejected on depth."
    )
    weather_constrained: bool = Field(
        False, description="True if a route was rejected on forecast wave height."
    )
    constraint_notes: list[str] = Field(default_factory=list)

    forecast_source: str = Field(
        "tft", description="'tft' or 'gbm_fallback'. Recorded so the deck and the code agree."
    )
    model_confidence: float = Field(ge=0, le=1)

    advisory_en: str
    advisory_fil: str
    advisory_source: str = "template"
