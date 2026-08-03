"""Train the degradation half of the fuel map.

    python -m services.speed.train

What this fits: given how hard the engine is working and how hot its exhaust is
running relative to its own healthy baseline, what multiple of its healthy fuel
burn is it now consuming?

What it deliberately does not fit: litres per hour. See `services.speed.fuel`
for why the absolute level comes from a diesel brake-specific-fuel-consumption
curve rather than from this gas-turbine dataset.

The script reports two baselines alongside the gradient-boosted model and prints
whichever wins. That is not ceremony. On a dataset this smooth it is genuinely
possible for a two-parameter linear fit to match XGBoost, and shipping a
gradient-booster that beats linear regression by nothing would be a worse
answer, not a more impressive one.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import joblib
import numpy as np
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import GroupShuffleSplit
from xgboost import XGBRegressor

from services.speed.dataset import (
    EXCLUDED_LEVER_SPEEDS_KN,
    FEATURE_COLUMNS,
    TARGET_COLUMN,
    build_dataset,
)

ARTIFACT_PATH = Path("models/fuel_degradation.joblib")
ONNX_PATH = Path("models/fuel_degradation.onnx")
MODEL_CARD_PATH = Path("models/fuel_degradation.card.json")

ONNX_PARITY_TOLERANCE = 1e-4
"""Maximum permitted disagreement between the trained model and its ONNX export.

Float32 rounding alone lands around 1e-6. Anything approaching this bound means
the conversion changed the model, and shipping it would put a different
predictor in production from the one these metrics describe. The export fails
loudly rather than warning."""

HELD_OUT_STATE_FRACTION = 0.25
RANDOM_SEED = 20260804  # the submission deadline; arbitrary, but fixed and stated

XGB_PARAMS = dict(
    n_estimators=400,
    max_depth=4,
    learning_rate=0.05,
    subsample=0.9,
    colsample_bytree=1.0,  # there are only two features; sampling them is noise
    reg_lambda=1.0,
    random_state=RANDOM_SEED,
    n_jobs=4,
)
"""Shallow and heavily regularised on purpose. The target surface is smooth and
monotone; depth here would buy training-set precision and lose the extrapolation
behaviour that matters when a real engine wears past anything in the grid."""


@dataclass(frozen=True)
class Score:
    name: str
    mae_pct_of_fuel: float
    """Mean absolute error expressed as percentage points of fuel burn. The
    honest unit: an error of 0.5 here means the model is off by half a percent
    of the vessel's fuel bill."""

    max_error_pct_of_fuel: float
    r2: float


def _score(name: str, y_true: np.ndarray, y_pred: np.ndarray) -> Score:
    err = np.abs(y_true - y_pred)
    return Score(
        name=name,
        mae_pct_of_fuel=float(mean_absolute_error(y_true, y_pred) * 100.0),
        max_error_pct_of_fuel=float(err.max() * 100.0),
        r2=float(r2_score(y_true, y_pred)),
    )


def export_onnx(model, X_sample: np.ndarray, path: Path = ONNX_PATH) -> float:
    """Export the chosen model to ONNX and verify it still predicts the same thing.

    **Why ONNX is the serving format.** The trained model is an XGBoost booster,
    and loading it for inference drags in xgboost, scikit-learn, scipy and pandas
    -- 358 MB of runtime for a 363 kB decision tree. ONNX Runtime alone is 40 MB
    and needs none of them, which is the difference between fitting inside a
    serverless function and not.

    It is also the edge story from the technical profile made real: the same
    artifact runs on the API and on a control unit aboard the vessel, with no
    Python data-science stack installed on either.

    Returns the maximum absolute prediction difference, which the caller records
    in the model card so the claim is auditable rather than asserted.
    """
    import onnxruntime as ort
    from onnxmltools.convert.common.data_types import FloatTensorType

    initial_types = [("features", FloatTensorType([None, X_sample.shape[1]]))]

    if isinstance(model, XGBRegressor):
        from onnxmltools.convert import convert_xgboost

        onnx_model = convert_xgboost(model, initial_types=initial_types, target_opset=15)
    else:
        from skl2onnx import convert_sklearn

        onnx_model = convert_sklearn(model, initial_types=initial_types, target_opset=15)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(onnx_model.SerializeToString())

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    sample = X_sample.astype(np.float32)

    original = np.asarray(model.predict(sample)).ravel()
    exported = np.asarray(session.run(None, {input_name: sample})[0]).ravel()
    drift = float(np.abs(original - exported).max())

    if drift > ONNX_PARITY_TOLERANCE:
        raise RuntimeError(
            f"ONNX export disagrees with the trained model by {drift:.2e} "
            f"(tolerance {ONNX_PARITY_TOLERANCE:.0e}). The exported model is not "
            "the model these metrics describe; refusing to ship it."
        )
    return drift


