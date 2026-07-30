"""How deep the water is under a candidate track.

A route that saves fuel by cutting the corner is worthless if the corner has two
metres of water over it. Depth is a hard constraint, checked at every densified
vertex, and a track that grounds the vessel is rejected outright rather than
costed and compared -- there is no litre saving that trades against a hull.

In production the depths come from a GEBCO bathymetry grid (see
docs/DEVIATIONS.md: GEBCO rather than onboard sonar, which a retrofit does not
have). This module defines the sampler seam and an analytic default that shoals
toward a coastline, so the planner has a real depth constraint to respect
offline and in tests.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from services.route.geo import LatLon, haversine_nm


@runtime_checkable
class Bathymetry(Protocol):
    """Position in, charted depth in metres out. Positive is water depth."""

    def depth_m(self, position: LatLon) -> float: ...


@dataclass(frozen=True)
class Shoal:
    """A charted shallow -- a reef or bank the planner must route around."""

    centre: LatLon
    radius_nm: float
    min_depth_m: float
    """Depth at the centre of the shoal. Rises back to open-water depth at the
    radius."""


@dataclass
class AnalyticBathymetry:
    """Deep offshore water, shoaling smoothly toward a coastline and over shoals.

    The default field: open water is `offshore_depth_m`, the seabed rises to the
    south (toward a modelled coast at `coast_lat`), and any `shoals` punch a
    smooth shallow into it. Deterministic, so a route's depth-feasibility is a
    fact a test can pin down.
    """

    offshore_depth_m: float = 60.0
    coast_lat: float = 10.55
    """Latitude of the modelled shoreline; depth falls to zero here."""
    coast_scale_deg: float = 0.30
    """Over how many degrees of latitude the water deepens away from the coast."""
    shoals: list[Shoal] = field(default_factory=list)

    def depth_m(self, position: LatLon) -> float:
        # Coastal shoaling: shallow at the coast, asymptotically offshore_depth_m
        # well out to sea.
        north_of_coast = max(0.0, position.lat - self.coast_lat)
        coastal = self.offshore_depth_m * (1.0 - math.exp(-north_of_coast / self.coast_scale_deg))

        depth = coastal
        for shoal in self.shoals:
            dist_nm = haversine_nm(position, shoal.centre)
            if dist_nm < shoal.radius_nm:
                # Smooth cosine dip to the shoal's minimum at its centre.
                t = 0.5 * (1.0 + math.cos(math.pi * dist_nm / shoal.radius_nm))
                depth = min(depth, depth + (shoal.min_depth_m - depth) * t)
        return max(0.0, depth)
