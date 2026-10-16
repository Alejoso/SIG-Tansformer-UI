"""
The engine's input tree.

The pipeline does not take a list of folders. It walks `<DATA_DIR>/in` and
reads each dataset's dimension and code straight out of the path:

    in/<dimension>/<CODE>/<one data file>
    in/09_regulatorio/REG_001/pct_exito_mw_onshore.csv

`ingest_to_geoparquet` mirrors that structure into `out/`, and everything
downstream — the master table, the MCDA, the layer sidebar — identifies a
variable by it. So a folder the user picked somewhere else on disk is not
input to anything until its contents are in that tree under a dimension and a
code. This module is what puts them there.

Copied, never moved: the folder the user chose is their own, and a tool that
relocates someone's data because they pointed at it is not one you trust
twice. The copy also means the project keeps working after the source is
unplugged, renamed or cleaned up.
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from . import fsutil, outputs, store

#: What `ingest_to_geoparquet` and `raster_to_h3` know how to read, taken from
#: their own format tables. A folder whose only file is something else has
#: nothing the pipeline can use, which is worth saying before a run rather
#: than after one silently skips it.
VECTOR_SUFFIXES = {".shp", ".geojson", ".json", ".gpkg", ".topojson", ".tab", ".gdb"}
RASTER_SUFFIXES = {".tif", ".tiff"}
TABULAR_SUFFIXES = {".csv", ".xlsx", ".xls"}
DATASET_SUFFIXES = VECTOR_SUFFIXES | RASTER_SUFFIXES | TABULAR_SUFFIXES

#: A shapefile is one dataset spread across several files, and it is unusable
#: without them — a `.shp` with no `.dbf` has geometry and no attributes, and
#: with no `.prj` the pipeline cannot know its projection. They travel
#: together, matched on the stem.
SHAPEFILE_COMPANIONS = {
    ".dbf", ".shx", ".prj", ".cpg", ".qpj", ".sbn", ".sbx", ".idx", ".qmd", ".xml",
}

#: Three letters and three digits, as `shared.DIM_CODE_RE` in the engine has
#: it. The engine uppercases the code in folder names, so we store it that way.
CODE_PATTERN = re.compile(r"^[A-Za-z]{3}_[0-9]{3}$")

#: A dimension is a folder name, so it has to be one — no separators, no
#: walking upwards, nothing hidden.
DIMENSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


@dataclass
class InputVariable:
    """One variable sitting in the engine's input tree, ready to process."""

    #: `<dimension>/<CODE>`, which is also where it lives.
    id: str
    dimension: str
    code: str
    #: The dataset itself. Companion files are counted, not named.
    filename: str
    #: GPKG, CSV, SHP… as the engine labels formats.
    format: str
    sizeBytes: int
    fileCount: int
    #: Where it was copied from, when we know. Empty for data put there by
    #: hand or by an earlier tool — the tree is the truth, not our record of
    #: it, so anything found there is listed whether we put it there or not.
    source: str = ""
    #: True when the source folder is no longer where it was. Informational:
    #: the data is already in the tree, so nothing is broken by it.
    sourceMissing: bool = False
    #: Set when the folder does not hold exactly one readable dataset.
    problem: str = ""


@dataclass
class ImportPlan:
    """What adding a folder would do, worked out before doing any of it."""

    source: str
    #: The dataset found, and its companions.
    filename: str = ""
    format: str = ""
    sizeBytes: int = 0
    files: list[str] = field(default_factory=list)
    #: Suggested destination, which the user can change.
    dimension: str = ""
    code: str = ""
    problem: str = ""


def data_in(project: store.ProjectRow) -> Path | None:
    """The project's input tree."""
    root = outputs.data_dir(project)
    return None if root is None else root / "in"


def _format_of(path: Path) -> str:
    suffix = path.suffix.lower()
    return {
        ".shp": "SHP", ".geojson": "GEOJSON", ".json": "GEOJSON", ".gpkg": "GPKG",
        ".topojson": "TOPOJSON", ".tab": "TAB", ".gdb": "GDB", ".tif": "GEOTIFF",
        ".tiff": "GEOTIFF", ".csv": "CSV", ".xlsx": "EXCEL", ".xls": "EXCEL",
    }.get(suffix, suffix.lstrip(".").upper())


