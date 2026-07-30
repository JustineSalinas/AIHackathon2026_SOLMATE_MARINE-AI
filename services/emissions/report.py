"""The monthly CO2-avoided report — Problem 3's actual deliverable.

The technical profile promises the operator "a monthly CO2-avoided report —
exportable evidence for LGU / MARINA compliance and ESG-linked green financing".
Everything in this module exists to make the word *evidence* survivable.

Three rules, and each one costs the headline figure something:

**1. A voyage with no baseline contributes fuel and CO2, but not avoided CO2.**
It is counted in the totals and named in the caveats. The alternative -- quietly
assuming an unmeasured voyage saved nothing, or worse, saved the monthly average
-- would make the report larger and worthless.

**2. Negative months are reported as negative.** A month with heavier loads, worse
weather, or a fouled hull can burn more than baseline. Flooring at zero would
mean the report can only ever flatter the operator, and a metric that cannot go
down is not a measurement.

**3. The baseline method is on the report, not in a footnote.** A figure measured
against the vessel's own prior runs on the same route is evidence; the same
number measured against a model's opinion of itself is an estimate. They are not
interchangeable and the report never lets them look it.

The emission factor is chemistry (see `services/emissions/__init__.py`), so the
accuracy of the whole report is inherited, transparently, from the accuracy of
the fuel model. That is stated on the report too.
"""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime

from packages.contracts.emissions import (
    BaselineMethod,
    EmissionsReport,
    EmissionsReportLine,
    VoyageRecord,
)
from packages.store.voyages import VoyageStore
from services.emissions import DIESEL_CO2_KG_PER_L, co2_avoided_kg, co2_kg

MIN_PRIOR_VOYAGES = 3
"""Prior runs needed on a route before their median counts as a baseline.

One earlier crossing is an anecdote -- it might have been a calm day with six
passengers. Three is still thin, and the report says so rather than implying a
statistical claim the sample cannot support."""


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def resolve_baseline(
    voyage: VoyageRecord, store: VoyageStore
) -> tuple[float | None, BaselineMethod]:
    """Establish what this voyage would otherwise have burned.

    Preference order is by how much an auditor should trust the answer, and the
    method is returned alongside the number so it can never be dropped in transit.

    The median, not the mean, of prior runs: one bad crossing -- a fouled prop, a
    day of running late -- would drag a mean upward and inflate every saving
    measured against it, permanently and in the product's own favour.
    """
    prior = [
        v
        for v in store.prior_on_route(
            voyage.vessel_id, voyage.origin_name, voyage.destination_name, voyage.departed_at
        )
        if v.distance_nm > 0
    ]
    if len(prior) >= MIN_PRIOR_VOYAGES:
        # Normalise by distance so a shortened or diverted run compares fairly.
        per_nm = _median([v.fuel_used_l / v.distance_nm for v in prior])
        return per_nm * voyage.distance_nm, BaselineMethod.OWN_PRIOR_ROUTE

    if voyage.baseline_fuel_l is not None:
        return voyage.baseline_fuel_l, BaselineMethod.COUNTERFACTUAL_MODEL

    return None, BaselineMethod.NONE


def build_report(
    vessel_id: str,
    year: int,
    month: int,
    store: VoyageStore,
    *,
    now: datetime | None = None,
) -> EmissionsReport:
    """Aggregate one vessel's month into a report it could be audited on."""
    voyages = store.month(vessel_id, year, month)
    generated_at = now or datetime.now(UTC)

    lines: list[EmissionsReportLine] = []
    total_fuel = 0.0
    total_distance = 0.0
    avoided_total = 0.0
    with_baseline = 0
    methods: set[BaselineMethod] = set()

    for voyage in voyages:
        baseline, method = resolve_baseline(voyage, store)
        total_fuel += voyage.fuel_used_l
        total_distance += voyage.distance_nm

        avoided: float | None = None
        if baseline is not None:
            avoided = co2_avoided_kg(baseline, voyage.fuel_used_l)
            avoided_total += avoided
            with_baseline += 1
            methods.add(method)

        route = " → ".join(
            part for part in (voyage.origin_name, voyage.destination_name) if part
        )
        lines.append(
            EmissionsReportLine(
                voyage_id=voyage.voyage_id,
                departed_at=voyage.departed_at,
                route=route or "unnamed",
                distance_nm=round(voyage.distance_nm, 3),
                fuel_used_l=round(voyage.fuel_used_l, 3),
                co2_kg=round(co2_kg(voyage.fuel_used_l), 3),
                baseline_fuel_l=None if baseline is None else round(baseline, 3),
                co2_avoided_kg=None if avoided is None else round(avoided, 3),
                baseline_method=method,
            )
        )

    # The weakest method used is the one reported. A month that mixes measured
    # baselines with modelled ones is only as strong as the modelled ones, and
    # claiming the stronger label would be the easiest lie in this document.
    if not methods:
        headline_method = BaselineMethod.NONE
    elif BaselineMethod.COUNTERFACTUAL_MODEL in methods:
        headline_method = BaselineMethod.COUNTERFACTUAL_MODEL
    else:
        headline_method = BaselineMethod.OWN_PRIOR_ROUTE

    return EmissionsReport(
        vessel_id=vessel_id,
        year=year,
        month=month,
        generated_at=generated_at,
        voyages=len(voyages),
        distance_nm=round(total_distance, 3),
        fuel_used_l=round(total_fuel, 3),
        co2_kg=round(co2_kg(total_fuel), 3),
        co2_avoided_kg=None if with_baseline == 0 else round(avoided_total, 3),
        voyages_with_baseline=with_baseline,
        baseline_method=headline_method,
        emission_factor_kg_per_l=DIESEL_CO2_KG_PER_L,
        lines=lines,
        caveats=_caveats(voyages, with_baseline, headline_method, store),
    )


