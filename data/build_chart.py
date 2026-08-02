"""Extract the demo route's chart geometry from Natural Earth.

    python -m data.build_chart

Writes `apps/bridge/public/chart.json`: coastline polylines for the
Iloilo Strait, in normalised chart coordinates, plus the geographic bounds so
the display can convert between screen position and real latitude/longitude.

**Why this exists.** The prototype simulator used a screenshot of a web map as
its chart background. The submission is graded on "use only licensed or public
datasets", and a screenshot of someone else's basemap is neither licensed nor
attributable. Natural Earth is public domain, already declared in
`data/registry.py`, and renders as a drawn nautical chart rather than a tile
basemap -- no API key, no quota, nothing to fail on stage.

Natural Earth 10m is a global dataset at roughly 1:10,000,000. That is the right
scale for showing where a route runs and the wrong scale for navigation, and the
distinction is recorded in the output so it cannot be quietly forgotten: the
depth constraint comes from bathymetry, never from this outline.
"""

from __future__ import annotations

import argparse
import json
import math
import urllib.request
from pathlib import Path

SHAPEFILE = Path("data/raw/natural-earth-coastline/ne_10m_coastline.shp")
OUTPUT = Path("apps/bridge/public/chart.json")
BASEMAP = Path("apps/bridge/public/basemap.jpg")
LANDMASK = Path("apps/bridge/public/landmask.png")

BASEMAP_WIDTH = 2800
"""Basemap resolution, matched to the source rather than guessed.

Sentinel-2 is a 10 m/px sensor. This window is 0.26 deg of longitude at 10.7 N,
which is 28.4 km, so 2800 px is 10.1 m/px -- native. The previous 1400 threw away
half the detail the satellite actually resolves, and it showed: the chart looked
acceptable fitted to the canvas and went soft the moment the follow camera zoomed
in. Asking a WMS for more than 2800 would not buy anything; it would just
upsample, which is why this is set to the sensor and not to the biggest number
the server will accept."""

MASK_WIDTH = 360
"""Mask resolution. The helm view ray-casts this to build its horizon, so it
needs enough detail to resolve a headland and no more; at 360 px across a 28 km
window each cell is about 80 m, which is finer than the horizon can show."""

# Iloilo City to Jordan, Guimaras -- the route the demo runs, and one of the
# busiest short-haul passenger crossings in the Philippines.
ILOILO_PORT = (10.6969, 122.5711)  # Muelle Loney / Ortiz wharf area
JORDAN_PORT = (10.6558, 122.5936)  # Jordan wharf, Guimaras

# Bounds drawn a little wider than the crossing so both shores have depth on
# screen and the helm view has land to put on the horizon.
BOUNDS = {
    "min_lat": 10.58,
    "max_lat": 10.78,
    "min_lon": 122.46,
    "max_lon": 122.72,
}

NM_PER_DEG_LAT = 60.0


