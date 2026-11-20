"""
A project's mesh: the area the engine builds its hexagons over.

The engine builds the mesh; this module only says which one, through the
variables both runners read (`run_full.sh` and `MCDA/run_mcda.sh` forward
them into the container):

| Source | Id here | What the engine is given |
|---|---|---|
| Colombia from DANE | `dane_colombia` | `MESH_SOURCE=dane_colombia` |
| A Natural Earth country | `natural_earth:<ADM0_A3>` | `MESH_SOURCE=natural_earth`, `MESH_COUNTRY` |
| A geoBoundaries country | `geoboundaries:<ISO3>:<ADM0/1/2>` | `MESH_SOURCE=geoboundaries`, `MESH_COUNTRY`, `MESH_LEVEL` |
| A file someone uploaded | `file:<upload id>` | `MESH_SOURCE=file`, `MESH_PATH`, and optionally `MESH_NAME_FIELD`, `MESH_CODE_FIELD` |

`dane_colombia` is what every run used before meshes could be chosen, and
the engine's default when nothing is set: Colombia from the DANE
municipalities, with the sea out to the exclusive economic zone. It is the
only mesh with a sea. Any other covers its own outline and nothing else, so
the engine refuses the things that only mean something there: the `sea` fill
domain, a `region` fill by department, and the model's `offshore` site.
`has_sea` is what the rest of the app asks before offering any of them.

Uploads are kept in this app's own data folder (`data/meshes/<id>/`), checked
when they arrive, and copied into the project's folder (`<project>/mesh/`)
when a project is created on one, because the engine only sees the project's
folder (mounted at `/data`). `MESH_PATH` is relative to it.
"""

from __future__ import annotations

import filecmp
import json
import math
import os
import re
import shutil
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import BinaryIO

from . import countries, inputs, outputs, store

DANE = "dane_colombia"
NATURAL_EARTH = "natural_earth"
GEOBOUNDARIES = "geoboundaries"
FILE = "file"
SOURCES = (DANE, NATURAL_EARTH, GEOBOUNDARIES, FILE)

GEOBOUNDARIES_LEVELS = ("ADM0", "ADM1", "ADM2")
#: Shown wherever geoBoundaries is offered. Its data is CC BY 4.0, and the
#: engine downloads it the first time a run asks for a country and level.
GEOBOUNDARIES_ATTRIBUTION = "geoBoundaries (CC BY 4.0), www.geoboundaries.org"

#: Inside the project's folder, so the engine sees it at `/data/mesh/`.
PROJECT_MESH_DIRNAME = "mesh"

#: The largest upload accepted, and the most a zip may unpack to. A country's
#: municipalities at full detail are tens of megabytes; this leaves room for
#: that and refuses a file picked by mistake.
MAX_UPLOAD_BYTES = int(os.environ.get("MAPHEX_MESH_MAX_MB", "200")) * 1024 * 1024

#: What can be uploaded. A shapefile is several files, so it comes zipped.
UPLOAD_FORMATS = {
    ".geojson": "GeoJSON",
    ".json": "GeoJSON",
    ".gpkg": "GeoPackage",
    ".parquet": "GeoParquet",
    ".zip": "Shapefile",
}
#: The parts of a shapefile taken out of a zip. Anything else in it is left
#: behind, never written anywhere.
SHAPEFILE_PARTS = (".shp", ".shx", ".dbf", ".prj", ".cpg")
SHAPEFILE_REQUIRED = (".shp", ".shx", ".dbf")

_UPLOAD_ID = re.compile(r"^u-[0-9a-f]{12}$")
_ISO3 = re.compile(r"^[A-Z]{3}$")
_NE_CODE = re.compile(r"^[A-Z0-9]{3}$")

#: Said wherever a sea option is refused, so the reason reads the same everywhere.
NO_SEA = (
    "This project's mesh has no sea: the sea and the land as separate parts "
    "exist only on the Colombia (DANE) mesh. Onshore and offshore need two projects."
)


class MeshError(ValueError):
    """A mesh that cannot be used, said in words for the screen."""


