"""Extract charted aids to navigation for the demo route from OpenSeaMap.

    python -m data.build_seamarks

Writes `apps/bridge/public/seamarks.json`: the lights, beacons and harbour
features inside the chart window, in the same normalised chart coordinates
`build_chart.py` uses, each carrying its real light characteristic.

**Why this exists.** The Nautical map style draws a Natural Earth coastline and
nothing else. A coastline is not a chart -- what makes a chart a chart is the
aids to navigation on it, and the Iloilo-Jordan crossing runs between a charted
red and green jetty light and lands at a red wharf light. Those are real, they
are on the demo route, and they are openly licensed.

**Why a build-time fetch and not a tile layer.** OpenSeaMap publishes a raster
overlay at tiles.openseamap.org, and pulling it live would be less code. It was
not done, for three reasons:

  1. `apps/bridge/lib/render-chart.ts` promises that nothing on the chart is
     fetched from a third party at runtime. That promise is what keeps the
     licence position a one-line answer, and it is worth more than a shortcut.
  2. A live tile fetch is a dependency that can fail on stage. Ten features in a
     3 kB JSON cannot.
  3. The raster is somebody else's cartography in somebody else's palette. The
     vector data lets the display draw the marks in its own symbology, and --
     because the light character, colour and period come through as fields --
     lets each light actually flash at its charted period.

ODbL requires attribution, which is rendered on the display and declared in
`data/registry.py`. It also requires that a derived database stays open; this
file is a filtered extract published in the same public repository, which is the
condition ODbL asks for.

**This is crowdsourced data, not a hydrographic office.** See the caveats on the
`openseamap-seamarks` registry entry. Absence of a mark here means no one has
mapped one, never that the water is clear.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

# The same window and the same projection the coastline is built with. Imported
# rather than restated: two builders writing coordinates for one canvas is
# precisely where a hand-agreeing second copy would drift.
from data.build_chart import BOUNDS, normalise

OUTPUT = Path("apps/bridge/public/seamarks.json")

ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
"""Overpass mirrors, tried in order.

