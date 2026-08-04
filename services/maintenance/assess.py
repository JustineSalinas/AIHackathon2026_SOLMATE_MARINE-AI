"""ISO 13374 SD, HA, PA and AG: from residuals to something an operator can act on.

`normalize.py` has already divided the operating condition out. This module turns
what is left into four answers, and keeps them as four answers rather than one
blended score, because they are different claims with different strength:

    SD  State detection      is this deviation real, or is the boat just working?
    HA  Health assessment    how much service life has this part got left?
    PA  Prognostic           when does it run out, and how sure are we?
    AG  Advisory             what should the operator consider doing?

**The distinction the whole feature rests on.** A raw reading that is unusual is
not an anomaly. Vibration climbs in a head sea because the boat is being thrown
about; exhaust temperature climbs at high load because that is what combustion
does. The state detector therefore scores the RESIDUAL -- the part the sea state
and the throttle do not explain -- and when a channel is far from its usual value
but close to its condition-adjusted expectation, it is reported as
`condition_explained` and never as a fault. That single flag is the difference
between a system a crew trusts and one they learn to ignore.

**On the prognosis.** Weeks-to-failure is design life divided by the rate this
vessel is actually consuming it, adjusted by how fast the component's residuals
are drifting. The tolerance is not decoration: it widens with a thin baseline and
with noisy residuals, so an engine three days into its life reports a wide window
and says why. `packages/contracts/pdm.py` refuses a prognosis without one.

Nothing here is learned. Every number traces to a published design life, a
measured exposure, or a residual against this vessel's own history -- which is
what lets this contract name a component when `MaintenanceStatus` may not.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import UTC, datetime

import numpy as np

from packages.contracts.pdm import (
    AnomalyRecord,
    ChannelResidual,
    ComponentHealth,
    DataQuality,
    HealthStatus,
    PdmReport,
    SystemAssessment,
    VesselSystem,
)
from packages.contracts.telemetry import TelemetryFrame
from services.maintenance.components import (
    PARTS_BY_SYSTEM,
    SYSTEM_LABELS,
    MonitoredPart,
)
from services.maintenance.normalize import (
    CHANNEL_BY_KEY,
    WINDOW_FRAMES,
    ConditionModelSet,
    window_channel_value,
    window_features,
)

SIGMA_ELEVATED = 2.0
SIGMA_DEGRADED = 3.0
SIGMA_SEVERE = 4.5
"""Residual thresholds, in sigmas of the residual rather than of the raw signal.