@dataclass(frozen=True)
class MeshSpec:
    """Which mesh, in the terms the engine is given it."""

    source: str
    #: ADM0_A3 for Natural Earth, ISO3 for geoBoundaries.
    country: str = ""
    #: ADM0, ADM1 or ADM2, geoBoundaries only.
    level: str = ""
    #: The upload it came from, for a file.
    upload: str = ""
    #: The file under `<project>/mesh/`, for a file.
    file: str = ""
    name_field: str = ""
    code_field: str = ""

    @property
    def id(self) -> str:
        if self.source == NATURAL_EARTH:
            return f"{NATURAL_EARTH}:{self.country}"
        if self.source == GEOBOUNDARIES:
            return f"{GEOBOUNDARIES}:{self.country}:{self.level}"
        if self.source == FILE:
            return f"{FILE}:{self.upload}"
        return DANE

    @property
    def has_sea(self) -> bool:
        return self.source == DANE


# ── ids ───────────────────────────────────────────────────────────────────


def parse_id(mesh_id: str) -> MeshSpec:
    """
    A mesh id read into its parts. Only the shape is checked here; whether
    the country or the upload exists is `resolve`'s job.
    """
    raw = (mesh_id or "").strip()
    if raw == DANE:
        return MeshSpec(source=DANE)
    source, _, rest = raw.partition(":")
    if source == NATURAL_EARTH:
        code = rest.strip().upper()
        if _NE_CODE.match(code):
            return MeshSpec(source=NATURAL_EARTH, country=code)
    elif source == GEOBOUNDARIES:
        iso, _, level = rest.partition(":")
        iso, level = iso.strip().upper(), level.strip().upper()
        if _ISO3.match(iso) and level in GEOBOUNDARIES_LEVELS:
            return MeshSpec(source=GEOBOUNDARIES, country=iso, level=level)
    elif source == FILE:
        upload = rest.strip()
        if _UPLOAD_ID.match(upload):
            return MeshSpec(source=FILE, upload=upload)
    raise MeshError(
        f"`{raw}` is not a mesh. Use `{DANE}`, `{NATURAL_EARTH}:<code>`, "
        f"`{GEOBOUNDARIES}:<ISO3>:<ADM0|ADM1|ADM2>` or `{FILE}:<upload id>`."
    )


def resolve(mesh_id: str, name_field: str = "", code_field: str = "") -> MeshSpec:
    """
    A mesh id checked against what exists: the country in the engine's list,
    a geoBoundaries country with an ISO code, an upload that arrived. Raises
    MeshError otherwise.
    """
    spec = parse_id(mesh_id)
    if spec.source == NATURAL_EARTH:
        if countries.find(spec.country) is None:
            raise MeshError(f"No country has the Natural Earth code {spec.country}.")
        return spec
    if spec.source == GEOBOUNDARIES:
        if not any(country.iso3 == spec.country for country in countries.list_countries()):
            raise MeshError(
                f"No country has the ISO code {spec.country}, and geoBoundaries is keyed by it."
            )
        return spec
    if spec.source == FILE:
        upload = read_upload(spec.upload)
        if upload is None:
            raise MeshError("That uploaded mesh is gone. Upload the file again.")
        columns = upload.get("columns", [])
        for label, value in (("name", name_field), ("code", code_field)):
            if value and value not in columns:
                raise MeshError(f"The {label} column `{value}` is not in the uploaded file.")
        return MeshSpec(
            source=FILE,
            upload=spec.upload,
            file=str(upload["file"]),
            name_field=name_field,
            code_field=code_field,
        )
    return spec


def label_of(spec: MeshSpec) -> str:
    """How the mesh reads on a project card."""
    if spec.source == DANE:
        return "Colombia (DANE)"
    if spec.source == NATURAL_EARTH:
        country = countries.find(spec.country)
        return f"{country.label if country else spec.country} (Natural Earth)"
    if spec.source == GEOBOUNDARIES:
        country = next(
            (c for c in countries.list_countries() if c.iso3 == spec.country), None
        )
        return f"{country.label if country else spec.country} (geoBoundaries {spec.level})"
    upload = read_upload(spec.upload) if spec.upload else None
    name = str(upload.get("label")) if upload else (spec.file or "Uploaded mesh")
    return f"{name} (uploaded)"


def legacy_id(mesh_id: str) -> str:
    """
    The mesh a project created before meshes reached the engine runs on.

    Those projects stored a slug of a Natural Earth 110m name (`colombia`,
    `dem_rep_congo`) and every one of them ran on the engine's Colombia
    boundaries, whatever it said. So:

    * `colombia` is `dane_colombia`, which is exactly what it has always run
      on, and keeps it running the same way;
    * another slug is that country from Natural Earth, when the 110m file
      still has it (its ADM0_A3 is the 10m code);
    * anything else, including an empty id or the name of a file the old
      mocked upload made up, is `dane_colombia`, which is what it ran on.

    An id already in the current form is returned as it is.
    """
    raw = (mesh_id or "").strip()
    try:
        return parse_id(raw).id
    except MeshError:
        pass
    if raw.lower() == "colombia":
        return DANE
    code = countries.code_for_legacy_slug(raw)
    if code and countries.find(code) is not None:
        return f"{NATURAL_EARTH}:{code}"
    return DANE


