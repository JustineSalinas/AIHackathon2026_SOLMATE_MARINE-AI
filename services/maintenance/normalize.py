"""ISO 13374 DM block: divide the operating condition out of every channel.

This is the module that lets the system tell a boat working hard from a boat
breaking down, and it is the reason the rest of the pipeline is worth building.

The problem it solves, stated as an engineer would:

    Vibration 0.09 g, punching into a 1.8 m head sea at 82% load  -> normal
    Vibration 0.09 g, flat calm, 40% load                          -> a fault

The reading is identical. A threshold cannot separate them and neither can a
detector that scores raw values, which is why alarm-on-absolute-value systems
either miss real faults or cry wolf every time the weather turns. The standard
calls the fix "deriving virtual sensor readings from the raw measurements"; in
practice it means learning what this vessel normally reads *under these
conditions* and scoring only what is left over.

**How.** For each channel, fit

    expected = b0 + b1*load + b2*wave_height + b3*sin(rel_wave) + b4*cos(rel_wave) + b5*rpm

by least squares over the vessel's own healthy history, keep the residual standard
deviation, and report deviations in sigmas of the RESIDUAL rather than of the raw
signal. Relative wave direction enters as a sine/cosine pair because it is
circular: 359 degrees and 1 degree are one degree apart, and a model fed the raw
number believes they are 358 apart.

**Why ordinary least squares and not something cleverer.** The serving image is
numpy plus onnxruntime, 85 MB, and scikit-learn would quintuple it -- the same
constraint that shaped `services/maintenance/baseline.py`. A linear fit is also
the honest amount of model for the data volume a single vessel produces in its
first season, and every coefficient can be read off and argued with by the
engineer whose engine it is.

**What it cannot do.** A residual model only normalises for conditions it has
seen. Fitted entirely on calm-water history, it has no basis for an opinion about
a head sea and will report confident nonsense. `condition_coverage()` exists so
that gap is visible rather than discovered on a rough day, and the fitted model
declines to normalise a condition far outside its training range.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from packages.contracts.telemetry import TelemetryFrame

# --------------------------------------------------------------------------
# Channels. Internal key, ISO 19848-style LocalID, and the words a crew uses.
#
# The LocalID follows ISO 19848's hierarchical slash-delimited DataChannelID
# shape so an uploaded dataset and a live frame can name the same measurement.
# It is deliberately a *style* match rather than a claim of certification: a
# real LocalID is generated from a DNV VIS reference library this build does not
# ship, and pretending otherwise would be the kind of standards-washing that
# falls apart under one question.
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Channel:
    key: str
    local_id: str
    label_en: str
    label_fil: str
    unit: str


CHANNELS: tuple[Channel, ...] = (
    Channel("coolant_temp_c", "/main-engine/cooling/fresh-water/temperature",
            "Coolant temperature", "Temperatura ng coolant", "degC"),
    Channel("oil_pressure_kpa", "/main-engine/lubrication/pressure",
            "Oil pressure", "Presyon ng langis", "kPa"),
    Channel("exhaust_gas_temp_c", "/main-engine/exhaust/temperature",
            "Exhaust gas temperature", "Temperatura ng tambutso", "degC"),
    Channel("battery_voltage_v", "/electrical/battery/voltage",
            "Battery voltage", "Boltahe ng baterya", "V"),
    Channel("oil_particulate_ppm", "/main-engine/lubrication/particulate",
            "Oil particulate", "Partikulo sa langis", "ppm"),
    Channel("exhaust_nox_ppm", "/main-engine/exhaust/nox",
            "Exhaust NOx", "NOx sa tambutso", "ppm"),
    Channel("vibration_rms_g", "/propulsion/vibration/rms",
            "Vibration", "Bibrasyon", "g"),
)

CHANNEL_BY_KEY = {c.key: c for c in CHANNELS}

FEATURE_NAMES = (
    "intercept", "load", "wave_height_m", "sin_rel_wave", "cos_rel_wave", "rpm_frac",
    "beam_excitation", "head_excitation",
)
"""The last two are interaction terms, and they are not optional.

