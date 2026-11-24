"""
The countries a project can be built on, from Natural Earth.

A project's "mesh" is the area being studied, and a country is the obvious
unit for that. The engine builds the mesh itself: it vendors Natural Earth's
10m admin-0 set (`admin/in/natural_earth/ne_10m_admin_0_countries.parquet`)
and cuts a country out of it when a run is given `MESH_SOURCE=natural_earth`
and `MESH_COUNTRY=<ADM0_A3>`. So the list offered here is read from that same
file: a country the picker shows is a country the engine can find, keyed by
the code the engine is handed.

Only the names are read, never the geometry. The polygons are the engine's
business; here a plain column read through `pyarrow` is all that is needed.

The 110m file vendored in `reference/` is kept for two jobs. It is the
fallback for names when the engine's file is missing (an engine checkout
older than 2026-11-20), so the picker still lists countries; a run on one of
them would then fail in the engine, which says why. (Projects created before
the 10m list existed stored a slug of the 110m `NAME`, `colombia` or
`dem_rep_congo`, but they all ran on Colombia and are read as Colombia (DANE):
see `meshes.legacy_id`.) GeoPandas used to ship that file as
`naturalearth_lowres`, but `geopandas.datasets` was removed in GeoPandas 1.0.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import pipeline

#: The engine's own copy of Natural Earth 10m, relative to its checkout.
ENGINE_COUNTRIES = Path("admin") / "in" / "natural_earth" / "ne_10m_admin_0_countries.parquet"
#: Natural Earth 110m, vendored here. Names only: see the module docstring.
COUNTRIES_GEOJSON = (
    Path(__file__).resolve().parent.parent / "reference" / "ne_110m_admin_0_countries.geojson"
)


@dataclass(frozen=True)
class Country:
    #: ADM0_A3: unique in the 10m set, and what the engine takes as `MESH_COUNTRY`.
    code: str
    #: ISO 3166-1 alpha-3, or "" where Natural Earth has none (France and
    #: Norway among them in 5.1.1). geoBoundaries is keyed by it, so a
    #: country without one cannot be offered at geoBoundaries detail.
    iso3: str
    name: str
    #: The unabbreviated form, "Western Sahara" rather than "W. Sahara".
    label: str
    continent: str


def engine_countries_path() -> Path:
    return pipeline.PIPELINE_DIR / ENGINE_COUNTRIES


def _text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    # Natural Earth writes -99 where a code does not exist, so it must never
    # be treated as an identifier.
    return "" if text in {"-99", "nan", "None", "<NA>"} else text


def _from_engine(path: Path) -> list[Country]:
    """
    The 10m list, read as plain columns.

    `pyarrow` rather than `geopandas.read_parquet`: GeoPandas insists on the
    geometry column, and the polygons are megabytes nobody here needs.
    """
    import pyarrow.parquet as pq  # noqa: PLC0415 (lazy: only when a list is asked for)

    table = pq.read_table(path, columns=["code", "iso_a3", "name", "name_long", "continent"])
    found: list[Country] = []
    for row in table.to_pylist():
        code = _text(row.get("code"))
        name = _text(row.get("name"))
        if not code or not name:
            continue
        found.append(Country(
            code=code,
            iso3=_text(row.get("iso_a3")),
            name=name,
            label=_text(row.get("name_long")) or name,
            continent=_text(row.get("continent")),
        ))
    return found


@lru_cache(maxsize=1)
def _frame_110m() -> Any:
    """
    The vendored 110m countries, read once and kept.

    GeoPandas is imported here rather than at module scope: it pulls in
    pandas, shapely and pyproj, which is a couple of seconds the server
    should not pay on startup when nobody has asked for a country yet.
    """
    import geopandas as gpd  # noqa: PLC0415 (deliberately lazy, see above)

    return gpd.read_file(COUNTRIES_GEOJSON)


def _from_110m() -> list[Country]:
    found: list[Country] = []
    for _, row in _frame_110m().iterrows():
        code = _text(row.get("ADM0_A3"))
        name = _text(row.get("NAME"))
        if not code or not name:
            continue
        found.append(Country(
            code=code,
            iso3=_text(row.get("ISO_A3")),
            name=name,
            label=_text(row.get("NAME_LONG")) or name,
            continent=_text(row.get("CONTINENT")),
        ))
    return found


@lru_cache(maxsize=1)
def _load() -> tuple[tuple[Country, ...], bool]:
    """The countries, alphabetical, and whether they came from the engine's file."""
    path = engine_countries_path()
    from_engine = False
    countries: list[Country] = []
    if path.is_file():
        try:
            countries = _from_engine(path)
            from_engine = bool(countries)
        except Exception:  # noqa: BLE001 (an unreadable file falls back like a missing one)
            countries = []
    if not countries:
        countries = _from_110m()
    countries.sort(key=lambda country: country.label)
    return tuple(countries), from_engine


def list_countries() -> list[Country]:
    """Every country, alphabetical by its long name."""
    return list(_load()[0])


def from_engine_file() -> bool:
    """False when the list is the 110m fallback, so the engine cannot build these."""
    return _load()[1]


def find(code: str) -> Country | None:
    """A country by its ADM0_A3, exactly as the engine keys it."""
    wanted = code.strip().upper()
    return next((country for country in _load()[0] if country.code == wanted), None)


def search_terms(country: Country) -> str:
    """
    One string for the UI to match against, so the filter does not need to
    know which fields exist: the names, both codes and the continent.

    The sovereign's name is deliberately not in it: every dependency carries
    its parent's there, so including it made "United States of America"
    match Puerto Rico. Each row is still findable by what it is called.
    """
    terms = {country.name, country.label, country.code, country.iso3, country.continent}
    return " ".join(sorted(term for term in terms if term))


def reset_cache() -> None:
    """Forget the loaded list, for tests that point the engine elsewhere."""
    _load.cache_clear()
