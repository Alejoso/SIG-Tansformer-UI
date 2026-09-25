"""
Country outlines, from Natural Earth via GeoPandas.

A project's "mesh" is the area being studied, and a country is the obvious
unit for that. GeoPandas used to ship this as `naturalearth_lowres`, but
`geopandas.datasets` was removed in GeoPandas 1.0 — it now points you at
naturalearthdata.com — so the 110m admin-0 file is vendored in `reference/`
instead. That also keeps the app working offline, which a local tool should.

Only names are served today. The geometry is loaded all the same, because the
next step is handing a country's polygon to h3 to build the mesh, and
`geometry_for` is already the function that does it.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Any

COUNTRIES_GEOJSON = Path(__file__).resolve().parent.parent / "reference" / "ne_110m_admin_0_countries.geojson"


@lru_cache(maxsize=1)
def _frame() -> Any:
    """
    The Natural Earth countries, read once and kept.

    GeoPandas is imported here rather than at module scope: it pulls in pandas,
    shapely and pyproj, which is a couple of seconds the server should not pay
    on startup when nobody has asked for a country yet.
    """
    import geopandas as gpd  # noqa: PLC0415 — deliberately lazy, see above

    return gpd.read_file(COUNTRIES_GEOJSON)


def _slug(name: str) -> str:
    """`Dem. Rep. Congo` → `dem_rep_congo`. Names are unique in this dataset."""
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def _text(row: Any, column: str) -> str:
    value = row.get(column)
    if value is None:
        return ""
    text = str(value).strip()
    # Natural Earth writes -99 where a code does not exist — Norway and France
    # among them — so it must never be treated as an identifier.
    return "" if text in {"-99", "nan", "None"} else text


@lru_cache(maxsize=1)
def list_countries() -> list[dict[str, str]]:
    """
    Every country, alphabetical.

    `id` is a slug of NAME because NAME is unique here and ISO_A3 is not
    always present. `label` is NAME_LONG, which is the unabbreviated form —
    "Western Sahara" rather than "W. Sahara" — and the shorter NAME and the
    ISO codes ride along as search terms so any of them finds the row.
    """
    frame = _frame()
    countries: list[dict[str, str]] = []

    for _, row in frame.iterrows():
        name = _text(row, "NAME")
        if not name:
            continue

        long_name = _text(row, "NAME_LONG") or name
        # The row's own names and codes only. SOVEREIGNT is deliberately left
        # out: every dependency carries its parent's name there, so including
        # it made "United States of America" match Puerto Rico. Each row is
        # still findable by what it is actually called.
        aliases = {name, long_name, _text(row, "ADMIN"),
                   _text(row, "ISO_A2"), _text(row, "ISO_A3")}

        countries.append(
            {
                "id": _slug(name),
                "label": long_name,
                "continent": _text(row, "CONTINENT"),
                "iso": _text(row, "ISO_A3"),
                # One string for the UI to match against, so the filter does
                # not need to know which fields exist.
                "search": " ".join(sorted(a for a in aliases if a)),
            }
        )

    countries.sort(key=lambda c: c["label"])
    return countries


def geometry_for(country_id: str) -> Any | None:
    """
    The country's polygon, ready to hand to h3 for mesh generation.

    Nothing calls this yet — it is the seam the H3 step plugs into.
    """
    frame = _frame()
    for _, row in frame.iterrows():
        if _slug(_text(row, "NAME")) == country_id:
            return row.geometry
    return None
