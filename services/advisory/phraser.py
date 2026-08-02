"""A language model rewrites the bridge sentence. It does not choose what the
sentence says.

The deterministic modules decide: `optimise_throttle` picks the RPM,
`plan_route` picks the track, `detect` picks the stream. Each one renders its
decision as a template sentence, and that sentence -- not the raw state, not
the model objects -- is what this layer sends to the model, with one
instruction: say this again, in language a fisherman reads at a glance, in
English and Filipino. Whatever comes back is checked by `guard.py` against the
template it came from, and thrown away if it changed a number or gave an order.

**Which model is an implementation detail, and that is the point.** Two
providers are wired -- Google (Gemini) and Anthropic (Claude) -- and the guard
knows about neither. It takes two strings and checks them. Swapping providers
therefore cannot weaken the safety property, which is the whole claim: the
guarantee is a property of our code, not of a vendor's behaviour.
`advisory_source` names whichever model actually wrote the sentence the captain
is reading, so the citation stays true when the provider changes.

Three design points that are load-bearing:

**The template is the cache key.** Two requests that reached the same decision
produce the same template, so they hit the same cache entry. The bridge polls
`/advise` once a second, but the throttle recommendation only changes when the
conditions do -- so a demo crossing costs a handful of calls, not hundreds.
Nothing about the request is in the key: two different vessels that arrive at
the same advice deserve the same sentence.

**The display never waits on this.** On a cache miss the caller gets the
deterministic template immediately and the rewrite is fetched in the
background; the next poll, a second later, picks it up. `advisory_source` says
which one the frame is carrying, so the upgrade is visible rather than
pretended. Serverless is the exception -- a function instance may be frozen the
moment it returns, so there is no "background" to speak of -- and there the
call blocks under a short timeout instead. `VERCEL` is set in that runtime, so
the default follows the platform rather than a flag someone has to remember.

**A missing key is a supported state, not a failure.** No API key, no SDK
installed, an API error, a rate limit, a timeout, a rejected rewrite -- every
one of them lands on the same path: the deterministic sentence, labelled
`"template"`. The judges' demo does not depend on a credential, and neither
does the boat. This matters more with a free-tier provider than a paid one: a
rate limit is an ordinary Tuesday, and it costs the display nothing.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass

from services.advisory.guard import rejection_reason

log = logging.getLogger(__name__)

#: Value of `advisory_source` when Claude wrote the displayed sentence.
SOURCE_CLAUDE = "claude"
#: Value of `advisory_source` when Gemini wrote it.
SOURCE_GEMINI = "gemini"
#: Value of `advisory_source` when the deterministic template did.
SOURCE_TEMPLATE = "template"
#: Every value that means "a language model wrote this", for callers that only
#: care whether the sentence was rewritten at all.
SOURCE_MODELS = frozenset({SOURCE_CLAUDE, SOURCE_GEMINI})

_DEFAULT_MODEL = "claude-opus-5"
#: Chosen by measuring the live free tier on 2026-08-01, not by reputation.
#:
#: The obvious candidates all failed for different reasons: `gemini-2.5-flash`
#: and `-flash-lite` return 404 (retired for new keys), `gemini-2.0-flash` has a
#: free-tier limit of 0, and the newest `gemini-3.6-flash` and `gemini-3.5-flash`
#: allow **20 requests per day** -- which a display polling once a second spends
#: in under a minute. `gemma-4-31b-it` also works and is the alternative if this
#: one tightens.
#:
#: An alias rather than a pin, unusually, and for a specific reason: retirement
#: is the failure that actually bit this project, and Google keeps the alias
#: pointing at something live. Override with `GOOGLE_MODEL`.
_DEFAULT_GOOGLE_MODEL = "gemini-flash-lite-latest"

#: Google's floor for a client-supplied transport deadline. Anything lower is a
#: 400 before the request is even attempted. Discovered live, not documented
#: here from memory -- see the note in `_ask_gemini`.
_GOOGLE_MIN_DEADLINE_MS = 10_000
_DEFAULT_TIMEOUT_S = 6.0
_CACHE_TTL_S = 30 * 60
_CACHE_MAX = 256

_SYSTEM = """\
You write the single sentence shown on the bridge display of a small Philippine \
passenger boat (a banca). The reader is the captain, at the helm, in daylight \
glare, with one second to spare.

