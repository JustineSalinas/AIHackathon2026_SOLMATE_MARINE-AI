"""Cumulative run-hours at load, and the duty-cycle severity index.

The technical profile (§3.3) names exactly two derived features and calls them
"the literal data link between Problem 1 (inefficiency) and Problem 2
(accelerated wear)":

  * **Cumulative run-hours at each load level** — built from RPM and torque
    history. Inefficient throttling accelerates this number.
  * **Duty-cycle severity index** — a composite score of how hard the engine has
    been run relative to its rating.

This module is those two features and nothing else.

Worth being precise about what they are and are not. They are *bookkeeping*, not
a model: nobody trained anything here, and the severity index is a weighted sum
whose weights are stated below and can be argued with. That is the appropriate
form for a feature that will eventually become an input to a Phase 2 RUL model
trained on real failure history -- at which point the weights stop mattering,
because the survival model learns its own.

The repository already implements a *stronger* Problem 1 → Problem 2 link than
the profile describes: engine wear measurably raises fuel burn, via the wear
model in `services/speed/fuel.py`, and that link is priced in litres and pesos on
every advisory. These features are the profile's named version of the link, and
both are worth having -- one is measured, the other is the accumulated exposure
that explains it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from packages.contracts.telemetry import TelemetryFrame

LOAD_BANDS: tuple[tuple[str, float, float], ...] = (
    ("idle", 0.0, 0.15),
    ("light", 0.15, 0.40),
    ("cruise", 0.40, 0.75),
    ("heavy", 0.75, 0.90),
    ("overload", 0.90, 1.01),
)
"""Load bands as a fraction of rated RPM, and the names an operator would use.

The boundaries are conventional rather than derived -- a marine diesel spends its
life around 'cruise' and its damage around 'overload'. They are named here in one
place so a per-vessel configuration can replace them without touching the
arithmetic below."""

SEVERITY_WEIGHTS: dict[str, float] = {
    "idle": 0.35,
    "light": 0.5,
    "cruise": 1.0,
    "heavy": 1.6,
    "overload": 2.6,
}
"""Relative wear cost of an hour spent in each band, with cruise as 1.0.

Two ends are worth explaining. **Overload is not merely proportional** -- thermal
and mechanical loading rise faster than load, which is the entire mechanism by
which Problem 1 causes Problem 2, so an hour at full throttle costs more than
twice an hour at cruise. **Idle is not free.** Extended low-load running on a
diesel glazes bores and wets-stacks the exhaust; it is gentler than cruise, not
harmless, and a weight of zero would let a boat idle all day and report a
perfectly healthy duty cycle."""

BAND_LABELS: dict[str, tuple[str, str]] = {
    "idle": ("idle", "walang karga"),
    "light": ("light load", "magaang karga"),
    "cruise": ("cruise", "katamtamang karga"),
    "heavy": ("heavy load", "mabigat na karga"),
    "overload": ("overload", "sobrang karga"),
}
"""(English, Filipino) words an operator would use for each band. They live here
next to the bands themselves so a per-vessel band table cannot drift from the
words the display puts on it.

Every label is a **noun phrase**, and that is a constraint rather than a style
note. Each one is dropped into a sentence frame in `detector._duty_clause` -- and
into a bare value slot on the bridge's health panel -- so a label written as a
clause breaks the grammar of the sentence around it. The first draft used
"mabigat ang karga", which is a complete clause, and rendered as "Halos puro
mabigat ang karga ang takbo": two subject markers, one sentence. Keep the
"<adjective> karga" shape."""

SEVERITY_ADVISORY_THRESHOLD = 1.3
"""Severity index above which the advisory mentions duty at all.

