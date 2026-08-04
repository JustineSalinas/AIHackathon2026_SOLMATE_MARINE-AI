"""Import a historical dataset and refit the condition models on it.

The condition models in `normalize.py` can only normalise for weather they have
seen. A vessel three days into service has seen a few crossings in whatever the
weather happened to be, so its residuals are confident about calm water and
guessing about everything else. An operator with a season of logs already has the
answer; this is how they hand it over.

**Format: CSV, after ISO 19848.** ISO 19848:2024 -- "Ships and marine technology,
standard data for shipboard machinery and equipment" -- defines how a shipboard
data channel is named and identified, using a hierarchical slash-delimited
DataChannelID, and names CSV as a storage method for tabular channel data. Column
headers are therefore matched against DataChannelIDs first:

    timestamp,/main-engine/cooling/fresh-water/temperature,/propulsion/vibration/rms
    2026-03-04T06:12:00Z,78.4,0.041

Plain internal keys (`coolant_temp_c`) and a few common aliases are accepted too,
because insisting on a standard the operator's existing export does not use would
make the feature unusable and the standard pointless. Headers that match nothing
are REPORTED rather than dropped in silence: a mistyped column that vanishes
quietly is worse than one that fails loudly.

**What it cannot do.** It cannot make a calm-water dataset teach the model about a
head sea. `condition_coverage` is returned with the summary so the operator sees
the spread they actually supplied, rather than assuming ten thousand rows bought
ten thousand rows' worth of understanding.
"""

from __future__ import annotations

import csv
import io
import math
from datetime import UTC, datetime

from packages.contracts.pdm import HistoryImportSummary
from packages.contracts.telemetry import TelemetryFrame
from services.maintenance.normalize import (
    CHANNELS,
    ConditionModelSet,
    condition_coverage,
    fit_condition_models,
)

MAX_ROWS = 200_000
"""Ceiling on accepted rows. A season of 1 Hz logging is about 20 million rows;
this is a console upload, not a data-warehouse ingest, and a browser tab that
freezes on a 2 GB file has helped nobody."""

# Header -> internal channel key. LocalIDs come from the channel registry so the
# two cannot drift; the aliases are the names real exports actually carry.
_ALIASES: dict[str, str] = {
    "coolant": "coolant_temp_c", "coolant_temp": "coolant_temp_c",
    "engine_coolant_temperature": "coolant_temp_c", "jacket_water_temp": "coolant_temp_c",
    "oil_pressure": "oil_pressure_kpa", "lube_oil_pressure": "oil_pressure_kpa",
    "egt": "exhaust_gas_temp_c", "exhaust_temp": "exhaust_gas_temp_c",
    "exhaust_gas_temperature": "exhaust_gas_temp_c",
    "battery": "battery_voltage_v", "battery_voltage": "battery_voltage_v",
    "oil_particulate": "oil_particulate_ppm", "oil_debris": "oil_particulate_ppm",
    "nox": "exhaust_nox_ppm",
    "vibration": "vibration_rms_g", "vib_rms": "vibration_rms_g",
}

# Context columns. Not sensor channels -- these are the operating conditions the
# residual models normalise against, and a dataset without them can still be
# imported but teaches the models far less.
_CONTEXT: dict[str, str] = {
    "rpm": "engine_rpm", "engine_rpm": "engine_rpm",
    "torque": "engine_torque_nm", "engine_torque_nm": "engine_torque_nm",
    "wave_height": "wave_height_m", "wave_height_m": "wave_height_m", "hs": "wave_height_m",
    "heading": "heading_deg", "heading_deg": "heading_deg", "hdg": "heading_deg",
    "wind_direction": "wind_direction_deg", "wind_direction_deg": "wind_direction_deg",
    "wind_from": "wind_direction_deg",
    "wind_speed": "wind_speed_kn", "wind_speed_kn": "wind_speed_kn",
    "sog": "speed_over_ground_kn", "speed_over_ground_kn": "speed_over_ground_kn",
}

_TIMESTAMP = {"timestamp", "ts", "time", "datetime", "recorded_at"}


def _resolve(header: str) -> tuple[str | None, str | None]:
    """Map one column header to (channel_key, context_key). Both None if unknown."""
    h = header.strip()
    lower = h.lower()

    for channel in CHANNELS:
        if lower == channel.local_id.lower() or lower == channel.key:
            return channel.key, None
    if lower in _ALIASES:
        return _ALIASES[lower], None
    if lower in _CONTEXT:
        return None, _CONTEXT[lower]
    return None, None


