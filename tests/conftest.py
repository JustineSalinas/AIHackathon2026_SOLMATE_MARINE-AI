"""Shared test setup.

Two things are forced here, both so that the suite's answer never depends on
the machine it runs on.

**No network.** A developer with a real `ANTHROPIC_API_KEY` exported would
otherwise have every `/advise` test make a live API call -- slow, billable, and
non-deterministic in a suite that asserts on sentences. The key is cleared for
the whole run; `tests/test_advisory.py` puts a fake one back, scoped to the
tests that need it, and never lets a real client be constructed.

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
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ["MARINE_AI_ADVISORY_DISABLED"] = "1"