def spec_of(project: store.ProjectRow) -> MeshSpec:
    """
    The mesh a project runs on. A row with no `mesh_source` was written before
    meshes reached the engine, and is read through `legacy_id`.
    """
    source = project.mesh_source.strip()
    if not source:
        return parse_id(legacy_id(project.mesh_id))
    if source == FILE:
        try:
            upload = parse_id(project.mesh_id).upload
        except MeshError:
            upload = ""
        return MeshSpec(
            source=FILE,
            upload=upload,
            file=project.mesh_file.strip(),
            name_field=project.mesh_name_field.strip(),
            code_field=project.mesh_code_field.strip(),
        )
    if source in (NATURAL_EARTH, GEOBOUNDARIES):
        return MeshSpec(
            source=source,
            country=project.mesh_country.strip().upper(),
            level=project.mesh_level.strip().upper() if source == GEOBOUNDARIES else "",
        )
    return MeshSpec(source=DANE)


def has_sea(project: store.ProjectRow) -> bool:
    return spec_of(project).has_sea


def store_fields(spec: MeshSpec) -> dict[str, str]:
    """The `projects.csv` columns a mesh is kept in."""
    return {
        "mesh_id": spec.id,
        "mesh_source": spec.source,
        "mesh_country": spec.country,
        "mesh_level": spec.level,
        "mesh_file": spec.file,
        "mesh_name_field": spec.name_field,
        "mesh_code_field": spec.code_field,
    }


# ── what the engine is given ──────────────────────────────────────────────

#: Every variable the engine reads for its mesh. All of them are passed with
#: every run, the unused ones empty: a value in the environment wins over the
#: engine's `.env`, so a mesh left there by hand cannot leak into a run here.
ENV_KEYS = (
    "MESH_SOURCE", "MESH_COUNTRY", "MESH_LEVEL", "MESH_PATH", "MESH_NAME_FIELD", "MESH_CODE_FIELD",
)


def env_of(spec: MeshSpec) -> dict[str, str]:
    env = dict.fromkeys(ENV_KEYS, "")
    env["MESH_SOURCE"] = spec.source
    if spec.source in (NATURAL_EARTH, GEOBOUNDARIES):
        env["MESH_COUNTRY"] = spec.country
    if spec.source == GEOBOUNDARIES:
        env["MESH_LEVEL"] = spec.level
    if spec.source == FILE:
        # Relative, so the engine resolves it against `/data`, the project.
        env["MESH_PATH"] = f"{PROJECT_MESH_DIRNAME}/{spec.file}"
        env["MESH_NAME_FIELD"] = spec.name_field
        env["MESH_CODE_FIELD"] = spec.code_field
    return env


def env_for(project: store.ProjectRow) -> dict[str, str]:
    """The `MESH_*` variables for a run of this project."""
    return env_of(spec_of(project))


# ── the catalog ───────────────────────────────────────────────────────────


def catalog() -> list[dict[str, object]]:
    """
    Every mesh that can be picked: Colombia from DANE first, the recommended
    one for work in Colombia (it is the only one with a sea), then every
    Natural Earth 10m country, alphabetical.

    geoBoundaries is not listed separately: it is a level of detail of a
    country, offered once the country is picked, and only where Natural Earth
    gives the country an ISO code (`geoboundaries` says so per row).
    """
    entries: list[dict[str, object]] = [{
        "id": DANE,
        "label": "Colombia (DANE)",
        "continent": "South America",
        "iso": "COL",
        "search": "Colombia COL CO DANE municipalities South America",
        "source": DANE,
        "country": "COL",
        "geoboundaries": False,
        "recommended": True,
        "hasSea": True,
    }]
    for country in countries.list_countries():
        entries.append({
            "id": f"{NATURAL_EARTH}:{country.code}",
            "label": country.label,
            "continent": country.continent,
            "iso": country.iso3,
            "search": countries.search_terms(country),
            "source": NATURAL_EARTH,
            "country": country.code,
            "geoboundaries": bool(country.iso3),
            "recommended": False,
            "hasSea": False,
        })
    return entries


# ── uploads ───────────────────────────────────────────────────────────────


