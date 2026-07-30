"""What "normal" looks like for one engine, learned from its own history.

Phase 1 predictive maintenance is unsupervised: with no labelled failures yet, the
only thing the system can know is what this engine usually does, and flag when it
stops doing it. This module is that learned normal -- a per-vessel baseline the
detector scores against.

The baseline has two halves, because two different kinds of fault hide in two
different places:

  * **Per-stream location and scale** (robust: median and MAD). Catches a single
    channel walking away from its usual value -- coolant creeping up, oil pressure
    sagging. A univariate detector.
  * **A PCA model of the joint normal.** Catches the fault that hides *between*
    channels: every stream individually in range, but in a combination that never
    occurs on a healthy engine (coolant up while load is flat). Reconstruction
    error in the discarded principal directions is the signal. A linear
    autoencoder is exactly PCA, so this is the "autoencoder" half of the ensemble
    the contract names -- see `services/maintenance/detector.py` and
    docs/DEVIATIONS.md for why it is PCA and not a deep net or an isolation forest.

Everything here is numpy. That is deliberate: the advisory API serves from a
85 MB `numpy + onnxruntime` image (see `requirements.txt`), and dragging
scikit-learn and scipy back in to run an isolation forest would more than
quintuple it. At cold-start data volumes over a handful of low-rate channels, the
principled statistical detector is also simply the better-fitted tool.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np

from packages.contracts.telemetry import TelemetryFrame

MAD_TO_SIGMA = 1.4826
"""Scales the median absolute deviation to a standard-deviation-equivalent for a
normal distribution. Using MAD rather than the raw standard deviation is what
keeps the learned scale from being inflated by the very outliers the detector
exists to catch."""


@dataclass(frozen=True)
class Feature:
    """One monitored quantity: where it comes from, what to call it, how to
    reduce a window of frames to a single number."""

    path: str
    label_en: str
    label_fil: str
    extractor: Callable[[Sequence[TelemetryFrame]], float | None]


def _mean_of(getter: Callable[[TelemetryFrame], float | None]):
    """Window reducer for a slow-moving channel: the mean of present samples."""

    def reduce(frames: Sequence[TelemetryFrame]) -> float | None:
        vals = [v for f in frames if (v := getter(f)) is not None]
        return float(np.mean(vals)) if vals else None

    return reduce


def _vibration_rms(frames: Sequence[TelemetryFrame]) -> float | None:
    """De-meaned RMS of the 3-axis accelerometer over the window, in g.

    The mean is removed per axis so the steady 1 g of gravity on the vertical axis
    does not swamp the signal -- what matters for bearing wear and shaft
    misalignment is the *fluctuation*, not the orientation. RMS across axes is a
    single scalar vibration energy the baseline can track.
    """
    axes = []
    for getter in (
        lambda f: f.electro_mechanical.accel_x_g,
        lambda f: f.electro_mechanical.accel_y_g,
        lambda f: f.electro_mechanical.accel_z_g,
    ):
        vals = [v for f in frames if (v := getter(f)) is not None]
        if len(vals) >= 2:
            axes.append(np.var(vals))
    if not axes:
        return None
    return float(np.sqrt(np.sum(axes)))


# The monitored channels. Electro-mechanical health only -- this is the engine's
# vital-signs panel, not the whole telemetry frame. Order is fixed because the
# PCA basis and every stored vector are indexed by it.
FEATURES: tuple[Feature, ...] = (
    Feature(
        "electro_mechanical.coolant_temp_c",
        "Engine coolant temperature",
        "Temperatura ng coolant ng makina",
        _mean_of(lambda f: f.electro_mechanical.coolant_temp_c),
    ),
    Feature(
        "electro_mechanical.oil_pressure_kpa",
        "Oil pressure",
        "Presyon ng langis",
        _mean_of(lambda f: f.electro_mechanical.oil_pressure_kpa),
    ),
    Feature(
        "electro_mechanical.battery_voltage_v",
        "Battery voltage",
        "Boltahe ng baterya",
        _mean_of(lambda f: f.electro_mechanical.battery_voltage_v),
    ),
    Feature(
        "electro_mechanical.exhaust_gas_temp_c",
        "Exhaust gas temperature",
        "Temperatura ng tambutso",
        _mean_of(lambda f: f.electro_mechanical.exhaust_gas_temp_c),
    ),
    Feature(
        "electro_mechanical.oil_particulate_ppm",
        "Oil particulate level",
        "Antas ng partikulo sa langis",
        _mean_of(lambda f: f.electro_mechanical.oil_particulate_ppm),
    ),
    Feature(
        "electro_mechanical.exhaust_nox_ppm",
        "Exhaust NOx",
        "NOx sa tambutso",
        _mean_of(lambda f: f.electro_mechanical.exhaust_nox_ppm),
    ),
    Feature(
        "electro_mechanical.vibration_rms_g",
        "Engine vibration",
        "Bibrasyon ng makina",
        _vibration_rms,
    ),
)

FEATURE_INDEX = {feat.path: i for i, feat in enumerate(FEATURES)}


def extract_features(frames: Sequence[TelemetryFrame]) -> tuple[np.ndarray, np.ndarray]:
    """Reduce a window of frames to one feature vector plus a presence mask.

    Missing channels are `nan` in the vector and `False` in the mask, so the
    detector can score only what the retrofit kit on this particular boat actually
    reports rather than assuming every sensor is installed.
    """
    values = np.full(len(FEATURES), np.nan)
    present = np.zeros(len(FEATURES), dtype=bool)
    for i, feat in enumerate(FEATURES):
        v = feat.extractor(frames)
        if v is not None and np.isfinite(v):
            values[i] = v
            present[i] = True
    return values, present


@dataclass(frozen=True)
class VesselBaseline:
    """One engine's learned normal. Indexed throughout by `FEATURES` order."""

    center: np.ndarray
    """Robust per-feature location (median)."""
    scale: np.ndarray
    """Robust per-feature spread (MAD-scaled sigma), floored away from zero."""
    components: np.ndarray
    """Retained principal directions of the standardized normal, shape (k, n)."""
    recon_ref: float
    """Reference reconstruction error (95th percentile on the training data). The
    scale that turns a raw residual into an interpretable anomaly level."""
    observed_hours: float
    """Run-hours of history behind this baseline. Drives cold-start confidence and
    the Phase 1 -> Phase 2 transition (which this module never crosses)."""

    @property
    def baseline_confidence(self) -> float:
        """How well-established this engine's normal is. Low early in Phase 1.

        Saturating in run-hours: a baseline built on a few hours of data is not
        yet trustworthy, and the detector says so rather than flagging confident
        anomalies against a normal it barely knows. ~300 run-hours reaches ~0.6.
        """
        return round(float(1.0 - np.exp(-self.observed_hours / 300.0)), 3)

    def standardize(self, values: np.ndarray) -> np.ndarray:
        return (values - self.center) / self.scale

    def reconstruction(self, z: np.ndarray) -> np.ndarray:
        """Project a standardized vector onto the normal subspace and back.

        The residual `z - reconstruction(z)` lives in the directions the healthy
        engine never varies in; its size is the multivariate anomaly signal.
        """
        if self.components.size == 0:
            return np.zeros_like(z)
        coeffs = self.components @ z
        return self.components.T @ coeffs

    @classmethod
    def fit(
        cls,
        rows: np.ndarray,
        *,
        observed_hours: float,
        variance_kept: float = 0.9,
    ) -> VesselBaseline:
        """Learn a baseline from a matrix of healthy feature vectors (rows x features).

        `variance_kept` sets how many principal directions count as "normal
        variation"; the rest become the reconstruction-error subspace. 0.9 keeps
        the axes the engine genuinely moves along and discards the noise floor
        where a novel fault will first show.
        """
        rows = np.asarray(rows, dtype=float)
        if rows.ndim != 2 or rows.shape[0] < 2:
            raise ValueError("need at least two healthy samples to fit a baseline")

        center = np.median(rows, axis=0)
        mad = np.median(np.abs(rows - center), axis=0) * MAD_TO_SIGMA
        # Floor the scale: a channel that never moved in training would otherwise
        # divide by zero and report every future reading as infinitely anomalous.
        scale = np.where(mad > 1e-9, mad, np.maximum(np.abs(center) * 0.01, 1e-6))

        standardized = (rows - center) / scale

        # PCA by SVD on the standardized data. Retain the smallest number of
        # components that explain `variance_kept` of the total variance.
        u, s, vt = np.linalg.svd(standardized - standardized.mean(axis=0), full_matrices=False)
        var = s**2
        if var.sum() <= 0:
            components = np.empty((0, rows.shape[1]))
        else:
            ratio = np.cumsum(var) / var.sum()
            k = int(np.searchsorted(ratio, variance_kept) + 1)
            k = max(1, min(k, vt.shape[0] - 1)) if vt.shape[0] > 1 else vt.shape[0]
            components = vt[:k]

        baseline = cls(
            center=center,
            scale=scale,
            components=components,
            recon_ref=1.0,  # placeholder, replaced below once we can score training rows
            observed_hours=observed_hours,
        )
        # Calibrate the reconstruction reference on the training data itself.
        residuals = [
            float(np.linalg.norm(z - baseline.reconstruction(z)))
            for z in ((rows - center) / scale)
        ]
        recon_ref = float(np.percentile(residuals, 95)) if residuals else 1.0
        return cls(
            center=center,
            scale=scale,
            components=components,
            recon_ref=max(recon_ref, 1e-6),
            observed_hours=observed_hours,
        )