You are given a sentence that the vessel's advisory system has already produced. \
Your only job is to say the same thing more naturally, in English and in Filipino. \
The decision has already been made by other software; you are not making it and \
you are not reviewing it.

Rules, all of them absolute:
1. Every number in the given sentence must appear in yours, unchanged. Add no \
number that is not in the given sentence. If it says 2.1 L/h, you may not write \
"about 2 L/h".
2. Never give an order. State what is true and let the captain decide. \
"1650 RPM saves 2.1 L/h" is correct. "Reduce to 1650 RPM" is forbidden, and so \
is "you should", "you must" and "dapat".
3. Add no fact, cause, advice or reassurance that is not in the given sentence. \
Do not explain why. Do not speculate.
4. One sentence each, under 140 characters. Plain words. No jargon, no \
engineering terms the reader would not use himself.
5. The Filipino is for a working fisherman, not a formal document. Conversational \
Tagalog, and keep the English loanwords a boat crew actually uses (RPM, throttle, \
makina) rather than translating them into words nobody says.\
"""

_SCHEMA = {
    "type": "object",
    "properties": {
        "en": {"type": "string", "description": "The English sentence."},
        "fil": {"type": "string", "description": "The Filipino sentence."},
    },
    "required": ["en", "fil"],
    "additionalProperties": False,
}

#: The same shape for Google, which speaks OpenAPI rather than JSON Schema and
#: rejects `additionalProperties`. Kept separate rather than translated at call
#: time: two literals a reader can compare beat one clever converter.
_GEMINI_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "en": {"type": "STRING", "description": "The English sentence."},
        "fil": {"type": "STRING", "description": "The Filipino sentence."},
    },
    "required": ["en", "fil"],
}


@dataclass(frozen=True, slots=True)
class Phrasing:
    """A bridge sentence pair and an honest account of who wrote it."""

    en: str
    fil: str
    source: str

    @property
    def is_claude(self) -> bool:
        return self.source == SOURCE_CLAUDE

    @property
    def is_model(self) -> bool:
        """Did a language model write this, whichever one?"""
        return self.source in SOURCE_MODELS


@dataclass(slots=True)
class _Entry:
    phrasing: Phrasing
    stored_at: float


_cache: dict[tuple[str, str, str], _Entry] = {}
_inflight: set[tuple[str, str, str]] = set()


def _env_flag(name: str) -> bool | None:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return None
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def provider() -> str | None:
    """Which model will be asked, or None for "serve templates".

    Google first, deliberately: it is the free tier this project runs on, and a
    key that costs nothing is the one a judge can reproduce. Anthropic stays
    wired as the fallback so a rate-limited demo has somewhere to go, and so the
    claim that the guard is provider-agnostic is demonstrable rather than
    asserted.

    Read per call rather than cached at import: the tests flip the keys, and a
    deployment that adds a secret should not need a rebuild to pick it up.
    """
    if _env_flag("MARINE_AI_ADVISORY_DISABLED"):
        return None
    forced = os.environ.get("MARINE_AI_ADVISORY_PROVIDER", "").strip().lower()
    if forced in {SOURCE_GEMINI, SOURCE_CLAUDE}:
        return forced
    if os.environ.get("GOOGLE_API_KEY", "").strip():
        return SOURCE_GEMINI
    if os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return SOURCE_CLAUDE
    return None


def enabled() -> bool:
    """Whether a rewrite will be attempted at all."""
    return provider() is not None


def _blocking() -> bool:
    """Wait for the rewrite, or serve the template and fetch it in the background?

    Serverless wins the argument by default: on Vercel the instance can be
    frozen as soon as the response is written, so a background task is a task
    that may never run, and the deployed demo would sit on templates forever.
    """
    override = _env_flag("MARINE_AI_ADVISORY_BLOCKING")
    if override is not None:
        return override
    return bool(os.environ.get("VERCEL"))


def _timeout_s() -> float:
    raw = os.environ.get("MARINE_AI_ADVISORY_TIMEOUT_S", "").strip()
    try:
        return float(raw) if raw else _DEFAULT_TIMEOUT_S
    except ValueError:
        return _DEFAULT_TIMEOUT_S


def reset_cache() -> None:
    """Drop every cached rewrite. For tests, and for a deliberate re-roll."""
    _cache.clear()
    _inflight.clear()


def _cached(key: tuple[str, str, str]) -> Phrasing | None:
    entry = _cache.get(key)
    if entry is None:
        return None
    if time.monotonic() - entry.stored_at > _CACHE_TTL_S:
        del _cache[key]
        return None
    return entry.phrasing


def _store(key: tuple[str, str, str], phrasing: Phrasing) -> None:
    if len(_cache) >= _CACHE_MAX:
        # Coarse, and deliberately so. The key space is the set of distinct
        # advisories a vessel can reach, which is small; if it ever is not, an
        # LRU would only be delaying the same eviction.
        _cache.clear()
    _cache[key] = _Entry(phrasing, time.monotonic())


def _user_prompt(kind: str, template_en: str, template_fil: str) -> str:
    """What goes over the wire: a finished sentence, never re-derivable state."""
    return (
        f"Advisory type: {kind}\n"
        f"English sentence to re-say: {template_en}\n"
        f"Filipino sentence to re-say: {template_fil}"
    )


def _accept(en: str, fil: str, template_en: str, template_fil: str, source: str) -> Phrasing | None:
    """Run both candidates past the guard. Shared by every provider.

    Deliberately provider-agnostic: this is the function that makes "swapping
    the model cannot weaken the guarantee" true rather than aspirational.
    """
    for candidate, template, label in ((en, template_en, "en"), (fil, template_fil, "fil")):
        reason = rejection_reason(candidate, template)
        if reason is not None:
            # The whole pair is discarded, not just the offending half: an
            # English sentence next to a Filipino one that says something else
            # is worse than two templates.
            log.warning("advisory: rewrite rejected [%s]: %s -- %r", label, reason, candidate)
            return None
    return Phrasing(en=en, fil=fil, source=source)


def _parse_pair(text: str) -> tuple[str, str] | None:
    try:
        payload = json.loads(text)
        return str(payload["en"]).strip(), str(payload["fil"]).strip()
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        log.warning("advisory: unparseable response (%s); serving template", exc)
        return None


async def _ask_gemini(kind: str, template_en: str, template_fil: str) -> Phrasing | None:
    """One call to Google. Returns None on any failure, including a rejection.

    Thinking is switched off. This is a rephrasing task with the decision
    already made, so reasoning tokens buy nothing and cost the one thing that
    matters here -- the sentence has to land while the captain still cares.
    """
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        log.info("advisory: google-genai not installed; serving templates")
        return None

    model = os.environ.get("GOOGLE_MODEL", "").strip() or _DEFAULT_GOOGLE_MODEL
    # Two different deadlines, deliberately.
    #
    # Google rejects any transport deadline under 10s outright -- `400
    # INVALID_ARGUMENT: Manually set deadline 6s is too short`. Our own timeout
    # is a product decision (a sentence that arrives after the captain has
    # stopped looking is worth nothing) and defaults to 6s, so passing it
    # straight through failed *every* call while looking exactly like a working
    # integration: templates on screen, `advisory_source: "template"`, no crash.
    #
    # So the transport gets a deadline Google will accept, and `asyncio.
    # wait_for` enforces ours on top of it. Whichever fires first, the caller
    # gets None and the display gets the template.
    client = genai.Client(
        api_key=os.environ["GOOGLE_API_KEY"],
        http_options=types.HttpOptions(
            timeout=max(_GOOGLE_MIN_DEADLINE_MS, int(_timeout_s() * 1000))
        ),
    )

    # `thinking_config` is opt-in, not default. Disabling thinking is the right
    # thing to ask for on a model that supports it -- the decision is already
    # made, so reasoning tokens buy nothing and cost latency -- but the lite
    # models reject the field outright with a bare `400 INVALID_ARGUMENT` that
    # names nothing, and the default model here is one of them. An unhelpful
    # error on every call is a worse trade than a little thinking on the models
    # that do support it.
    config = types.GenerateContentConfig(
        system_instruction=_SYSTEM,
        response_mime_type="application/json",
        response_schema=_GEMINI_SCHEMA,
        max_output_tokens=1000,
    )
    if _env_flag("MARINE_AI_ADVISORY_NO_THINKING"):
        config.thinking_config = types.ThinkingConfig(thinking_budget=0)

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=model,
                contents=_user_prompt(kind, template_en, template_fil),
                config=config,
            ),
            timeout=_timeout_s(),
        )
    except TimeoutError:
        log.warning("advisory: Gemini did not answer in %.1fs; serving template", _timeout_s())
        return None
    except Exception as exc:  # noqa: BLE001 -- every failure has the same answer
        # A free-tier rate limit arrives here like any other error, and is
        # handled like any other error: the captain gets the template.
        log.warning("advisory: Gemini call failed (%s); serving template", exc)
        return None

    pair = _parse_pair(response.text or "")
    if pair is None:
        return None
    return _accept(*pair, template_en, template_fil, SOURCE_GEMINI)


async def _ask_claude(kind: str, template_en: str, template_fil: str) -> Phrasing | None:
    """One call. Returns None on any failure -- including a rejected rewrite."""
    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        log.info("advisory: anthropic package not installed; serving templates")
        return None

    model = os.environ.get("ANTHROPIC_MODEL", "").strip() or _DEFAULT_MODEL
    client = AsyncAnthropic(timeout=_timeout_s(), max_retries=1)

    user = _user_prompt(kind, template_en, template_fil)

    try:
        response = await client.messages.create(
            model=model,
            max_tokens=1000,
            system=_SYSTEM,
            output_config={
                # A phrasing task. Low effort keeps the sentence on the display
                # while the captain still cares about it.
                "effort": "low",
                "format": {"type": "json_schema", "schema": _SCHEMA},
            },
            messages=[{"role": "user", "content": user}],
        )
    except Exception as exc:  # noqa: BLE001 -- every failure has the same answer
        log.warning("advisory: Claude call failed (%s); serving template", exc)
        return None
    finally:
        await client.close()

    if response.stop_reason == "refusal":
        log.warning("advisory: request declined by safety classifiers; serving template")
        return None

    text = next((b.text for b in response.content if b.type == "text"), "")
    pair = _parse_pair(text)
    if pair is None:
        return None
    return _accept(*pair, template_en, template_fil, SOURCE_CLAUDE)


async def _ask_model(kind: str, template_en: str, template_fil: str) -> Phrasing | None:
    """Ask whichever provider is configured. None means "serve the template"."""
    chosen = provider()
    if chosen == SOURCE_GEMINI:
        return await _ask_gemini(kind, template_en, template_fil)
    if chosen == SOURCE_CLAUDE:
        return await _ask_claude(kind, template_en, template_fil)
    return None


async def _fill(key: tuple[str, str, str]) -> Phrasing | None:
    kind, template_en, template_fil = key
    _inflight.add(key)
    try:
        phrasing = await _ask_model(kind, template_en, template_fil)
    finally:
        _inflight.discard(key)
    if phrasing is not None:
        _store(key, phrasing)
    return phrasing


async def phrase(*, kind: str, template_en: str, template_fil: str) -> Phrasing:
    """The bridge sentence for this decision, and who wrote it.

    Never raises and never blocks longer than the configured timeout. The
    deterministic template is always an acceptable answer, so there is no
    failure mode here that the caller has to handle.
    """
    template = Phrasing(en=template_en, fil=template_fil, source=SOURCE_TEMPLATE)
    if not enabled():
        return template

    key = (kind, template_en, template_fil)
    hit = _cached(key)
    if hit is not None:
        return hit

    if _blocking():
        return await _fill(key) or template

    if key not in _inflight:
        # Fire and forget. The reference is dropped deliberately -- nothing
        # awaits this, and the result is delivered through the cache to
        # whichever request arrives after it lands.
        task = asyncio.create_task(_fill(key))
        _background.add(task)
        task.add_done_callback(_background.discard)
    return template


# asyncio only holds a weak reference to a running task, so a task nothing else
# is holding can be garbage collected mid-flight. Keeping the set is what stops
# the background rewrite from being cancelled at random.
_background: set[asyncio.Task] = set()