def upload_root() -> Path:
    """`data/meshes/`, beside the CSVs. Read at call time, so tests can move it."""
    return store.DATA_DIR / "meshes"


def _upload_dir(upload_id: str) -> Path:
    if not _UPLOAD_ID.match(upload_id):
        raise MeshError("Not an upload id.")
    return upload_root() / upload_id


def _remove_upload_dir(folder: Path) -> None:
    """
    Remove a half-made upload. Only ever a folder this module named, directly
    under `upload_root()`, and checked to be so before anything is deleted.
    """
    root = upload_root().resolve()
    target = folder.resolve()
    if target.parent != root or not _UPLOAD_ID.match(target.name):
        return
    shutil.rmtree(target, ignore_errors=True)


def read_upload(upload_id: str) -> dict | None:
    """What was recorded about an upload when it arrived, or None."""
    try:
        meta = _upload_dir(upload_id) / "mesh.json"
        return json.loads(meta.read_text(encoding="utf-8"))
    except (MeshError, OSError, json.JSONDecodeError):
        return None


def _safe_name(original: str) -> str:
    """
    The name an upload is kept under: the last part of what the browser sent
    (a path or a Windows path is cut to its file name), spelled the way the
    engine's lint spells names (lower case, letters, digits and underscores),
    so nothing in it can climb out of the folder it is written to.
    """
    base = PurePosixPath(original.replace("\\", "/")).name
    return inputs.engine_name(base, is_dir=False)


def _label_from(original: str) -> str:
    base = PurePosixPath(original.replace("\\", "/")).name
    stem = base.rsplit(".", 1)[0] if "." in base else base
    stem = re.sub(r"[\x00-\x1f]+", "", stem).strip()
    return (stem or "Uploaded mesh")[:80]


def _copy_limited(source: BinaryIO, target: Path, budget: int) -> int:
    """Copy at most `budget` bytes. Raises MeshError past it. Returns bytes written."""
    written = 0
    with target.open("wb") as out:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > budget:
                raise MeshError(
                    f"The file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
                )
            out.write(chunk)
    return written


