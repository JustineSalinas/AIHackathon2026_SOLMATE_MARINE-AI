"""The natural-language layer, and the boundary it is not allowed to cross.

Most of this file is about rejection. The interesting property of the advisory
layer is not that Claude can write a nicer sentence -- it is that when Claude
writes a *wrong* one, the wrong sentence never reaches the captain. So the
tests drive the guard with the specific failures that matter on a boat: a
changed number, a dropped number, an order dressed as advice.

No test here touches the network. `_ask_claude` is replaced wholesale where a
success path is needed, and `conftest.py` clears the key for the whole run so a
developer's real credential cannot turn this file into a billing event.
"""

from __future__ import annotations

import asyncio

import pytest

from services.advisory import phraser
from services.advisory.guard import numbers_in, rejection_reason
from services.advisory.phraser import SOURCE_CLAUDE, SOURCE_TEMPLATE, Phrasing, phrase

TEMPLATE_EN = "1650 RPM saves 2.1 L/h — about PHP 143 per hour."
TEMPLATE_FIL = "1650 RPM ay nakakatipid ng 2.1 L/h — humigit-kumulang PHP 143 kada oras."


@pytest.fixture(autouse=True)
def _clean_cache():
    phraser.reset_cache()
    yield
    phraser.reset_cache()


