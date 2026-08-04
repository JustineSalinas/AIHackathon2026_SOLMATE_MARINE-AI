"""Marine-AI advisory API.

    uvicorn apps.api.main:app --reload

One endpoint carries the product: `POST /advise` takes conditions and returns
the cheapest throttle that still meets the schedule, with the reasoning
itemised. Everything the bridge display shows comes from here.

Why the display calls an API rather than computing anything itself: there is one
fuel model in this system and it is in Python. A JavaScript reimplementation --
even a faithful one -- becomes a second model the moment either is edited, and
the version the judges see would drift from the version the tests cover. The
browser renders; it does not decide.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import TypeVar

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware

from apps.api.schemas import (
    AdviseRequest,
    AdviseResponse,
    CurvePoint,
    EmissionsOut,
    ComponentLifeRequest,
    HistoryUploadRequest,
    MaintenanceRequest,
    PdmRequest,
    PowerOut,
    RouteRequest,
    RouteResponse,
    SafetyRequest,
    WearOut,
)
from packages.contracts.emissions import EmissionsReport, VoyageRecord
from packages.contracts.maintenance import ComponentLifeReport, MaintenanceStatus
from packages.contracts.pdm import HistoryImportSummary, PdmReport
from packages.contracts.route import RouteRecommendation
from packages.contracts.safety import SafetyState
from packages.contracts.speed import SpeedRecommendation
from packages.store import VoyageStore, open_store
from services.advisory import phrase
from services.advisory import provider as advisory_provider
from services.emissions import co2_kg
from services.emissions.report import build_report, to_csv
from services.maintenance.baseline import fit_from_frames, synthetic_healthy_baseline
from services.maintenance.detector import detect
from services.maintenance.assess import assess as assess_pdm
from services.maintenance.history import parse_history_csv, refit_from_history
from services.maintenance.lifespan import resolve_component_life
from services.maintenance.normalize import ConditionModelSet, fit_condition_models
from services.route.forecast import load_forecast
from services.route.geo import LatLon
from services.route.planner import as_route_recommendation, plan_route
from services.safety import evaluate as evaluate_safety
from services.speed.fuel import EngineSpec, FuelMap
from services.speed.optimizer import (
    as_recommendation,
    optimise_throttle,
    performance_curve,
    power_for_rpm,
    speed_for_power_kn,
)
from services.speed.resistance import SeaState, VesselHull

logger = logging.getLogger(__name__)

# Make the documented `uvicorn apps.api.main:app` command actually see `.env`.
#
# Nothing else in the repository loads it, so before this the file was inert: a
# correctly pasted ANTHROPIC_API_KEY behaved exactly like a missing one, and
# because a missing key is a *supported* state the failure was silent -- every
# sentence shipped as `advisory_source: "template"` and `GET /health` still
# reported the layer as enabled. That is an expensive way to discover a working
# key on demo day.
#
# Deliberately optional. `requirements.txt` is the minimal serving image and
# python-dotenv is not in it; on Vercel the environment comes from project
# settings and there is no `.env` to read, so this import is expected to fail
# there. `load_dotenv` never overwrites a variable that is already set, so a
# real deployment environment always wins over a stray local file.
try:
    from dotenv import load_dotenv
except ImportError:  # serving image -- the platform supplies the environment
    pass
else:
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")

_state: dict[str, object] = {}

#: Any wire model carrying `advisory_en` / `advisory_fil` / `advisory_source`.
T = TypeVar("T", SpeedRecommendation, RouteRecommendation, MaintenanceStatus)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the trained wear model once, not per request.

    `FuelMap.load` degrades gracefully when the artifact is missing -- wear stays
    at 1.0 and confidence drops -- so a fresh clone boots and serves before
    anyone has run the trainer. `model_trained` on every response says which
    mode is active rather than leaving the client to guess.
    """
    _state["fuel_map_loaded"] = FuelMap.load(EngineSpec(rated_kw=90.0, rated_rpm=2800.0))
    # The forecaster is loaded once too. `load_forecast` degrades to the analytic
    # field when no trained artifact exists, so `/route` serves on a fresh clone.
    _state["forecast"] = load_forecast()
    # A demo maintenance baseline. In production this is a per-vessel baseline
    # fitted from that engine's own healthy history; the synthetic one lets
    # `/maintenance` answer before any real telemetry has been logged.
    _state["maintenance_baseline"] = synthetic_healthy_baseline()
    # Voyage records for the monthly emissions report. `open_store` degrades to
    # an in-memory store on a read-only filesystem -- the serverless case -- and
    # every report generated from it carries that fact in its caveats.
    _state["voyages"] = open_store()
    yield
    _state.clear()