def _parse_ts(value: str) -> datetime | None:
    v = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def parse_history_csv(
    text: str, *, vessel_id: str = "MV-CONSOLE-01"
) -> tuple[list[TelemetryFrame], HistoryImportSummary]:
    """Turn an uploaded CSV into frames, and say honestly what came of it."""
    reader = csv.reader(io.StringIO(text))
    try:
        headers = next(reader)
    except StopIteration:
        return [], HistoryImportSummary(
            rows_received=0, rows_accepted=0, rows_rejected=0,
            channels_mapped=[], message_en="The file was empty.",
            message_fil="Walang laman ang file.",
        )

    channel_cols: dict[int, str] = {}
    context_cols: dict[int, str] = {}
    ts_col: int | None = None
    unrecognised: list[str] = []

    for i, raw in enumerate(headers):
        if raw.strip().lower() in _TIMESTAMP:
            ts_col = i
            continue
        channel, context = _resolve(raw)
        if channel:
            channel_cols[i] = channel
        elif context:
            context_cols[i] = context
        elif raw.strip():
            unrecognised.append(raw.strip())

    frames: list[TelemetryFrame] = []
    received = accepted = rejected = 0
    first_ts: datetime | None = None
    last_ts: datetime | None = None

    for row in reader:
        received += 1
        if received > MAX_ROWS:
            rejected += 1
            continue

        em: dict[str, float] = {}
        thr: dict[str, float] = {}
        rte: dict[str, float] = {}
        vibration: float | None = None

        for i, cell in enumerate(row):
            if not cell or not cell.strip():
                continue
            try:
                value = float(cell)
            except ValueError:
                continue
            if i in channel_cols:
                key = channel_cols[i]
                if key == "vibration_rms_g":
                    vibration = value
                else:
                    em[key] = value
            elif i in context_cols:
                key = context_cols[i]
                if key in {"engine_rpm", "engine_torque_nm", "wind_direction_deg", "wind_speed_kn"}:
                    thr[key] = value
                else:
                    rte[key] = value

        # Vibration arrives as a scalar RMS but the contract carries an
        # accelerometer, and the models derive RMS from axis variance. Distribute
        # it across three axes so an imported row aggregates to the value it was
        # given -- var per axis = v^2/3 reproduces sqrt(sum(var)) = v.
        if vibration is not None and vibration >= 0:
            a = vibration / math.sqrt(3.0)
            em["accel_x_g"] = a
            em["accel_y_g"] = -a
            em["accel_z_g"] = 1.0 + a

        if not em and not thr:
            rejected += 1
            continue

        ts = _parse_ts(row[ts_col]) if (ts_col is not None and ts_col < len(row)) else None
        ts = ts or datetime.now(UTC)
        first_ts = ts if first_ts is None or ts < first_ts else first_ts
        last_ts = ts if last_ts is None or ts > last_ts else last_ts

        try:
            frames.append(TelemetryFrame(
                vessel_id=vessel_id, ts=ts, source="historical-import",
                throttling=thr, routing=rte, electro_mechanical=em,
            ))
            accepted += 1
        except Exception:
            # A row outside the contract's declared ranges -- a coolant reading of
            # 900 degC, say. Rejected and counted, never coerced into range: a
            # silently clamped outlier trains the model on a fiction.
            rejected += 1

    span = None
    if first_ts and last_ts and last_ts > first_ts:
        span = (last_ts - first_ts).total_seconds() / 3600.0

    mapped = sorted(set(channel_cols.values()))
    if not mapped:
        msg_en = ("No recognised sensor channels. Column headers should be ISO 19848 "
                  "DataChannelIDs such as /main-engine/cooling/fresh-water/temperature, "
                  "or plain names like coolant_temp_c.")
        msg_fil = ("Walang nakilalang sensor channel. Dapat ISO 19848 DataChannelID ang "
                   "pamagat ng kolum, o payak na pangalan tulad ng coolant_temp_c.")
    else:
        msg_en = f"{accepted} rows accepted across {len(mapped)} channels."
        msg_fil = f"{accepted} hanay ang tinanggap sa {len(mapped)} channel."

    return frames, HistoryImportSummary(
        rows_received=received, rows_accepted=accepted, rows_rejected=rejected,
        channels_mapped=mapped, channels_unrecognised=unrecognised,
        span_hours=round(span, 2) if span else None,
        message_en=msg_en, message_fil=msg_fil,
    )


def refit_from_history(
    frames: list[TelemetryFrame], *, rated_rpm: float, summary: HistoryImportSummary
) -> tuple[ConditionModelSet, HistoryImportSummary]:
    """Refit the condition models on imported history and report what improved."""
    models = fit_condition_models(frames, rated_rpm=rated_rpm)
    coverage = condition_coverage(frames, rated_rpm=rated_rpm)

    refitted = sorted(models.models)
    if refitted:
        summary.message_en += (
            f" Condition models refitted for {len(refitted)} channels on "
            f"{models.rows_fitted} windows."
        )
        summary.message_fil += (
            f" Na-refit ang condition models para sa {len(refitted)} channel sa "
            f"{models.rows_fitted} window."
        )
    elif summary.rows_accepted:
        # Rows arrived but nothing could be fitted. Almost always the same cause,
        # so say it rather than leaving the operator to guess.
        summary.message_en += (
            " Not enough usable windows to refit — the dataset needs engine RPM "
            "alongside the sensor channels for conditions to be known."
        )
        summary.message_fil += (
            " Kulang ang magagamit na window para sa refit — kailangan ng engine RPM "
            "kasabay ng sensor channels."
        )

    summary = summary.model_copy(update={
        "models_refitted": refitted,
        "conditions_covered": {k: round(v, 3) for k, v in coverage.items()},
    })
    return models, summary