# --- The demo default -------------------------------------------------------

# Healthy operating values for the ~90 kW demo diesel. These describe a warm
# engine at cruise; they exist so `/maintenance` answers on a fresh clone before
# any real telemetry history has been logged, exactly as `FuelMap.load` and
# `load_forecast` degrade gracefully. A fitted baseline replaces them per vessel.
_HEALTHY_MEAN = np.array([82.0, 350.0, 13.8, 380.0, 15.0, 600.0, 0.05])
_HEALTHY_SIGMA = np.array([3.0, 20.0, 0.3, 25.0, 5.0, 80.0, 0.015])


def synthetic_healthy_baseline(
    *, observed_hours: float = 500.0, samples: int = 600, seed: int = 7
) -> VesselBaseline:
    """A reproducible healthy baseline for the demo engine.

    Draws correlated healthy samples -- coolant and exhaust temperature rise
    together with load, so the joint model has real structure for the PCA half of
    the detector to learn -- and fits a baseline on them. Seeded, so the demo and
    the tests see the same normal every time.
    """
    rng = np.random.default_rng(seed)
    n = len(FEATURES)
    load = rng.normal(0.0, 1.0, size=samples)  # a shared latent: engine load
    noise = rng.normal(0.0, 1.0, size=(samples, n))
    # Coolant (0) and EGT (3) track load; the rest are largely independent.
    load_gain = np.array([0.6, -0.2, 0.0, 0.7, 0.1, 0.3, 0.2])
    z = load[:, None] * load_gain + noise * 0.6
    rows = _HEALTHY_MEAN + z * _HEALTHY_SIGMA
    return VesselBaseline.fit(rows, observed_hours=observed_hours)