def _datasets_in(folder: Path) -> list[Path]:
    """
    The data files in a folder, companions excluded.

    Only the top level: the engine reads one dataset per code folder, so
    anything nested is a different arrangement than the one it expects and is
    better reported than silently flattened.
    """
    try:
        entries = sorted(folder.iterdir())
    except OSError:
        return []

    found = [
        entry for entry in entries
        if entry.is_file() and entry.suffix.lower() in DATASET_SUFFIXES
    ]
    # A .gdb is a directory, not a file.
    found += [entry for entry in entries if entry.is_dir() and entry.suffix.lower() == ".gdb"]

    # `x.shp` and `x.json` in one folder is one dataset plus a sidecar, not
    # two datasets: some exports write a `.json` of metadata beside the shape.
    shapefile_stems = {entry.stem for entry in found if entry.suffix.lower() == ".shp"}
    return [
        entry for entry in found
        if entry.suffix.lower() == ".shp" or entry.stem not in shapefile_stems
    ]


def _companions(dataset: Path) -> list[Path]:
    """The files that belong with a dataset and must travel with it."""
    if dataset.suffix.lower() != ".shp":
        return []
    return sorted(
        sibling
        for sibling in dataset.parent.iterdir()
        if sibling.is_file()
        and sibling != dataset
        and sibling.stem == dataset.stem
        and sibling.suffix.lower() in SHAPEFILE_COMPANIONS
    )


def _measure(paths: list[Path]) -> int:
    total = 0
    for path in paths:
        try:
            total += path.stat().st_size if path.is_file() else fsutil.measure(path)[1]
        except OSError:
            pass
    return total


# ── reading the tree ──────────────────────────────────────────────────────


def scan(project: store.ProjectRow) -> list[InputVariable]:
    """
    Every variable in the input tree, as the pipeline will see it.

    Listed from disk rather than from our own records, because the pipeline
    reads disk. Data dropped in by hand shows up here too, which is the point:
    the screen should show what will actually be processed.
    """
    root = data_in(project)
    if root is None or not root.is_dir():
        return []

    sources = {row.name: row for row in store.folders_of(project.id)}
    found: list[InputVariable] = []

    for dimension_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        for code_dir in sorted(p for p in dimension_dir.iterdir() if p.is_dir()):
            identifier = f"{dimension_dir.name}/{code_dir.name}"
            datasets = _datasets_in(code_dir)

            problem = ""
            if not datasets:
                problem = "No file here the pipeline can read"
            elif len(datasets) > 1:
                problem = (
                    f"{len(datasets)} datasets in one folder — the pipeline expects one, "
                    "and names the variable after it"
                )

            dataset = datasets[0] if datasets else None
            row = sources.get(identifier)
            try:
                file_count = sum(1 for entry in code_dir.iterdir() if entry.is_file())
            except OSError:
                file_count = 0

            found.append(
                InputVariable(
                    id=identifier,
                    dimension=dimension_dir.name,
                    code=code_dir.name,
                    filename=dataset.name if dataset else "",
                    format=_format_of(dataset) if dataset else "",
                    sizeBytes=_measure([dataset]) if dataset else 0,
                    fileCount=file_count,
                    source=row.path if row else "",
                    sourceMissing=bool(row) and not Path(row.path).is_dir(),
                    problem=problem,
                )
            )
    return found


def dimensions(project: store.ProjectRow) -> list[str]:
    """The dimension folders that already exist, for offering rather than typing."""
    root = data_in(project)
    if root is None or not root.is_dir():
        return []
    return sorted(p.name for p in root.iterdir() if p.is_dir())


def suggest_code(project: store.ProjectRow, dimension: str) -> str:
    """
    The next free code in a dimension.

    The three-letter prefix comes from the codes already there — `REG` for
    `09_regulatorio`, `SOE` for `10_socioeconomico`. It cannot be derived
    from the dimension name (`socioeconomico` would give `SOC`), so an empty
    dimension gets a guess from its letters that the user is expected to
    correct.
    """
    existing = [
        variable.code for variable in scan(project)
        if variable.dimension == dimension and CODE_PATTERN.match(variable.code)
    ]
    if existing:
        prefix = existing[0][:3].upper()
        used = {int(code[4:]) for code in existing if code[:3].upper() == prefix}
    else:
        letters = re.sub(r"[^A-Za-z]", "", dimension)[:3].upper()
        prefix, used = (letters or "VAR").ljust(3, "X"), set()

    number = next(n for n in range(1, 1000) if n not in used)
    return f"{prefix}_{number:03d}"


# ── adding to it ──────────────────────────────────────────────────────────