A hull's response to a sea is not the sum of "how big" and "from where" -- it is
their product. Roll excitation scales with wave height TIMES how abeam the sea
is; pitch and slamming scale with height times how far forward it is. A model
given only separate height and direction terms cannot represent either, so it
under-predicts vibration in a beam sea and then reports the shortfall as a
mechanical fault. Fitting one without these terms produced exactly that: a
healthy engine in a 2.1 m beam sea read DEGRADED at 3.5 sigma."""

MIN_ROWS_TO_FIT = 25
"""Below this, a six-parameter fit describes the noise rather than the engine.

Deliberately well above the parameter count. A fit on twelve rows will happily
report a residual standard deviation near zero and then call every subsequent
reading a five-sigma anomaly."""

WINDOW_FRAMES = 20
"""Frames aggregated into one observation, for fitting and for scoring alike.

An engine is not diagnosed from an instant. More importantly, vibration has no
per-frame value at all -- it is the fluctuation of the accelerometer across a
span -- so a window is the smallest unit on which every channel is measurable."""

WINDOW_STRIDE = 5
"""Frames advanced between training windows. Overlapping windows extract more
observations from a short history; the overlap correlates them, which is
acceptable for a linear fit and stated rather than hidden."""

RESIDUAL_FLOOR = 1e-6
"""Floors the residual sigma so a perfectly-fitted channel cannot divide by zero
and report infinite deviation on the first bit of sensor noise."""


@dataclass(frozen=True)
class ConditionModel:
    """What one channel normally reads, as a function of how hard the boat is working."""

    channel: str
    coefficients: np.ndarray
    residual_std: float
    n_samples: int
    raw_mean: float
    raw_std: float
    """Plain mean and spread of this channel across the TRAINING history, which
    spans many conditions. Used only to answer "is this reading unusual at all?"
    -- the question that decides whether "the vessel is working hard" is worth
    saying. Comparing against the scoring window instead would be useless: a
    window is a minute of one condition and has almost no spread, so nothing ever
    looks unusual and the explanation never fires."""

    feature_ranges: dict[str, tuple[float, float]]
    """Min and max of each feature in the training data. Used to refuse
    extrapolation rather than silently produce a confident number for weather the
    model has never seen."""

    def expected(self, features: np.ndarray) -> float:
        return float(features @ self.coefficients)

    def residual_sigma(self, measured: float, features: np.ndarray) -> float:
        return (measured - self.expected(features)) / max(self.residual_std, RESIDUAL_FLOOR)

    def within_training_envelope(self, features: np.ndarray, slack: float = 0.25) -> bool:
        """Is this operating point inside the conditions the model was fitted on?

        `slack` allows a quarter of the observed range beyond each edge. Beyond
        that the linear fit is extrapolating, and a residual computed from an
        extrapolated expectation says more about the model than the engine.
        """
        for i, name in enumerate(FEATURE_NAMES):
            if name == "intercept":
                continue
            lo, hi = self.feature_ranges.get(name, (0.0, 0.0))
            span = max(hi - lo, 1e-9)
            if not (lo - slack * span) <= features[i] <= (hi + slack * span):
                return False
        return True


@dataclass
class ConditionModelSet:
    """Every channel's condition model, plus what it was fitted on."""

    models: dict[str, ConditionModel] = field(default_factory=dict)
    rows_fitted: int = 0

    def has(self, channel: str) -> bool:
        return channel in self.models