def train(*, artifact_path: Path = ARTIFACT_PATH, verbose: bool = True) -> dict:
    ds = build_dataset()
    X = ds.features.to_numpy()
    y = ds.target.to_numpy()
    groups = ds.groups.to_numpy()

    # Whole wear states are held out, never individual rows. With a factorial
    # grid, a row-wise split leaks: the held-out point sits between two training
    # points 0.001 of a decay coefficient away, and any model scores near-perfectly
    # without having generalised to anything.
    splitter = GroupShuffleSplit(
        n_splits=1, test_size=HELD_OUT_STATE_FRACTION, random_state=RANDOM_SEED
    )
    train_idx, test_idx = next(splitter.split(X, y, groups))
    X_train, X_test = X[train_idx], X[test_idx]
    y_train, y_test = y[train_idx], y[test_idx]

    scores: list[Score] = []

    # Baseline 1: the do-nothing model. Assume every engine is healthy. This is
    # what the system does today with no fuel map at all, and its error is the
    # size of the problem being solved.
    scores.append(_score("assume-healthy", y_test, np.ones_like(y_test)))

    # Baseline 2: two-parameter linear fit. If this ties, ship this.
    linear = LinearRegression().fit(X_train, y_train)
    scores.append(_score("linear", y_test, linear.predict(X_test)))

    started = time.perf_counter()
    model = XGBRegressor(**XGB_PARAMS).fit(X_train, y_train)
    fit_seconds = time.perf_counter() - started
    scores.append(_score("xgboost", y_test, model.predict(X_test)))

    by_name = {s.name: s for s in scores}
    best = min(scores[1:], key=lambda s: s.mae_pct_of_fuel)

    card = {
        "model": "fuel degradation multiplier",
        "target": TARGET_COLUMN,
        "target_meaning": (
            "specific fuel consumption as a multiple of the same engine's healthy "
            "SFC at the same shaft load"
        ),
        "features": list(FEATURE_COLUMNS),
        "training_data": {
            "source": "UCI CBM (Coraddu et al., 2014), CC BY 4.0",
            "prime_mover": "27 MW marine gas turbine — a documented proxy for a "
            "small marine diesel; see docs/DATA.md",
            "rows_used": int(len(ds.frame)),
            "rows_dropped": int(ds.rows_dropped),
            "excluded_lever_speeds_kn": list(EXCLUDED_LEVER_SPEEDS_KN),
            # Distinct *lever positions*, not distinct load_fraction floats. The
            # grid is factorial: load is commanded at a handful of lever settings
            # and load_fraction is a near-continuous quantity derived from the
            # measured torque, so nunique() on it returns ~one value per row
            # (9207 of 9282) and reads as dense sampling of an axis that is
            # actually coarse. That inverts the limitation this card exists to
            # disclose.
            "distinct_load_points": int(ds.frame.lever_position.nunique()),
            "distinct_wear_states": int(ds.frame.degradation_state_id.nunique()),
            "load_fraction_range": [
                float(ds.frame.load_fraction.min()),
                float(ds.frame.load_fraction.max()),
            ],
            "observed_wear_penalty_pct": float((ds.target.max() - 1.0) * 100.0),
        },
        "validation": {
            "split": "GroupShuffleSplit over whole (compressor, turbine) decay states",
            "rationale": "row-wise splits leak across a factorial grid",
            "held_out_wear_states": int(len(set(groups[test_idx]))),
            "held_out_rows": int(len(test_idx)),
            "scores": {s.name: asdict(s) for s in scores},
            "selected": best.name,
        },
        "known_limits": [
            f"Load is commanded at only {ds.frame.lever_position.nunique()} distinct lever "
            "positions. The wear axis is densely sampled and trustworthy; the load "
            "axis is interpolated between coarse steps.",
            "Trained on a gas turbine. Only the dimensionless wear penalty is "
            "transferred; absolute fuel level comes from a diesel BSFC curve.",
            "Wind, current, wave height and passenger load do not vary in this "
            "dataset and are handled by services/speed/resistance.py instead.",
        ],
        "xgb_params": {k: v for k, v in XGB_PARAMS.items()},
        "fit_seconds": round(fit_seconds, 2),
        "random_seed": RANDOM_SEED,
    }

    chosen = model if best.name == "xgboost" else linear

    # ONNX is the serving format; the joblib below is kept for retraining and
    # inspection only. Nothing in apps/api loads the joblib.
    onnx_drift = export_onnx(chosen, X_test[:512])
    card["serving"] = {
        "format": "onnx",
        "artifact": str(ONNX_PATH),
        "runtime": "onnxruntime",
        "parity_max_abs_diff": onnx_drift,
        "rationale": (
            "Serving through xgboost/scikit-learn requires 358 MB of runtime for a "
            "363 kB model. ONNX Runtime needs 40 MB and no data-science stack, which "
            "is what lets the advisory API run as a serverless function and what the "
            "profile's edge-inference claim actually rests on."
        ),
    }

    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {
            "model": chosen,
            "model_name": best.name,
            "features": list(FEATURE_COLUMNS),
            "load_fraction_range": card["training_data"]["load_fraction_range"],
            "card": card,
        },
        artifact_path,
    )
    MODEL_CARD_PATH.write_text(json.dumps(card, indent=2), encoding="utf-8")

    if verbose:
        _report(ds, scores, by_name, best, artifact_path)
        print(f"  -> {ONNX_PATH}  (serving format, parity {onnx_drift:.1e})\n")
    return card