app = FastAPI(
    title="Marine-AI Advisory API",
    version="0.1.0",
    summary="Conditions in, recommended throttle out. Advisory only.",
    lifespan=lifespan,
)

# Local dev ports for the bridge display. 3000 is the Next default; the others
# are there because a developer machine frequently already has something on it.
_DEFAULT_ORIGINS = [
    f"http://{host}:{port}"
    for host in ("localhost", "127.0.0.1")
    for port in (3000, 3100, 3001)
]
_origins = [
    origin.strip()
    for origin in os.environ.get("MARINE_AI_CORS_ORIGINS", "").split(",")
    if origin.strip()
]

# Preview deployments get a fresh hostname every push, so pinning the deployed
# display by exact origin means the preview link silently stops working. The
# regex covers them. This API is public, unauthenticated and read-only -- it
# holds no session and returns the same answer to anyone -- so a permissive
# origin policy gives away nothing that GET /advise does not already give away.
_origin_regex = os.environ.get("MARINE_AI_CORS_ORIGIN_REGEX") or r"https://.*\.vercel\.app"

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or _DEFAULT_ORIGINS,
    allow_origin_regex=_origin_regex,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _fuel_map_for(spec: EngineSpec) -> FuelMap:
    """Reuse the loaded wear model with this request's engine spec.

    The wear model is dimensionless -- it predicts a fuel *ratio*, not litres --
    so it transfers across engine specs unchanged. Only the BSFC baseline and
    the idle floor are per-vessel, and those live on `EngineSpec`.
    """
    loaded = _state.get("fuel_map_loaded")
    wear_model = getattr(loaded, "_wear_model", None)
    load_range = getattr(loaded, "_load_range", None)
    return FuelMap(spec, wear_model=wear_model, load_range=load_range)


async def _phrased(recommendation: T, *, kind: str) -> T:
    """Swap in Claude's wording of the advisory this object already carries.

    Applied here, at the boundary, rather than inside the services: the modules
    that decide stay deterministic, synchronous and model-free, and every test
    of `optimise_throttle`, `plan_route` and `detect` keeps asserting on the
    template it always did. What leaves the API is the same decision, better
    said -- and `advisory_source` names the author of the sentence in the frame.
    """
    phrasing = await phrase(
        kind=kind,
        template_en=recommendation.advisory_en,
        template_fil=recommendation.advisory_fil,
    )
    return recommendation.model_copy(
        update={
            "advisory_en": phrasing.en,
            "advisory_fil": phrasing.fil,
            "advisory_source": phrasing.source,
        }
    )


@app.get("/health")
async def health() -> dict:
    loaded = _state.get("fuel_map_loaded")
    return {
        "status": "ok",
        "wear_model_loaded": bool(getattr(loaded, "has_wear_model", False)),
        # Names the provider that *would* be asked, not one that has answered:
        # a key can be present and the account out of credit or over its rate
        # limit. Confirm the layer really works with a POST /advise and check
        # `advisory_source` -- see docs/DEPLOY.md section 4.
        "advisory_layer": advisory_provider() or "template",
        "advisory_only": True,
    }


