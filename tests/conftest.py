"""Shared test setup.

Two things are forced here, both so that the suite's answer never depends on
the machine it runs on.

**No network.** A developer with a real `ANTHROPIC_API_KEY` exported would
otherwise have every `/advise` test make a live API call -- slow, billable, and
non-deterministic in a suite that asserts on sentences. The key is cleared for
the whole run; `tests/test_advisory.py` puts a fake one back, scoped to the
tests that need it, and never lets a real client be constructed.

It is cleared by being set **empty**, not by being deleted, and that detail is
load-bearing: `apps/api/main.py` calls `load_dotenv()` at import, which happens
*after* this file runs, and `load_dotenv` repopulates any variable that is
absent while leaving any variable that is already set alone. Deleting the key
here therefore handed it straight back the moment a test imported the app, and
the suite's hermeticity silently came to rest on `MARINE_AI_ADVISORY_DISABLED`
alone. Both defences are meant to hold independently.

**Provider selection is cleared for the same reason.** The moment a developer
put `MARINE_AI_ADVISORY_PROVIDER=claude` in their own `.env`, two Gemini tests
began failing in the full suite while passing in isolation -- `provider()` reads
that variable before it looks at any key, so an operator's local preference was
deciding what the suite asserted. Which provider the tests exercise must be a
property of the tests, not of the machine.

**No disk.** The voyage store is the only part of this system that writes. Left to
its default it would put a real `data/voyages.db` in the working tree, so the
suite would leave a file behind, and worse, a test's voyages would still be there
on the next run -- making the emissions totals depend on how many times you had
run pytest. Forcing the non-durable store keeps every test hermetic.

Set at import time rather than in a fixture: the store is opened in the FastAPI
lifespan, which runs when a module-scoped `TestClient` is entered, and that can
happen before any function-scoped fixture would get a chance to patch it.
"""

from __future__ import annotations

import os

os.environ.setdefault("MARINE_AI_VOYAGE_DB", ":memory:")
os.environ["ANTHROPIC_API_KEY"] = ""  # empty, not absent -- see the docstring
os.environ["GOOGLE_API_KEY"] = ""  # same reasoning; provider selection prefers it
os.environ["MARINE_AI_ADVISORY_PROVIDER"] = ""  # an operator's .env must not pick
os.environ["ANTHROPIC_MODEL"] = ""  # nor decide which model a test asserts against
os.environ["MARINE_AI_ADVISORY_DISABLED"] = "1"
