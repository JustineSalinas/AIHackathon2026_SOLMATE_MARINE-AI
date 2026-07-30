"""Pull the historical wind/wave/current archive the route forecaster trains on.

    python -m data.fetch_route_forecast
    python -m data.fetch_route_forecast --years 1   # smaller pull, faster iteration

Declared in `data/registry.py` as `open-meteo-weather-archive` (wind) and
`open-meteo-marine-archive` (waves, current) but fetched by this script rather
than the generic `data/download.py`: those two datasets are not one static
file, they are a (latitude, longitude, start_date, end_date) query repeated
across a grid, and the generic single-URL fetcher does not model that shape.

The grid is 9 points spanning the Iloilo Strait operating box that
`data/build_chart.py` and `apps/bridge/lib/simulation.ts` already draw the
chart for (`lat 10.58-10.78, lon 122.46-122.72`), so the forecaster trains on
exactly the water the display shows.

Nothing here is committed -- see `.gitignore` for `/data/raw/`.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx

RAW = Path(__file__).parent / "raw" / "route_forecast"

# Matches BOUNDS in data/build_chart.py and apps/bridge/lib/simulation.ts. Kept
# as a literal copy rather than an import: this script must run standalone with
# only httpx installed, before the rest of the project's dependencies matter.
MIN_LAT, MAX_LAT = 10.58, 10.78
MIN_LON, MAX_LON = 122.46, 122.72

GRID_LATS = (MIN_LAT, (MIN_LAT + MAX_LAT) / 2, MAX_LAT)
GRID_LONS = (MIN_LON, (MIN_LON + MAX_LON) / 2, MAX_LON)
GRID_POINTS = tuple((lat, lon) for lat in GRID_LATS for lon in GRID_LONS)

WEATHER_URL = "https://archive-api.open-meteo.com/v1/archive"
MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"

WEATHER_VARS = "wind_speed_10m,wind_direction_10m"
MARINE_VARS = "wave_height,wave_direction,ocean_current_velocity,ocean_current_direction"

# Open-Meteo Marine's model archive starts well after ERA5's; this is the
# earliest date both sources answer for cleanly, verified 2026-07-30.
EARLIEST_START = date(2024, 1, 1)


def _cache_path(kind: str, lat: float, lon: float) -> Path:
    return RAW / f"{kind}_{lat:.2f}_{lon:.2f}.json"


def _fetch_one(
    client: httpx.Client,
    *,
    url: str,
    variables: str,
    lat: float,
    lon: float,
    start: date,
    end: date,
) -> dict:
    response = client.get(
        url,
        params={
            "latitude": lat,
            "longitude": lon,
            "hourly": variables,
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "timezone": "UTC",
        },
        timeout=90.0,
    )
    response.raise_for_status()
    return response.json()


def fetch(*, years: float = 2.5, force: bool = False) -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    end = datetime.now(UTC).date() - timedelta(days=1)  # yesterday: today may be partial
    start = max(EARLIEST_START, end - timedelta(days=int(years * 365)))

    jobs = [
        ("weather", WEATHER_URL, WEATHER_VARS),
        ("marine", MARINE_URL, MARINE_VARS),
    ]

    with httpx.Client() as client:
        for lat, lon in GRID_POINTS:
            for kind, url, variables in jobs:
                path = _cache_path(kind, lat, lon)
                if path.exists() and not force:
                    print(f"  {kind} @ ({lat:.2f}, {lon:.2f}): cached")
                    continue
                print(f"  {kind} @ ({lat:.2f}, {lon:.2f}): fetching {start} to {end}...")
                payload = _fetch_one(
                    client, url=url, variables=variables, lat=lat, lon=lon, start=start, end=end
                )
                path.write_text(json.dumps(payload), encoding="utf-8")
                # Open-Meteo's free tier rate-limits by request burst, not by this
                # pull's total volume -- a beat between requests keeps 18 sequential
                # calls comfortably under it without meaningfully slowing the pull.
                time.sleep(1.0)

    manifest = {
        "grid_points": [{"lat": lat, "lon": lon} for lat, lon in GRID_POINTS],
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "fetched_at": datetime.now(UTC).isoformat(),
        "weather_url": WEATHER_URL,
        "marine_url": MARINE_URL,
    }
    (RAW / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\n{len(GRID_POINTS)} grid points x 2 sources ready in {RAW}")
    return RAW


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch the route-forecast training archive.")
    parser.add_argument(
        "--years", type=float, default=2.5, help="How far back to pull (default 2.5 years)."
    )
    parser.add_argument("--force", action="store_true", help="Refetch even if cached.")
    args = parser.parse_args()
    fetch(years=args.years, force=args.force)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