Three sigma is the conventional control limit and sits at DEGRADED. Two is a
watch level, deliberately not an alarm: on seven channels a two-sigma excursion
somewhere is an ordinary afternoon, and a system that shouts about it teaches a
crew to stop reading it."""

RAW_UNUSUAL_SIGMA = 2.0
"""How far from its plain average a reading must sit before "the boat is working
hard" is worth saying out loud. Below this the channel is unremarkable either way
and does not need explaining."""

DAYS_PER_WEEK = 7.0


def _status_for_sigma(sigma: float) -> HealthStatus:
    a = abs(sigma)
    if a >= SIGMA_SEVERE:
        return HealthStatus.SEVERE
    if a >= SIGMA_DEGRADED:
        return HealthStatus.DEGRADED
    if a >= SIGMA_ELEVATED:
        return HealthStatus.ELEVATED
    return HealthStatus.NORMAL


def _worst(statuses: Sequence[HealthStatus]) -> HealthStatus:
    order = [HealthStatus.NORMAL, HealthStatus.ELEVATED, HealthStatus.DEGRADED, HealthStatus.SEVERE]
    return max(statuses, key=order.index) if statuses else HealthStatus.NORMAL


def compute_residuals(
    frames: Sequence[TelemetryFrame],
    models: ConditionModelSet,
    *,
    rated_rpm: float,
) -> list[ChannelResidual]:
    """The DM/SD hand-off: every channel, measured against what conditions predict."""
    if not frames:
        return []

    # Score the trailing window, aggregated exactly as the training windows were.
    # Scoring a single frame against a window-fitted model would compare a noisy
    # sample to a smoothed expectation and call the difference a fault.
    window = frames[-WINDOW_FRAMES:] if len(frames) >= WINDOW_FRAMES else frames
    feats = window_features(window, rated_rpm)
    out: list[ChannelResidual] = []

    for key, channel in CHANNEL_BY_KEY.items():
        measured = window_channel_value(window, key)
        if measured is None:
            continue

        model = models.models.get(key)

        # Is this reading unusual AT ALL? Judged against the training history,
        # which spans many conditions -- not against the scoring window, which is
        # a minute of one condition and has almost no spread. Getting this wrong
        # is why an earlier pass never once reported "the vessel is working hard":
        # nothing ever looked unusual, so nothing ever needed explaining.
        if model is not None and model.raw_std > 1e-9:
            raw_mean = model.raw_mean
            raw_sigma = abs(measured - raw_mean) / model.raw_std
        else:
            raw_mean = float(measured)
            raw_sigma = 0.0

        if model is None or feats is None or not model.within_training_envelope(feats):
            # No condition model, or an operating point outside anything it has
            # seen. Report the raw picture and say the expectation is the plain
            # mean, rather than extrapolate a fit and dress the guess as physics.
            out.append(
                ChannelResidual(
                    channel=key, local_id=channel.local_id,
                    label_en=channel.label_en, label_fil=channel.label_fil,
                    measured=round(float(measured), 3),
                    expected=round(raw_mean, 3),
                    residual_sigma=round(float(raw_sigma if measured >= raw_mean else -raw_sigma), 2),
                    condition_explained=False,
                )
            )
            continue

        expected = model.expected(feats)
        sigma = model.residual_sigma(float(measured), feats)
        # The flag the feature exists for: the reading is odd, the residual is not.
        explained = raw_sigma >= RAW_UNUSUAL_SIGMA and abs(sigma) < SIGMA_ELEVATED

        out.append(
            ChannelResidual(
                channel=key, local_id=channel.local_id,
                label_en=channel.label_en, label_fil=channel.label_fil,
                measured=round(float(measured), 3),
                expected=round(float(expected), 3),
                residual_sigma=round(float(sigma), 2),
                condition_explained=explained,
            )
        )
    return out


def _component_condition_factor(part: MonitoredPart, residuals: dict[str, ChannelResidual]) -> tuple[float, list[str]]:
    """How much faster than nominal this component is ageing, and on what evidence.

    A weighted mean of its channels' residuals, mapped to a multiplier. Only
    positive residuals accelerate: a cooler-than-expected engine is not ageing
    more slowly in any sense worth acting on, and letting it slow the clock would
    let one benign channel mask a deteriorating one.
    """
    total_w = 0.0
    accumulated = 0.0
    contributing: list[str] = []

    for channel, weight in part.channel_weights.items():
        r = residuals.get(channel)
        if r is None:
            continue
        total_w += weight
        # A residual explained by the sea state ages nothing.
        effective = 0.0 if r.condition_explained else max(0.0, r.residual_sigma)
        accumulated += weight * effective
        if effective >= SIGMA_ELEVATED:
            contributing.append(r.label_en)

    if total_w <= 0:
        return 1.0, []

    mean_sigma = accumulated / total_w
    # Each sigma of unexplained drift adds 25% to the ageing rate, capped at 3x.
    # Stated rather than fitted: with labelled failures this becomes a hazard
    # model, and until then a linear rule an engineer can argue with beats a
    # curve that merely looks learned.
    return float(min(3.0, 1.0 + 0.25 * mean_sigma)), contributing


def assess_component(
    part: MonitoredPart,
    *,
    wear_hours: float,
    wear_hours_per_week: float | None,
    residuals: dict[str, ChannelResidual],
    baseline_confidence: float,
    renewed_at_wear_hours: float = 0.0,
) -> ComponentHealth:
    """HA and PA for one component."""
    consumed = max(0.0, wear_hours - renewed_at_wear_hours)
    remaining = part.design_life_wear_hours - consumed
    life_score = max(0.0, min(1.0, remaining / part.design_life_wear_hours))

    factor, contributing = _component_condition_factor(part, residuals)

    weeks: float | None = None
    tolerance: float | None = None
    if wear_hours_per_week and wear_hours_per_week > 0 and remaining > 0:
        weeks = remaining / (wear_hours_per_week * factor)
        # Tolerance from two sources, added rather than multiplied so neither can
        # collapse the other: how well this vessel's normal is known, and how
        # hard its residuals are currently arguing.
        confidence_term = (1.0 - baseline_confidence) * 0.6
        drift_term = 0.10 * (factor - 1.0) / 0.25 if factor > 1.0 else 0.0
        tolerance = max(0.5, weeks * (0.15 + confidence_term + drift_term))
        # A window wider than the projection is not a projection.
        tolerance = min(tolerance, weeks * 0.9)

    residual_status = _worst([
        _status_for_sigma(residuals[c].residual_sigma)
        for c in part.channel_weights
        if c in residuals and not residuals[c].condition_explained
    ])
    life_status = (
        HealthStatus.SEVERE if remaining <= 0
        else HealthStatus.DEGRADED if life_score <= 0.10
        else HealthStatus.ELEVATED if life_score <= 0.33
        else HealthStatus.NORMAL
    )

    return ComponentHealth(
        component_id=part.component_id,
        label_en=part.label_en,
        label_fil=part.label_fil,
        system=part.system,
        criticality=part.criticality,
        life_score=round(life_score, 4),
        design_life_wear_hours=part.design_life_wear_hours,
        wear_hours_consumed=round(consumed, 2),
        weeks_to_failure=round(weeks, 1) if weeks is not None else None,
        weeks_tolerance=round(tolerance, 1) if tolerance is not None else None,
        status=_worst([residual_status, life_status]),
        contributing_channels=contributing,
        condition_factor=round(factor, 3),
    )


def _analysis(system: VesselSystem, status: HealthStatus,
              residuals: list[ChannelResidual], weakest: ComponentHealth | None) -> tuple[str, str]:
    """The AG block's reading. Says when the boat is merely working hard."""
    label_en, label_fil = SYSTEM_LABELS[system]
    explained = [r for r in residuals if r.condition_explained]
    driving = [r for r in residuals if not r.condition_explained and abs(r.residual_sigma) >= SIGMA_ELEVATED]

    if status is HealthStatus.NORMAL:
        if explained:
            names = ", ".join(r.label_en.lower() for r in explained[:2])
            return (
                f"Normal. {names.capitalize()} is running high, but no higher than this "
                f"load and sea state account for — the vessel is working, not failing.",
                f"Normal. Mataas ang {names}, ngunit tugma lamang ito sa bigat ng takbo at "
                f"lagay ng dagat — nagtatrabaho ang sasakyan, hindi sira.",
            )
        return (f"Normal. {label_en} is behaving as this vessel usually does.",
                f"Normal. Karaniwan ang takbo ng {label_fil}.")

    lead = driving[0].label_en.lower() if driving else (weakest.label_en.lower() if weakest else "this system")
    sigma = f"{abs(driving[0].residual_sigma):.1f}σ" if driving else ""
    word_en = {HealthStatus.ELEVATED: "Elevated", HealthStatus.DEGRADED: "Degraded",
               HealthStatus.SEVERE: "Severe"}[status]
    word_fil = {HealthStatus.ELEVATED: "Mataas", HealthStatus.DEGRADED: "Bumababa",
                HealthStatus.SEVERE: "Malubha"}[status]

    if driving:
        return (
            f"{word_en}. {lead.capitalize()} is {sigma} beyond what the current load and "
            f"sea state explain — this is a change in the machinery, not in the weather.",
            f"{word_fil}. Ang {lead} ay {sigma} na lampas sa maipapaliwanag ng bigat ng takbo "
            f"at lagay ng dagat — pagbabago ito sa makinarya, hindi sa panahon.",
        )
    return (
        f"{word_en}. Sensors read normally; {lead} is simply near the end of its service life.",
        f"{word_fil}. Normal ang mga sensor; malapit na lamang sa dulo ng buhay ang {lead}.",
    )


