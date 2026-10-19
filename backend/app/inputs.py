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
import unicodedata
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from . import engine_state, fsutil, outputs, pipeline, store

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


def prepare(project: store.ProjectRow) -> None:
    """
    Make sure the project's input folder exists, owned by whoever runs this.

    Best effort, and worth doing early. `data/` is not in the engine's
    repository, so on a fresh checkout the first `docker compose up -d` is
    what creates it — and Docker creates a missing bind-mount source as root,
    after which nothing here can write to it. Creating it first means Docker
    mounts what is already there and the question never comes up.
    """
    root = data_in(project)
    if root is None or root.is_dir():
        return
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        # The folder may be unreachable or not ours to create; that is the
        # import's problem to report, with a message about this exact thing.
        pass


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


def _strip_accents(text: str) -> str:
    """
    `técnico` -> `tecnico`, the way the engine does it.

    NFD splits an accented letter into the letter plus a combining mark, and
    the marks (category Mn) are dropped. Without this an accent becomes an
    underscore and `técnico` sanitises to `t_cnico`.
    """
    return "".join(
        char for char in unicodedata.normalize("NFD", text)
        if unicodedata.category(char) != "Mn"
    )


def normalise_dimension(name: str) -> str:
    """
    A dimension name as the engine will end up storing it.

    The pipeline's `lint_filenames` sanitises folder names under `data/in`:
    lowercased, anything but a letter or digit turned into an underscore, and
    then `format_code` puts a leading `abc_123` back into capitals. So a
    folder typed as `10-Socioeconomico` is renamed to `10_socioeconomico` on
    the first run, and one typed `soe-001` comes back as `SOE_001` — either
    way every variable under it changes id. Normalising here means what the
    screen shows is what the engine will end up with.
    """
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", _strip_accents(name).strip()).strip("_").lower()
    # The engine's `format_code`, which applies to folders only.
    return re.sub(r"^[a-z]{3}_[0-9]{3}(?=_|$)", lambda m: m.group(0).upper(), cleaned)


def normalise_code(raw: str) -> str:
    """
    A code in the engine's own shape: three letters, underscore, three digits.

    Typed codes copy the file they came from, and files are named `SOE-001`
    as often as `SOE_001`. The engine's `DIM_CODE_RE` only recognises the
    underscore form, and a code it does not recognise stops being a code —
    it becomes part of the name and the variable loses its identity. So a
    hyphen is corrected rather than rejected.
    """
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", _strip_accents(raw).strip()).strip("_").upper()
    # `SOE001` is unambiguous too, and is what you get from a tidy filename.
    match = re.fullmatch(r"([A-Za-z]{3})_?([0-9]{1,3})", cleaned)
    if match:
        return f"{match.group(1).upper()}_{int(match.group(2)):03d}"
    return cleaned


def _code_from_filename(filename: str) -> str:
    """
    The code a file names itself after, if it does.

    `SOE-001.gpkg` is a variable announcing its own code, which is a better
    suggestion than the next free number — and it is how these files arrive.
    """
    stem = filename.split(".")[0]
    candidate = normalise_code(stem)
    return candidate if CODE_PATTERN.match(candidate) else ""


def suggest_dimension(project: store.ProjectRow, source: Path) -> str:
    """
    Which dimension a folder probably belongs to.

    The folder is usually named after it — `10-Socioeconomico` holding
    `SOE-001.gpkg`. Only offered when the project has no dimensions yet;
    once there are some, the first is the better default because variables
    arrive in batches.
    """
    existing = dimensions(project)
    if existing:
        return existing[0]
    guess = normalise_dimension(source.name)
    # A folder called `data` or `downloads` says nothing; one that looks like
    # a dimension usually has a number or several words.
    return guess if len(guess) > 3 else ""


