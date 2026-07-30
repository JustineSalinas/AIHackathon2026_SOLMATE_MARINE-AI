"""Natural-language layer for the bridge display.

The profile's claim is "Claude phrases, it does not decide". This package is
where that boundary lives: `phraser` sends an already-decided sentence to
Claude and `guard` refuses anything that came back with a different number or
an imperative mood. Nothing in here is consulted by a module that decides
something -- the safety cutoffs in particular are rule-based and a test asserts
they never import this.
"""

from services.advisory.guard import MAX_CHARS, numbers_in, rejection_reason
from services.advisory.phraser import (
    SOURCE_CLAUDE,
    SOURCE_TEMPLATE,
    Phrasing,
    enabled,
    phrase,
    reset_cache,
)

__all__ = [
    "MAX_CHARS",
    "SOURCE_CLAUDE",
    "SOURCE_TEMPLATE",
    "Phrasing",
    "enabled",
    "numbers_in",
    "phrase",
    "rejection_reason",
    "reset_cache",
]
