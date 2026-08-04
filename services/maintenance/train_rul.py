"""Phase 2 methodology: remaining useful life, demonstrated on NASA C-MAPSS.

    python -m services.maintenance.train_rul

**Read this before quoting any number this file produces.**

The vessel has no labelled failure history. That is the whole reason
`packages/contracts/maintenance.py` forbids a Phase 1 unit from naming a
component or a repair date, and no model trained here changes it. What this
module does is demonstrate that the *method* works, on the only real run-to-
failure corpus available: 100 turbofan engines run to breakdown under a single
operating condition and a single fault mode.

So the output is a capability claim, not a vessel claim:

    "The RUL method predicts remaining life on held-out engines to within
     N cycles RMSE. This vessel's own model needs its own failure history."

`data/registry.py` states the corpus is "explicitly not a source of RUL
predictions here", and that stays true: nothing in this file is wired into
`/maintenance` or the P.P.S. panel, and it must not be. The panel's figures come
from `services/maintenance/lifespan.py` -- design lives divided by measured
exposure, which is arithmetic about this boat rather than a turbofan's fate.

`docs/PROJECT_OVERVIEW.md` has carried "Phase 2 (RUL) -- methodology demo on
C-MAPSS" as a roadmap line since before this file existed. This is that line.

**Validation is per unit, on the supplied test set.** C-MAPSS ships truncated
test trajectories and a separate file of true remaining life, so the honest
question is "given a partial history, how much life is left?" -- scored once per
engine at the last cycle it was observed. A row-wise split would leak: consecutive
cycles of the same engine are nearly identical, so a random split trains on the
answer. This is the same reasoning `models/route_forecast.card.json` gives for
its time-based split.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[2]
CMAPSS_DIR = (
    REPO_ROOT
    / "data"
    / "raw"
    / "nasa-cmapss"
    / "6. Turbofan Engine Degradation Simulation Data Set"
)
ONNX_PATH = REPO_ROOT / "models" / "rul_cmapss.onnx"
MODEL_CARD_PATH = REPO_ROOT / "models" / "rul_cmapss.card.json"

SUBSET = "FD001"
"""One operating condition, one fault mode, 100 train and 100 test engines.

The cleanest of the four subsets, and the right one for a methodology
demonstration: FD002 and FD004 mix six operating conditions, which turns the
problem into condition-detection plus RUL and muddies what is being shown."""

RUL_CAP = 125
"""Piecewise-linear RUL cap, in cycles.

