"""Voyage records, stored.

Two implementations behind one protocol, and a loader that picks between them
the same way `FuelMap.load` and `load_forecast` do elsewhere in this repository:
try the real thing, degrade to something honest, never raise at import time and
never pretend the degraded path is the real one.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from packages.contracts.emissions import BaselineMethod, VoyageRecord

DEFAULT_PATH = Path("data/voyages.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS voyages (
    voyage_id        TEXT PRIMARY KEY,
    vessel_id        TEXT NOT NULL,
    departed_at      TEXT NOT NULL,
    arrived_at       TEXT NOT NULL,
    origin_name      TEXT,
    destination_name TEXT,
    distance_nm      REAL NOT NULL,
    fuel_used_l      REAL NOT NULL,
    baseline_fuel_l  REAL,
    baseline_method  TEXT NOT NULL,
    passenger_count  INTEGER NOT NULL DEFAULT 0,
    cargo_kg         REAL NOT NULL DEFAULT 0,
    source           TEXT NOT NULL DEFAULT 'simulator'
);
CREATE INDEX IF NOT EXISTS voyages_vessel_departed
    ON voyages (vessel_id, departed_at);
"""


class VoyageStore(Protocol):
    """The seam Supabase or TimescaleDB swaps in behind."""

    durable: bool
    """False when records will not survive the process. The report says so."""

    def record(self, voyage: VoyageRecord) -> None:
        """Store one completed voyage. Re-recording the same id replaces it."""
        ...

    def month(self, vessel_id: str, year: int, month: int) -> list[VoyageRecord]:
        """Every voyage that *departed* in the given month, oldest first."""
        ...

    def prior_on_route(
        self, vessel_id: str, origin: str | None, destination: str | None, before: datetime
    ) -> list[VoyageRecord]:
        """Earlier voyages by this vessel on the same route.

        This is what makes `BaselineMethod.OWN_PRIOR_ROUTE` possible: the boat
        against its own past, on its own route, which is the only baseline the
        technical profile allows and the only one an auditor can check.
        """
        ...


def _month_bounds(year: int, month: int) -> tuple[datetime, datetime]:
    start = datetime(year, month, 1, tzinfo=UTC)
    end = datetime(year + (month == 12), (month % 12) + 1, 1, tzinfo=UTC)
    return start, end


def _same_route(a: VoyageRecord, origin: str | None, destination: str | None) -> bool:
    return a.origin_name == origin and a.destination_name == destination


class InMemoryVoyageStore:
    """Non-durable store. The honest fallback, not a mock.

    Used where a filesystem is not available or not persistent -- notably a
    serverless function. It behaves identically for a single process, and
    `durable=False` is carried into every report generated from it so nobody
    mistakes a session's worth of voyages for a month's records.
    """

    durable = False

    def __init__(self) -> None:
        self._rows: dict[str, VoyageRecord] = {}

    def record(self, voyage: VoyageRecord) -> None:
        self._rows[voyage.voyage_id] = voyage

    def month(self, vessel_id: str, year: int, month: int) -> list[VoyageRecord]:
        start, end = _month_bounds(year, month)
        rows = [
            v
            for v in self._rows.values()
            if v.vessel_id == vessel_id and start <= v.departed_at < end
        ]
        return sorted(rows, key=lambda v: v.departed_at)

    def prior_on_route(
        self, vessel_id: str, origin: str | None, destination: str | None, before: datetime
    ) -> list[VoyageRecord]:
        rows = [
            v
            for v in self._rows.values()
            if v.vessel_id == vessel_id
            and v.departed_at < before
            and _same_route(v, origin, destination)
        ]
        return sorted(rows, key=lambda v: v.departed_at)