def _recommendation(status: HealthStatus, weakest: ComponentHealth | None) -> tuple[str, str]:
    """Statements, never orders. The rule `services/advisory/guard.py` enforces."""
    if weakest is None:
        return ("No action indicated.", "Walang kailangang gawin.")

    part = weakest.label_en.lower()
    part_fil = weakest.label_fil.lower()
    horizon = ""
    horizon_fil = ""
    if weakest.weeks_to_failure is not None and weakest.weeks_tolerance is not None:
        horizon = f" — projected {weakest.weeks_to_failure:.0f} ± {weakest.weeks_tolerance:.0f} weeks"
        horizon_fil = f" — tinatayang {weakest.weeks_to_failure:.0f} ± {weakest.weeks_tolerance:.0f} linggo"

    if status is HealthStatus.SEVERE:
        return (
            f"The {part} warrants inspection before the next crossing{horizon}. "
            f"A spare is worth having aboard.",
            f"Kailangang suriin ang {part_fil} bago ang susunod na biyahe{horizon_fil}. "
            f"Mainam magdala ng kapalit.",
        )
    if status is HealthStatus.DEGRADED:
        return (
            f"The {part} is worth ordering now{horizon}, so the part is at the pier "
            f"before it is needed.",
            f"Mainam nang mag-order ng {part_fil}{horizon_fil}, nang nasa pantalan na ito "
            f"bago pa kailanganin.",
        )
    if status is HealthStatus.ELEVATED:
        return (
            f"Worth watching the {part} over the next few crossings{horizon}.",
            f"Bantayan ang {part_fil} sa susunod na ilang biyahe{horizon_fil}.",
        )
    return (
        f"No action indicated. Next attention is the {part}{horizon}.",
        f"Walang kailangang gawin. Susunod na aasikasuhin ang {part_fil}{horizon_fil}.",
    )