@app.post("/advise", response_model=AdviseResponse)
async def advise(req: AdviseRequest) -> AdviseResponse:
    hull = VesselHull(
        length_waterline_m=req.vessel.length_waterline_m,
        beam_m=req.vessel.beam_m,
        draft_m=req.vessel.draft_m,
        displacement_kg=req.vessel.displacement_kg,
        admiralty_coefficient=req.vessel.admiralty_coefficient,
    )
    spec = EngineSpec(
        rated_kw=req.vessel.rated_kw,
        rated_rpm=req.vessel.rated_rpm,
        best_bsfc_g_per_kwh=req.vessel.best_bsfc_g_per_kwh,
        idle_burn_lph=req.vessel.idle_burn_lph,
    )
    fuel_map = _fuel_map_for(spec)

    sea = SeaState(
        wind_speed_kn=req.sea.wind_speed_kn,
        wind_direction_deg=req.sea.wind_direction_deg,
        current_speed_kn=req.sea.current_speed_kn,
        current_direction_deg=req.sea.current_direction_deg,
        wave_height_m=req.sea.wave_height_m,
        wave_direction_deg=req.sea.wave_direction_deg,
    )
    load = req.added_load_kg

    advice = optimise_throttle(
        hull,
        spec,
        fuel_map,
        sea,
        req.heading_deg,
        distance_remaining_nm=req.distance_remaining_nm,
        minutes_available=req.minutes_available,
        current_rpm=req.current_rpm,
        added_load_kg=load,
        egt_excess_ratio=req.egt_excess_ratio,
    )

    max_speed = speed_for_power_kn(hull, spec.rated_kw, sea, req.heading_deg, added_load_kg=load)

    # The honest speed: what the vessel actually makes at the throttle the
    # captain is holding, in the weather it is actually in.
    achievable = None
    if req.current_rpm:
        achievable = speed_for_power_kn(
            hull, power_for_rpm(spec, req.current_rpm), sea, req.heading_deg, added_load_kg=load
        )

    curve = performance_curve(
        hull,
        spec,
        fuel_map,
        sea,
        req.heading_deg,
        added_load_kg=load,
        egt_excess_ratio=req.egt_excess_ratio,
        max_speed_kn=max(1.0, max_speed),
    )

    best = advice.recommended
    php = req.php_per_litre

    return AdviseResponse(
        recommendation=await _phrased(
            as_recommendation(advice, vessel_id=req.vessel.vessel_id, php_per_litre=php),
            kind="throttle",
        ),
        power=PowerOut(
            total_kw=best.power.total_kw,
            calm_water_kw=best.power.calm_water_kw,
            wind_kw=best.power.wind_kw,
            wave_kw=best.power.wave_kw,
            speed_through_water_kn=best.power.speed_through_water_kn,
            environmental_penalty_pct=best.power.environmental_penalty_pct,
        ),
        wear=WearOut(
            multiplier=best.burn.wear_multiplier,
            penalty_lph=best.burn.wear_penalty_lph,
            penalty_php_per_hour=None if php is None else best.burn.wear_penalty_lph * php,
        ),
        emissions=EmissionsOut(
            co2_kg_per_hour=co2_kg(best.litres_per_hour),
            co2_kg_per_nm=(
                co2_kg(best.litres_per_hour / best.speed_kn) if best.speed_kn > 0 else None
            ),
        ),
        curve=[
            CurvePoint(
                speed_kn=o.speed_kn,
                rpm=o.rpm,
                shaft_kw=o.power.total_kw,
                litres_per_hour=o.litres_per_hour,
            )
            for o in curve
        ],
        achievable_speed_kn=achievable,
        max_speed_kn=max_speed,
        feasible=advice.feasible,
        notes=list(advice.notes) + list(best.burn.caveats),
        model_trained=fuel_map.has_wear_model,
    )


@app.post("/route", response_model=RouteResponse)
async def route(req: RouteRequest) -> RouteResponse:
    """Cheapest depth- and weather-feasible track from origin to destination.

    Scored on the *same* fuel model as `/advise` -- each leg is costed through the
    identical throttle optimizer -- so the route's litres and the throttle
    advisor's litres can never come from two different models. The forecast along
    the track comes from the loaded forecaster; on a fresh clone that is the
    analytic field, and `recommendation.forecast_source` says so.
    """
    hull = VesselHull(
        length_waterline_m=req.vessel.length_waterline_m,
        beam_m=req.vessel.beam_m,
        draft_m=req.vessel.draft_m,
        displacement_kg=req.vessel.displacement_kg,
        admiralty_coefficient=req.vessel.admiralty_coefficient,
    )
    spec = EngineSpec(
        rated_kw=req.vessel.rated_kw,
        rated_rpm=req.vessel.rated_rpm,
        best_bsfc_g_per_kwh=req.vessel.best_bsfc_g_per_kwh,
        idle_burn_lph=req.vessel.idle_burn_lph,
    )
    fuel_map = _fuel_map_for(spec)
    forecast = _state.get("forecast")

    depart = req.depart_at or datetime.now(UTC)
    plan = plan_route(
        LatLon(req.origin.latitude, req.origin.longitude),
        LatLon(req.destination.latitude, req.destination.longitude),
        hull=hull,
        spec=spec,
        fuel_map=fuel_map,
        forecast=forecast,
        depart=depart,
        minutes_available=req.minutes_available,
        added_load_kg=req.added_load_kg,
        egt_excess_ratio=req.egt_excess_ratio,
    )

    return RouteResponse(
        recommendation=await _phrased(
            as_route_recommendation(plan, vessel_id=req.vessel.vessel_id, depart=depart),
            kind="route",
        ),
        schedule_feasible=plan.chosen.schedule_feasible,
        model_trained=fuel_map.has_wear_model,
    )


