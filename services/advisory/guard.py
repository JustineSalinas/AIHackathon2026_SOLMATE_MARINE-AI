"""The rule that makes "Claude phrases, it does not decide" checkable.

The technical profile promises a natural-language layer that rewords a decision
the deterministic modules already made. That promise is worth nothing if the
model can quietly change a number, or turn a statement into an order. So the
model's output is not trusted: it is checked against the deterministic sentence
it was asked to rewrite, and anything that fails goes in the bin.

Two checks carry the promise.

**Numbers.** The set of numbers in the rewrite must equal the set of numbers in
the template, exactly. Not "similar", not "within tolerance" -- equal. The
template is generated from the optimiser's own output, so its numbers *are* the
decision; requiring set equality means the model may reorder, translate and
re-phrase, and may not invent, drop or round a single figure. A model that
writes "saves 3.4 L/h" when the optimiser said 2.1 is rejected, not displayed.

**Mood.** PRODUCT.md's non-negotiable: the display never uses imperative
language, because an advisory system that gives orders is a system that has
taken command. "1650 RPM saves 2.1 L/h" is right; "Reduce to 1650 RPM" is
wrong. Checked per clause, so a command buried after a semicolon is caught too.

A rejected rewrite is not an error. The caller falls back to the deterministic
template and labels the sentence `advisory_source="template"`, so a
misbehaving model degrades the prose and never the truth.
"""

from __future__ import annotations

import re

# Longest sentence the throttle zone can render without wrapping past the point
# where a captain stops reading it at a glance. Generous: the templates run
# 40-90 characters, so this only catches a model that has started explaining.
MAX_CHARS = 180

_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")

# Clause boundaries. An order is still an order after a semicolon or a dash.
_CLAUSE = re.compile(r"[.;:!?]|--|—")

# Imperative lead verbs. Only matched at the start of a clause, so the gerund
# forms that make a legitimate advisory ("Holding 1650 RPM saves...") pass while
# the command forms ("Hold 1650 RPM") do not.
_COMMAND_VERBS = frozenset(
    {
        "add",
        "adjust",
        "avoid",
        "bring",
        "change",
        "cut",
        "decrease",
        "do",
        "drop",
        "ease",
        "go",
        "hold",
        "increase",
        "keep",
        "lower",
        "maintain",
        "make",
        "pull",
        "push",
        "raise",
        "reduce",
        "run",
        "set",
        "slow",
        "speed",
        "stop",
        "switch",
        "take",
        "throttle",
        "turn",
        "use",
        # Tagalog imperative / obligation forms.
        "bawasan",
        "dagdagan",
        "gamitin",
        "gawin",
        "hinaan",
        "ibaba",
        "itaas",
        "itakda",
        "iwasan",
        "lakasan",
        "palitan",
        "panatilihin",
        "tumigil",
    }
)

# Obligation anywhere in the sentence, not just at a clause head. "You should
# reduce to 1650" is an order wearing a hedge, and so is its Filipino
# equivalent. `paki-` is the Tagalog polite-request prefix.
_OBLIGATION = (
    "you must",
    "you should",
    "you need to",
    "must be",
    "should be",
    "please ",
    "dapat",
    "kailangan",
    "paki",
)


def numbers_in(text: str) -> set[str]:
    """Every number in `text`, normalised so 1,234 and 1234 are one number.

    Thousands separators matter here: the peso clause renders as "PHP 1,234"
    in English and the model may legitimately write it without the comma.
    That is a formatting choice, not a change to the decision.
    """
    return {match.group(0).replace(",", "") for match in _NUMBER.finditer(text)}


def _first_words_of_clauses(text: str) -> list[str]:
    words = []
    for clause in _CLAUSE.split(text):
        stripped = clause.strip().strip("\"'()-— ")
        if stripped:
            words.append(stripped.split()[0].lower().strip(",."))
    return words


def rejection_reason(candidate: str, template: str) -> str | None:
    """Why `candidate` may not replace `template`, or None if it may.

    Returns a reason string rather than a bool so the caller can log *which*
    rule fired. A model that keeps failing the number check is a different
    problem from one that keeps giving orders, and the log should say so.
    """
    text = candidate.strip()

    if not text:
        return "empty"
    if "\n" in text:
        return "multi-line"
    if len(text) > MAX_CHARS:
        return f"too long ({len(text)} > {MAX_CHARS} chars)"

    lowered = text.lower()
    for phrase in _OBLIGATION:
        if phrase in lowered:
            return f"obligation language: {phrase.strip()!r}"

    for word in _first_words_of_clauses(text):
        if word in _COMMAND_VERBS:
            return f"imperative clause opening: {word!r}"

    theirs = numbers_in(text)
    ours = numbers_in(template)
    if theirs != ours:
        invented = sorted(theirs - ours)
        dropped = sorted(ours - theirs)
        parts = []
        if invented:
            parts.append(f"invented {invented}")
        if dropped:
            parts.append(f"dropped {dropped}")
        return "numbers changed: " + ", ".join(parts)

    return None