def assess(
    frames: Sequence[TelemetryFrame],
    models: ConditionModelSet,
    *,
    vessel_id: str,
    rated_rpm: float,
    wear_hours: float,
    run_hours: float,
    severity_index: float | None = None,
    hours_per_day: float | None = None,
    baseline_confidence: float = 0.0,
    renewals: dict[str, float] | None = None,
    generated_at: datetime | None = None,
) -> PdmReport:
    """Run the whole ISO 13374 chain and produce the panel's report."""
    now = generated_at or datetime.now(UTC)
    renewals = renewals or {}

    residual_list = compute_residuals(frames, models, rated_rpm=rated_rpm)
    residuals = {r.channel: r for r in residual_list}

    # Wear-hours consumed per calendar week at the vessel's stated pattern.
    wear_per_week: float | None = None
    if hours_per_day and hours_per_day > 0 and severity_index and severity_index > 0:
        wear_per_week = hours_per_day * DAYS_PER_WEEK * severity_index

    systems: list[SystemAssessment] = []
    for system in VesselSystem:
        parts = PARTS_BY_SYSTEM[system]
        sys_channels = {c for p in parts for c in p.channel_weights}
        sys_residuals = [r for r in residual_list if r.channel in sys_channels]

        components = [
            assess_component(
                p, wear_hours=wear_hours, wear_hours_per_week=wear_per_week,
                residuals=residuals, baseline_confidence=baseline_confidence,
                renewed_at_wear_hours=renewals.get(p.component_id, 0.0),
            )
            for p in parts
        ]
        # Most urgent first: worst status, then least life. A part that strands the
        # boat should not sit below a cosmetic one with a smaller percentage.
        order = {HealthStatus.SEVERE: 0, HealthStatus.DEGRADED: 1,
                 HealthStatus.ELEVATED: 2, HealthStatus.NORMAL: 3}
        components.sort(key=lambda c: (order[c.status], c.criticality, c.life_score))

        status = _worst([c.status for c in components])
        weakest = components[0] if components else None
        analysis_en, analysis_fil = _analysis(system, status, sys_residuals, weakest)
        rec_en, rec_fil = _recommendation(status, weakest)

        anomalies = [
            AnomalyRecord(
                observed_at=now, channel=r.channel, label_en=r.label_en,
                residual_sigma=r.residual_sigma,
                status=_status_for_sigma(r.residual_sigma),
                run_hours=round(run_hours, 2),
                note_en=f"{abs(r.residual_sigma):.1f}σ beyond the value this load and sea state predict "
                        f"({r.measured} against {r.expected} expected).",
                note_fil=f"{abs(r.residual_sigma):.1f}σ lampas sa inaasahan sa ganitong takbo at dagat "
                         f"({r.measured} kumpara sa {r.expected}).",
            )
            for r in sys_residuals
            if not r.condition_explained and abs(r.residual_sigma) >= SIGMA_ELEVATED
        ]

        label_en, label_fil = SYSTEM_LABELS[system]
        systems.append(
            SystemAssessment(
                system=system, label_en=label_en, label_fil=label_fil,
                status=status,
                life_score=round(min((c.life_score for c in components), default=1.0), 4),
                components=components, residuals=sys_residuals, anomalies=anomalies,
                analysis_en=analysis_en, analysis_fil=analysis_fil,
                recommended_action_en=rec_en, recommended_action_fil=rec_fil,
            )
        )

    # ISO 13374 asks acquisition and detection to declare their own trust rather
    # than let a downstream block assume it.
    if not frames or not residual_list:
        quality = DataQuality.BAD
    elif not models.models or baseline_confidence < 0.15:
        quality = DataQuality.UNDETERMINED
    else:
        quality = DataQuality.GOOD

    return PdmReport(
        vessel_id=vessel_id,
        generated_at=now,
        run_hours=round(run_hours, 3),
        wear_hours=round(wear_hours, 2),
        severity_index=round(severity_index, 4) if severity_index else None,
        systems=systems,
        overall_status=_worst([s.status for s in systems]),
        data_quality=quality,
        baseline_confidence=round(baseline_confidence, 3),
        history_rows=models.rows_fitted,
    )