def _relative_wave_deg(frame: TelemetryFrame) -> float | None:
    """Wave direction relative to the bow. The confounder that matters most.

    A 2 m sea on the beam rolls a boat; the same sea astern barely registers.
    Absolute wave direction tells the model nothing without the heading, so the
    two are combined here rather than fed in separately and hoped for.
    """
    heading = frame.routing.heading_deg
    if heading is None:
        return None
    # This build carries wave height on the frame but not wave direction, so the
    # wind bearing stands in for it: wind sea and swell are aligned in a coastal
    # strait far more often than not. Stated rather than hidden -- with a wave
    # direction channel this becomes exact instead of a good approximation.
    from_dir = frame.throttling.wind_direction_deg
    if from_dir is None:
        return None
    return ((float(from_dir) - float(heading)) % 360.0 + 360.0) % 360.0


def features_for(frame: TelemetryFrame, rated_rpm: float) -> np.ndarray | None:
    """The operating condition, as the model sees it. None if it cannot be read."""
    rpm = frame.throttling.engine_rpm
    if rpm is None or rated_rpm <= 0:
        return None

    rpm_frac = float(rpm) / rated_rpm
    # Load is torque-weighted when torque is reported, because RPM alone cannot
    # distinguish a light boat spinning up from a full one pushing through a sea.
    torque = frame.throttling.engine_torque_nm
    load = rpm_frac if torque is None else rpm_frac * min(1.5, max(0.1, float(torque) / 300.0))

    wave = frame.routing.wave_height_m
    wave_h = 0.0 if wave is None else float(wave)

    rel = _relative_wave_deg(frame)
    if rel is None:
        sin_rel = cos_rel = 0.0
    else:
        rad = math.radians(rel)
        sin_rel, cos_rel = math.sin(rad), math.cos(rad)

    # Interaction terms. |sin| because a sea on either beam rolls the boat the
    # same way; max(0, cos) because a head sea slams and a following sea does not.
    beam_excitation = wave_h * abs(sin_rel)
    head_excitation = wave_h * max(0.0, cos_rel)

    return np.array(
        [1.0, load, wave_h, sin_rel, cos_rel, rpm_frac, beam_excitation, head_excitation],
        dtype=float,
    )


def window_channel_value(frames: Sequence[TelemetryFrame], channel: str) -> float | None:
    """One channel's value over a window.

    Vibration is the de-meaned RMS of the accelerometer across the window --
    identical in spirit to `baseline.py::_vibration_rms`, and for the same reason:
    the steady 1 g of gravity says nothing about the engine, the fluctuation says
    everything. Every other channel is the window mean, which removes the
    per-sample noise that would otherwise dominate a residual.
    """
    if not frames:
        return None

    if channel == "vibration_rms_g":
        axes = []
        for getter in (lambda e: e.accel_x_g, lambda e: e.accel_y_g, lambda e: e.accel_z_g):
            vals = [v for f in frames if (v := getter(f.electro_mechanical)) is not None]
            if len(vals) >= 2:
                axes.append(float(np.var(vals)))
        if not axes:
            return None
        return float(math.sqrt(sum(axes)))

    vals = [v for f in frames if (v := getattr(f.electro_mechanical, channel, None)) is not None]
    return float(np.mean(vals)) if vals else None


def window_features(frames: Sequence[TelemetryFrame], rated_rpm: float) -> np.ndarray | None:
    """The operating condition over a window: the mean of each frame's features."""
    feats = [f for f in (features_for(fr, rated_rpm) for fr in frames) if f is not None]
    if not feats:
        return None
    mean = np.vstack(feats).mean(axis=0)
    mean[0] = 1.0  # the intercept is a constant, not something to average
    return mean


def channel_value(frame: TelemetryFrame, channel: str) -> float | None:
    """Read one channel off a frame, deriving vibration from the accelerometer.

    Vibration is not a field. The contract carries a three-axis IMU, and what
    matters for bearing wear is the FLUCTUATION rather than the level -- gravity
    sits on one axis and says nothing about the engine. Per-frame there is no
    fluctuation to measure, so the instantaneous magnitude about 1 g is used, and
    the windowed RMS in `baseline.py` remains the more reliable figure.
    """
    em = frame.electro_mechanical
    if channel == "vibration_rms_g":
        ax, ay, az = em.accel_x_g, em.accel_y_g, em.accel_z_g
        if ax is None or ay is None or az is None:
            return None
        return float(math.sqrt(ax * ax + ay * ay + (az - 1.0) ** 2))
    return getattr(em, channel, None)