Deliberately well clear of 1.0. The index is a *rate* normalised by running
hours, so a boat working a normal day sits near cruise and must not be told
anything -- an exposure note that fires on ordinary operation is noise, and the
crew stops reading the line that also has to carry real anomalies. 1.3 is roughly
a window spent between heavy and overload."""


@dataclass
class DutyCycle:
    """Accumulated engine exposure for one vessel.

    Accumulates from frames rather than storing them: this is a running total
    over the life of an engine, and keeping the samples would mean keeping every
    frame forever to recompute a number that only ever grows.
    """

    hours_by_band: dict[str, float] = field(
        default_factory=lambda: {name: 0.0 for name, _, _ in LOAD_BANDS}
    )
    total_hours: float = 0.0

    @property
    def severity_index(self) -> float:
        """Weighted wear-hours per running hour. 1.0 is a life spent at cruise.

        Normalised by total hours so it is a *rate*, not a total: an old engine
        run gently must be able to score better than a young one thrashed, or the
        index would just be a proxy for age and tell an operator nothing they
        could act on.
        """
        if self.total_hours <= 0:
            return 0.0
        weighted = sum(
            hours * SEVERITY_WEIGHTS[band] for band, hours in self.hours_by_band.items()
        )
        return round(weighted / self.total_hours, 4)

    @property
    def dominant_band(self) -> str:
        """The band this engine spent the most time in, and so the one word worth
        putting on a display.

        Ties break toward the *harder* band: `LOAD_BANDS` runs gentle to hard and
        a strict `>` keeps the first maximum, so the comparison is reversed here.
        A window split evenly between cruise and overload is an overload window
        for the purpose of warning someone about it.
        """
        if self.total_hours <= 0:
            return LOAD_BANDS[0][0]
        return max(
            (name for name, _, _ in LOAD_BANDS),
            key=lambda name: (self.hours_by_band[name], SEVERITY_WEIGHTS[name]),
        )

    @property
    def weighted_hours(self) -> float:
        """Wear-equivalent hours: the denominator a Phase 2 RUL model would use
        instead of raw run-hours."""
        return round(
            sum(hours * SEVERITY_WEIGHTS[band] for band, hours in self.hours_by_band.items()), 4
        )

    def accumulate(self, load_fraction: float, seconds: float) -> None:
        """Add one interval at a given load."""
        if seconds < 0:
            raise ValueError("seconds cannot be negative")
        hours = seconds / 3600.0
        self.hours_by_band[band_for(load_fraction)] += hours
        self.total_hours += hours


def band_for(load_fraction: float) -> str:
    """The band a load falls in. Clamped, so out-of-range readings still land."""
    value = max(0.0, min(1.0, load_fraction))
    for name, low, high in LOAD_BANDS:
        if low <= value < high:
            return name
    return LOAD_BANDS[-1][0]


def load_fraction(frame: TelemetryFrame, rated_rpm: float) -> float | None:
    """Engine load from a frame, as a fraction of rating.

    Torque is preferred when present, exactly as the profile's parameter list
    says it should be -- "torque under load is a stronger fuel-burn predictor
    than RPM alone", and it is a stronger wear predictor for the same reason. RPM
    is the fallback, and when neither is reported the frame contributes nothing
    rather than being assumed idle.
    """
    if frame.throttling is None or rated_rpm <= 0:
        return None

    rpm = frame.throttling.engine_rpm
    torque = frame.throttling.engine_torque_nm

    if rpm is None:
        return None
    speed_fraction = max(0.0, min(1.0, rpm / rated_rpm))

    if torque is None:
        return speed_fraction

    # Power is torque x speed; both matter. A high-torque lug at low RPM and a
    # free-running high RPM are different kinds of hard, and the geometric mean
    # keeps either from hiding the other.
    torque_fraction = max(0.0, min(1.0, torque / _rated_torque(rated_rpm)))
    return (speed_fraction * torque_fraction) ** 0.5


_DEMO_RATED_TORQUE_NM = 310.0
"""Rated torque for the demo engine (~90 kW at 2800 rpm). Per-vessel in
production; here it exists so the torque path is exercised rather than dead."""


def _rated_torque(rated_rpm: float) -> float:
    return _DEMO_RATED_TORQUE_NM if rated_rpm > 0 else 1.0


def duty_cycle(
    frames: Sequence[TelemetryFrame],
    *,
    rated_rpm: float,
    seconds_per_frame: float | None = None,
) -> DutyCycle:
    """Accumulate a duty cycle from a run of frames.

    Interval length comes from the timestamps when it can -- frames are not
    guaranteed evenly spaced, and assuming they are would silently mis-weight a
    window with a gap in it. `seconds_per_frame` overrides for a caller that
    knows better.
    """
    cycle = DutyCycle()
    if not frames:
        return cycle

    for index, frame in enumerate(frames):
        load = load_fraction(frame, rated_rpm)
        if load is None:
            continue

        if seconds_per_frame is not None:
            interval = seconds_per_frame
        elif index + 1 < len(frames):
            interval = (frames[index + 1].ts - frame.ts).total_seconds()
        elif index > 0:
            interval = (frame.ts - frames[index - 1].ts).total_seconds()
        else:
            interval = 0.0

        # A negative or absurd gap means the clock moved backwards or a frame is
        # from another voyage. Dropping it is better than integrating nonsense.
        if 0 < interval <= 3600:
            cycle.accumulate(load, interval)

    return cycle