def _report(ds, scores, by_name, best, artifact_path: Path) -> None:
    # ASCII only: the Windows console defaults to cp1252 and mangles em-dashes.
    print(f"\nFuel degradation map - {len(ds.frame):,} rows, "
          f"{ds.frame.degradation_state_id.nunique()} wear states, "
          f"{ds.rows_dropped:,} rows dropped\n")
    print(f"  {'model':<16} {'MAE':>9} {'max err':>9} {'R2':>8}")
    for s in scores:
        print(
            f"  {s.name:<16} {s.mae_pct_of_fuel:>8.3f}% {s.max_error_pct_of_fuel:>8.3f}% "
            f"{s.r2:>8.4f}"
        )

    naive = by_name["assume-healthy"].mae_pct_of_fuel
    print(f"\n  selected: {best.name}")
    print(
        f"  Ignoring engine wear costs {naive:.2f}% of fuel in average error; "
        f"{best.name} cuts that to {best.mae_pct_of_fuel:.3f}%."
    )
    gap = by_name["linear"].mae_pct_of_fuel - by_name["xgboost"].mae_pct_of_fuel
    if abs(gap) < 0.01:
        print(
            "  NOTE: XGBoost and linear are within 0.01pp - "
            "the extra model is not earning its keep."
        )
    print(f"\n  -> {artifact_path}\n  -> {MODEL_CARD_PATH}\n")


if __name__ == "__main__":
    train()