@app.post("/maintenance", response_model=MaintenanceStatus)
async def maintenance(req: MaintenanceRequest) -> MaintenanceStatus:
    """Phase 1 engine-health status from a window of recent telemetry.

    Unsupervised anomaly detection against the vessel's learned normal. By the
    contract's own validator the returned status cannot name a component or a
    repair date -- a cold-start unit may say which sensor stream is deviating, and
    no more. That fairness commitment is enforced here, not merely intended.

    When `rated_rpm` is supplied the response also carries a duty-cycle summary:
    how hard this window worked the engine. That is exposure, not diagnosis, and
    it does not feed the anomaly score.
    """
    baseline = _state.get("maintenance_baseline")
    # A caller that can vouch for a window of healthy frames gets a baseline fitted
    # to ITS engine. Without this the served default decides what "normal" means,
    # and a boat that simply differs from the reference -- 24V loom, oil pressure in
    # another range -- is scored as faulty from its first frame. That is Bias 3 in
    # DATA.md, and this is the path out of it.
    # Falls back rather than failing: a window too short to fit is a caller
    # problem, and refusing to answer at all would be a worse one.
    if req.baseline_frames:
        try:
            baseline = fit_from_frames(
                req.baseline_frames,
                observed_hours=req.observed_hours
                if req.observed_hours is not None
                else 0.0,
            )
        except ValueError:
            logger.warning(
                "maintenance: %d baseline frames were not enough to fit; "
                "scoring against the served reference engine instead",
                len(req.baseline_frames),
            )
    return await _phrased(
        detect(
            req.frames,
            baseline,
            vessel_id=req.vessel_id,
            observed_hours=req.observed_hours,
            rated_rpm=req.rated_rpm,
        ),
        kind="engine health",
    )


@app.post("/maintenance/component-life", response_model=ComponentLifeReport)
async def maintenance_component_life(req: ComponentLifeRequest) -> ComponentLifeReport:
    """How much design life each component has left, at the duty it is worked at.

    The sibling of `/maintenance`, and deliberately not the same answer. That one
    watches condition and reports what is deviating now. This one spends
    accumulated wear against the maker's published design lives -- so a shaft
    reaches its 8000-hour life after 8000 run-hours at cruise, and after about
    3100 at overload.

    Neither endpoint feeds the other. A design life that moved because an anomaly
    fired would be a prediction dressed as a service manual, and this build has no
    labelled failure history to predict from.

    Naming a component here is legitimate where it would not be in
    `MaintenanceStatus`, because it is a lookup against a published life rather
    than a forecast of failure. The two live in separate models so that
    distinction cannot erode -- see the note in packages/contracts/maintenance.py.
    """
    return resolve_component_life(
        vessel_id=req.vessel_id,
        wear_hours=req.wear_hours,
        severity_index=req.severity_index,
        hours_per_day=req.hours_per_day,
        wear_hours_at_last_renewal=req.wear_hours_at_last_renewal,
    )