def suggest_code(project: store.ProjectRow, dimension: str, filename: str = "") -> str:
    """
    The code to offer for a new variable.

    Three sources, in order of how much they know: the file's own name, the
    codes already in the dimension, and failing both, the dimension's
    letters. The prefix cannot be derived from the dimension name in general
    — `socioeconomico` would give `SOC`, not `SOE` — so the existing codes
    are what settle it.
    """
    existing = [
        variable.code for variable in scan(project)
        if variable.dimension == dimension and CODE_PATTERN.match(variable.code)
    ]
    taken = set(existing)

    from_file = _code_from_filename(filename) if filename else ""
    if from_file and from_file not in taken:
        return from_file

    if existing:
        prefix = existing[0][:3].upper()
        used = {int(code[4:]) for code in existing if code[:3].upper() == prefix}
    elif from_file:
        # The filename gave a code, but it is taken — keep its prefix and
        # move to the next free number under it.
        prefix, used = from_file[:3], {int(from_file[4:])}
    else:
        letters = re.sub(r"[^A-Za-z]", "", dimension)[:3].upper()
        prefix, used = (letters or "VAR").ljust(3, "X"), set()

    used |= {int(code[4:]) for code in taken if code[:3].upper() == prefix}
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

    # With no dimension chosen yet, the folder's own name is the best guess —
    # these arrive as `10-Socioeconomico/SOE-001.gpkg`, which says both.
    chosen = normalise_dimension(dimension) if dimension else suggest_dimension(project, source)

    result.filename = dataset.name
    result.format = _format_of(dataset)
    result.files = [dataset.name] + [c.name for c in companions]
    result.sizeBytes = _measure([dataset, *companions])
    result.dimension = chosen
    result.code = suggest_code(project, chosen, dataset.name)
    return result


def _first_existing(path: Path) -> Path | None:
    """The nearest folder up the chain that exists, which is the one we need to write in."""
    for candidate in [path, *path.parents]:
        if candidate.is_dir():
            return candidate
    return None


def _explain_permission(path: Path) -> str:
    """
    Why a folder in the project cannot be written to, and how to fix it.

    Two different causes, and the wrong explanation sends people looking in
    the wrong place for an hour — so the owner is checked rather than
    assumed. `[Errno 13] Permission denied` on its own has people blaming
    WSL, Windows paths and the app, when it is usually neither.
    """
    try:
        owner = path.owner()
    except (KeyError, OSError):
        owner = ""

    try:
        ours = os.getuid() == path.stat().st_uid
    except OSError:
        ours = False

    # Walk up past the pipeline's own subfolders: `chown` belongs on the
    # data directory, not on `in/` alone.
    root = path
    while root.parent != root and root.name in ("in", "out"):
        root = root.parent

    fix = f"    sudo chown -R $(id -un):$(id -gn) {root}"

    if ours:
        # Ours, but with the write bit off. Nothing to do with Docker.
        return (
            f"Cannot write to {path}. It belongs to you, so this is its permissions "
            f"rather than its owner — something has it read-only. `chmod u+w` on it, "
            f"or check whether it is on a read-only mount."
        )

    whose = f"belongs to {owner}" if owner else "belongs to another user"
    return (
        f"Cannot write to {path} — it {whose}. That usually means Docker created it: "
        f"the engine's `data/` folder is not in its repository, so the first "
        f"`docker compose up -d` is what makes it, and the daemon runs as root. "
        f"Give it back with:\n\n{fix}\n\n"
        f"The engine keeps working afterwards — inside the container it runs as root "
        f"and can write either way."
    )


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

    # Corrected rather than rejected where the intent is clear: `SOE-001` is
    # the code the file is named after, and `10-Socioeconomico` is what the
    # engine's own lint would turn into `10_socioeconomico` on the first run
    # anyway. Normalising here means the path never changes under the user.
    folder = normalise_dimension(dimension)
    identifier = normalise_code(code)

    if not folder or not DIMENSION_PATTERN.match(folder):
        raise ValueError(
            "A dimension is a folder name — letters, digits and underscores, "
            "like 10_socioeconomico."
        )
    if not CODE_PATTERN.match(identifier):
        raise ValueError(
            f"{code!r} is not a code the engine can read. It wants three letters "
            "and three digits, like SOE_001 — it reads the variable's identity "
            "out of that."
        )

    target = (root / folder / identifier).resolve()
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
    identifier = f"{target.parent.name}/{target.name}"
    if target.exists() and any(target.iterdir()):
        raise ValueError(
            f"{identifier} already has data. Remove it first, or use another code."
        )

    # Checked up front rather than discovered mid-copy: the useful answer is
    # about ownership, and it is the same answer whether the dimension folder
    # exists yet or not.
    writable = target.parent if target.parent.is_dir() else _first_existing(target.parent)
    if writable is not None and not os.access(writable, os.W_OK | os.X_OK):
        raise ValueError(_explain_permission(writable))

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
    except PermissionError as error:
        shutil.rmtree(staging, ignore_errors=True)
        raise ValueError(_explain_permission(Path(error.filename or staging).parent)) from error
    except OSError as error:
        shutil.rmtree(staging, ignore_errors=True)
        raise ValueError(f"Could not copy into the project: {error}") from error

    # Remember where it came from, so the screen can say so later.
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


