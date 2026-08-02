"""Tests for the OpenSeaMap aids-to-navigation extract.

Two things are worth pinning here. The chart notation, because "Fl R 5s" is
lettered on the display beside a light that flashes, and a wrong label is a
wrong claim about what the screen is doing. And the projection, because the
seamark builder and the chart builder place points on the same canvas from two
different scripts -- the failure mode is a buoy drawn on the wrong side of a
channel, which looks plausible and is not.

The shipped `seamarks.json` is checked too. It is a committed artifact fetched
from a live API, so it can go stale or come back malformed from a rebuild, and
nothing else in the suite would notice.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from data.build_chart import BOUNDS, normalise
from data.build_seamarks import (
    OUTPUT,
    build,
    classify,
    light_label,
    mark_name,
    to_mark,
)

# --- chart notation ---------------------------------------------------------


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        # The three characteristics actually present in the Iloilo Strait.
        (
            {
                "seamark:light:character": "Fl",
                "seamark:light:colour": "white",
                "seamark:light:period": "5",
            },
            "Fl W 5s",
        ),
        (
            {
                "seamark:light:character": "Fl",
                "seamark:light:colour": "red",
                "seamark:light:period": "5",
            },
            "Fl R 5s",
        ),
        (
            {
                "seamark:light:character": "Fl",
                "seamark:light:colour": "white",
                "seamark:light:group": "3",
                "seamark:light:period": "6",
            },
            "Fl(3) W 6s",
        ),
        # A period tagged as a float is the same light as one tagged as an int.
        # "5.0s" on a chart is noise a mariner does not expect to read.
        (
            {
                "seamark:light:character": "Fl",
                "seamark:light:colour": "green",
                "seamark:light:period": "5.0",
            },
            "Fl G 5s",
        ),
        # Sector lights carry more than one colour, semicolon-separated.
        (
            {
                "seamark:light:character": "Oc",
                "seamark:light:colour": "white;red",
                "seamark:light:period": "8",
            },
            "Oc WR 8s",
        ),
        # Partial tagging is normal in crowdsourced data and must degrade to a
        # shorter label rather than to a crash or a fabricated period.
        ({"seamark:light:character": "Q"}, "Q"),
        (
            {"seamark:light:character": "Iso", "seamark:light:period": "2"},
            "Iso 2s",
        ),
    ],
)
def test_light_label_reads_as_chart_notation(tags: dict[str, str], expected: str) -> None:
    assert light_label(tags) == expected


def test_a_feature_with_no_light_character_is_not_a_light() -> None:
    """The marina and the coastguard station must not acquire a characteristic."""
    assert light_label({"seamark:type": "harbour"}) is None
    assert light_label({"seamark:type": "coastguard_station", "name": "Dumangas"}) is None


def test_an_unparseable_period_is_carried_through_rather_than_dropped() -> None:
    """Bad data should be visible on the chart, not silently smoothed away."""
    label = light_label(
        {
            "seamark:light:character": "Fl",
            "seamark:light:colour": "white",
            "seamark:light:period": "about 5",
        }
    )
    assert label == "Fl W about 5s"


# --- classification and naming ----------------------------------------------


def test_lights_of_every_rank_classify_together() -> None:
    """major/minor is an importance ranking, not a different kind of symbol."""
    assert classify("light_major") == "light"
    assert classify("light_minor") == "light"
    assert classify("light") == "light"


def test_an_unknown_seamark_type_survives_as_other() -> None:
    """This extract is re-fetched to stay current, so tomorrow's data may carry a
    type this table has never seen. It must still reach the chart."""
    assert classify("buoy_installation") == "buoy"
    assert classify("something_invented_next_year") == "other"


def test_the_chart_name_is_preferred_over_the_prose_name() -> None:
    tags = {"seamark:name": "Jordan Wharf", "name": "Jordan Wharf Lighthouse"}
    assert mark_name(tags) == "Jordan Wharf"


def test_the_lighthouse_suffix_is_stripped_when_falling_back() -> None:
    assert mark_name({"name": "Bondulan Lighthouse"}) == "Bondulan"
    assert mark_name({"name": "Siete Pecados Light"}) == "Siete Pecados"
    assert mark_name({"name": "The Boat Club Iloilo"}) == "The Boat Club Iloilo"
    assert mark_name({}) is None


# --- projection -------------------------------------------------------------


def test_a_mark_is_projected_with_the_charts_own_definition() -> None:
    """The load-bearing one.

    Two builders place points on one canvas. If this ever disagrees, marks land
    somewhere believable and wrong -- the exact failure a visual check does not
    catch, because a buoy 200 m off still looks like a buoy in open water.
    """
    latitude, longitude = 10.66735, 122.58852  # Jordan Wharf light
    mark = to_mark(
        {
            "type": "node",
            "id": 9632484371,
            "lat": latitude,
            "lon": longitude,
            "tags": {"seamark:type": "light_minor", "seamark:name": "Jordan Wharf"},
        }
    )
    assert mark is not None

    expected_x, expected_y = normalise(longitude, latitude)
    assert mark["x"] == pytest.approx(expected_x, abs=1e-5)
    assert mark["y"] == pytest.approx(expected_y, abs=1e-5)


def test_a_way_is_placed_at_its_centre() -> None:
    """Overpass returns areas with a `center` rather than a `lat`/`lon`."""
    mark = to_mark(
        {
            "type": "way",
            "id": 1,
            "center": {"lat": 10.70, "lon": 122.58},
            "tags": {"seamark:type": "harbour"},
        }
    )
    assert mark is not None
    assert mark["category"] == "harbour"


def test_an_element_with_no_position_is_dropped_not_placed_at_the_origin() -> None:
    """A relation without a centre would otherwise land at chart (0,0) -- the
    top-left corner, on land, looking like a real mark."""
    assert to_mark({"type": "relation", "id": 1, "tags": {"seamark:type": "harbour"}}) is None


# --- the built document -----------------------------------------------------


def test_build_carries_the_licence_it_is_used_under() -> None:
    """ODbL requires attribution; if it is not in the file it cannot reach the
    screen, and the submission is graded on exactly this."""
    document = build([])
    assert document["licence"] == "ODbL 1.0"
    assert "OpenStreetMap" in document["attribution"]
    assert "Not for navigation" in document["caveat"]
    assert document["bounds"] == BOUNDS


def test_marks_are_ordered_so_a_rebuild_diffs_cleanly() -> None:
    buoy = {"seamark:type": "buoy_lateral"}
    elements = [
        {"type": "node", "id": 2, "lat": 10.60, "lon": 122.50, "tags": buoy},
        {"type": "node", "id": 1, "lat": 10.77, "lon": 122.50, "tags": buoy},
    ]
    ys = [mark["y"] for mark in build(elements)["marks"]]
    assert ys == sorted(ys)


# --- the committed artifact -------------------------------------------------


def _shipped() -> dict:
    if not OUTPUT.exists():
        pytest.skip(f"{OUTPUT} not built; run python -m data.build_seamarks")
    return json.loads(Path(OUTPUT).read_text(encoding="utf-8"))


def test_the_shipped_extract_is_inside_the_chart_window() -> None:
    """A mark outside the bounds draws off-canvas and is invisible -- which
    looks identical to not having fetched it."""
    for mark in _shipped()["marks"]:
        assert BOUNDS["min_lat"] <= mark["lat"] <= BOUNDS["max_lat"], mark
        assert BOUNDS["min_lon"] <= mark["lon"] <= BOUNDS["max_lon"], mark
        assert -0.01 <= mark["x"] <= 1.01, mark
        assert -0.01 <= mark["y"] <= 1.01, mark


def test_the_shipped_extract_still_has_the_lights_the_demo_runs_between() -> None:
    """The Iloilo departure runs between a red and a green jetty light and lands
    at a red light on Jordan Wharf. Those three are the reason this dataset is
    worth carrying, and a rebuild that quietly loses them should fail here rather
    than on stage.
    """
    by_name = {mark.get("name"): mark for mark in _shipped()["marks"]}
    for name, expected in [
        ("Iloilo Jetty G", "Fl G 5s"),
        ("Iloilo Jetty R", "Fl R 5s"),
        ("Jordan Wharf", "Fl R 5s"),
    ]:
        assert name in by_name, f"{name} missing from the extract"
        assert by_name[name]["light"]["label"] == expected


def test_every_shipped_light_can_be_animated() -> None:
    """The renderer divides by the period and counts flashes per group. A zero
    or missing period would make a light either never flash or flash every
    frame, and both read as a rendering bug rather than a data one."""
    for mark in _shipped()["marks"]:
        light = mark.get("light")
        if light is None:
            continue
        assert light["period_s"] > 0, mark
        assert light["group"] >= 1, mark
        assert light["colour"].startswith("#"), mark