def _unzip_shapefile(archive: Path, folder: Path) -> str:
    """
    Take one shapefile out of a zip. Returns the `.shp` name it is kept under.

    Nothing in the zip decides where anything is written: each part is
    written under a name built here, beside the others, in `folder`. A member
    whose name climbs out of the zip (`../`, an absolute path, a drive) or is
    a link is refused outright rather than skipped, because a zip made that
    way was made on purpose.
    """
    try:
        bundle = zipfile.ZipFile(archive)
    except zipfile.BadZipFile as error:
        raise MeshError("The .zip could not be opened.") from error
    with bundle:
        parts: dict[str, zipfile.ZipInfo] = {}
        shapefiles: list[str] = []
        for member in bundle.infolist():
            name = member.filename.replace("\\", "/")
            pieces = PurePosixPath(name).parts
            if name.startswith("/") or ".." in pieces or re.match(r"^[A-Za-z]:", name):
                raise MeshError(f"The zip has a file outside itself ({member.filename}).")
            if (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise MeshError(f"The zip has a link in it ({member.filename}).")
            if member.is_dir() or pieces[-1].startswith((".", "__MACOSX")) or "__MACOSX" in pieces:
                continue
            suffix = PurePosixPath(name).suffix.lower()
            if suffix == ".shp":
                shapefiles.append(name)
            if suffix in SHAPEFILE_PARTS:
                parts[name] = member

        if not shapefiles:
            raise MeshError("The zip has no .shp in it. Zip the .shp with its .shx, .dbf and .prj.")
        if len(shapefiles) > 1:
            raise MeshError(
                f"The zip has {len(shapefiles)} shapefiles in it. A mesh is one: zip only that one."
            )

        shp = shapefiles[0]
        stem = shp[: -len(".shp")]
        wanted = {
            suffix: next((parts[n] for n in parts if n.lower() == (stem + suffix).lower()), None)
            for suffix in SHAPEFILE_PARTS
        }
        missing = [suffix for suffix in SHAPEFILE_REQUIRED if wanted[suffix] is None]
        if missing:
            raise MeshError(
                f"The shapefile in the zip has no {', '.join(missing)} beside it. A shapefile "
                "needs its .shp, .shx and .dbf, and a .prj to say where it is."
            )

        kept = _safe_name(PurePosixPath(shp).name)
        kept_stem = kept[: -len(".shp")]
        budget = MAX_UPLOAD_BYTES
        for suffix, member in wanted.items():
            if member is None:
                continue
            with bundle.open(member) as source:
                budget -= _copy_limited(source, folder / f"{kept_stem}{suffix}", budget)
        return kept


@dataclass
class _Reading:
    features: int
    columns: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _string_columns(frame) -> list[str]:
    import pandas as pd  # noqa: PLC0415 (lazy, with geopandas)

    geometry = frame.geometry.name
    return [
        str(column) for column in frame.columns
        if column != geometry
        and (pd.api.types.is_string_dtype(frame[column]) or frame[column].dtype == object)
    ]


def _guess(columns: list[str], hints: tuple[str, ...]) -> str:
    """The first column whose name has one of the hints in it, for the UI to suggest."""
    for hint in hints:
        for column in columns:
            if column.lower() == hint:
                return column
    for hint in hints:
        for column in columns:
            if hint in column.lower():
                return column
    return ""


def _read_and_check(path: Path, kind: str) -> _Reading:
    """
    Read the kept file the way the engine will and check it can be a mesh:
    readable, with at least one polygon, and a coordinate system.

    A file without a coordinate system is accepted only when every coordinate
    is a longitude and a latitude, and then EPSG:4326 is written into the kept
    copy, so the engine reads the same assumption rather than guessing again.
    """
    import geopandas as gpd  # noqa: PLC0415 (a couple of seconds, only when uploading)

    try:
        if kind == "GeoParquet":
            frame = gpd.read_parquet(path)
        else:
            if kind == "GeoPackage":
                import pyogrio  # noqa: PLC0415

                layers = pyogrio.list_layers(path)
                if len(layers) > 1:
                    names = ", ".join(str(layer[0]) for layer in layers[:5])
                    raise MeshError(
                        f"The GeoPackage has {len(layers)} layers ({names}). A mesh is one "
                        "layer: save that one on its own."
                    )
            frame = gpd.read_file(path)
    except MeshError:
        raise
    except Exception as error:  # noqa: BLE001 (whatever the reader says, it is unreadable)
        reason = str(error).strip().splitlines()[0][:200] if str(error).strip() else type(error).__name__
        raise MeshError(f"The file could not be read as {kind}: {reason}") from error

    if len(frame) == 0:
        raise MeshError("The file has no features in it.")
    types = frame.geometry.geom_type
    polygons = int(types.isin(["Polygon", "MultiPolygon"]).sum())
    if polygons == 0:
        found = ", ".join(sorted({str(t) for t in types.dropna().unique()})) or "no geometry"
        raise MeshError(
            f"The file has no polygons ({found}). A mesh is an area, so it needs "
            "Polygon or MultiPolygon features."
        )

    reading = _Reading(features=polygons, columns=_string_columns(frame))
    others = int(types.notna().sum()) - polygons
    if others:
        reading.notes.append(
            f"{others} feature{'s' if others != 1 else ''} that {'are' if others != 1 else 'is'} "
            "not a polygon will be left out of the mesh."
        )

    if frame.crs is None:
        minx, miny, maxx, maxy = (float(v) for v in frame.total_bounds)
        in_range = all(math.isfinite(v) for v in (minx, miny, maxx, maxy)) and (
            -180 <= minx <= maxx <= 180 and -90 <= miny <= maxy <= 90
        )
        if not in_range:
            raise MeshError(
                "The file has no coordinate system, and its coordinates are not longitudes "
                "and latitudes, so where it is cannot be known. Save it with one (for a "
                "shapefile, include its .prj)."
            )
        _write_wgs84(path, kind, frame)
        reading.notes.append(
            "The file has no coordinate system. Its coordinates are longitudes and "
            "latitudes, so EPSG:4326 (WGS 84) is assumed."
        )
    return reading


def _write_wgs84(path: Path, kind: str, frame) -> None:
    """Record the assumed EPSG:4326 in the kept copy itself."""
    if kind == "Shapefile":
        from pyproj import CRS  # noqa: PLC0415

        path.with_suffix(".prj").write_text(
            CRS.from_epsg(4326).to_wkt(version="WKT1_ESRI"), encoding="utf-8"
        )
        return
    located = frame.set_crs(4326)
    if kind == "GeoParquet":
        located.to_parquet(path)
    elif kind == "GeoPackage":
        located.to_file(path, driver="GPKG")
    else:
        located.to_file(path, driver="GeoJSON")


def save_upload(original_name: str, source: BinaryIO) -> dict:
    """
    Keep an uploaded mesh, check it, and record what it holds. Returns that
    record; raises MeshError, with nothing left behind, when it cannot be one.
    """
    base = PurePosixPath((original_name or "").replace("\\", "/")).name
    suffix = PurePosixPath(base.lower()).suffix
    kind = UPLOAD_FORMATS.get(suffix)
    if kind is None:
        raise MeshError(
            "A mesh can be a GeoJSON (.geojson, .json), a GeoPackage (.gpkg), a GeoParquet "
            "(.parquet) or a shapefile zipped with its parts (.zip)."
        )

    upload_id = f"u-{uuid.uuid4().hex[:12]}"
    folder = _upload_dir(upload_id)
    folder.mkdir(parents=True, exist_ok=False)
    try:
        if kind == "Shapefile":
            archive = folder / "upload.zip"
            _copy_limited(source, archive, MAX_UPLOAD_BYTES)
            kept = _unzip_shapefile(archive, folder)
            archive.unlink()
        else:
            kept = _safe_name(base)
            _copy_limited(source, folder / kept, MAX_UPLOAD_BYTES)

        reading = _read_and_check(folder / kept, kind)
        stem = kept[: -len(".shp")] if kind == "Shapefile" else kept
        files = sorted(
            entry.name for entry in folder.iterdir()
            if entry.is_file() and (entry.name == kept or entry.name.startswith(f"{stem}."))
        )
        record = {
            "id": upload_id,
            "label": _label_from(base),
            "originalName": base[:200],
            "file": kept,
            "files": files,
            "format": kind,
            "featureCount": reading.features,
            "columns": reading.columns,
            "nameField": _guess(reading.columns, ("name", "nombre", "shapename", "nom", "nm")),
            "codeField": _guess(reading.columns, ("code", "codigo", "shapeid", "iso", "cod", "id")),
            "notes": reading.notes,
            "createdAt": store.now(),
        }
        (folder / "mesh.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        return record
    except BaseException:
        _remove_upload_dir(folder)
        raise


def as_mesh(record: dict) -> dict[str, object]:
    """An upload as a catalog row, so the picker can hold it like any other."""
    return {
        "id": f"{FILE}:{record['id']}",
        "label": f"{record['label']} (uploaded)",
        "continent": "",
        "iso": "",
        "search": f"{record['label']} {record.get('originalName', '')}",
        "source": FILE,
        "country": "",
        "geoboundaries": False,
        "recommended": False,
        "hasSea": False,
        "format": record.get("format", ""),
        "featureCount": record.get("featureCount"),
        "columns": record.get("columns", []),
        "nameField": record.get("nameField", ""),
        "codeField": record.get("codeField", ""),
        "notes": record.get("notes", []),
    }


# ── into the project ──────────────────────────────────────────────────────


def materialise(project: store.ProjectRow) -> str:
    """
    Make sure an uploaded mesh is in the project's folder, where the engine
    reads it. Returns "" when it is (or the mesh is not a file), or why not.

    Done when the project is created and again before every run, so a project
    whose folder was set later, or emptied by hand, still gets its copy. A
    file already there under the same name is left alone when it is the
    same, and never overwritten when it is not: it is in someone's folder.
    """
    spec = spec_of(project)
    if spec.source != FILE:
        return ""
    folder = outputs.data_dir(project)
    if folder is None:
        return "An uploaded mesh is copied into the project's folder, and this project has none."
    target = folder / PROJECT_MESH_DIRNAME
    record = read_upload(spec.upload) if spec.upload else None
    if record is None:
        if spec.file and (target / spec.file).is_file():
            return ""
        return (
            f"The project's mesh file ({PROJECT_MESH_DIRNAME}/{spec.file or '?'}) is not in its "
            "folder, and the upload it came from is gone. Create the project again on a new upload."
        )
    source_dir = _upload_dir(spec.upload)
    try:
        target.mkdir(parents=True, exist_ok=True)
        for name in record.get("files", []):
            # Names written by `save_upload`, but read back from a file, so
            # checked again before they are joined to a path.
            if not name or name != _safe_name(name) or name == "mesh.json":
                return f"The upload's record names a file it should not ({name})."
            source_file, target_file = source_dir / name, target / name
            if target_file.exists():
                if filecmp.cmp(source_file, target_file, shallow=False):
                    continue
                return (
                    f"{target_file} already exists and is a different file. Move it out of "
                    "the way and run again."
                )
            shutil.copy2(source_file, target_file)
    except OSError as error:
        return f"The mesh could not be copied into the project's folder: {error}"
    return ""
