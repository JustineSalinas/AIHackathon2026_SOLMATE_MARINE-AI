"""Dataset registry — the single place a data source is declared.

Every entry carries its licence and source URL. `data/download.py` refuses to
fetch anything not declared here. The submission rules require licensed or
public datasets only; making the licence a required field is how that stays
true after the fourth late-night dataset addition.

`docs/DATA.md` is the human-facing version of this file and must be kept in
sync by hand when an entry changes.

Nothing downloaded here is committed to the repository.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Dataset:
    key: str
    name: str
    url: str
    licence: str
    citation: str
    purpose: str
    archive: bool = False
    """True if the download is a zip that must be extracted."""

    caveats: list[str] = field(default_factory=list)
    """Honest limitations. Rendered into docs/DATA.md and expected to appear in
    the pitch deck. A caveat recorded here and nowhere else is a caveat a judge
    finds before you mention it."""


REGISTRY: dict[str, Dataset] = {
    "uci-cbm": Dataset(
        key="uci-cbm",
        name="Condition Based Maintenance of Naval Propulsion Plants",
        url=(
            "https://archive.ics.uci.edu/static/public/316/"
            "condition+based+maintenance+of+naval+propulsion+plants.zip"
        ),
        licence="CC BY 4.0 (UCI Machine Learning Repository)",
        citation=(
            "Coraddu, A., Oneto, L., Ghio, A., Savio, S., Anguita, D., & Figari, M. (2014). "
            "Machine learning approaches for improving condition-based maintenance of naval "
            "propulsion plants. UCI Machine Learning Repository."
        ),
        purpose=(
            "Trains the fuel-consumption model: given lever position, ship speed, shaft "
            "torque and shaft RPM, predict fuel flow."
        ),
        archive=True,
        caveats=[
            "This is a GAS TURBINE frigate propulsion plant, not a diesel engine. It is used "
            "as a documented proxy because it is the only public dataset pairing shaft "
            "torque, RPM, ship speed and ground-truth fuel flow at this resolution.",
            "TRANSFER IS NARROWER THAN IT LOOKS. Only the DIMENSIONLESS WEAR PENALTY is "
            "taken from this dataset -- at the same shaft load, how much more fuel does a worn "
            "engine burn than a healthy one. The part-load curve is NOT transferred: measured "
            "2026-07-22, this turbine burns ~7x its best-point SFC at 10% load where a marine "
            "diesel burns ~1.5x, so borrowing its shape would overstate the savings from "
            "slowing down by roughly five times, in the product's own favour. Healthy burn "
            "comes from a published diesel BSFC curve in services/speed/fuel.py instead. "
            "See docs/DEVIATIONS.md section 2.",
            "STRUCTURE VERIFIED 2026-07-22: 11,934 rows are a complete factorial grid of "
            "9 lever positions x 51 compressor-decay states x 26 turbine-decay states. "
            "There are only 9 distinct ship speeds, and speed is fully determined by lever "
            "position. Ambient inlet temperature (T1) and pressure (P1) are constant and "
            "carry no information.",
            "CONSEQUENCE: this dataset cannot support learning the effect of wind, current, "
            "wave height or passenger load on fuel burn, because none of those variables "
            "vary in it. It supports exactly one thing: the engine's fuel map — shaft torque "
            "and RPM, modulated by degradation state, to fuel flow. Environmental and load "
            "effects are therefore computed by an explicit hull-resistance model rather than "
            "pretended to be learned. See docs/DATA.md.",
            "Simulator-generated, not measured at sea.",
        ],
    ),
    "nasa-cmapss": Dataset(
        key="nasa-cmapss",
        name="NASA C-MAPSS Turbofan Engine Degradation Simulation",
        url=(
            "https://phm-datasets.s3.amazonaws.com/NASA/"
            "6.+Turbofan+Engine+Degradation+Simulation+Data+Set.zip"
        ),
        licence="U.S. Government work, public domain (NASA Open Data)",
        citation=(
            "Saxena, A., Goebel, K., Simon, D., & Eklund, N. (2008). Damage propagation "
            "modeling for aircraft engine run-to-failure simulation. IEEE PHM 2008."
        ),
        purpose=(
            "Pretrains the Phase 1 anomaly detector on run-to-failure degradation patterns "
            "before fine-tuning on vessel engine channels."
        ),
        archive=True,
        caveats=[
            "Turbofan, not marine diesel. Used for the SHAPE of gradual multi-sensor "
            "degradation, not for any component-level claim about a boat engine.",
            "Consumed by services/maintenance/train_rul.py, which demonstrates the RUL "
            "METHOD on held-out turbofan units. It is explicitly not a source of RUL "
            "predictions for a vessel: that output is wired to nothing, and the boat's "
            "component figures come from published design lives in "
            "services/maintenance/lifespan.py instead.",
        ],
    ),
    "open-meteo-weather-archive": Dataset(
        key="open-meteo-weather-archive",
        name="Open-Meteo Historical Weather API (ERA5/ERA5-Land reanalysis)",
        url="https://archive-api.open-meteo.com/v1/archive",
        licence="CC BY 4.0 (Open-Meteo), underlying Copernicus ERA5 reanalysis",
        citation=(
            "Open-Meteo.com Historical Weather API, https://open-meteo.com. Weather data "
            "by Copernicus Climate Change Service, ECMWF."
        ),
        purpose=(
            "Hourly 10 m wind speed and direction, 2024-01-01 through the fetch date, at a "
            "grid of points across the Iloilo Strait operating box. Trains the route "
            "forecaster's wind targets."
        ),
        caveats=[
            "Fetched by services/route/train.py's data pull "
            "(python -m data.fetch_route_forecast), not data/download.py -- the endpoint "
            "takes a (latitude, longitude, start_date, end_date) query per grid point rather "
            "than a single static URL, which the generic single-file fetcher does not model. "
            "Every request this dataset entry covers is templated from this one base URL.",
            "ERA5 is a REANALYSIS, not an observation network -- it is a physics model's best "
            "estimate of the historical atmospheric state, ~9-31 km resolution depending on "
            "variable. It is the closest thing to ground truth publicly available for a "
            "specific strait with no local weather station, and it is what the route "
            "forecaster is honestly trained against.",
        ],
    ),
    "open-meteo-marine-archive": Dataset(
        key="open-meteo-marine-archive",
        name="Open-Meteo Marine Weather API (wave and ocean-current models)",
        url="https://marine-api.open-meteo.com/v1/marine",
        licence="CC BY 4.0 (Open-Meteo), underlying ECMWF WAM / NOAA / Copernicus Marine",
        citation=(
            "Open-Meteo.com Marine Weather API, https://open-meteo.com. Wave and ocean "
            "current data by ECMWF, NOAA NCEP, and Copernicus Marine Service."
        ),
        purpose=(
            "Hourly wave height, wave direction, and ocean current velocity/direction over "
            "the same grid and date range as open-meteo-weather-archive. Trains the route "
            "forecaster's wave and current targets."
        ),
        caveats=[
            "Same templated-fetch note as open-meteo-weather-archive: one base URL, many "
            "(position, date-range) queries, run by data/fetch_route_forecast.py.",
            "Blended model output (WAM wave model, NOAA/Copernicus current reanalysis), not "
            "buoy measurement. The Iloilo Strait is narrow and partly land-sheltered, which "
            "coarse ocean models under-resolve -- expect the current and wave figures to be "
            "smoother than what a boat in the strait actually feels, same caveat a hand-tuned "
            "analytic field would carry.",
            "ocean_current_velocity/ocean_current_direction had ~0.5% missing hours in the "
            "pulled window (120 of 22,560 for the sampled point); dropped at feature-build "
            "time, not imputed.",
        ],
    ),
    # FEMTO / PRONOSTIA is named in the technical profile but is NOT used here.
    # Two reasons, recorded so the omission is a decision rather than an oversight:
    #
    #   1. Its NASA PCoE download key could not be resolved on 2026-07-22. The
    #      data.nasa.gov entry 404s and the phm-datasets S3 bucket denies listing.
    #      We do not cite a source we could not download.
    #
    #   2. More fundamentally, it would not have helped. FEMTO is bench-rig bearing
    #      vibration sampled at 25.6 kHz. Bearing defect signatures live in the
    #      kilohertz band. The retrofit IMU logs at ~1 Hz alongside the other
    #      electro-mechanical channels, which is three to four orders of magnitude
    #      too slow to resolve them. Pretraining on FEMTO and applying it to a 1 Hz
    #      IMU stream would imply a diagnostic capability the sensor cannot deliver.
    #
    # What the IMU is genuinely good for at 1 Hz -- sustained vibration energy
    # trending upward, shock events, changes in mounting rigidity -- is learned
    # from the vessel's own baseline instead. See docs/DEVIATIONS.md.
    "sentinel2-cloudless": Dataset(
        key="sentinel2-cloudless",
        name="Sentinel-2 cloudless (EOX) — Iloilo Strait basemap",
        url=(
            "https://tiles.maps.eox.at/wms?service=WMS&version=1.1.1&request=GetMap"
            "&layers=s2cloudless-2025&bbox=122.46,10.58,122.72,10.78"
            "&width=1400&height=1077&srs=EPSG:4326&format=image/jpeg"
        ),
        licence="CC BY 4.0 (EOX IT Services GmbH; modified Copernicus Sentinel data 2025)",
        citation=(
            "Sentinel-2 cloudless (2025) by EOX IT Services GmbH, https://s2maps.eu. "
            "Contains modified Copernicus Sentinel data 2025. Licensed CC BY 4.0."
        ),
        purpose=(
            "Real satellite basemap for the bridge display, and the source of the "
            "land/water mask the helm view ray-casts to build its horizon."
        ),
        caveats=[
            "10 m ground resolution, cloud-free annual composite. It is imagery, not a "
            "navigational chart: it carries no depth, no aids to navigation, and no "
            "survey date. The depth constraint must come from bathymetry.",
            "A composite, so it shows no particular day. Vessels, wakes and tide state "
            "visible in any single scene are averaged out, which is the correct choice "
            "for a basemap and the wrong one for anything time-sensitive.",
            "ATTRIBUTION IS REQUIRED under CC BY 4.0 and is rendered on the display. "
            "Google/Bing/Esri satellite tiles were considered and REJECTED: their terms "
            "forbid reuse outside their own APIs, and the submission is graded on using "
            "only licensed or public data.",
        ],
    ),
    "openseamap-seamarks": Dataset(
        key="openseamap-seamarks",
        name="OpenSeaMap aids to navigation (OpenStreetMap seamark tags)",
        url="https://overpass-api.de/api/interpreter",
        licence="ODbL 1.0 (OpenStreetMap contributors)",
        citation=(
            "Aids to navigation from OpenSeaMap / OpenStreetMap contributors, "
            "https://www.openseamap.org. Data licensed under the Open Database "
            "License (ODbL) 1.0, https://www.openstreetmap.org/copyright."
        ),
        purpose=(
            "Charted lights, beacons and harbour features inside the Iloilo Strait "
            "chart window. Turns the display's Nautical style from a coastline "
            "outline into a chart that shows the aids a captain actually steers by."
        ),
        caveats=[
            "Fetched by data/build_seamarks.py through the Overpass API, not "
            "data/download.py -- the request is a QUERY over a bounding box rather "
            "than a single static file, which the generic fetcher does not model. "
            "Same shape as the two Open-Meteo entries above.",
            "OpenSeaMap is CROWDSOURCED, not a hydrographic office. It is not a "
            "Notice to Mariners feed and carries no survey guarantee: a light may "
            "have been changed, moved or discontinued since it was last edited. "
            "Several marks in this window cite UK Admiralty notices from 2016. "
            "Correct for showing where the aids are; not a substitute for an "
            "official chart, and the display says 'Not for navigation' on screen.",
            "ATTRIBUTION IS REQUIRED under ODbL and is rendered on the display. "
            "This is the licence-clean answer to the same need Google/Bing/Esri "
            "tiles would have served -- see the sentinel2-cloudless caveats and "
            "docs/DEVIATIONS.md section 10 for why those were rejected.",
            "COVERAGE IS SPARSE AND THAT IS THE HONEST STATE: 10 features in the "
            "0.2 deg x 0.26 deg window as fetched 2026-08-01. Absence of a mark "
            "here is absence of a mapped mark, NOT evidence of clear water.",
        ],
    ),
    "natural-earth-coastline": Dataset(
        key="natural-earth-coastline",
        name="Natural Earth 10m Physical Coastline",
        url="https://naciscdn.org/naturalearth/10m/physical/ne_10m_coastline.zip",
        licence="Public domain (Natural Earth)",
        citation="Natural Earth. Free vector and raster map data, naturalearthdata.com.",
        purpose=(
            "Chart geometry for the bridge display. Rendered as a drawn nautical chart "
            "rather than a tile basemap: no API key, no quota, nothing to fail on stage."
        ),
        archive=True,
    ),
}


def get(key: str) -> Dataset:
    try:
        return REGISTRY[key]
    except KeyError:
        known = ", ".join(sorted(REGISTRY))
        raise KeyError(f"Unknown dataset {key!r}. Declared datasets: {known}") from None