@pytest.fixture
def claude_configured(monkeypatch):
    """A key that looks real enough to enable the layer and cannot be used."""
    monkeypatch.delenv("MARINE_AI_ADVISORY_DISABLED", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-not-a-real-key")
    monkeypatch.setenv("MARINE_AI_ADVISORY_BLOCKING", "1")


# --- the guard --------------------------------------------------------------


def test_a_faithful_rewrite_is_accepted():
    """The whole point: better prose, same facts."""
    assert (
        rejection_reason("Easing to 1650 RPM saves 2.1 L/h, about PHP 143 an hour.", TEMPLATE_EN)
        is None
    )


def test_an_invented_saving_is_rejected():
    """The failure that would actually mislead a captain.

    A model that rounds 2.1 up to 3.0 has not rephrased the advice, it has
    replaced it -- and the number on the display is what the operator decides
    against. This is the reason the guard exists.
    """
    reason = rejection_reason("1650 RPM saves 3.0 L/h — about PHP 143 per hour.", TEMPLATE_EN)
    assert reason is not None
    assert "invented" in reason and "3.0" in reason


def test_a_dropped_number_is_rejected():
    """Losing the peso figure quietly makes the advice less useful, not wrong-er.

    Still rejected. The sentence the optimiser produced is the sentence the
    captain is entitled to; an LLM does not get to decide which half of it
    matters.
    """
    reason = rejection_reason("1650 RPM saves 2.1 L/h.", TEMPLATE_EN)
    assert reason is not None
    assert "dropped" in reason and "143" in reason


def test_rounding_is_not_a_licence():
    """"About 2 L/h" reads naturally and is a different number. Rejected."""
    assert rejection_reason("1650 RPM saves about 2 L/h — PHP 143 per hour.", TEMPLATE_EN)


def test_thousands_separators_are_not_a_change():
    """PHP 1,234 and PHP 1234 are the same peso figure, formatted twice."""
    template = "1650 RPM saves 2.1 L/h — about PHP 1,234 per hour."
    assert rejection_reason("1650 RPM saves 2.1 L/h, about PHP 1234 an hour.", template) is None


@pytest.mark.parametrize(
    "order",
    [
        "Reduce to 1650 RPM and save 2.1 L/h — PHP 143 per hour.",
        "Set 1650 RPM; it saves 2.1 L/h — PHP 143 per hour.",
        "You should hold 1650 RPM to save 2.1 L/h — PHP 143 per hour.",
        "1650 RPM saves 2.1 L/h — PHP 143 per hour. Slow down now.",
    ],
)
def test_orders_are_rejected_however_they_are_phrased(order):
    """PRODUCT.md's non-negotiable, enforced.

    An advisory system that gives orders has taken command, and under maritime
    liability that is a different product with a different legal position. The
    last case matters most: the order is in a second clause, after a perfectly
    correct first one.
    """
    assert rejection_reason(order, TEMPLATE_EN) is not None


def test_a_gerund_is_not_an_order():
    """"Holding 1650 RPM..." states a consequence. "Hold 1650 RPM" commands.

    The guard checks the first word of each clause precisely so this
    distinction survives -- a blanket keyword ban would fail every natural
    rewrite of the advisory.
    """
    holding = "Holding 1650 RPM saves 2.1 L/h — PHP 143 an hour."
    assert rejection_reason(holding, TEMPLATE_EN) is None


def test_tagalog_obligation_is_rejected():
    """"Dapat" is "should". The rule is not English-only."""
    assert rejection_reason("Dapat 1650 RPM para makatipid ng 2.1 L/h — PHP 143.", TEMPLATE_FIL)


def test_an_essay_is_rejected():
    """The captain has one second. A model that started explaining loses."""
    padded = "1650 RPM saves 2.1 L/h — about PHP 143 per hour, " + "and so on " * 20
    reason = rejection_reason(padded, TEMPLATE_EN)
    assert reason is not None and "too long" in reason


def test_numbers_in_normalises_separators():
    assert numbers_in("PHP 1,234 and 2.1 and 1650") == {"1234", "2.1", "1650"}


# --- the phraser ------------------------------------------------------------


async def test_without_a_key_the_template_is_served():
    """A missing credential is a supported state, not an outage.

    The demo URL the judges open must not depend on a secret being present, so
    the absence of one has to land on the ordinary path and label itself.
    """
    result = await phrase(kind="throttle", template_en=TEMPLATE_EN, template_fil=TEMPLATE_FIL)
    assert result == Phrasing(TEMPLATE_EN, TEMPLATE_FIL, SOURCE_TEMPLATE)


async def test_no_key_means_no_client_is_ever_constructed(monkeypatch):
    """Not just "no answer" -- no call. Cheap to assert, easy to regress."""
    called = False

    async def _boom(*args, **kwargs):
        nonlocal called
        called = True
        return None

    monkeypatch.setattr(phraser, "_ask_claude", _boom)
    await phrase(kind="throttle", template_en=TEMPLATE_EN, template_fil=TEMPLATE_FIL)
    assert not called


async def test_an_accepted_rewrite_is_labelled_claude(monkeypatch, claude_configured):
    async def _rewrite(kind, en, fil):
        return Phrasing("Easing to 1650 RPM saves 2.1 L/h, about PHP 143 an hour.", fil, "claude")

    monkeypatch.setattr(phraser, "_ask_claude", _rewrite)
    result = await phrase(kind="throttle", template_en=TEMPLATE_EN, template_fil=TEMPLATE_FIL)
    assert result.source == SOURCE_CLAUDE
    assert "Easing" in result.en


async def test_a_rejected_rewrite_degrades_to_the_template(monkeypatch, claude_configured):
    """`_ask_claude` returning None is how a guard rejection reaches the caller."""

    async def _rejected(kind, en, fil):
        return None

    monkeypatch.setattr(phraser, "_ask_claude", _rejected)
    result = await phrase(kind="throttle", template_en=TEMPLATE_EN, template_fil=TEMPLATE_FIL)
    assert result == Phrasing(TEMPLATE_EN, TEMPLATE_FIL, SOURCE_TEMPLATE)


async def test_the_same_decision_is_only_paid_for_once(monkeypatch, claude_configured):
    """The bridge polls once a second; the decision changes far less often.

    Without this the demo would issue a call per frame. The template pair is
    the cache key, which means "same advice" and "same cache entry" are the
    same statement.
    """
    calls = 0

    async def _count(kind, en, fil):
        nonlocal calls
        calls += 1
        return Phrasing("Easing to 1650 RPM saves 2.1 L/h, about PHP 143 an hour.", fil, "claude")

    monkeypatch.setattr(phraser, "_ask_claude", _count)
    for _ in range(5):
        result = await phrase(kind="throttle", template_en=TEMPLATE_EN, template_fil=TEMPLATE_FIL)
    assert calls == 1
    assert result.source == SOURCE_CLAUDE


async def test_a_new_decision_is_a_new_sentence(monkeypatch, claude_configured):
    """The cache must not outlive the advice it describes."""
    seen = []

    async def _record(kind, en, fil):
        seen.append(en)
        return Phrasing(en, fil, "claude")

    monkeypatch.setattr(phraser, "_ask_claude", _record)
    await phrase(kind="throttle", template_en=TEMPLATE_EN, template_fil=TEMPLATE_FIL)
    await phrase(kind="throttle", template_en="1700 RPM meets the schedule.", template_fil="x")
    assert len(seen) == 2


async def test_non_blocking_mode_never_makes_the_display_wait(monkeypatch):
    """On the boat the sentence upgrades a second late. It never arrives late.

    A captain looking at a frozen panel while an HTTP call to a US datacentre
    completes is a worse product than one whose prose improves on the next
    poll, so the default path returns the template immediately and fills the
    cache behind it.
    """
    monkeypatch.delenv("MARINE_AI_ADVISORY_DISABLED", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-not-a-real-key")
    monkeypatch.setenv("MARINE_AI_ADVISORY_BLOCKING", "0")

    async def _slow(kind, en, fil):
        await asyncio.sleep(0.05)
        return Phrasing("Easing to 1650 RPM saves 2.1 L/h, about PHP 143 an hour.", fil, "claude")

    monkeypatch.setattr(phraser, "_ask_claude", _slow)

    first = await phrase(kind="throttle", template_en=TEMPLATE_EN, template_fil=TEMPLATE_FIL)
    assert first.source == SOURCE_TEMPLATE

    await asyncio.sleep(0.15)  # the background fill lands

    second = await phrase(kind="throttle", template_en=TEMPLATE_EN, template_fil=TEMPLATE_FIL)
    assert second.source == SOURCE_CLAUDE


async def test_a_slow_call_is_not_asked_for_twice(monkeypatch):
    """Nine polls arriving during one in-flight call must not become nine calls."""
    monkeypatch.delenv("MARINE_AI_ADVISORY_DISABLED", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-not-a-real-key")
    monkeypatch.setenv("MARINE_AI_ADVISORY_BLOCKING", "0")
    calls = 0

    async def _slow(kind, en, fil):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return Phrasing(en, fil, "claude")

    monkeypatch.setattr(phraser, "_ask_claude", _slow)
    for _ in range(9):
        await phrase(kind="throttle", template_en=TEMPLATE_EN, template_fil=TEMPLATE_FIL)
        await asyncio.sleep(0.002)
    await asyncio.sleep(0.15)
    assert calls == 1


# --- the call itself, with a fake SDK ---------------------------------------
#
# These drive the real `_ask_claude`, so the request shape, the JSON parsing and
# the guard integration are all exercised. The `anthropic` package is replaced
# in `sys.modules`, so the suite passes whether or not it is installed and never
# opens a socket either way.


class _FakeBlock:
    type = "text"

    def __init__(self, text):
        self.text = text


class _FakeResponse:
    def __init__(self, text, stop_reason="end_turn"):
        self.content = [_FakeBlock(text)]
        self.stop_reason = stop_reason


def _fake_sdk(monkeypatch, *, response=None, error=None):
    import sys
    import types

    class _Messages:
        async def create(self, **kwargs):
            _Messages.last_kwargs = kwargs
            if error is not None:
                raise error
            return response

    class _Client:
        def __init__(self, **kwargs):
            self.messages = _Messages()

        async def close(self):
            pass

    module = types.ModuleType("anthropic")
    module.AsyncAnthropic = _Client
    monkeypatch.setitem(sys.modules, "anthropic", module)
    return _Messages


async def test_a_faithful_rewrite_survives_the_round_trip(monkeypatch, claude_configured):
    body = (
        '{"en": "Easing to 1650 RPM saves 2.1 L/h, about PHP 143 an hour.",'
        ' "fil": "Sa 1650 RPM, tipid ng 2.1 L/h — mga PHP 143 kada oras."}'
    )
    messages = _fake_sdk(monkeypatch, response=_FakeResponse(body))

    result = await phraser._ask_claude("throttle", TEMPLATE_EN, TEMPLATE_FIL)

    assert result is not None and result.source == SOURCE_CLAUDE
    assert "Easing" in result.en
    # The decision goes over the wire as a finished sentence, never as state
    # the model could re-derive differently.
    sent = messages.last_kwargs["messages"][0]["content"]
    assert TEMPLATE_EN in sent and TEMPLATE_FIL in sent


async def test_a_transport_failure_returns_none(monkeypatch, claude_configured):
    """A dropped connection mid-crossing is a Tuesday, not an incident."""
    _fake_sdk(monkeypatch, error=RuntimeError("connection reset"))
    assert await phraser._ask_claude("throttle", TEMPLATE_EN, TEMPLATE_FIL) is None


async def test_a_hallucinated_number_is_caught_end_to_end(monkeypatch, claude_configured):
    """The guard wired into the real call path, not just unit-tested beside it."""
    body = '{"en": "1650 RPM saves 9.9 L/h — PHP 143 per hour.", "fil": "1650 RPM, 9.9 L/h."}'
    _fake_sdk(monkeypatch, response=_FakeResponse(body))
    assert await phraser._ask_claude("throttle", TEMPLATE_EN, TEMPLATE_FIL) is None


async def test_a_bad_english_sentence_discards_the_filipino_too(monkeypatch, claude_configured):
    """Half a rewrite is worse than none.

    An English line that failed the guard sitting next to a Filipino line that
    passed would put two different claims on the same panel, in two languages
    the same crew reads. The pair is atomic.
    """
    body = (
        '{"en": "Reduce to 1650 RPM; saves 2.1 L/h — PHP 143 per hour.",'
        ' "fil": "Sa 1650 RPM, tipid ng 2.1 L/h — mga PHP 143 kada oras."}'
    )
    _fake_sdk(monkeypatch, response=_FakeResponse(body))
    assert await phraser._ask_claude("throttle", TEMPLATE_EN, TEMPLATE_FIL) is None


async def test_malformed_json_returns_none(monkeypatch, claude_configured):
    _fake_sdk(monkeypatch, response=_FakeResponse("not json at all"))
    assert await phraser._ask_claude("throttle", TEMPLATE_EN, TEMPLATE_FIL) is None


async def test_a_refusal_returns_none(monkeypatch, claude_configured):
    """Safety classifiers can decline. That is a template frame, not a 500."""
    _fake_sdk(monkeypatch, response=_FakeResponse("", stop_reason="refusal"))
    assert await phraser._ask_claude("throttle", TEMPLATE_EN, TEMPLATE_FIL) is None


# --- the wiring -------------------------------------------------------------


def _api_client():
    from fastapi.testclient import TestClient

    from apps.api.main import app

    return TestClient(app)


def test_the_api_serves_templates_and_says_so_when_unconfigured():
    """The default state of a fresh clone, and of the demo without a key."""
    with _api_client() as client:
        body = client.post("/advise", json={"distance_remaining_nm": 2.0}).json()
        assert body["recommendation"]["advisory_source"] == SOURCE_TEMPLATE
        assert client.get("/health").json()["advisory_layer"] == "template"


def test_the_api_labels_a_claude_sentence_on_every_advisory_endpoint(monkeypatch):
    """All three zones the display renders go through the same layer.

    Throttle, route and health each carry an advisory sentence, and a judge who
    checks one and not the others should not find a different answer.
    """
    monkeypatch.delenv("MARINE_AI_ADVISORY_DISABLED", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-not-a-real-key")
    monkeypatch.setenv("MARINE_AI_ADVISORY_BLOCKING", "1")

    async def _rewrite(kind, en, fil):
        # A rewrite that would pass the guard for any template: the same
        # sentence. What is under test here is the wiring, not the prose.
        return Phrasing(en, fil, SOURCE_CLAUDE)

    monkeypatch.setattr(phraser, "_ask_claude", _rewrite)

    with _api_client() as client:
        throttle = client.post("/advise", json={"distance_remaining_nm": 2.0}).json()
        assert throttle["recommendation"]["advisory_source"] == SOURCE_CLAUDE

        route = client.post(
            "/route",
            json={
                "origin": {"latitude": 10.70, "longitude": 122.55},
                "destination": {"latitude": 10.62, "longitude": 122.75},
            },
        ).json()
        assert route["recommendation"]["advisory_source"] == SOURCE_CLAUDE

        from tests.test_api import em_window

        health = client.post("/maintenance", json={"frames": em_window()}).json()
        assert health["advisory_source"] == SOURCE_CLAUDE

        assert client.get("/health").json()["advisory_layer"] == "claude"


def test_the_numbers_on_the_wire_are_the_optimizers_numbers(monkeypatch):
    """The integration property, stated as a test.

    A rewrite reaches the display only if it carries the optimiser's figures, so
    the recommended RPM in the JSON must still be findable in the sentence a
    captain reads. This is what stops a nicer sentence from becoming a different
    recommendation.
    """
    monkeypatch.delenv("MARINE_AI_ADVISORY_DISABLED", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-not-a-real-key")
    monkeypatch.setenv("MARINE_AI_ADVISORY_BLOCKING", "1")

    async def _reword(kind, en, fil):
        return Phrasing(f"At {en.lower()}", fil, SOURCE_CLAUDE)

    monkeypatch.setattr(phraser, "_ask_claude", _reword)

    with _api_client() as client:
        body = client.post(
            "/advise", json={"distance_remaining_nm": 2.0, "current_rpm": 2400.0}
        ).json()

    rec = body["recommendation"]
    assert rec["advisory_source"] == SOURCE_CLAUDE
    assert str(round(rec["recommended_rpm"])) in rec["advisory_en"]


# --- the boundary -----------------------------------------------------------


def test_the_deciding_modules_never_import_the_advisory_layer():
    """The claim is "Claude phrases, it does not decide". This is the proof.

    A future edit that reaches for the model to break a tie in the optimiser,
    pick a route, or set an anomaly threshold fails here -- which is the point.
    The natural-language layer is downstream of every decision, and nothing
    upstream may consult it.
    """
    import services.maintenance.detector
    import services.route.planner
    import services.safety.rules
    import services.speed.optimizer

    for module in (
        services.speed.optimizer,
        services.route.planner,
        services.maintenance.detector,
        services.safety.rules,
    ):
        assert module.__file__ is not None
        with open(module.__file__, encoding="utf-8") as handle:
            text = handle.read()
        assert "services.advisory" not in text, f"{module.__name__} must not import the LLM layer"
        assert "anthropic" not in text.lower(), f"{module.__name__} must not import the LLM layer"
