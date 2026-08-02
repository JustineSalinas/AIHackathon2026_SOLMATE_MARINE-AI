"""Natural-language layer for the bridge display.

The profile's claim is "the model phrases, it does not decide". This package is
where that boundary lives: `phraser` sends an already-decided sentence to a
language model and `guard` refuses anything that came back with a different
number or an imperative mood. Nothing in here is consulted by a module that
decides something -- the safety cutoffs in particular are rule-based and a test
asserts they never import this.

Two providers are wired, Google and Anthropic, and `guard` knows about neither.
That is deliberate: the guarantee has to be a property of this code rather than
of a particular vendor's behaviour, and the cheapest way to prove that is to
run it against more than one vendor.
"""

from services.advisory.guard import MAX_CHARS, numbers_in, rejection_reason
from services.advisory.phraser import (
    SOURCE_CLAUDE,
    SOURCE_GEMINI,
    SOURCE_MODELS,
    SOURCE_TEMPLATE,
    Phrasing,
    enabled,
    phrase,
    provider,
    reset_cache,
)

__all__ = [
    "MAX_CHARS",
    "SOURCE_CLAUDE",
    "SOURCE_GEMINI",
    "SOURCE_MODELS",
    "SOURCE_TEMPLATE",
    "Phrasing",
    "enabled",
    "numbers_in",
    "phrase",
    "provider",
    "rejection_reason",
    "reset_cache",
]
