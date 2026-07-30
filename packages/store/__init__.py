"""Voyage persistence.

The emissions report is a *monthly* document, which means it needs a month of
voyages to exist somewhere. Until now nothing in this system stored anything --
every endpoint answered from the request in front of it and forgot it. That is
fine for an advisory API and fatal for auditable evidence: a report synthesised
at request time is not a record, and "auditable" is the one word Problem 3 cannot
give up.

**Why SQLite.** `sqlite3` is in the Python standard library, so the serving image
gains exactly nothing -- see the header of `requirements.txt`, where the 85 MB
serving figure is defended. Adding a database driver to produce a monthly PDF
would have undone the ONNX work. The technical profile names TimescaleDB and
docs/DEVIATIONS.md records Supabase Postgres as the intended production store;
both speak SQL, and `VoyageStore` is the seam they swap in behind.

**What this is not.** It is not a time-series store for telemetry. Telemetry is
high-rate and belongs in Timescale or Supabase; voyage records are a handful of
rows per vessel per day and belong wherever is simplest. Conflating the two is
what would make this decision wrong later.

**The serverless caveat, stated rather than discovered.** A Vercel function's
filesystem is ephemeral: a SQLite file written there does not survive the
invocation. On that deployment the store degrades to in-memory and the report
covers only what the caller supplies, which `EmissionsReport.caveats` says out
loud. Durable storage is the Supabase path, and it is blocked on credentials, not
on design.
"""

from packages.store.voyages import (
    InMemoryVoyageStore,
    SqliteVoyageStore,
    VoyageStore,
    open_store,
)

__all__ = [
    "InMemoryVoyageStore",
    "SqliteVoyageStore",
    "VoyageStore",
    "open_store",
]
