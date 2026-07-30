"""Great-circle geodesy for route planning.

Every distance, bearing and intermediate point the planner needs, computed on a
spherical earth. A sphere, not an ellipsoid: the routes in this product are
coastal hops of tens of nautical miles, where the sphere-vs-WGS84 error is under
0.3% -- an order of magnitude below the fuel model's own uncertainty, and not
worth the weight of a geodesic library on a serverless function.

Angles are compass degrees (0 = north, 90 = east). Distances are nautical miles,
because that is the unit the rest of the system, the charts, and the captain all
already speak.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

EARTH_RADIUS_NM = 3440.065
"""Mean earth radius in nautical miles (6371.0088 km / 1.852). The nautical mile
was originally one minute of arc, so a great circle spans very nearly 360*60 nm;
this radius reproduces that to the metre."""


@dataclass(frozen=True)
class LatLon:
    """A position. Kept separate from the contract's `Waypoint` so the geometry
    layer has no dependency on pydantic or on the wire shape."""

    lat: float
    lon: float

    def __post_init__(self) -> None:
        if not -90.0 <= self.lat <= 90.0:
            raise ValueError(f"latitude out of range: {self.lat}")
        if not -180.0 <= self.lon <= 180.0:
            raise ValueError(f"longitude out of range: {self.lon}")


def haversine_nm(a: LatLon, b: LatLon) -> float:
    """Great-circle distance between two points, in nautical miles.

    The haversine form is used rather than the simpler spherical law of cosines
    because the latter loses all its precision for the short legs this planner
    densifies a route into -- two points a hundred metres apart round to the same
    cosine, and the distance collapses to zero or NaN. Haversine stays accurate
    down to sub-metre separations.
    """
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat = lat2 - lat1
    dlon = math.radians(b.lon - a.lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2.0 * EARTH_RADIUS_NM * math.asin(min(1.0, math.sqrt(h)))


def initial_bearing_deg(a: LatLon, b: LatLon) -> float:
    """Compass bearing to steer at `a` to reach `b` along the great circle.

    The bearing of a great circle changes continuously along its length, so this
    is the heading at the *start* of the leg. The planner keeps legs short enough
    that the heading is near-constant across each one, which is what lets a single
    heading be handed to the resistance model per leg.
    """
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlon = math.radians(b.lon - a.lon)
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def destination(origin: LatLon, bearing_deg: float, distance_nm: float) -> LatLon:
    """The point `distance_nm` from `origin` along `bearing_deg`.

    Used to build the laterally-offset candidate routes: take the direct track's
    midpoint and step off it at a right angle. Solving that on the sphere rather
    than by nudging raw degrees keeps a 2-nm offset the same size at every
    latitude, which naive `lat += x` does not.
    """
    ang = distance_nm / EARTH_RADIUS_NM
    brg = math.radians(bearing_deg)
    lat1, lon1 = math.radians(origin.lat), math.radians(origin.lon)

    lat2 = math.asin(
        math.sin(lat1) * math.cos(ang) + math.cos(lat1) * math.sin(ang) * math.cos(brg)
    )
    lon2 = lon1 + math.atan2(
        math.sin(brg) * math.sin(ang) * math.cos(lat1),
        math.cos(ang) - math.sin(lat1) * math.sin(lat2),
    )
    # Normalise longitude back into [-180, 180].
    lon2 = (math.degrees(lon2) + 540.0) % 360.0 - 180.0
    return LatLon(math.degrees(lat2), lon2)


def midpoint(a: LatLon, b: LatLon) -> LatLon:
    """Great-circle midpoint of a leg. The pivot for lateral offsets."""
    lat1, lon1 = math.radians(a.lat), math.radians(a.lon)
    lat2 = math.radians(b.lat)
    dlon = math.radians(b.lon - a.lon)

    bx = math.cos(lat2) * math.cos(dlon)
    by = math.cos(lat2) * math.sin(dlon)
    lat3 = math.atan2(
        math.sin(lat1) + math.sin(lat2),
        math.sqrt((math.cos(lat1) + bx) ** 2 + by**2),
    )
    lon3 = lon1 + math.atan2(by, math.cos(lat1) + bx)
    return LatLon(math.degrees(lat3), (math.degrees(lon3) + 540.0) % 360.0 - 180.0)


def densify(points: list[LatLon], *, max_leg_nm: float = 2.0) -> list[LatLon]:
    """Insert intermediate points so no leg is longer than `max_leg_nm`.

    The planner samples the weather field and the seabed at every vertex, and it
    hands one heading and one sea state to the fuel model per leg. Both of those
    are only fair approximations if the leg is short. Densifying to ~2 nm keeps
    the per-leg constant-conditions assumption honest without inflating the point
    count into the thousands.

    Interpolation is linear in lat/lon rather than along the great circle. Over a
    2-nm segment the two are indistinguishable, and the linear form cannot fail on
    a leg of zero length the way the spherical interpolation's `sin(0)` divisor
    can.
    """
    if max_leg_nm <= 0:
        raise ValueError("max_leg_nm must be positive")
    if len(points) < 2:
        return list(points)

    out: list[LatLon] = [points[0]]
    for a, b in zip(points, points[1:], strict=False):
        leg = haversine_nm(a, b)
        n = max(1, math.ceil(leg / max_leg_nm))
        for i in range(1, n + 1):
            t = i / n
            out.append(LatLon(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t))
    return out


def path_length_nm(points: list[LatLon]) -> float:
    """Total great-circle length of a polyline in nautical miles."""
    return sum(haversine_nm(a, b) for a, b in zip(points, points[1:], strict=False))
