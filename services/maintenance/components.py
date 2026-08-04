"""The parts that strand a boat, and the channels that see them coming.

Four systems, and under each only the components whose failure actually ends a
crossing. A list of every serviceable item would be a parts catalogue; this is
the set a coastal passenger boat is genuinely lost to, which is the useful list
for a panel a skipper reads before departure.

Two things are declared per component and both matter:

**Design life, in wear-hours.** Not run-hours. An hour at overload takes more out
of a stern tube than an hour at cruise -- `services/maintenance/duty.py` weights
that at 2.6 against 1.0 -- so lives are denominated in the weighted figure and a
hard-worked boat reaches them sooner in calendar time. Class-typical for a
200-300 HP marine diesel installation in coastal service; a specific engine's
manual overrides every line, and the display says so.

**Which channels bear on it, and how hard.** A stern tube bearing announces
itself in vibration and says nothing through exhaust temperature; an injector is
the reverse. Weighting the channels per component is what stops one noisy stream
dragging every part's score down together, and it is what lets the panel answer
"why?" with a channel name instead of a shrug.

The weights are stated, not fitted. With a season of labelled failures they
should be learned; until then an engineer can read them off this page and
disagree, which is the right property for a number with no data behind it yet.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from packages.contracts.pdm import VesselSystem


@dataclass(frozen=True)
class MonitoredPart:
    """One component, its life, and the channels that inform its health."""

    component_id: str
    label_en: str
    label_fil: str
    system: VesselSystem
    design_life_wear_hours: float
    criticality: int
    """1 strands the boat, 2 ends the voyage, 3 degrades it."""

    channel_weights: dict[str, float] = field(default_factory=dict)
    """Channel key -> how much its residual moves this component's condition.
    Weights need not sum to one; they are relative influences, normalised at use."""

    failure_mode_en: str = ""
    """What actually goes wrong. Shown to the operator, because "shaft: 41%" means
    nothing without "stern tube bearing wears, seal passes water"."""


SYSTEM_LABELS: dict[VesselSystem, tuple[str, str]] = {
    VesselSystem.PROPULSION: ("Propeller & Drive System", "Propela at Sistema ng Pagpapatakbo"),
    VesselSystem.ENGINE: ("Engine", "Makina"),
    VesselSystem.FUEL: ("Fuel System", "Sistema ng Krudo"),
    VesselSystem.ELECTRICAL: ("Electrical System", "Sistemang Elektrikal"),
}


PARTS: tuple[MonitoredPart, ...] = (
    # ---------------- Propeller & drive -----------------------------------
    MonitoredPart(
        "stern_tube_bearing", "Stern tube bearing & seal", "Bearing at seal ng stern tube",
        VesselSystem.PROPULSION, 8000.0, 1,
        {"vibration_rms_g": 1.0},
        "Bearing wears, the seal passes water, and the shaft runs out of true.",
    ),
    MonitoredPart(
        "propeller", "Propeller", "Propela",
        VesselSystem.PROPULSION, 10000.0, 1,
        {"vibration_rms_g": 0.8},
        "Blade erosion and cavitation damage; a strike bends a blade and unbalances the shaft.",
    ),
    MonitoredPart(
        "shaft_coupling", "Shaft & flexible coupling", "Shaft at coupling",
        VesselSystem.PROPULSION, 9000.0, 2,
        {"vibration_rms_g": 0.9},
        "Misalignment works the coupling until it fails, taking the gearbox output with it.",
    ),
    MonitoredPart(
        "rudder_gear", "Rudder & steering gear", "Timon at steering gear",
        VesselSystem.PROPULSION, 12000.0, 1,
        {"vibration_rms_g": 0.3},
        "Bearing play and linkage wear; loss of steering is the one failure with no workaround.",
    ),

    # ---------------- Engine ----------------------------------------------
    MonitoredPart(
        "cooling_circuit", "Raw-water pump & heat exchanger", "Water pump at heat exchanger",
        VesselSystem.ENGINE, 6000.0, 1,
        {"coolant_temp_c": 1.0, "exhaust_gas_temp_c": 0.5},
        "Impeller vanes shed and the exchanger silts; the engine overheats within minutes of losing flow.",
    ),
    MonitoredPart(
        "lubrication", "Oil pump, cooler & filtration", "Oil pump at filter",
        VesselSystem.ENGINE, 7000.0, 1,
        {"oil_pressure_kpa": 1.0, "oil_particulate_ppm": 0.8},
        "Pressure falls and debris circulates; bearing damage follows quickly and is not repairable at sea.",
    ),
    MonitoredPart(
        "liners_rings", "Cylinder liners & piston rings", "Liner at singsing ng piston",
        VesselSystem.ENGINE, 10000.0, 2,
        {"oil_particulate_ppm": 1.0, "exhaust_gas_temp_c": 0.6, "vibration_rms_g": 0.3},
        "Bore wear raises oil consumption and blow-by; the engine loses compression gradually, not suddenly.",
    ),
    MonitoredPart(
        "valve_train", "Valve train & cylinder head", "Valve train at cylinder head",
        VesselSystem.ENGINE, 8000.0, 2,
        {"exhaust_gas_temp_c": 0.8, "vibration_rms_g": 0.5},
        "Clearances close up and a valve burns; exhaust temperature leads the failure.",
    ),

    # ---------------- Fuel -------------------------------------------------
    MonitoredPart(
        "injectors", "Injectors & nozzles", "Injector at nozzle",
        VesselSystem.FUEL, 6000.0, 1,
        {"exhaust_gas_temp_c": 1.0, "exhaust_nox_ppm": 0.7},
        "Nozzles coke and spray pattern degrades; exhaust temperature climbs before power falls off.",
    ),
    MonitoredPart(
        "fuel_filter", "Filter & water separator", "Filter at water separator",
        VesselSystem.FUEL, 3000.0, 1,
        {"exhaust_gas_temp_c": 0.4},
        "Blocks on dirty fuel and starves the engine -- the commonest cause of a coastal boat stopping.",
    ),
    MonitoredPart(
        "fuel_pump", "Fuel pump & delivery", "Fuel pump at linya",
        VesselSystem.FUEL, 8000.0, 2,
        {"exhaust_gas_temp_c": 0.5, "exhaust_nox_ppm": 0.4},
        "Delivery pressure drops off; the engine will not hold rated power under load.",
    ),

    # ---------------- Electrical -------------------------------------------
    MonitoredPart(
        "alternator", "Alternator & regulator", "Alternator at regulator",
        VesselSystem.ELECTRICAL, 5000.0, 2,
        {"battery_voltage_v": 1.0},
        "Charging output falls; the batteries flatten over a day or two rather than all at once.",
    ),
    MonitoredPart(
        "batteries", "Battery bank", "Baterya",
        VesselSystem.ELECTRICAL, 4000.0, 1,
        {"battery_voltage_v": 1.0},
        "Capacity fades until the engine will not crank -- typically discovered at the pier, in the dark.",
    ),
    MonitoredPart(
        "starter", "Starter motor & circuit", "Starter at circuit",
        VesselSystem.ELECTRICAL, 6000.0, 2,
        {"battery_voltage_v": 0.6},
        "Brushes and solenoid wear; cranking voltage dips deeper each start.",
    ),
)

PARTS_BY_SYSTEM: dict[VesselSystem, tuple[MonitoredPart, ...]] = {
    system: tuple(p for p in PARTS if p.system is system) for system in VesselSystem
}

PART_BY_ID = {p.component_id: p for p in PARTS}


def channels_for_system(system: VesselSystem) -> list[str]:
    """Every channel that bears on any component of a system, most influential first."""
    weights: dict[str, float] = {}
    for part in PARTS_BY_SYSTEM[system]:
        for channel, w in part.channel_weights.items():
            weights[channel] = max(weights.get(channel, 0.0), w)
    return [c for c, _ in sorted(weights.items(), key=lambda kv: -kv[1])]