def _caveats(
    voyages: list[VoyageRecord],
    with_baseline: int,
    method: BaselineMethod,
    store: VoyageStore,
) -> list[str]:
    """Everything that qualifies the headline figure, attached to it.

    These travel with the number by construction. Someone quoting the report
    cannot take the total and leave the reason it is provisional behind.
    """
    notes: list[str] = []

    if not voyages:
        notes.append("No voyages recorded for this vessel in this month.")
        return notes

    missing = len(voyages) - with_baseline
    if missing:
        notes.append(
            f"{missing} of {len(voyages)} voyages had no baseline and are excluded from the "
            "avoided-CO2 total. Their fuel and CO2 are included."
        )

    if method is BaselineMethod.COUNTERFACTUAL_MODEL:
        notes.append(
            "Baseline is the fuel model's estimate of the same voyage at the throttle actually "
            f"held, not measured history. At least {MIN_PRIOR_VOYAGES} prior runs on a route are "
            "needed before the vessel's own record is used instead."
        )
    elif method is BaselineMethod.OWN_PRIOR_ROUTE:
        notes.append(
            "Baseline is the median fuel-per-nautical-mile of this vessel's own earlier runs on "
            "the same route. Not a fleet average and not a published benchmark."
        )
        # The profile's baseline is the vessel's burn *before Marine-AI was
        # fitted*. Prior runs held here may post-date installation, which makes
        # the comparison conservative -- it measures improvement against an
        # already-advised boat, not against the untouched one. Said out loud
        # because an auditor would otherwise have to work it out themselves.
        notes.append(
            "Prior runs are those on record, which may already have been made with Marine-AI "
            "fitted. Where that is so, the avoided figure understates the improvement against "
            "pre-installation operation rather than overstating it."
        )

    if not getattr(store, "durable", False):
        notes.append(
            "Records are held in memory on this deployment and do not persist between restarts. "
            "This report covers the current session only."
        )

    notes.append(
        "CO2 is computed from litres burned by a fixed combustion factor "
        f"({DIESEL_CO2_KG_PER_L} kg/L, tank-to-wake). Its accuracy is inherited from the fuel "
        "model's accuracy and is not independently measured at the exhaust."
    )
    notes.append(
        "Operational record produced by an advisory system. Not a certified emissions inventory."
    )
    return notes


def to_csv(report: EmissionsReport) -> str:
    """The report as CSV — the export the profile promises.

    CSV rather than PDF on purpose: an LGU clerk or a lender's analyst opens it in
    a spreadsheet and can re-add the column themselves. A rendered PDF looks more
    official and is harder to check, which is the wrong trade for a document whose
    only job is to be checkable.

    The header block carries the totals, the method and every caveat, so a
    detached CSV still explains itself.
    """
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")

    writer.writerow(["Marine-AI monthly emissions report"])
    writer.writerow(["vessel_id", report.vessel_id])
    writer.writerow(["period", f"{report.year}-{report.month:02d}"])
    writer.writerow(["generated_at", report.generated_at.isoformat()])
    writer.writerow(["voyages", report.voyages])
    writer.writerow(["distance_nm", report.distance_nm])
    writer.writerow(["fuel_used_l", report.fuel_used_l])
    writer.writerow(["co2_kg", report.co2_kg])
    avoided = report.co2_avoided_kg
    writer.writerow(
        ["co2_avoided_kg", "not reported - no baseline" if avoided is None else avoided]
    )
    writer.writerow(["baseline_method", str(report.baseline_method)])
    writer.writerow(["voyages_with_baseline", report.voyages_with_baseline])
    writer.writerow(["emission_factor_kg_per_l", report.emission_factor_kg_per_l])
    for caveat in report.caveats:
        writer.writerow(["caveat", caveat])

    writer.writerow([])
    writer.writerow(
        [
            "voyage_id",
            "departed_at",
            "route",
            "distance_nm",
            "fuel_used_l",
            "co2_kg",
            "baseline_fuel_l",
            "co2_avoided_kg",
            "baseline_method",
        ]
    )
    for line in report.lines:
        writer.writerow(
            [
                line.voyage_id,
                line.departed_at.isoformat(),
                line.route,
                line.distance_nm,
                line.fuel_used_l,
                line.co2_kg,
                "" if line.baseline_fuel_l is None else line.baseline_fuel_l,
                "" if line.co2_avoided_kg is None else line.co2_avoided_kg,
                str(line.baseline_method),
            ]
        )

    return out.getvalue()