class SqliteVoyageStore:
    """Durable store on the local filesystem.

    `sqlite3` ships with Python, so this costs the serving image nothing. The
    connection is opened per call rather than held: these are a handful of writes
    per vessel per day, and a long-lived connection across an async server is a
    threading problem bought for no measurable gain.
    """

    durable = True

    def __init__(self, path: Path | str = DEFAULT_PATH) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Fail fast here if the path is unusable, so `open_store` can fall back.
        self._connect().close()

    def _connect(self) -> sqlite3.Connection:
        """Open a connection, ensuring the schema exists.

        The schema is applied on *every* connection rather than once at
        construction. `CREATE TABLE IF NOT EXISTS` is idempotent and effectively
        free at this volume, and doing it here makes the store self-healing: a
        process whose database file is replaced, restored from a backup, or
        removed underneath it recreates the schema on the next write instead of
        raising `no such table` for the rest of its life.

        That is not hypothetical -- it happened during testing the moment the
        file was deleted while the server was up, and the failure mode was a 500
        on every voyage from then on. A record store whose whole purpose is
        durable evidence should not be one `rm` away from silently refusing to
        record anything.
        """
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.executescript(_SCHEMA)
        return conn

    @staticmethod
    def _to_row(v: VoyageRecord) -> tuple:
        return (
            v.voyage_id,
            v.vessel_id,
            v.departed_at.isoformat(),
            v.arrived_at.isoformat(),
            v.origin_name,
            v.destination_name,
            v.distance_nm,
            v.fuel_used_l,
            v.baseline_fuel_l,
            str(v.baseline_method),
            v.passenger_count,
            v.cargo_kg,
            v.source,
        )

    @staticmethod
    def _from_row(row: sqlite3.Row) -> VoyageRecord:
        return VoyageRecord(
            voyage_id=row["voyage_id"],
            vessel_id=row["vessel_id"],
            departed_at=datetime.fromisoformat(row["departed_at"]),
            arrived_at=datetime.fromisoformat(row["arrived_at"]),
            origin_name=row["origin_name"],
            destination_name=row["destination_name"],
            distance_nm=row["distance_nm"],
            fuel_used_l=row["fuel_used_l"],
            baseline_fuel_l=row["baseline_fuel_l"],
            baseline_method=BaselineMethod(row["baseline_method"]),
            passenger_count=row["passenger_count"],
            cargo_kg=row["cargo_kg"],
            source=row["source"],
        )

    def record(self, voyage: VoyageRecord) -> None:
        # `closing` for the handle, `with conn` for the transaction. They are not
        # the same thing: a sqlite3 connection used as a context manager commits
        # and then stays open, so the bare `with self._connect()` this replaced
        # leaked a handle on every call -- and on Windows an open handle also
        # makes the file undeletable, which is how it was noticed.
        with closing(self._connect()) as conn, conn:
            conn.execute(
                "INSERT OR REPLACE INTO voyages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                self._to_row(voyage),
            )

    def month(self, vessel_id: str, year: int, month: int) -> list[VoyageRecord]:
        start, end = _month_bounds(year, month)
        with closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT * FROM voyages WHERE vessel_id = ? AND departed_at >= ? "
                "AND departed_at < ? ORDER BY departed_at",
                (vessel_id, start.isoformat(), end.isoformat()),
            ).fetchall()
        return [self._from_row(r) for r in rows]

    def prior_on_route(
        self, vessel_id: str, origin: str | None, destination: str | None, before: datetime
    ) -> list[VoyageRecord]:
        with closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT * FROM voyages WHERE vessel_id = ? AND departed_at < ? "
                "AND origin_name IS ? AND destination_name IS ? ORDER BY departed_at",
                (vessel_id, before.isoformat(), origin, destination),
            ).fetchall()
        return [self._from_row(r) for r in rows]


def open_store(path: Path | str | None = None) -> VoyageStore:
    """Open the durable store, or degrade to memory and say so.

    Degrades on a read-only or absent filesystem, which is exactly the serverless
    case. Set `MARINE_AI_VOYAGE_DB` to override the path; set it to `:memory:` to
    force the non-durable store.
    """
    target = path or os.environ.get("MARINE_AI_VOYAGE_DB") or DEFAULT_PATH
    if str(target) == ":memory:":
        return InMemoryVoyageStore()
    try:
        return SqliteVoyageStore(target)
    except (OSError, sqlite3.Error):
        # A read-only filesystem is a supported deployment, not a failure. The
        # report will carry `durable=False` into its caveats.
        return InMemoryVoyageStore()
