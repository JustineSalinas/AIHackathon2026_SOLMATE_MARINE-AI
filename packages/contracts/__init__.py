"""Shared data contracts for Marine-AI.

Pydantic models here are the single source of truth. TypeScript types for the
bridge display are generated from their JSON Schema by
`packages/contracts/export_schema.py` -> `apps/bridge/lib/contracts.ts`.

Never hand-edit the generated TypeScript. Change the model, re-run the export.

Unit convention, applied without exception:
  - all timestamps are timezone-aware UTC
  - `_c` celsius, `_kpa` kilopascal, `_v` volts, `_rpm` rev/min
  - `_lph` litres per hour, `_l` litres
  - `_kn` knots, `_m` metres, `_deg` degrees (compass or lat/lon)
  - `_nm` nautical miles, `_kg` kilograms
"""

from packages.contracts.bridge import BridgeState, ModuleStatus
from packages.contracts.emissions import (
    BaselineMethod,
    EmissionsReport,
    EmissionsReportLine,
    VoyageRecord,
)
from packages.contracts.maintenance import (
    AnomalyStream,
    MaintenancePhase,
    MaintenanceStatus,
)
from packages.contracts.route import RouteRecommendation, Waypoint
from packages.contracts.safety import SafetyCutoff, SafetyState, Severity
from packages.contracts.speed import SpeedRecommendation
from packages.contracts.telemetry import (
    ElectroMechanicalFrame,
    OperatorContext,
    RoutingFrame,
    TelemetryFrame,
    ThrottlingFrame,
    VesselProfile,
)

__all__ = [
    "AnomalyStream",
    "BaselineMethod",
    "BridgeState",
    "ElectroMechanicalFrame",
    "EmissionsReport",
    "EmissionsReportLine",
    "MaintenancePhase",
    "MaintenanceStatus",
    "ModuleStatus",
    "OperatorContext",
    "RouteRecommendation",
    "RoutingFrame",
    "SafetyCutoff",
    "SafetyState",
    "Severity",
    "SpeedRecommendation",
    "TelemetryFrame",
    "ThrottlingFrame",
    "VesselProfile",
    "VoyageRecord",
    "Waypoint",
]