def fit_condition_models(
    frames: Sequence[TelemetryFrame], *, rated_rpm: float
) -> ConditionModelSet:
    """Learn what this vessel normally reads, per channel, per operating condition.

    Frames are assumed HEALTHY. That assumption is the same one
    `services/maintenance/baseline.py` documents and for the same reason: a model
    fitted over a developing fault learns the fault as normal, and nothing
    downstream can then see it.
    """
    rows: list[np.ndarray] = []
    values: dict[str, list[float]] = {c.key: [] for c in CHANNELS}
    keep: dict[str, list[int]] = {c.key: [] for c in CHANNELS}

    # Slide a window over the history. Each window is one observation, so a
    # channel's value and the conditions it was recorded under are aggregated the
    # same way here as they will be at scoring time -- otherwise the residual
    # standard deviation describes single-sample noise and every windowed reading
    # looks impossibly quiet by comparison.
    for start in range(0, max(0, len(frames) - WINDOW_FRAMES + 1), WINDOW_STRIDE):
        window = frames[start:start + WINDOW_FRAMES]
        feats = window_features(window, rated_rpm)
        if feats is None:
            continue
        idx = len(rows)
        rows.append(feats)
        for c in CHANNELS:
            v = window_channel_value(window, c.key)
            if v is not None:
                values[c.key].append(float(v))
                keep[c.key].append(idx)

    out = ConditionModelSet(rows_fitted=len(rows))
    if len(rows) < MIN_ROWS_TO_FIT:
        return out

    X_all = np.vstack(rows)
    ranges = {
        name: (float(X_all[:, i].min()), float(X_all[:, i].max()))
        for i, name in enumerate(FEATURE_NAMES)
        if name != "intercept"
    }

    for c in CHANNELS:
        idxs = keep[c.key]
        if len(idxs) < MIN_ROWS_TO_FIT:
            continue
        X = X_all[idxs]
        y = np.asarray(values[c.key], dtype=float)
        # lstsq rather than a normal-equation inverse: the design matrix is
        # rank-deficient whenever a condition never varied -- a whole dataset at
        # one throttle setting, say -- and lstsq returns the minimum-norm solution
        # instead of raising on a singular matrix.
        coef, *_ = np.linalg.lstsq(X, y, rcond=None)
        resid = y - X @ coef
        out.models[c.key] = ConditionModel(
            channel=c.key,
            coefficients=coef,
            residual_std=float(np.std(resid)),
            n_samples=len(idxs),
            raw_mean=float(np.mean(y)),
            raw_std=float(np.std(y)),
            feature_ranges=ranges,
        )
    return out


def condition_coverage(frames: Sequence[TelemetryFrame], *, rated_rpm: float) -> dict[str, float]:
    """How much of the operating envelope a dataset actually covers.

    Reported to the operator after an upload, because "10,000 rows" and "10,000
    rows all recorded alongside a pier in flat calm" are very different gifts to a
    model that exists to normalise for weather.
    """
    feats = [f for f in (features_for(fr, rated_rpm) for fr in frames) if f is not None]
    if not feats:
        return {}
    X = np.vstack(feats)
    return {
        "load_range": float(X[:, 1].max() - X[:, 1].min()),
        "wave_height_range_m": float(X[:, 2].max() - X[:, 2].min()),
        "heading_spread": float(np.std(X[:, 3]) + np.std(X[:, 4])),
        "rpm_range": float(X[:, 5].max() - X[:, 5].min()),
    }