@app.post("/maintenance/pdm", response_model=PdmReport)
async def maintenance_pdm(req: PdmRequest) -> PdmReport:
    """Full ISO 13374 assessment: four systems, their components, and what to do.

    The chain is DA -> DM -> SD -> HA -> PA -> AG, and the blocks stay separate on
    the way out: a residual, a state, a life score, a prognosis and an advisory are
    five different claims of five different strengths, and collapsing them into one
    number is how a condition-monitoring system starts lying.

    Condition models come from an imported historical dataset when one has been
    uploaded, because it spans far more weather than a single voyage. Failing that
    they are fitted from the caller's asserted-healthy frames, and failing that the
    report degrades to raw readings and says so through `data_quality`.
    """
    models: ConditionModelSet | None = _state.get(f"condition_models:{req.vessel_id}")
    if models is None or not models.models:
        if req.baseline_frames:
            models = fit_condition_models(req.baseline_frames, rated_rpm=req.rated_rpm)
        else:
            models = ConditionModelSet()

    return assess_pdm(
        req.frames, models,
        vessel_id=req.vessel_id,
        rated_rpm=req.rated_rpm,
        wear_hours=req.wear_hours,
        run_hours=req.run_hours,
        severity_index=req.severity_index,
        hours_per_day=req.hours_per_day,
        baseline_confidence=req.baseline_confidence,
        renewals=req.renewals,
    )


@app.post("/maintenance/history", response_model=HistoryImportSummary)
async def maintenance_history(req: HistoryUploadRequest) -> HistoryImportSummary:
    """Import a historical dataset and refit this vessel's condition models on it.

    The models are held in process memory, which on a serverless deployment means
    they live for as long as the instance does -- the same caveat the voyage store
    carries, and stated for the same reason. A production fleet would persist them
    per vessel; a console session does not need to.
    """
    frames, summary = parse_history_csv(req.csv_text, vessel_id=req.vessel_id)
    models, summary = refit_from_history(frames, rated_rpm=req.rated_rpm, summary=summary)
    if models.models:
        _state[f"condition_models:{req.vessel_id}"] = models
    return summary


@app.post("/voyages", response_model=VoyageRecord, status_code=201)
async def record_voyage(voyage: VoyageRecord) -> VoyageRecord:
    """Store one completed crossing.

    The write side of Problem 3. A monthly report needs a month of voyages to
    exist somewhere, and until this endpoint every part of the system answered
    from the request in front of it and forgot it.

    Re-posting the same `voyage_id` replaces the record rather than duplicating
    it, so a display that retries after a dropped connection cannot inflate an
    operator's fuel total.
    """
    store: VoyageStore = _state["voyages"]  # type: ignore[assignment]
    store.record(voyage)
    return voyage


@app.get("/emissions/report", response_model=EmissionsReport)
async def emissions_report(
    vessel_id: str = "MV-DEMO-01",
    year: int | None = None,
    month: int | None = None,
) -> EmissionsReport:
    """The monthly CO2-avoided report — Problem 3's deliverable.

    Defaults to the current month. The report carries its own baseline method and
    caveats; see `services/emissions/report.py` for why a voyage with no baseline
    contributes fuel and CO2 but not avoided CO2.
    """
    store: VoyageStore = _state["voyages"]  # type: ignore[assignment]
    today = datetime.now(UTC)
    return build_report(vessel_id, year or today.year, month or today.month, store)


@app.get("/emissions/report.csv")
async def emissions_report_csv(
    vessel_id: str = "MV-DEMO-01",
    year: int | None = None,
    month: int | None = None,
) -> Response:
    """The same report as CSV — the *exportable* half of "exportable evidence".

    CSV rather than PDF deliberately: the recipient can re-add the column
    themselves, which is the whole point of an auditable document.
    """
    store: VoyageStore = _state["voyages"]  # type: ignore[assignment]
    today = datetime.now(UTC)
    report = build_report(vessel_id, year or today.year, month or today.month, store)
    filename = f"marine-ai-emissions-{report.vessel_id}-{report.year}-{report.month:02d}.csv"
    return Response(
        content=to_csv(report),
        media_type="text/csv",
        headers={"content-disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/safety", response_model=SafetyState)
async def safety(req: SafetyRequest) -> SafetyState:
    """Rule-based safety cutoffs for one telemetry frame.

    The deliberately boring endpoint, and the answer to "what happens when your
    model is wrong": nothing here consults a model. No artifact is loaded, no
    state is carried between requests, and the same frame returns the same
    verdict forever. The AI modules advise; this one is arithmetic against
    thresholds a mechanic could check against an engine manual.

    It is still advisory. Marine-AI does not actuate the vessel -- a cutoff
    raises an alarm on the bridge and the captain decides what to do about it.
    """
    return evaluate_safety(req.frame, vessel_id=req.vessel_id)
