"""The safety rule set, and the evaluator that runs it.

This module is deliberately the dullest code in the repository. It imports no
model, loads no artifact, calls no network, and holds no state. Given the same
telemetry frame it returns the same answer, forever, and any engineer can read a
threshold off the page and check it against an engine manual.

That dullness is the point. The technical profile calls the AI-authority boundary
non-negotiable: the three AI modules advise, the captain commands, and safety
cutoffs stay rule-based "so behaviour under fault is deterministic and
auditable". A learned safety layer would be the single least defensible thing
Marine-AI could ship -- when a judge asks *"what happens when your model is
wrong?"*, the answer has to be that the safety path never consulted the model at
all.

Three design decisions worth stating, because each one is a place where the
obvious implementation is wrong:

**1. Low oil pressure, not over-pressure.** The profile lists the cutoffs as
"over-temperature, over-pressure, critical battery voltage". Over-pressure is
not the failure mode a diesel lubrication system has. Oil pressure *falling* is
what destroys an engine -- bearing starvation from a failing pump, a leak, or
oil thinned by dilution -- and every marine diesel alarm panel in service watches
the low side. Implementing a literal "over-pressure" cutoff would satisfy the
document and protect nothing. Recorded as a deviation; see docs/DEVIATIONS.md.

**2. Rules that need a running engine say so.** A stopped engine legitimately has
zero oil pressure and a resting battery around 12.4 V. Evaluating those rules at
the wharf would fire two critical alarms on every healthy boat before it left the
berth -- and an alarm that is usually wrong is worse than no alarm, because crews
learn to silence it. `requires_running` gates them on engine RPM.

**3. A missing sensor is reported, never assumed safe.** A modular retrofit may
not have every channel wired. The contract has `skipped_rules` for exactly this,
and treating an absent reading as "nominal" would let an unwired temperature
sensor read as a healthy engine.

Thresholds below are for the demo vessel's ~90 kW high-speed marine diesel on a
12 V electrical system. In production they are per-vessel configuration taken
from the engine manufacturer's manual, not constants in a source file.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from packages.contracts.safety import SafetyCutoff, SafetyState, Severity
from packages.contracts.telemetry import TelemetryFrame

IDLE_RPM_FLOOR = 400.0
"""Below this the engine is treated as stopped, so pressure and charging rules
do not fire at the berth. A high-speed marine diesel idles near 700-800 rpm; 400
sits clearly under any running state and clearly over a stopped one."""


@dataclass(frozen=True)
class Rule:
    """One deterministic cutoff.

    `warning` and `critical` are compared with `direction`: an "above" rule trips
    when the reading rises past the threshold, a "below" rule when it falls past
    it. Keeping the comparison in data rather than in code is what lets the whole
    rule set be read as a table.
    """

    rule_id: str
    stream: str
    label_en: str
    label_fil: str
    unit: str

    read: Callable[[TelemetryFrame], float | None]
    direction: Literal["above", "below"]
    warning: float
    critical: float

    message_en: str
    message_fil: str

    requires_running: bool = False
    """True for rules that are only meaningful with the engine turning."""

    def breach(self, value: float) -> Severity:
        """Severity implied by a reading. NOMINAL when within limits."""
        if self.direction == "above":
            if value >= self.critical:
                return Severity.CRITICAL
            if value >= self.warning:
                return Severity.WARNING
        else:
            if value <= self.critical:
                return Severity.CRITICAL
            if value <= self.warning:
                return Severity.WARNING
        return Severity.NOMINAL


Reader = Callable[[TelemetryFrame], float | None]


def _em(getter: Reader) -> Reader:
    """Read an electro-mechanical channel, tolerating an absent block."""

    def read(frame: TelemetryFrame) -> float | None:
        if frame.electro_mechanical is None:
            return None
        return getter(frame)

    return read


RULES: tuple[Rule, ...] = (
    Rule(
        rule_id="coolant_overtemp",
        stream="electro_mechanical.coolant_temp_c",
        label_en="Engine coolant temperature",
        label_fil="Temperatura ng coolant ng makina",
        unit="C",
        read=_em(lambda f: f.electro_mechanical.coolant_temp_c),
        direction="above",
        warning=98.0,
        critical=105.0,
        # Never imperative: the display states the condition and its consequence,
        # and the captain decides. Same rule the advisory layer follows.
        message_en="Coolant is at {observed:.0f} C, past the {threshold:.0f} C limit. "
        "Overheating damages the engine within minutes.",
        message_fil="Ang coolant ay nasa {observed:.0f} C, lampas sa limitasyong "
        "{threshold:.0f} C. Ang sobrang init ay nakakasira ng makina sa loob ng ilang minuto.",
    ),
    Rule(
        rule_id="oil_pressure_low",
        stream="electro_mechanical.oil_pressure_kpa",
        label_en="Oil pressure",
        label_fil="Presyon ng langis",
        unit="kPa",
        read=_em(lambda f: f.electro_mechanical.oil_pressure_kpa),
        direction="below",
        warning=200.0,
        critical=100.0,
        message_en="Oil pressure is {observed:.0f} kPa, below the {threshold:.0f} kPa limit. "
        "Running without lubrication seizes the engine.",
        message_fil="Ang presyon ng langis ay {observed:.0f} kPa, mas mababa sa "
        "{threshold:.0f} kPa. Ang pagpapatakbo na walang pampadulas ay nakakasira ng makina.",
        requires_running=True,
    ),
    Rule(
        rule_id="battery_voltage_low",
        stream="electro_mechanical.battery_voltage_v",
        label_en="Battery voltage",
        label_fil="Boltahe ng baterya",
        unit="V",
        read=_em(lambda f: f.electro_mechanical.battery_voltage_v),
        direction="below",
        warning=12.6,
        critical=12.0,
        message_en="Bus voltage is {observed:.1f} V with the engine running; "
        "the alternator is not charging. Navigation and radio run on the battery alone.",
        message_fil="Ang boltahe ay {observed:.1f} V habang umaandar ang makina; "
        "hindi nagcha-charge ang alternator. Baterya na lang ang gumagana sa radyo at nabigasyon.",
        requires_running=True,
    ),
    Rule(
        rule_id="battery_voltage_high",
        stream="electro_mechanical.battery_voltage_v",
        label_en="Battery voltage",
        label_fil="Boltahe ng baterya",
        unit="V",
        read=_em(lambda f: f.electro_mechanical.battery_voltage_v),
        direction="above",
        warning=15.0,
        critical=15.8,
        # The one genuine over-voltage case: a failed regulator boils the
        # electrolyte and can cook every instrument on the bus.
        message_en="Bus voltage is {observed:.1f} V, above the {threshold:.1f} V limit. "
        "A failed regulator overcharges the battery and can damage instruments.",
        message_fil="Ang boltahe ay {observed:.1f} V, lampas sa {threshold:.1f} V. "
        "Ang sirang regulator ay sumosobra sa pag-charge at nakakasira ng mga instrumento.",
        requires_running=True,
    ),
    Rule(
        rule_id="exhaust_overtemp",
        stream="electro_mechanical.exhaust_gas_temp_c",
        label_en="Exhaust gas temperature",
        label_fil="Temperatura ng tambutso",
        unit="C",
        read=_em(lambda f: f.electro_mechanical.exhaust_gas_temp_c),
        direction="above",
        warning=520.0,
        critical=580.0,
        message_en="Exhaust temperature is {observed:.0f} C, past the {threshold:.0f} C limit. "
        "Sustained overtemperature damages the turbocharger and injectors.",
        message_fil="Ang temperatura ng tambutso ay {observed:.0f} C, lampas sa "
        "{threshold:.0f} C. Ang tuloy-tuloy na sobrang init ay nakakasira ng turbo at injector.",
        requires_running=True,
    ),
)


def _engine_running(frame: TelemetryFrame) -> bool | None:
    """True, False, or None when RPM was not reported.

    None matters: with no RPM channel we cannot tell a stopped engine from a
    running one, so rules that depend on it are skipped rather than guessed.
    """
    if frame.throttling is None or frame.throttling.engine_rpm is None:
        return None
    return frame.throttling.engine_rpm >= IDLE_RPM_FLOOR


def evaluate(
    frame: TelemetryFrame,
    *,
    vessel_id: str | None = None,
    now: datetime | None = None,
) -> SafetyState:
    """Run every rule against one frame.

    Takes a single frame, not a window, and that is deliberate: a cutoff must fire
    on the reading in front of it. Averaging over a window would delay a coolant
    alarm by exactly the length of the window, which on an overheating engine is
    the difference between a warning and a repair.

    Anomaly detection is the opposite -- it needs a window, and it lives in
    `services/maintenance/`. The two are separate on purpose: one is a learned
    model that can be wrong, the other is a threshold that cannot.
    """
    generated_at = now or datetime.now(UTC)
    running = _engine_running(frame)

    active: list[SafetyCutoff] = []
    skipped: list[str] = []
    evaluated = 0

    for rule in RULES:
        value = rule.read(frame)
        if value is None:
            skipped.append(rule.rule_id)
            continue
        if rule.requires_running:
            if running is None:
                skipped.append(rule.rule_id)
                continue
            if not running:
                # Not a skip in the "sensor missing" sense -- the reading is there
                # and the rule simply does not apply to a stopped engine.
                continue

        evaluated += 1
        severity = rule.breach(value)
        if severity is Severity.NOMINAL:
            continue

        threshold = rule.critical if severity is Severity.CRITICAL else rule.warning
        active.append(
            SafetyCutoff(
                rule_id=rule.rule_id,
                severity=severity,
                stream=rule.stream,
                label_en=rule.label_en,
                label_fil=rule.label_fil,
                observed=round(float(value), 3),
                threshold=threshold,
                unit=rule.unit,
                message_en=rule.message_en.format(observed=value, threshold=threshold),
                message_fil=rule.message_fil.format(observed=value, threshold=threshold),
                triggered_at=generated_at,
            )
        )

    # Critical first, then warnings; within a severity, worst breach first. The
    # display shows the top of this list, so the ordering decides what a captain
    # reads in the two seconds they have.
    order = {Severity.CRITICAL: 0, Severity.WARNING: 1, Severity.NOMINAL: 2}
    active.sort(key=lambda c: (order[c.severity], -abs(c.observed - c.threshold)))

    severity = Severity.NOMINAL
    if any(c.severity is Severity.CRITICAL for c in active):
        severity = Severity.CRITICAL
    elif active:
        severity = Severity.WARNING

    return SafetyState(
        vessel_id=vessel_id or frame.vessel_id,
        generated_at=generated_at,
        severity=severity,
        active=active,
        evaluated_rules=evaluated,
        skipped_rules=skipped,
    )