@dataclass
class Removal:
    """What removing a variable took away."""

    id: str
    inputFiles: int
    outputFiles: int


def _count_files(folder: Path) -> int:
    try:
        return sum(1 for entry in folder.rglob("*") if entry.is_file())
    except OSError:
        return 0


def _owner_of(path: Path) -> str:
    try:
        return path.owner()
    except (KeyError, OSError):
        return "another user"


def _removable(folder: Path) -> bool:
    """Whether this process can delete a folder — which is the parent's business."""
    parent = folder.parent
    return parent.is_dir() and os.access(parent, os.W_OK | os.X_OK)


def remove(project: store.ProjectRow, dimension: str, code: str) -> Removal:
    """
    Take a variable out of the project, input and results together.

    Both, because the engine's database is derived rather than authoritative:
    `load_h3_values` truncates `variables` and `archivo_valores` on a full
    rebuild and repopulates them from whatever `.h3.parquet` files it finds
    under `out/`, skipping any whose file has gone. So the output *is* the
    variable as far as everything downstream is concerned.

    The results usually cannot be deleted from here: the pipeline runs as
    root, so everything it wrote under `out/` belongs to root and no amount
    of owning the folder above helps. Those go through the container, which
    is root. Chowning would not fix it — the next run writes root-owned
    files again.

    Nothing is deleted until both parts are known to be deletable. Deleting
    the input first and discovering the rest was impossible is what this did
    before: a 500, and a variable that looked removed until the next run
    brought it back from the output still sitting there.

    The folder it was copied from is still never touched.
    """
    target = _destination(project, dimension, code)
    identifier = f"{target.parent.name}/{target.name}"
    if not target.is_dir():
        raise ValueError(f"No {identifier} in this project.")

    results_root = outputs.out_dir(project)
    results: Path | None = None
    if results_root is not None and results_root.is_dir():
        candidate = (results_root / target.parent.name / target.name).resolve()
        if results_root.resolve() in candidate.parents and candidate.is_dir():
            results = candidate

    # Decided before anything goes, so a half-removed variable is not a state
    # this can end in.
    by_hand = {"input": _removable(target), "results": results is None or _removable(results)}
    if not all(by_hand.values()) and not pipeline.can_remove_as_root():
        stuck = results if not by_hand["results"] else target
        raise ValueError(
            f"Cannot remove {identifier}: {stuck} belongs to {_owner_of(stuck)} and Docker "
            "is not available to do it. The pipeline writes its results as root, so "
            "removing them needs either the engine running or "
            f"`sudo rm -rf {stuck}`."
        )

    removal = Removal(id=identifier, inputFiles=_count_files(target), outputFiles=0)

    # Results first: it is the part that can fail, and failing before the
    # input is gone leaves the variable intact rather than half-deleted.
    if results is not None:
        removal.outputFiles = _count_files(results)
        if by_hand["results"]:
            shutil.rmtree(results)
        else:
            relative = f"out/{target.parent.name}/{target.name}"
            problem = pipeline.remove_as_root(outputs.data_dir(project), relative)
            if problem:
                raise ValueError(f"Could not remove the results for {identifier}: {problem}")

    if by_hand["input"]:
        shutil.rmtree(target)
    else:
        problem = pipeline.remove_as_root(
            outputs.data_dir(project), f"in/{target.parent.name}/{target.name}"
        )
        if problem:
            raise ValueError(f"Removed the results, but not the input for {identifier}: {problem}")

    # A dimension with nothing left in it would still be offered in the
    # picker, which reads the folders. Drop it rather than leave a choice
    # that means nothing. Best effort: a root-owned empty folder is untidy,
    # not broken.
    for parent in (target.parent, results.parent if results is not None else None):
        if parent is not None and parent.is_dir():
            try:
                if not any(parent.iterdir()):
                    parent.rmdir()
            except OSError:
                pass

    rows = [row for row in store.folders_of(project.id) if row.name != identifier]
    store.replace_folders(project.id, rows)

    # An incremental load upserts the files it finds and never deletes rows,
    # so the engine's database still holds this variable. The next run has to
    # clear the per-project tables or it comes back.
    engine_state.mark_stale(project.id)
    return removal
