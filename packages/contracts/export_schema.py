"""Emit TypeScript types from the Pydantic contracts.

    python -m packages.contracts.export_schema

The `packages/contracts` docstring has promised this file since the scaffold:
the Pydantic models are the single source of truth, and the bridge display's
types are generated from them rather than maintained in parallel. Two hand-kept
copies of a contract are one contract and one lie, and the lie is discovered on
stage.

Deliberately a small emitter rather than a `json-schema-to-typescript`
dependency. The schema surface here is narrow -- flat models, primitives,
optionals, lists, enums, and refs between them -- and a hundred lines that
handle exactly that is easier to trust than a general tool plus a Node build
step in the middle of a Python repository.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from apps.api.schemas import (
    AdviseRequest,
    AdviseResponse,
    MaintenanceRequest,
    RouteRequest,
    RouteResponse,
    SafetyRequest,
)
from packages.contracts import (
    BridgeState,
    EmissionsReport,
    MaintenanceStatus,
    RouteRecommendation,
    SafetyState,
    SpeedRecommendation,
    TelemetryFrame,
    VesselProfile,
    VoyageRecord,
)

OUTPUT = Path("apps/bridge/lib/contracts.ts")

EXPORTED: tuple[type[BaseModel], ...] = (
    AdviseRequest,
    AdviseResponse,
    RouteRequest,
    RouteResponse,
    MaintenanceRequest,
    SafetyRequest,
    VoyageRecord,
    EmissionsReport,
    BridgeState,
    SpeedRecommendation,
    RouteRecommendation,
    MaintenanceStatus,
    SafetyState,
    TelemetryFrame,
    VesselProfile,
)


def _ts_type(schema: dict[str, Any], required: bool) -> str:
    """One JSON-Schema node -> one TypeScript type expression."""
    ts = _ts_type_inner(schema)
    if not required and "null" not in ts:
        ts = f"{ts} | null"
    return ts


def _ts_type_inner(schema: dict[str, Any]) -> str:
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]

    if "const" in schema:
        value = schema["const"]
        if isinstance(value, bool):
            return "true" if value else "false"
        return repr(value).replace("'", '"')

    if "enum" in schema:
        return " | ".join(f'"{v}"' for v in schema["enum"])

    if "anyOf" in schema:
        parts = [_ts_type_inner(s) for s in schema["anyOf"]]
        # Collapse the Optional[X] pattern Pydantic emits as anyOf[X, null].
        seen: list[str] = []
        for p in parts:
            if p not in seen:
                seen.append(p)
        return " | ".join(seen)

    kind = schema.get("type")
    if kind == "array":
        return f"{_ts_type_inner(schema.get('items', {}))}[]"
    if kind == "object":
        extra = schema.get("additionalProperties")
        if isinstance(extra, dict):
            return f"Record<string, {_ts_type_inner(extra)}>"
        return "Record<string, unknown>"
    if kind == "string":
        return "string"
    if kind in ("number", "integer"):
        return "number"
    if kind == "boolean":
        return "boolean"
    if kind == "null":
        return "null"
    return "unknown"


def _emit_model(name: str, schema: dict[str, Any]) -> str:
    if "enum" in schema:
        values = " | ".join(f'"{v}"' for v in schema["enum"])
        return f"export type {name} = {values};\n"

    required = set(schema.get("required", []))
    lines = [f"export interface {name} {{"]
    for field, node in schema.get("properties", {}).items():
        is_required = field in required
        ts = _ts_type(node, is_required)
        if desc := node.get("description"):
            lines.append(f"  /** {desc.strip()} */")
        optional = "" if is_required else "?"
        lines.append(f"  {field}{optional}: {ts};")
    lines.append("}\n")
    return "\n".join(lines)


def build() -> str:
    definitions: dict[str, dict[str, Any]] = {}
    roots: list[tuple[str, dict[str, Any]]] = []

    for model in EXPORTED:
        schema = model.model_json_schema(ref_template="#/$defs/{model}")
        definitions.update(schema.pop("$defs", {}))
        roots.append((model.__name__, schema))

    try:
        commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        commit = "unknown"

    out = [
        "// GENERATED FILE -- DO NOT EDIT.",
        "//",
        "// Emitted from the Pydantic contracts by:",
        "//     python -m packages.contracts.export_schema",
        "//",
        "// The Python models in packages/contracts and apps/api are the single",
        "// source of truth. Change them and re-run; never hand-edit this file.",
        f"// Generated from commit {commit}.",
        "",
    ]

    emitted: set[str] = set()
    for name, schema in sorted(definitions.items()):
        out.append(_emit_model(name, schema))
        emitted.add(name)
    for name, schema in roots:
        if name not in emitted:
            out.append(_emit_model(name, schema))
            emitted.add(name)

    return "\n".join(out)


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(build(), encoding="utf-8")
    print(f"-> {OUTPUT} ({len(EXPORTED)} root models)")


if __name__ == "__main__":
    main()