def haversine_nm(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in nautical miles."""
    r_nm = 3440.065
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r_nm * math.asin(math.sqrt(h))


def normalise(lon: float, lat: float) -> tuple[float, float]:
    """Geographic -> normalised chart coordinates, x east, y south (screen order).

    Public because `data/build_seamarks.py` projects into the same chart window
    and must use the same definition. Two builders writing coordinates for one
    canvas is exactly the situation where a second, hand-agreeing copy of this
    arithmetic would eventually drift and put a buoy on the wrong side of a
    channel.
    """
    x = (lon - BOUNDS["min_lon"]) / (BOUNDS["max_lon"] - BOUNDS["min_lon"])
    y = (BOUNDS["max_lat"] - lat) / (BOUNDS["max_lat"] - BOUNDS["min_lat"])
    return x, y


def _clip(points: list[tuple[float, float]]) -> list[list[tuple[float, float]]]:
    """Split a polyline into the runs that fall inside the bounds.

    Natural Earth coastlines are long strings that wander far outside any local
    window. Keeping only the in-window runs is what makes the file small enough
    to ship to a browser.
    """
    runs: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    for lon, lat in points:
        inside = (
            BOUNDS["min_lon"] <= lon <= BOUNDS["max_lon"]
            and BOUNDS["min_lat"] <= lat <= BOUNDS["max_lat"]
        )
        if inside:
            current.append(normalise(lon, lat))
        elif current:
            if len(current) > 1:
                runs.append(current)
            current = []
    if len(current) > 1:
        runs.append(current)
    return runs


def basemap_url(width: int, height: int) -> str:
    """WMS request for the chart window. Declared in `data/registry.py`."""
    return (
        "https://tiles.maps.eox.at/wms?service=WMS&version=1.1.1&request=GetMap"
        "&layers=s2cloudless-2025"
        f"&bbox={BOUNDS['min_lon']},{BOUNDS['min_lat']},"
        f"{BOUNDS['max_lon']},{BOUNDS['max_lat']}"
        f"&width={width}&height={height}&srs=EPSG:4326&format=image/jpeg"
    )


def fetch_basemap() -> tuple[int, int]:
    """Download the Sentinel-2 composite for the chart window."""
    aspect = (BOUNDS["max_lat"] - BOUNDS["min_lat"]) / (BOUNDS["max_lon"] - BOUNDS["min_lon"])
    height = round(BASEMAP_WIDTH * aspect)

    BASEMAP.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(basemap_url(BASEMAP_WIDTH, height), timeout=120) as response:
        if response.status != 200:
            raise RuntimeError(f"basemap request returned {response.status}")
        BASEMAP.write_bytes(response.read())
    return BASEMAP_WIDTH, height


def build_land_mask() -> tuple[int, int, float]:
    """Classify the basemap into land and water, and save it as a 1-bit PNG.

    The helm view ray-casts this mask outward from the vessel to work out where
    land sits on the horizon and how far away it is. Deriving it from the same
    imagery the chart displays means the silhouette on the horizon and the
    coastline under the vessel can never disagree.

    Classification is a two-term colour test rather than a trained classifier,
    because the separation in this scene is not subtle. Sampled values:

        open water    rgb(24, 60, 58)     blue ~ green, blue >> red
        vegetation    rgb(25, 49, 15)     blue << green, blue < red
        urban         rgb(90, 116, 87)    blue < green, blue ~ red

    Water is the only class where blue materially exceeds red. Anything a
    trained model would add here is accuracy this display cannot render.
    """
    # Imported lazily so the vector chart still builds without Pillow/numpy.
    import numpy as np
    from PIL import Image

    image = Image.open(BASEMAP).convert("RGB")
    aspect = image.height / image.width
    small = image.resize((MASK_WIDTH, round(MASK_WIDTH * aspect)), Image.BILINEAR)

    pixels = np.asarray(small).astype(float)
    red, green, blue = pixels[..., 0], pixels[..., 1], pixels[..., 2]
    water = (blue > red * 1.25) & (blue > green * 0.80)

    # Median filter: strips the speckle that thin cloud, wakes and small boats
    # leave behind, without moving a real shoreline more than one cell.
    land = ~water
    padded = np.pad(land.astype(np.uint8), 1, mode="edge")
    neighbourhood = np.stack(
        [
            padded[dy : dy + land.shape[0], dx : dx + land.shape[1]]
            for dy in range(3)
            for dx in range(3)
        ]
    )
    land = neighbourhood.sum(axis=0) >= 5

    Image.fromarray((land * 255).astype("uint8"), mode="L").save(LANDMASK, optimize=True)
    return small.width, small.height, float(land.mean())


def build() -> dict:
    # Imported lazily, for the same reason Pillow and numpy are below: this
    # module's window and projection are imported by `data/build_seamarks.py`,
    # which places points in the chart and has no use for a shapefile reader.
    import shapefile

    if not SHAPEFILE.exists():
        raise FileNotFoundError(
            f"{SHAPEFILE} not found. Fetch it with: "
            "python -m data.download natural-earth-coastline"
        )

    reader = shapefile.Reader(str(SHAPEFILE))
    rings: list[list[list[float]]] = []
    for shape in reader.shapes():
        bbox = shape.bbox  # (min_lon, min_lat, max_lon, max_lat)
        if (
            bbox[2] < BOUNDS["min_lon"]
            or bbox[0] > BOUNDS["max_lon"]
            or bbox[3] < BOUNDS["min_lat"]
            or bbox[1] > BOUNDS["max_lat"]
        ):
            continue
        for run in _clip([(p[0], p[1]) for p in shape.points]):
            rings.append([[round(x, 5), round(y, 5)] for x, y in run])

    crossing_nm = haversine_nm(ILOILO_PORT, JORDAN_PORT)
    width_nm = (BOUNDS["max_lon"] - BOUNDS["min_lon"]) * NM_PER_DEG_LAT * math.cos(
        math.radians(ILOILO_PORT[0])
    )

    return {
        "source": "Natural Earth 10m physical coastline (public domain)",
        "attribution": "Natural Earth, naturalearthdata.com",
        "scale_caveat": (
            "1:10,000,000 global outline. Adequate for showing where a route runs; "
            "not a navigational chart. Depth constraints come from bathymetry, "
            "never from this outline."
        ),
        "bounds": BOUNDS,
        "chart_width_nm": round(width_nm, 3),
        # Height and width are different scales: a degree of longitude is shorter
        # than a degree of latitude away from the equator. The helm view ray-casts
        # in nautical miles, so it needs both or every bearing comes out skewed.
        "chart_height_nm": round((BOUNDS["max_lat"] - BOUNDS["min_lat"]) * NM_PER_DEG_LAT, 3),
        "crossing_nm": round(crossing_nm, 3),
        "ports": [
            {
                "name": "Iloilo City",
                "lat": ILOILO_PORT[0],
                "lon": ILOILO_PORT[1],
                "x": round(normalise(ILOILO_PORT[1], ILOILO_PORT[0])[0], 5),
                "y": round(normalise(ILOILO_PORT[1], ILOILO_PORT[0])[1], 5),
            },
            {
                "name": "Jordan, Guimaras",
                "lat": JORDAN_PORT[0],
                "lon": JORDAN_PORT[1],
                "x": round(normalise(JORDAN_PORT[1], JORDAN_PORT[0])[0], 5),
                "y": round(normalise(JORDAN_PORT[1], JORDAN_PORT[0])[1], 5),
            },
        ],
        "coastline": rings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-basemap",
        action="store_true",
        help="skip the satellite download and reuse whatever is already on disk",
    )
    args = parser.parse_args()

    chart = build()

    if not args.no_basemap:
        width, height = fetch_basemap()
        print(f"-> {BASEMAP}  {width}x{height}, {BASEMAP.stat().st_size / 1024:.0f} kB")

    if BASEMAP.exists():
        mask_w, mask_h, land_fraction = build_land_mask()
        chart["basemap"] = {
            "image": "/basemap.jpg",
            "landmask": "/landmask.png",
            "mask_width": mask_w,
            "mask_height": mask_h,
            "land_fraction": round(land_fraction, 4),
            "source": "Sentinel-2 cloudless 2025, EOX IT Services GmbH",
            "attribution": (
                "Sentinel-2 cloudless by EOX / modified Copernicus Sentinel data 2025 "
                "(CC BY 4.0)"
            ),
            "caveat": (
                "Satellite imagery, not a navigational chart. No depth, no aids to "
                "navigation, and it is an annual composite showing no particular day."
            ),
        }
        print(f"-> {LANDMASK}  {mask_w}x{mask_h}, {land_fraction:.1%} land")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(chart), encoding="utf-8")
    points = sum(len(r) for r in chart["coastline"])
    size_kb = OUTPUT.stat().st_size / 1024
    print(
        f"-> {OUTPUT}  "
        f"{len(chart['coastline'])} polylines, {points} points, {size_kb:.1f} kB\n"
        f"   crossing {chart['crossing_nm']} nm, chart width {chart['chart_width_nm']} nm"
    )


if __name__ == "__main__":
    main()