def plan(project: store.ProjectRow, raw_source: str, dimension: str = "") -> ImportPlan:
    """
    What importing a folder would copy, and where.

    Worked out and shown before anything is written. Copying into the
    pipeline's tree is the one thing on this screen that changes somebody
    else's directory, so it should never be a surprise.
    """
    source = fsutil.expand(raw_source)
    result = ImportPlan(source=str(source))

    if not raw_source.strip():
        result.problem = "Enter a folder path"
        return result
    if not source.exists():
        result.problem = "No such folder"
        return result
    if not source.is_dir():
        result.problem = "That is a file, not a folder"
        return result
    if not os.access(source, os.R_OK):
        result.problem = "That folder is not readable"
        return result

    datasets = _datasets_in(source)
    if not datasets:
        readable = ", ".join(sorted(s.lstrip(".") for s in DATASET_SUFFIXES))
        result.problem = f"Nothing here the pipeline can read. It takes: {readable}"
        return result
    if len(datasets) > 1:
        names = ", ".join(d.name for d in datasets[:4])
        result.problem = (
            f"{len(datasets)} datasets here ({names}…). The pipeline takes one per "
            "variable and names the variable after it — add them one folder at a time"
        )
        return result

    dataset = datasets[0]
    companions = _companions(dataset)

    chosen = dimension or (dimensions(project) or [""])[0]
    result.filename = dataset.name
    result.format = _format_of(dataset)
    result.files = [dataset.name] + [c.name for c in companions]
    result.sizeBytes = _measure([dataset, *companions])
    result.dimension = chosen
    result.code = suggest_code(project, chosen) if chosen else ""
    return result


def _destination(project: store.ProjectRow, dimension: str, code: str) -> Path:
    """
    Where a variable goes, checked.

    The dimension and code arrive from the browser, and they are used to build
    a path — so they are matched against a pattern that cannot express `..` or
    a separator, and the result is confirmed to sit inside the tree before
    anything is written to it.
    """
    root = data_in(project)
    if root is None:
        raise ValueError("This project has no folder set.")
    if not DIMENSION_PATTERN.match(dimension):
        raise ValueError(
            "A dimension is a folder name: letters, digits, dashes and underscores."
        )
    if not CODE_PATTERN.match(code):
        raise ValueError(
            "A code is three letters and three digits, like REG_007 — the engine "
            "reads the variable's identity out of it."
        )

    target = (root / dimension / code.upper()).resolve()
    if root.resolve() not in target.parents:
        raise ValueError("That is not a place inside this project's input folder.")
    return target


def import_folder(
    project: store.ProjectRow, raw_source: str, dimension: str, code: str
) -> InputVariable:
    """
    Copy a folder's dataset into the input tree as one variable.

    Copies into a temporary folder beside the destination and renames it into
    place, so an interrupted copy cannot leave the pipeline a half-written
    variable to find on its next run.
    """
    prepared = plan(project, raw_source, dimension)
    if prepared.problem:
        raise ValueError(prepared.problem)

    target = _destination(project, dimension, code)
    if target.exists() and any(target.iterdir()):
        raise ValueError(
            f"{dimension}/{code.upper()} already has data. Remove it first, or use another code."
        )

    source = fsutil.expand(raw_source)
    dataset = _datasets_in(source)[0]
    wanted = [dataset, *_companions(dataset)]

    staging = target.with_name(f".{target.name}.incoming")
    shutil.rmtree(staging, ignore_errors=True)
    try:
        staging.mkdir(parents=True)
        for item in wanted:
            if item.is_dir():  # a .gdb
                shutil.copytree(item, staging / item.name)
            else:
                shutil.copy2(item, staging / item.name)
        if target.exists():
            target.rmdir()  # empty, checked above
        staging.rename(target)
    except OSError as error:
        shutil.rmtree(staging, ignore_errors=True)
        raise ValueError(f"Could not copy into the project: {error}") from error

    # Remember where it came from, so the screen can say so later.
    identifier = f"{dimension}/{code.upper()}"
    rows = [row for row in store.folders_of(project.id) if row.name != identifier]
    rows.append(
        store.FolderRow(
            project_id=project.id,
            folder_id=store.new_id("f"),
            name=identifier,
            path=str(source),
            added_at=store.now(),
        )
    )
    store.replace_folders(project.id, rows)

    return next(v for v in scan(project) if v.id == identifier)


def remove(project: store.ProjectRow, dimension: str, code: str) -> None:
    """
    Take a variable out of the input tree.

    Deletes the copy in the project, never the folder it came from. What the
    pipeline already produced from it in `out/` is left alone: that is a
    result, and removing an input is not a statement about results.
    """
    target = _destination(project, dimension, code)
    if not target.is_dir():
        raise ValueError(f"No {dimension}/{code.upper()} in this project.")
    shutil.rmtree(target)

    identifier = f"{dimension}/{code.upper()}"
    rows = [row for row in store.folders_of(project.id) if row.name != identifier]
    store.replace_folders(project.id, rows)