An engine 300 cycles from failure is not meaningfully more healthy than one 200
cycles away -- degradation has not started, and the sensors say nothing. Training
against the raw countdown therefore asks the model to predict a number the inputs
do not contain, and it answers by fitting noise. Capping the target is the
conventional treatment for this dataset and is stated here rather than buried."""

WINDOW = 20
"""Cycles of history summarised into each feature row. Long enough for a trend to
be visible above C-MAPSS's sensor noise, short enough that the truncated test
trajectories -- some only 31 cycles -- still produce a window."""

SENSOR_COLS = [f"s{i}" for i in range(1, 22)]
SETTING_COLS = ["op1", "op2", "op3"]
COLUMNS = ["unit", "cycle", *SETTING_COLS, *SENSOR_COLS]

RANDOM_SEED = 20260804


def load_subset(subset: str = SUBSET) -> tuple[pd.DataFrame, pd.DataFrame, np.ndarray]:
    """Read the whitespace-delimited train/test/RUL triple for one subset."""
    train = pd.read_csv(
        CMAPSS_DIR / f"train_{subset}.txt", sep=r"\s+", header=None, names=COLUMNS,
        index_col=False, engine="python",
    )
    test = pd.read_csv(
        CMAPSS_DIR / f"test_{subset}.txt", sep=r"\s+", header=None, names=COLUMNS,
        index_col=False, engine="python",
    )
    true_rul = pd.read_csv(
        CMAPSS_DIR / f"RUL_{subset}.txt", sep=r"\s+", header=None, engine="python",
    ).iloc[:, 0].to_numpy(dtype=float)
    return train, test, true_rul


def informative_sensors(train: pd.DataFrame) -> list[str]:
    """Drop channels that never move.

    Several C-MAPSS sensors are constant for the whole of FD001 -- they carry no
    signal, and feeding them wastes model capacity and pads the feature vector
    that has to be shipped to ONNX. Dropped by measurement rather than from a list
    copied out of a paper, so the choice re-derives if the subset changes.
    """
    return [c for c in SENSOR_COLS if train[c].std() > 1e-6]


def _window_features(block: pd.DataFrame, sensors: list[str]) -> np.ndarray:
    """Summarise the last `WINDOW` cycles of one engine into a feature row.

    Three statistics per sensor: last value, window mean, and slope. The slope is
    what makes this a degradation model rather than a threshold check -- a sensor
    sitting high and steady is a different engine from one climbing through the
    same reading.
    """
    tail = block.tail(WINDOW)
    x = np.arange(len(tail), dtype=float)
    feats: list[float] = [float(block["cycle"].iloc[-1])]
    for col in sensors:
        v = tail[col].to_numpy(dtype=float)
        feats.append(float(v[-1]))
        feats.append(float(v.mean()))
        # polyfit needs two distinct points; a one-cycle tail has no slope.
        feats.append(float(np.polyfit(x, v, 1)[0]) if len(v) > 1 else 0.0)
    return np.asarray(feats, dtype=np.float32)


def build_training_rows(train: pd.DataFrame, sensors: list[str]) -> tuple[np.ndarray, np.ndarray]:
    """Every cycle of every training engine becomes one capped-RUL example."""
    X: list[np.ndarray] = []
    y: list[float] = []
    for _, block in train.groupby("unit", sort=True):
        block = block.sort_values("cycle")
        end = int(block["cycle"].iloc[-1])
        for i in range(len(block)):
            history = block.iloc[: i + 1]
            if len(history) < 2:
                continue
            X.append(_window_features(history, sensors))
            y.append(min(RUL_CAP, end - int(history["cycle"].iloc[-1])))
    return np.vstack(X), np.asarray(y, dtype=np.float32)


def build_test_rows(test: pd.DataFrame, sensors: list[str]) -> np.ndarray:
    """One row per test engine, from the last cycle it was observed at."""
    rows = [
        _window_features(block.sort_values("cycle"), sensors)
        for _, block in test.groupby("unit", sort=True)
    ]
    return np.vstack(rows)


def nasa_score(error: np.ndarray) -> float:
    """The dataset's own asymmetric scoring function.

    Late predictions are penalised far more steeply than early ones, because an
    overestimate of remaining life is a component left in service past the point
    it should have come out. Worth reporting alongside RMSE, which treats the two
    directions as equally bad and so flatters a model that runs late.
    """
    return float(np.sum(np.where(error < 0, np.exp(-error / 13.0), np.exp(error / 10.0)) - 1.0))


def main() -> None:
    from xgboost import XGBRegressor

    from services.speed.train import export_onnx

    train, test, true_rul = load_subset()
    sensors = informative_sensors(train)

    X_train, y_train = build_training_rows(train, sensors)
    X_test = build_test_rows(test, sensors)
    y_test = np.minimum(true_rul, RUL_CAP)

    model = XGBRegressor(
        n_estimators=400,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_lambda=1.0,
        min_child_weight=10,
        random_state=RANDOM_SEED,
        n_jobs=4,
    )
    model.fit(X_train, y_train)

    pred = np.asarray(model.predict(X_test)).ravel()
    error = pred - y_test
    rmse = float(np.sqrt(np.mean(error**2)))
    mae = float(np.mean(np.abs(error)))
    score = nasa_score(error)

    # A model that predicted the training mean for every engine. Any RUL claim has
    # to beat this, and quoting the comparison stops a plausible-looking RMSE
    # standing in for a model that learned nothing.
    baseline_rmse = float(np.sqrt(np.mean((float(np.mean(y_train)) - y_test) ** 2)))

    # Scale-appropriate parity tolerance. export_onnx defaults to 1e-4 ABSOLUTE,
    # which is calibrated to a target around 1.0; RUL is 0-125 cycles, so 1e-2
    # absolute here is a RELATIVE parity of ~1e-4 -- the same strictness, not a
    # weaker guard. The observed drift is recorded in the card either way.
    drift = export_onnx(model, X_test.astype(np.float32), path=ONNX_PATH, tolerance=1e-2)

    card = {
        "model": "remaining useful life (methodology demonstration)",
        "not_a_vessel_claim": (
            "Trained and validated on NASA C-MAPSS turbofan engines. It is NOT wired "
            "into /maintenance or the component-life panel and must not be: this "
            "vessel has no labelled failure history, so it has no RUL model of its "
            "own. The panel's figures come from services/maintenance/lifespan.py, "
            "which divides published design lives by measured exposure."
        ),
        "target": "remaining cycles to failure, piecewise-linear capped at 125",
        "features": (
            f"cycle number, plus last value / window mean / window slope over the "
            f"last {WINDOW} cycles for each of {len(sensors)} informative sensors"
        ),
        "informative_sensors": sensors,
        "dropped_constant_sensors": [c for c in SENSOR_COLS if c not in sensors],
        "training_data": {
            "source": "NASA C-MAPSS Turbofan Engine Degradation Simulation (Saxena et al., 2008)",
            "licence": "U.S. Government work — public domain",
            "subset": SUBSET,
            "subset_rationale": "one operating condition, one fault mode",
            "train_units": int(train["unit"].nunique()),
            "test_units": int(test["unit"].nunique()),
            "train_rows": int(X_train.shape[0]),
            "feature_count": int(X_train.shape[1]),
        },
        "validation": {
            "split": "the dataset's own held-out test set, scored once per engine at "
                     "its last observed cycle against RUL_FD001.txt",
            "rationale": "consecutive cycles of one engine are nearly identical, so a "
                         "row-wise split trains on the answer",
            "test_rmse_cycles": round(rmse, 3),
            "test_mae_cycles": round(mae, 3),
            "nasa_asymmetric_score": round(score, 1),
            "predict_the_mean_rmse_cycles": round(baseline_rmse, 3),
        },
        "known_limits": [
            "Turbofan, not marine diesel. Demonstrates the method; transfers no "
            "component-level claim to a boat.",
            "FD001 is the easiest subset: one operating condition and one fault mode. "
            "Six-condition subsets are materially harder and were not attempted.",
            f"RUL is capped at {RUL_CAP} cycles, so the model cannot distinguish "
            "between engines that are merely far from failure.",
            "Scored on a single seed. No repeated-run variance is reported.",
        ],
        "xgb_params": model.get_params(),
        "random_seed": RANDOM_SEED,
        "serving": {
            "format": "onnx",
            "artifact": str(ONNX_PATH.relative_to(REPO_ROOT)),
            "runtime": "onnxruntime",
            "parity_max_abs_diff": drift,
        },
    }
    MODEL_CARD_PATH.write_text(json.dumps(card, indent=2, default=str), encoding="utf-8")

    print(f"C-MAPSS {SUBSET} RUL — methodology demonstration")
    print(f"  train units      : {train['unit'].nunique()}  rows {X_train.shape[0]}")
    print(f"  features         : {X_train.shape[1]}  ({len(sensors)} informative sensors)")
    print(f"  test units       : {test['unit'].nunique()}")
    print(f"  test RMSE        : {rmse:.2f} cycles")
    print(f"  test MAE         : {mae:.2f} cycles")
    print(f"  NASA score       : {score:.1f}")
    print(f"  predict-the-mean : {baseline_rmse:.2f} cycles RMSE")
    print(f"  ONNX parity drift: {drift:.2e}")
    print(f"  wrote {ONNX_PATH.relative_to(REPO_ROOT)} and {MODEL_CARD_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
