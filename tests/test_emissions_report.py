"""Tests for the monthly emissions report and the voyage store.

The load-bearing ones are about what the report *refuses* to claim.

`test_voyage_without_baseline_contributes_fuel_but_not_avoided_co2` and
`test_a_worse_month_reports_negative` are the two ways an emissions report is
normally dishonest -- assuming an unmeasured voyage saved nothing, and flooring a
bad month at zero. Both would make the headline figure larger and the document
worthless.

`test_baseline_prefers_the_vessels_own_history` pins the profile's promise: the
boat against its own past on its own route, never a fleet average.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from packages.contracts.emissions import BaselineMethod, VoyageRecord
from packages.store.voyages import InMemoryVoyageStore, SqliteVoyageStore
from services.emissions import DIESEL_CO2_KG_PER_L
from services.emissions.report import MIN_PRIOR_VOYAGES, build_report, to_csv

JAN = datetime(2026, 1, 5, 6, 0, tzinfo=UTC)


def voyage(
    n: int,
    *,
    fuel: float = 3.3,
    baseline: float | None = None,
    distance: float = 2.8,
    at: datetime | None = None,
    origin: str = "Iloilo City",
    destination: str = "Jordan, Guimaras",
) -> VoyageRecord:
    departed = at or (JAN + timedelta(days=n))
    return VoyageRecord(
        voyage_id=f"v{n}",
        vessel_id="MV-DEMO-01",
        departed_at=departed,
        arrived_at=departed + timedelta(minutes=22),
        origin_name=origin,
        destination_name=destination,
        distance_nm=distance,
        fuel_used_l=fuel,
        baseline_fuel_l=baseline,
        baseline_method=(
            BaselineMethod.COUNTERFACTUAL_MODEL if baseline is not None else BaselineMethod.NONE
        ),
    )


@pytest.fixture
def store() -> InMemoryVoyageStore:
    return InMemoryVoyageStore()


# --- Totals -----------------------------------------------------------------


def test_empty_month_is_reported_not_errored(store):
    report = build_report("MV-DEMO-01", 2026, 1, store)
    assert report.voyages == 0
    assert report.co2_kg == 0
    assert report.co2_avoided_kg is None
    assert "No voyages recorded" in report.caveats[0]


def test_fuel_and_co2_totals(store):
    for i in range(3):
        store.record(voyage(i, fuel=10.0))
    report = build_report("MV-DEMO-01", 2026, 1, store)
    assert report.voyages == 3
    assert report.fuel_used_l == pytest.approx(30.0)
    assert report.co2_kg == pytest.approx(30.0 * DIESEL_CO2_KG_PER_L)
    assert report.emission_factor_kg_per_l == DIESEL_CO2_KG_PER_L


def test_only_the_requested_month_is_counted(store):
    store.record(voyage(1))
    store.record(voyage(2, at=datetime(2026, 2, 3, 6, 0, tzinfo=UTC)))
    assert build_report("MV-DEMO-01", 2026, 1, store).voyages == 1
    assert build_report("MV-DEMO-01", 2026, 2, store).voyages == 1


def test_other_vessels_are_not_counted(store):
    store.record(voyage(1))
    other = voyage(2).model_copy(update={"vessel_id": "MV-OTHER-02"})
    store.record(other)
    assert build_report("MV-DEMO-01", 2026, 1, store).voyages == 1


# --- The baseline is the claim ---------------------------------------------


def test_voyage_without_baseline_contributes_fuel_but_not_avoided_co2(store):
    store.record(voyage(1, fuel=10.0, baseline=None))
    report = build_report("MV-DEMO-01", 2026, 1, store)

    assert report.fuel_used_l == pytest.approx(10.0)
    assert report.co2_kg > 0
    assert report.co2_avoided_kg is None
    assert report.voyages_with_baseline == 0
    assert report.baseline_method is BaselineMethod.NONE
    assert any("no baseline" in c for c in report.caveats)


def test_counterfactual_baseline_is_used_and_labelled(store):
    store.record(voyage(1, fuel=8.0, baseline=10.0))
    report = build_report("MV-DEMO-01", 2026, 1, store)

    assert report.baseline_method is BaselineMethod.COUNTERFACTUAL_MODEL
    assert report.co2_avoided_kg == pytest.approx(2.0 * DIESEL_CO2_KG_PER_L)
    assert any("not measured history" in c for c in report.caveats)


def test_baseline_prefers_the_vessels_own_history(store):
    """Once enough prior runs exist, measured history outranks the model."""
    for i in range(MIN_PRIOR_VOYAGES):
        store.record(voyage(i, fuel=10.0, distance=2.0, at=JAN - timedelta(days=10 - i)))

    # The voyage under test burned 8 L over the same 2 nm route. Prior median is
    # 5 L/nm, so the baseline is 10 L and 2 L were saved -- and the recorded
    # counterfactual (9.0) must be ignored in favour of measured history.
    store.record(voyage(9, fuel=8.0, baseline=9.0, distance=2.0))

    report = build_report("MV-DEMO-01", 2026, 1, store)
    line = next(line for line in report.lines if line.voyage_id == "v9")
    assert line.baseline_method is BaselineMethod.OWN_PRIOR_ROUTE
    assert line.baseline_fuel_l == pytest.approx(10.0)
    assert line.co2_avoided_kg == pytest.approx(2.0 * DIESEL_CO2_KG_PER_L)


def test_prior_history_on_a_different_route_is_not_used(store):
    """A baseline from another crossing is a fleet average by another name."""
    for i in range(MIN_PRIOR_VOYAGES + 2):
        store.record(
            voyage(i, fuel=99.0, at=JAN - timedelta(days=10 - i), destination="Buenavista")
        )
    store.record(voyage(9, fuel=8.0, baseline=9.0))

    report = build_report("MV-DEMO-01", 2026, 1, store)
    line = next(line for line in report.lines if line.voyage_id == "v9")
    assert line.baseline_method is BaselineMethod.COUNTERFACTUAL_MODEL


def test_a_worse_month_reports_negative(store):
    """Heavier loads, worse weather, a fouled hull. A real month."""
    store.record(voyage(1, fuel=12.0, baseline=10.0))
    report = build_report("MV-DEMO-01", 2026, 1, store)
    assert report.co2_avoided_kg == pytest.approx(-2.0 * DIESEL_CO2_KG_PER_L)


def test_mixed_methods_report_the_weaker_one(store):
    """A month is only as strong as its weakest baseline."""
    for i in range(MIN_PRIOR_VOYAGES):
        store.record(voyage(i, fuel=10.0, distance=2.0, at=JAN - timedelta(days=10 - i)))
    store.record(voyage(8, fuel=8.0, distance=2.0))  # gets own-history baseline
    store.record(voyage(9, fuel=8.0, baseline=9.0, destination="Buenavista"))

    report = build_report("MV-DEMO-01", 2026, 1, store)
    assert report.baseline_method is BaselineMethod.COUNTERFACTUAL_MODEL


def test_partial_baseline_coverage_is_stated(store):
    store.record(voyage(1, fuel=8.0, baseline=10.0))
    store.record(voyage(2, fuel=8.0, baseline=None))
    report = build_report("MV-DEMO-01", 2026, 1, store)

    assert report.voyages == 2
    assert report.voyages_with_baseline == 1
    assert any("1 of 2 voyages had no baseline" in c for c in report.caveats)


def test_report_always_carries_its_limitations(store):
    store.record(voyage(1, fuel=8.0, baseline=10.0))
    report = build_report("MV-DEMO-01", 2026, 1, store)
    joined = " ".join(report.caveats)
    assert "inherited from the fuel model" in joined
    assert "Not a certified emissions inventory" in joined
    assert report.advisory_only is True


def test_non_durable_store_says_so(store):
    store.record(voyage(1))
    report = build_report("MV-DEMO-01", 2026, 1, store)
    assert any("do not persist" in c for c in report.caveats)


# --- Export -----------------------------------------------------------------


def test_csv_carries_totals_caveats_and_every_voyage(store):
    store.record(voyage(1, fuel=8.0, baseline=10.0))
    store.record(voyage(2, fuel=9.0, baseline=None))
    csv_text = to_csv(build_report("MV-DEMO-01", 2026, 1, store))

    assert "Marine-AI monthly emissions report" in csv_text
    assert "co2_avoided_kg" in csv_text
    assert "baseline_method" in csv_text
    assert "caveat" in csv_text
    assert "v1" in csv_text and "v2" in csv_text
    # A detached CSV must still explain itself.
    assert "Not a certified emissions inventory" in csv_text


def test_csv_leaves_missing_baselines_blank_not_zero(store):
    """A blank is 'not measured'. A zero is a claim that nothing was saved."""
    store.record(voyage(1, fuel=9.0, baseline=None))
    rows = to_csv(build_report("MV-DEMO-01", 2026, 1, store)).splitlines()
    line = next(r for r in rows if r.startswith("v1,"))
    assert line.endswith(",,none")


# --- Store ------------------------------------------------------------------


def test_sqlite_round_trips_and_persists(tmp_path):
    path = tmp_path / "voyages.db"
    first = SqliteVoyageStore(path)
    first.record(voyage(1, fuel=8.0, baseline=10.0))

    # A new instance on the same file is a new process for our purposes.
    second = SqliteVoyageStore(path)
    rows = second.month("MV-DEMO-01", 2026, 1)
    assert len(rows) == 1
    assert rows[0].fuel_used_l == pytest.approx(8.0)
    assert rows[0].baseline_method is BaselineMethod.COUNTERFACTUAL_MODEL
    assert second.durable is True


def test_store_recovers_if_its_file_disappears(tmp_path):
    """A live process must survive losing its database file.

    Found the hard way: deleting the db while the API was running produced a 500
    on every subsequent voyage, because the schema was created once at startup.
    A store whose job is durable evidence should not be one `rm` away from
    silently refusing to record anything.
    """
    path = tmp_path / "voyages.db"
    store = SqliteVoyageStore(path)
    store.record(voyage(1, fuel=8.0))

    path.unlink()

    store.record(voyage(2, fuel=9.0))
    rows = store.month("MV-DEMO-01", 2026, 1)
    assert [r.voyage_id for r in rows] == ["v2"]


def test_rerecording_the_same_voyage_replaces_it(tmp_path):
    """A display retrying after a dropped connection must not double-count fuel."""
    store = SqliteVoyageStore(tmp_path / "v.db")
    store.record(voyage(1, fuel=8.0))
    store.record(voyage(1, fuel=8.0))
    rows = store.month("MV-DEMO-01", 2026, 1)
    assert len(rows) == 1
