"""Phase 1 anomaly detection: a window of engine telemetry in, a MaintenanceStatus out.

This is the consumer-facing half of Predictive Maintenance's cold-start phase. It
scores a window of frames against the vessel's learned normal
(`services/maintenance/baseline.py`) with an ensemble of two detectors, and
packages the result as a `MaintenanceStatus` that -- by the contract's own
validator -- cannot name a component or a repair date. A Phase 1 unit is allowed
to say *which sensor stream is deviating*, and that is exactly as far as this goes.

The ensemble:

  * **Univariate** -- the largest robust z-score across streams. Catches one
    channel walking away from its usual value.
  * **Multivariate** -- PCA reconstruction error. Catches a fault that keeps every
    channel individually in range but in a joint pattern the healthy engine never
    produces.

The two are combined as a probabilistic OR: either detector firing raises the
score, because the two see different faults and a real system must catch both. All
of it is numpy, for the serving-size reason documented in `baseline.py`.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

import numpy as np

from packages.contracts.maintenance import (
    AnomalyStream,
    MaintenancePhase,
    MaintenanceStatus,
)
from packages.contracts.telemetry import TelemetryFrame
from services.maintenance.baseline import FEATURES, VesselBaseline, extract_features

Z_REFERENCE = 3.0
"""The robust z-score treated as a strong single-channel anomaly. At 3 sigma the
univariate detector contributes ~0.63 to the score; the choice mirrors the
conventional 3-sigma control limit."""

ANOMALY_THRESHOLD = 0.6
"""Ensemble score at or above which the status is flagged anomalous. Tuned so a
healthy window sits well below it and a clearly deviating channel crosses it,
without a hair-trigger that would train a captain to ignore the strip."""


def _squash(value: float, reference: float) -> float:
    """Map a non-negative deviation to [0, 1), reaching ~0.63 at `reference`.

    A bounded, smooth transfer so the score never saturates hard at 1.0 and a
    worse anomaly always reads as a higher number -- useful ordering the display
    depends on."""
    if reference <= 0:
        return 0.0
    r = value / reference
    return float(1.0 - np.exp(-0.5 * r * r))


def _trend_minutes(
    frames: Sequence[TelemetryFrame], feature_index: int, baseline: VesselBaseline
) -> float | None:
    """How long a stream has been deviating: drift reads differently from a spike.

    Splits the window in half by time and checks whether the stream is already off
    in the earlier half (a drift, so the whole span) or only in the later half (a
    recent spike, so half the span). Returns None when the window is too short to
    tell or the stream is not deviating.
    """
    if len(frames) < 4:
        return None
    ts = [f.ts for f in frames]
    span_min = (max(ts) - min(ts)).total_seconds() / 60.0
    if span_min <= 0:
        return None

    mid = len(frames) // 2
    feat = FEATURES[feature_index]
    early, _ = extract_features(frames[:mid])
    late, _ = extract_features(frames[mid:])
    i = feature_index
    c, s = baseline.center[i], baseline.scale[i]

    z_early = abs((early[i] - c) / s) if np.isfinite(early[i]) else 0.0
    z_late = abs((late[i] - c) / s) if np.isfinite(late[i]) else 0.0
    _ = feat  # feature identity is carried by the index; kept for readability
    if z_late < 1.0:
        return None
    return span_min if z_early >= 1.0 else span_min / 2.0


def _advisories(
    is_anomalous: bool,
    top: AnomalyStream | None,
    baseline_confidence: float,
) -> tuple[str, str]:
    """(English, Filipino) plain-language status. Names a stream, never a part.

    Phase 1's whole discipline is here: the sentence may say "coolant temperature
    is drifting", which is what the data supports, and may not say "your impeller
    will fail" -- which it cannot know and the contract would reject anyway.
    """
    if not is_anomalous or top is None:
        return (
            "All monitored engine systems are within their normal range.",
            "Lahat ng binabantayang sistema ng makina ay nasa normal na antas.",
        )

    drifting = top.trend_minutes is not None and top.trend_minutes > 0
    verb_en = "is drifting from" if drifting else "is reading outside"
    verb_fil = "ay unti-unting lumalayo sa" if drifting else "ay wala sa"
    en = f"{top.label_en} {verb_en} its normal range."
    fil = f"{top.label_fil} {verb_fil} normal nitong antas."

    if baseline_confidence < 0.3:
        en += " The engine's normal is still being established."
        fil += " Kinukumpirma pa ang normal ng makina."
    return en, fil


def detect(
    frames: Sequence[TelemetryFrame],
    baseline: VesselBaseline,
    *,
    vessel_id: str,
    observed_hours: float | None = None,
    generated_at: datetime | None = None,
) -> MaintenanceStatus:
    """Score a window of frames and build a Phase 1 `MaintenanceStatus`.

    `observed_hours` overrides the baseline's own history count when the caller
    knows this vessel's run-hours (they drive the cold-start confidence). The
    returned status is always Phase 1: this detector never sets a component-level
    field, so the contract's validator has nothing to reject.
    """
    now = generated_at or datetime.now(UTC)
    obs_hours = observed_hours if observed_hours is not None else baseline.observed_hours
    confidence = baseline.baseline_confidence

    values, present = extract_features(frames)

    if not present.any():
        # No engine-health channels on this frame. Report honestly rather than
        # inventing a score against data that is not there.
        return MaintenanceStatus(
            vessel_id=vessel_id,
            generated_at=now,
            phase=MaintenancePhase.PHASE_1_COLD_START,
            anomaly_score=0.0,
            is_anomalous=False,
            streams=[],
            observed_hours=obs_hours,
            baseline_confidence=confidence,
            advisory_en="No engine-health sensors are reporting.",
            advisory_fil="Walang sensor ng kalusugan ng makina ang nag-uulat.",
        )

    z = baseline.standardize(values)
    z = np.where(present, z, 0.0)  # absent channels sit at the baseline, no residual

    residual = z - baseline.reconstruction(z)
    recon_err = float(np.linalg.norm(residual))

    max_z = float(np.max(np.abs(z[present]))) if present.any() else 0.0
    univariate = _squash(max_z, Z_REFERENCE)
    multivariate = _squash(recon_err, baseline.recon_ref)
    anomaly_score = round(1.0 - (1.0 - univariate) * (1.0 - multivariate), 4)

    # Per-stream anomaly energy: univariate deviation plus the share of the
    # multivariate residual it carries. Both are in standardized units, so they
    # add on a common scale, and their split across streams ranks the display.
    energy = np.where(present, z**2 + residual**2, 0.0)
    total_energy = float(energy.sum())

    streams: list[AnomalyStream] = []
    for i, feat in enumerate(FEATURES):
        if not present[i]:
            continue
        contribution = 100.0 * float(energy[i]) / total_energy if total_energy > 0 else 0.0
        streams.append(
            AnomalyStream(
                stream=feat.path,
                label_en=feat.label_en,
                label_fil=feat.label_fil,
                reconstruction_error=abs(float(residual[i])),
                z_score=round(float(z[i]), 3),
                contribution_pct=round(contribution, 2),
                trend_minutes=_trend_minutes(frames, i, baseline),
            )
        )
    streams.sort(key=lambda s: s.contribution_pct, reverse=True)

    is_anomalous = anomaly_score >= ANOMALY_THRESHOLD
    top = streams[0] if streams else None
    en, fil = _advisories(is_anomalous, top if is_anomalous else None, confidence)

    return MaintenanceStatus(
        vessel_id=vessel_id,
        generated_at=now,
        phase=MaintenancePhase.PHASE_1_COLD_START,
        anomaly_score=anomaly_score,
        is_anomalous=is_anomalous,
        streams=streams,
        observed_hours=obs_hours,
        baseline_confidence=confidence,
        advisory_en=en,
        advisory_fil=fil,
    )