The public instance answers 504 'server too busy' under load often enough that a
single attempt is not a reliable build step -- it did so twice while this script
was being written."""

USER_AGENT = "Marine-AI/1.0 (National AI Hackathon 2026 prototype; +https://openseamap.org)"

QUERY = """[out:json][timeout:120];
(
  node["seamark:type"]({min_lat},{min_lon},{max_lat},{max_lon});
  way["seamark:type"]({min_lat},{min_lon},{max_lat},{max_lon});
);
out center tags;"""


# Chart notation. A mariner reads "Fl R 5s" as one token, so it is built here
# rather than assembled in the renderer: this is the half of the display with a
# test runner behind it.
COLOUR_ABBREVIATIONS = {
    "white": "W",
    "red": "R",
    "green": "G",
    "yellow": "Y",
    "orange": "Or",
    "blue": "Bu",
    "violet": "Vi",
    "amber": "Am",
}

# What the display paints the flash. Keyed by the OSM colour word, so an
# unmapped colour falls back to white rather than vanishing.
COLOUR_RENDER = {
    "white": "#fde68a",
    "red": "#f87171",
    "green": "#4ade80",
    "yellow": "#fde047",
    "orange": "#fb923c",
    "blue": "#60a5fa",
    "violet": "#c4b5fd",
    "amber": "#fbbf24",
}

CATEGORIES = {
    "light": ("light", "light_major", "light_minor", "light_vessel", "light_float"),
    "buoy": (
        "buoy_lateral",
        "buoy_cardinal",
        "buoy_safe_water",
        "buoy_special_purpose",
        "buoy_isolated_danger",
        "buoy_installation",
        "mooring",
    ),
    "beacon": (
        "beacon_lateral",
        "beacon_cardinal",
        "beacon_safe_water",
        "beacon_special_purpose",
        "beacon_isolated_danger",
    ),
    "harbour": ("harbour", "harbour_basin", "anchorage", "berth", "pilot_boarding"),
    "rescue": ("coastguard_station", "rescue_station"),
}


def classify(seamark_type: str) -> str:
    """Group a raw `seamark:type` into the handful of shapes the chart draws.

    Unknown types deliberately return "other" and are still carried through and
    drawn as a generic mark. This file is re-run to pick up current data, so a
    type nobody has seen yet must not silently disappear from the chart.
    """
    for category, members in CATEGORIES.items():
        if seamark_type in members:
            return category
    return "other"


def colour_words(tags: dict[str, str]) -> list[str]:
    """Light colours, lowercased. OSM separates multiples with a semicolon."""
    raw = tags.get("seamark:light:colour", "")
    return [word.strip().lower() for word in raw.split(";") if word.strip()]


def light_label(tags: dict[str, str]) -> str | None:
    """Chart notation for a light, or None if this feature is not a light.

    Examples, all from the Iloilo Strait window:

        Fl W 5s      Bondulan, and most of the strait
        Fl R 5s      Jordan Wharf -- the demo's destination
        Fl(3) W 6s   Navalas, a group-flashing light
    """
    character = tags.get("seamark:light:character")
    if not character:
        return None

    parts = [character]
    group = tags.get("seamark:light:group")
    if group:
        parts[0] = f"{character}({group})"

    abbreviations = [
        COLOUR_ABBREVIATIONS.get(word, word.upper()[:2]) for word in colour_words(tags)
    ]
    if abbreviations:
        parts.append("".join(abbreviations))

    period = tags.get("seamark:light:period")
    if period:
        # "5" and "5.0" are the same light; a trailing ".0" on a chart is noise.
        try:
            seconds = float(period)
            parts.append(f"{seconds:g}s")
        except ValueError:
            parts.append(f"{period}s")

    return " ".join(parts)


def mark_name(tags: dict[str, str]) -> str | None:
    """The short name to letter on the chart.

    `seamark:name` is the one a chart carries ("Jordan Wharf"); `name` is often
    the prose version of the same thing ("Jordan Wharf Lighthouse"). Prefer the
    chart form, and strip the redundant suffix when falling back.
    """
    if tags.get("seamark:name"):
        return tags["seamark:name"]
    name = tags.get("name")
    if not name:
        return None
    for suffix in (" Lighthouse", " Light"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def to_mark(element: dict[str, Any]) -> dict[str, Any] | None:
    """One Overpass element -> one chart mark, or None if it has no position."""
    latitude = element.get("lat") or element.get("center", {}).get("lat")
    longitude = element.get("lon") or element.get("center", {}).get("lon")
    if latitude is None or longitude is None:
        return None

    tags = element.get("tags", {})
    seamark_type = tags.get("seamark:type", "")
    x, y = normalise(longitude, latitude)

    mark: dict[str, Any] = {
        "id": f"{element['type']}/{element['id']}",
        "type": seamark_type,
        "category": classify(seamark_type),
        "lat": round(latitude, 5),
        "lon": round(longitude, 5),
        "x": round(x, 5),
        "y": round(y, 5),
    }

    name = mark_name(tags)
    if name:
        mark["name"] = name

    label = light_label(tags)
    if label:
        colours = colour_words(tags)
        mark["light"] = {
            "label": label,
            "character": tags.get("seamark:light:character", "Fl"),
            "colour": COLOUR_RENDER.get(colours[0] if colours else "white", "#fde68a"),
            "period_s": _float_or(tags.get("seamark:light:period"), 5.0),
            "group": _int_or(tags.get("seamark:light:group"), 1),
        }

    if tags.get("seamark:harbour:category"):
        mark["harbour_category"] = tags["seamark:harbour:category"]

    return mark


def _float_or(value: str | None, fallback: float) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback


def _int_or(value: str | None, fallback: int) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback


def fetch() -> list[dict[str, Any]]:
    """Run the Overpass query, trying each mirror until one answers."""
    query = QUERY.format(**BOUNDS)
    body = urllib.parse.urlencode({"data": query}).encode()
    last_error = "no endpoint attempted"

    for attempt, endpoint in enumerate(ENDPOINTS):
        if attempt:
            time.sleep(5)
        request = urllib.request.Request(endpoint, data=body, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = json.load(response)
            print(f"   {endpoint} -> {len(payload.get('elements', []))} elements")
            return payload.get("elements", [])
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
            last_error = f"{endpoint}: {error}"
            print(f"   {last_error}")

    raise RuntimeError(f"every Overpass mirror failed; last was {last_error}")


def build(elements: list[dict[str, Any]]) -> dict[str, Any]:
    marks = [mark for mark in (to_mark(element) for element in elements) if mark]
    # North to south, so the drawing order down the chart is stable between runs
    # and a diff of this file shows real edits rather than reordering.
    marks.sort(key=lambda mark: (mark["y"], mark["x"]))

    return {
        "source": "OpenSeaMap / OpenStreetMap contributors",
        "attribution": "© OpenStreetMap contributors (ODbL) — aids to navigation via OpenSeaMap",
        "licence": "ODbL 1.0",
        "fetched": date.today().isoformat(),
        "bounds": BOUNDS,
        "caveat": (
            "Crowdsourced aids to navigation, not a hydrographic survey and not a "
            "Notice to Mariners feed. A light may have changed since it was last "
            "edited. Absence of a mark means none is mapped, not that the water is "
            "clear. Not for navigation."
        ),
        "marks": marks,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--offline",
        action="store_true",
        help="skip the fetch and keep the seamarks.json already on disk",
    )
    args = parser.parse_args()

    if args.offline:
        if OUTPUT.exists():
            print(f"-> {OUTPUT} left as it is (--offline)")
            return
        raise SystemExit("--offline given but no seamarks.json exists to keep")

    print("Querying Overpass for seamarks in the chart window...")
    try:
        elements = fetch()
    except RuntimeError as error:
        # Degrading rather than clobbering. Overpass being busy must not empty
        # the chart, and a half-written file is worse than a stale one.
        if OUTPUT.exists():
            print(f"!  {error}\n!  keeping the existing {OUTPUT}")
            return
        raise

    seamarks = build(elements)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(seamarks), encoding="utf-8")

    lights = [mark for mark in seamarks["marks"] if "light" in mark]
    print(
        f"-> {OUTPUT}  {len(seamarks['marks'])} marks "
        f"({len(lights)} lit), {OUTPUT.stat().st_size / 1024:.1f} kB"
    )
    for mark in lights:
        print(f"   {mark['light']['label']:<12} {mark.get('name', mark['type'])}")


if __name__ == "__main__":
    main()
