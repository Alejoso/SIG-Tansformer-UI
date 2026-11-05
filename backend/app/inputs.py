"""
The engine's input tree.

The pipeline does not take a list of folders. It walks `<DATA_DIR>/in` and
reads each dataset's dimension and code straight out of the path:

    in/<dimension>/<CODE>/<one data file>
    in/09_regulatorio/REG_001/pct_exito_mw_onshore.csv
    in/tec/TEC_001_t/TEC_001_sv003/velocidad_100m.tif

at any depth: the dimension is the first folder, and the code is the folder
holding the file, which the loader names the master-table column after.
`TEC_001_t` there is only a group of a variable's versions.

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
#: it — optionally followed by more, because a folder is often named
#: `SOE_001_poblacion` and that whole name is what the engine makes the
#: column out of. The engine only reads the identity from the first seven
#: characters and keeps the rest, so the tail is free text.
#:
#: The engine uppercases the code in folder names, so we store it that way.
CODE_PATTERN = re.compile(r"^[A-Za-z]{3}_[0-9]{3}(?:_[A-Za-z0-9_]+)?$")

#: The identity the engine reads, which is always exactly this much.
CODE_PREFIX = re.compile(r"^([A-Za-z]{3})_([0-9]{3})")

#: How long a code may be. Nothing in the engine stops a longer one — it
#: becomes a Postgres column name, and those run to 63 — but past this it
#: stops being readable in the model file, on the map and in a folder
#: listing, which is most of what a code is for.
MAX_CODE_LENGTH = 32

#: Folders under `out/` that hold the pipeline's own products rather than
#: variables — the master export, archived copies, the MCDA's own output and


#: A dimension is a folder name, so it has to be one — no separators, no
#: walking upwards, nothing hidden.
DIMENSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


@dataclass
class InputVariable:
    """One variable sitting in the engine's input tree, ready to process."""

    #: Where it lives, relative to `in/`: `<dimension>/<CODE>`, or deeper for
    #: a nested one, `tec/TEC_001_t/TEC_001_sv003`.
    id: str
    dimension: str
    #: The folder holding the dataset, which is what the engine names the
    #: master-table column after (`leaf_var_name`): `TEC_001_sv003`.
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
    #: Set when the folder holds nothing the engine can read.
    problem: str = ""
    #: Something the engine does that is worth knowing and is not a failure:
    #: several datasets in one folder become a column each, named after the
    #: folder and the file.
    note: str = ""
    #: The folders between the dimension and this one, `TEC_001_t` for
    #: `tec/TEC_001_t/TEC_001_sv003`. Empty for the usual flat variable.
    group: str = ""
    #: Results with no input left. The pipeline loads whatever `.h3.parquet`
    #: it finds under `out/`, so one of these is still a variable in the
    #: master table and in the model — it just has nothing behind it. Listed
    #: so it can be seen and removed, because the screen otherwise shows
    #: inputs only and these are invisible.
    processedOnly: bool = False


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
    #: Set when the folder holds several variables rather than one — either
    #: subfolders with a dataset each, or several datasets side by side. The
    #: single fields above stay empty then, and these are what to show.
    #:
    #: Two shapes in one type, deliberately: the single case is the one that
    #: works and is used constantly, and threading it through a list of one
    #: to save a branch would be a rewrite of the screen that adds nothing.
    variables: list[ImportCandidate] = field(default_factory=list)


@dataclass
class ImportCandidate:
    """One variable a folder of variables would add."""

    #: The folder to import from. For several datasets sitting in one folder
    #: this is that folder for all of them, and `filename` is what separates
    #: them.
    source: str
    #: What to call it in the list: the folder it came from, or the file.
    label: str
    filename: str
    format: str
    sizeBytes: int
    files: list[str] = field(default_factory=list)
    #: Suggested, and editable before anything is copied.
    code: str = ""
    #: Why this one cannot be added. The others still can.
    problem: str = ""
    #: The folders it is filed under between the dimension and its code,
    #: kept from the folder it came from: `TEC_001_t` for
    #: `TEC_001_t/TEC_001_sv003`. Empty for a flat variable.
    group: str = ""


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
    The data files directly in a folder, companions excluded.

    One folder's worth: `_dataset_folders` is what walks the levels below,
    the way the engine does.
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


#: How far below a folder the walk goes. The engine has no limit (it uses
#: `rglob`), but its own data is never more than three folders deep under a
#: dimension, and a walk with no limit over a folder picked by mistake (a
#: home directory) would not come back.
MAX_DEPTH = 6
#: And how many folders it looks at before giving up, for the same reason.
MAX_FOLDERS = 5000

#: First-level folders under `in/` the engine does not read
#: (`IGNORE_DIRS` in `ingest_to_geoparquet.py`).
ENGINE_INPUT_IGNORED = frozenset({"admin"})


def _subfolders(folder: Path) -> list[Path]:
    """
    The folders under one to walk into: not hidden, not a `.gdb` (which is a
    dataset), and not a link, which could lead back up the tree.
    """
    try:
        return [
            entry for entry in sorted(folder.iterdir())
            if entry.is_dir()
            and not entry.is_symlink()
            and not entry.name.startswith(".")
            and entry.suffix.lower() != ".gdb"
        ]
    except OSError:
        return []


def _dataset_folders(root: Path) -> tuple[list[tuple[Path, list[Path]]], bool]:
    """
    Every folder at or under `root` holding a dataset itself, with them,
    top-down and in order; and whether the walk stopped at `MAX_FOLDERS`.

    This is the engine's view of a tree: ingest and the raster step `rglob`
    the whole of `in/`, and every dataset at any depth is processed into the
    mirror of its folder under `out/`. So `tec/TEC_001_t/TEC_001_sv003/x.tif`
    is a variable just like `soc/SOC_001/x.csv`, and `TEC_001_t`, which only
    holds folders, is not one.
    """
    found: list[tuple[Path, list[Path]]] = []
    pending = [(root, 0)]
    visited = 0
    while pending:
        folder, depth = pending.pop(0)
        visited += 1
        if visited > MAX_FOLDERS:
            return found, True
        datasets = _datasets_in(folder)
        if datasets:
            found.append((folder, datasets))
        if depth < MAX_DEPTH:
            pending[0:0] = [(child, depth + 1) for child in _subfolders(folder)]
    return found, False


def scan(project: store.ProjectRow) -> list[InputVariable]:
    """
    Every variable in the input tree, as the pipeline will see it.

    Listed from disk rather than from our own records, because the pipeline
    reads disk. Data dropped in by hand shows up here too, which is the point:
    the screen should show what will actually be processed.

    At any depth, as the engine reads it: a variable is a folder holding a
    dataset, wherever it sits under its dimension, and its code is that
    folder's name (the column the loader makes of it). The folders above it
    are its `group`. A folder straight under a dimension with nothing
    readable anywhere inside is listed with that problem, since it was
    clearly meant to be a variable; one that only holds variable folders
    (`TEC_001_t`) is not a variable at all.
    """
    root = data_in(project)
    if root is None or not root.is_dir():
        return []

    sources = {row.name: row for row in store.folders_of(project.id)}
    found: list[InputVariable] = []

    for dimension_dir in _subfolders(root):
        if dimension_dir.name in ENGINE_INPUT_IGNORED:
            continue
        folders, _ = _dataset_folders(dimension_dir)
        holding = {folder for folder, _ in folders}
        for folder, datasets in folders:
            if folder == dimension_dir:
                # A file straight in the dimension folder. The engine reads
                # it and names its column after the dimension; nothing here
                # writes one, and it has no code to list it by.
                continue
            found.append(_input_variable(root, folder, datasets, sources))

        # A code folder with nothing readable in it or under it.
        for code_dir in _subfolders(dimension_dir):
            if any(folder == code_dir or code_dir in folder.parents for folder in holding):
                continue
            found.append(_input_variable(root, code_dir, [], sources))

    found += _results_without_input(project, {variable.id for variable in found})
    found.sort(key=lambda variable: variable.id)
    return found


def _input_variable(
    root: Path, folder: Path, datasets: list[Path], sources: dict[str, store.FolderRow]
) -> InputVariable:
    """One folder of the input tree as a variable."""
    relative = folder.relative_to(root)
    identifier = relative.as_posix()
    problem = note = ""
    if not datasets:
        problem = "No file here the pipeline can read"
    elif len(datasets) > 1:
        # The engine processes every one of them, and the loader tells them
        # apart by adding the file's name to the folder's (`build_variable_key`).
        note = (
            f"{len(datasets)} datasets in one folder. The engine makes a column of each, "
            f"named {format_code(folder.name)}_<file>; one per folder keeps the column "
            "named after the folder"
        )

    dataset = datasets[0] if datasets else None
    row = sources.get(identifier)
    try:
        file_count = sum(1 for entry in folder.iterdir() if entry.is_file())
    except OSError:
        file_count = 0

    return InputVariable(
        id=identifier,
        dimension=relative.parts[0],
        code=folder.name,
        filename=dataset.name if dataset else "",
        format=_format_of(dataset) if dataset else "",
        sizeBytes=_measure([dataset]) if dataset else 0,
        fileCount=file_count,
        source=row.path if row else "",
        sourceMissing=bool(row) and not Path(row.path).is_dir(),
        problem=problem,
        note=note,
        group="/".join(relative.parts[1:-1]),
    )


def _results_without_input(
    project: store.ProjectRow, known: set[str]
) -> list[InputVariable]:
    """
    Variables that exist only as results.

    The pipeline loads every `.h3.parquet` under `out/`, so one of these is a
    column in the master table and a leaf the model can score, with no input
    behind it and, until now, no way to see or remove it from here.

    They come from an input removed outside this app, or from the window
    where removing a variable deleted its input and left its results.
    Nested ones too: the results mirror the input tree at any depth.
    """
    root = outputs.out_dir(project)
    if root is None or not root.is_dir():
        return []

    orphans: list[InputVariable] = []
    for parts in outputs.result_folders(root, outputs.LOADED_SUFFIXES):
        identifier = "/".join(parts)
        if identifier in known:
            continue
        folder = root.joinpath(*parts)
        try:
            files = [entry for entry in folder.iterdir() if entry.is_file()]
        except OSError:
            continue
        if not files:
            continue
        orphans.append(
            InputVariable(
                id=identifier,
                dimension=parts[0],
                code=parts[-1],
                filename=min((f.name for f in files), key=len),
                format="",
                sizeBytes=sum(f.stat().st_size for f in files),
                fileCount=len(files),
                processedOnly=True,
                group="/".join(parts[1:-1]),
                problem=(
                    "Results with no input: still loaded into the master table "
                    "and the model"
                ),
            )
        )
    return orphans


def dimensions(project: store.ProjectRow) -> list[str]:
    """The dimension folders that already exist, for offering rather than typing."""
    root = data_in(project)
    if root is None or not root.is_dir():
        return []
    return [
        p.name for p in _subfolders(root) if p.name not in ENGINE_INPUT_IGNORED
    ]


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


#: What the engine's lint spells out rather than drops (`READABLE_REPLACEMENTS`
#: in `app/tools/lint_filenames.py`).
_READABLE_REPLACEMENTS = {"&": " y ", "@": " at "}

#: The suffix the lint keeps whole on a file, as it has it.
_LINT_SPECIAL_SUFFIXES = (".h3.parquet",)


def engine_name(name: str, is_dir: bool) -> str:
    """
    A file or folder name as the engine's lint leaves it.

    A copy of `sanitize_name` in the engine's `app/tools/lint_filenames.py`,
    which renames everything under `data/in` on every run: the part before
    the last dot is lowercased, stripped of accents, `&` and `@` spelled out,
    anything but a letter or digit turned into one underscore; the extension
    is lowercased; and on a folder, `format_code` puts a leading `abc_123`
    back into capitals. Anything written into the input tree under another
    name is renamed under the app on the next run, which is how a variable
    used to lose its own record of where it came from.

    Kept a copy rather than imported: the engine runs in a container and this
    does not. Worth re-reading against the engine's when it changes.
    """
    lower = name.lower()
    special = next((suffix for suffix in _LINT_SPECIAL_SUFFIXES if lower.endswith(suffix)), None)
    if special:
        base, ext = name[: -len(special)], special
    elif "." in name and not name.startswith("."):
        base, ext = name.rsplit(".", 1)
        ext = "." + ext.lower()
    else:
        base, ext = name, ""

    base = _strip_accents(base).lower()
    for key, value in _READABLE_REPLACEMENTS.items():
        base = base.replace(key, value)
    base = re.sub(r"[^A-Za-z0-9]+", "_", base).strip("_") or "unnamed"
    if is_dir:
        base = format_code(base)
    return base + ext


def format_code(name: str) -> str:
    """The engine's `shared.format_code`: a leading `abc_123` in capitals, the rest as it is."""
    return re.sub(
        r"^[a-z]{3}_[0-9]{3}(?=_|$)", lambda m: m.group(0).upper(), name, flags=re.IGNORECASE
    )


def _folder_name(raw: str) -> str:
    """
    A folder name the lint will leave alone, from anything typed.

    The lint reads a dot in a folder's name as the start of an extension and
    keeps what follows it as it is, so `SOC_024.6-s` survives it untouched.
    This app never writes one: a dot is an underscore here, which gives a name
    that is the same before and after the lint.
    """
    cleaned = _strip_accents(raw).strip().replace(".", "_")
    if not re.search(r"[A-Za-z0-9]", cleaned):
        return ""
    return engine_name(cleaned, is_dir=True)


def normalise_dimension(name: str) -> str:
    """
    A dimension name as the engine will end up storing it.

    The pipeline's `lint_filenames` sanitises folder names under `data/in`:
    lowercased, anything but a letter or digit turned into an underscore, and
    then `format_code` puts a leading `abc_123` back into capitals. So a
    folder typed as `10-Socioeconomico` is renamed to `10_socioeconomico` on
    the first run, and one typed `soe-001` comes back as `SOE_001`; either
    way every variable under it changes id. Normalising here means what the
    screen shows is what the engine will end up with.
    """
    return _folder_name(name)


def normalise_code(raw: str) -> str:
    """
    A code in the engine's own shape: three letters, underscore, three digits,
    and whatever the folder called itself after that.

    Exactly what the engine's lint makes of the folder (`engine_name`): the
    identity in capitals and the tail in lower case, so `TEC_001_SV003` is
    `TEC_001_sv003`. Anything else would be renamed by the first run, and the
    variable would stop matching what was recorded about it here.

    Typed codes copy the folder or file they came from, and those are named
    `SOE-001` as often as `SOE_001`. The engine's `DIM_CODE_RE` only
    recognises the underscore form, and a code it does not recognise stops
    being a code: it becomes part of the name and the variable loses its
    identity. So a hyphen is corrected rather than rejected, as are a missing
    underscore and missing zeros (`SOE1` is `SOE_001`). Every result is a name
    the lint leaves as it is.
    """
    cleaned = _folder_name(raw)
    # `SOE001` is unambiguous too, and is what you get from a tidy filename.
    match = re.fullmatch(r"([A-Za-z]{3})_?([0-9]{1,3})(?:_(.+))?", cleaned)
    if match:
        base = f"{match.group(1).upper()}_{int(match.group(2)):03d}"
        return f"{base}_{match.group(3).lower()}" if match.group(3) else base
    return cleaned


def is_code(name: str) -> bool:
    """Whether a folder name starts with an identity the engine reads (`abc_123`)."""
    return bool(CODE_PREFIX.match(normalise_code(name)))


def _code_from_name(name: str) -> str:
    """
    The code a folder or file names itself after, if it does.

    `SOE_001_poblacion` is a variable announcing its own code, which is a
    better suggestion than the next free number — and it is how these arrive.
    The folder is asked first because that is what the engine names the
    variable after; a file inside it may be called anything.
    """
    stem = name.split(".")[0]
    candidate = normalise_code(stem)
    # `soe_001_SOE-001.gpkg` is a file saying its code twice — the folder's
    # and its own. Once is enough.
    prefix = CODE_PREFIX.match(candidate)
    if prefix and candidate.lower() == f"{prefix.group(0)}_{prefix.group(0)}".lower():
        candidate = prefix.group(0)
    if len(candidate) > MAX_CODE_LENGTH:
        # Too long to keep whole. The identity is still worth having.
        prefix = CODE_PREFIX.match(candidate)
        candidate = prefix.group(0) if prefix else ""
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


def _taken_codes(project: store.ProjectRow, dimension: str) -> tuple[list[str], set[str]]:
    """
    Codes already used in a dimension, in the order they were found, and
    every code in the project.

    Both, because they answer different questions. The dimension's own codes
    say which prefix it uses. But a code taken anywhere is taken: the loader
    names a column after the folder alone, whatever dimension or group it is
    in, and two folders with one name are both renamed (`build_variable_key`
    adds the file's name to each), so neither column is called what the
    model expects.
    """
    variables = scan(project)
    existing = [
        variable.code for variable in variables
        if variable.dimension == dimension and CODE_PATTERN.match(variable.code)
    ]
    return existing, {variable.code for variable in variables}


def _numbers_under(codes, prefix: str) -> set[int]:
    """The numbers already used under a three-letter prefix."""
    found = set()
    for code in codes:
        match = CODE_PREFIX.match(code)
        if match and match.group(1).upper() == prefix:
            found.add(int(match.group(2)))
    return found


def _next_code(existing: list[str], taken: set[str], dimension: str, name: str) -> str:
    """
    Which code to give a variable, against a set the caller keeps.

    The caller keeps it because a batch allocates several at once: each one
    has to miss the codes already on disk *and* the ones handed to the rows
    above it, which a function that re-reads the tree every call cannot do.

    `name` is the folder the variable comes from, or the file when several
    sit in one folder. A name that already says its code is taken at its
    word — including the tail, so `SOE_001_poblacion` stays itself rather
    than being flattened to `SOE_001`.
    """
    from_name = _code_from_name(name) if name else ""
    if from_name and from_name not in taken:
        return from_name

    if existing:
        prefix = existing[0][:3].upper()
    elif from_name:
        # The name gave a code, but it is taken — keep its prefix and move to
        # the next free number under it.
        prefix = from_name[:3]
    else:
        letters = re.sub(r"[^A-Za-z]", "", dimension)[:3].upper()
        prefix = (letters or "VAR").ljust(3, "X")

    used = _numbers_under(existing, prefix) | _numbers_under(taken, prefix)
    if from_name:
        used |= _numbers_under([from_name], prefix)
    number = next(n for n in range(1, 1000) if n not in used)
    return f"{prefix}_{number:03d}"


def suggest_code(project: store.ProjectRow, dimension: str, filename: str = "") -> str:
    """
    The code to offer for a new variable.

    Three sources, in order of how much they know: the file's own name, the
    codes already in the dimension, and failing both, the dimension's
    letters. The prefix cannot be derived from the dimension name in general
    — `socioeconomico` would give `SOC`, not `SOE` — so the existing codes
    are what settle it.

    One variable's worth. A batch allocates several against one set it keeps
    itself; both go through `_next_code`, so they cannot drift apart.
    """
    existing, taken = _taken_codes(project, dimension)
    return _next_code(existing, taken, dimension, filename)


# ── adding to it ──────────────────────────────────────────────────────────


def _candidate(source: Path, dataset: Path, label: str) -> ImportCandidate:
    companions = _companions(dataset)
    return ImportCandidate(
        source=str(source),
        label=label,
        filename=dataset.name,
        format=_format_of(dataset),
        sizeBytes=_measure([dataset, *companions]),
        files=[dataset.name] + [c.name for c in companions],
    )


def _batch_candidates(
    folders: list[tuple[Path, list[Path]]], source: Path
) -> list[tuple[ImportCandidate, str]]:
    """
    The variables a folder holds, when it holds several rather than being one,
    each with the name its code is suggested from.

    Found at any depth, the way the engine finds them (`_dataset_folders`):
    every folder holding one dataset is a variable, and every dataset in a
    folder holding several is one too. So all of these are a folder of
    variables:

    * subfolders with one dataset each: `socioeconomico/SOE_001/x.gpkg`;
    * several datasets side by side: `socioeconomico/SOE-001.gpkg,
      SOE-002.gpkg`. That one used to be refused outright, with a message
      saying to add them one folder at a time;
    * the engine's own arrangement of a variable's versions,
      `TEC_001_t/TEC_001_sv003/x.tif`, whether the folder picked is the
      dimension above it or `TEC_001_t` itself.

    Each variable is copied into a folder named after its code, and that
    code is the master-table column, as the loader names it. The folders
    above it are kept when they are named like a code and hold no data of
    their own (`TEC_001_t`, a group), and dropped otherwise: a `shp/` or a
    `data/` says nothing, and keeping it would leave the variable's column
    named `shp`. A folder like that, alone under a code (`SOC_025_sr/shp/`),
    is the code's own variable.

    A subfolder with nothing readable is left out: a folder of variables
    usually has a `docs` or a `.git` in it, and those are not failures.
    """
    holding = {folder for folder, _ in folders}
    entries: list[dict] = []
    for folder, datasets in folders:
        relative = folder.relative_to(source)
        chain = [source] + [
            source.joinpath(*relative.parts[: index + 1]) for index in range(len(relative.parts))
        ]
        own = len(datasets) == 1
        for dataset in datasets:
            above = chain[:-1] if own else chain
            if own:
                label = relative.as_posix() if folder != source else dataset.name
            else:
                label = (relative / dataset.name).as_posix()
            entries.append({
                "candidate": _candidate(folder, dataset, label),
                "group": [a for a in above if a not in holding and is_code(a.name)],
                "folder": folder,
                "name": folder.name if own else dataset.name,
                "own": own,
                "dataset": dataset,
            })

    def under(group_folder: Path) -> int:
        return sum(
            1 for entry in entries
            if entry["folder"] == group_folder or group_folder in entry["folder"].parents
        )

    found = []
    for entry in entries:
        group, name = entry["group"], entry["name"]
        if entry["own"] and not is_code(name) and group and under(group[-1]) == 1:
            # `SOC_025_sr/shp/x.shp`: the code is the folder above.
            name, group = group[-1].name, group[:-1]
        if not _code_from_name(name):
            # A folder called `descargas` says nothing; the file may.
            name = entry["dataset"].name
        entry["candidate"].group = "/".join(normalise_code(g.name) for g in group)
        found.append((entry["candidate"], name))
    return found


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

    folders, truncated = _dataset_folders(source)
    if truncated:
        result.problem = (
            f"More than {MAX_FOLDERS} folders under here. Point at the folder that holds "
            "the variables."
        )
        return result

    # With no dimension chosen yet, the folder's own name is the best guess —
    # these arrive as `10-Socioeconomico/SOE-001.gpkg`, which says both.
    chosen = normalise_dimension(dimension) if dimension else suggest_dimension(project, source)
    result.dimension = chosen

    if len(folders) == 1 and folders[0][0] == source and len(folders[0][1]) == 1:
        dataset = folders[0][1][0]
        companions = _companions(dataset)
        result.filename = dataset.name
        result.format = _format_of(dataset)
        result.files = [dataset.name] + [c.name for c in companions]
        result.sizeBytes = _measure([dataset, *companions])
        # The folder first: that is what the engine makes the variable's
        # name out of, and it is the one usually called `SOE_001_algo`. The
        # file is the fallback, for a folder called `descargas`.
        result.code = suggest_code(
            project, chosen, source.name if _code_from_name(source.name) else dataset.name
        )
        return result

    # Not one variable: several datasets side by side, or folders with one
    # each, at any depth. All are what someone means by a folder of variables.
    candidates = _batch_candidates(folders, source)
    if not candidates:
        readable = ", ".join(sorted(s.lstrip(".") for s in DATASET_SUFFIXES))
        result.problem = f"Nothing here the pipeline can read. It takes: {readable}"
        return result

    # Codes are allocated across the whole batch at once: each has to miss
    # what is on disk *and* what the rows above it were given.
    existing, taken = _taken_codes(project, chosen)
    for candidate, name in candidates:
        candidate.code = _next_code(existing, taken, chosen, name)
        taken.add(candidate.code)

    result.variables = [candidate for candidate, _ in candidates]
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


#: How many folders a group may hold between the dimension and the code.
MAX_GROUP_DEPTH = 3


def _destination(
    project: store.ProjectRow, dimension: str, code: str, group: str = ""
) -> Path:
    """
    Where a variable goes, checked.

    The dimension, group and code arrive from the browser, and they are used
    to build a path, so they are matched against a pattern that cannot
    express `..` or a separator, and the result is confirmed to sit inside
    the tree before anything is written to it.
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
    groups = [normalise_code(part) for part in group.split("/") if part.strip()]

    if not folder or not DIMENSION_PATTERN.match(folder):
        raise ValueError(
            "A dimension is a folder name — letters, digits and underscores, "
            "like 10_socioeconomico."
        )
    if folder in ENGINE_INPUT_IGNORED:
        raise ValueError(f"The engine does not read in/{folder}/. Use another dimension.")
    if len(groups) > MAX_GROUP_DEPTH or not all(DIMENSION_PATTERN.match(part) for part in groups):
        raise ValueError(f"{group!r} is not a folder the variable can be filed under.")
    if not CODE_PATTERN.match(identifier):
        raise ValueError(
            f"{code!r} is not a code the engine can read. It wants three letters "
            "and three digits, like SOE_001 — it reads the variable's identity "
            "out of that. Anything after them is yours: SOE_001_poblacion works."
        )
    if len(identifier) > MAX_CODE_LENGTH:
        raise ValueError(
            f"{code!r} is {len(identifier)} characters. Keep a code to "
            f"{MAX_CODE_LENGTH} — it becomes a folder name, a column and a line "
            "on the map."
        )

    target = root.joinpath(folder, *groups, identifier).resolve()
    if root.resolve() not in target.parents:
        raise ValueError("That is not a place inside this project's input folder.")
    return target


def _copy_name(item: Path) -> str:
    """
    The name a file or `.gdb` gets in the copy: the one the engine's lint
    would give it on the first run, so nothing is renamed under the app.
    """
    return engine_name(item.name, is_dir=item.is_dir())


def import_folder(
    project: store.ProjectRow,
    raw_source: str,
    dimension: str,
    code: str,
    dataset_name: str = "",
    group: str = "",
) -> InputVariable:
    """
    Copy a folder's dataset into the input tree as one variable.

    Copies into a temporary folder beside the destination and renames it into
    place, so an interrupted copy cannot leave the pipeline a half-written
    variable to find on its next run.

    `dataset_name` picks one of several datasets sitting in the same folder,
    which is how a batch imports `SOE-001.gpkg` and `SOE-002.gpkg` out of one
    directory as two variables. Left empty, the folder must hold exactly one,
    which is the single-variable case and what `plan` checks.

    `group` is the folders it is filed under between the dimension and its
    code, `TEC_001_t` for `in/tec/TEC_001_t/TEC_001_sv003/`, as `plan`
    found them. The engine reads it at any depth and names the column after
    the code alone, so the group is kept only for the tree to look like the
    one it came from.
    """
    if not dataset_name:
        prepared = plan(project, raw_source, dimension)
        if prepared.problem:
            raise ValueError(prepared.problem)
        if prepared.variables:
            raise ValueError(
                "This folder holds several variables. Add them together, or point at one "
                "of them."
            )

    target = _destination(project, dimension, code, group)
    identifier = target.relative_to(data_in(project).resolve()).as_posix()
    if target.exists() and any(target.iterdir()):
        raise ValueError(
            f"{identifier} already has data. Remove it first, or use another code."
        )
    # The loader names a column after the folder alone, so the same code in
    # another dimension or group would rename both columns.
    clash = next(
        (
            v for v in scan(project)
            if format_code(v.code) == format_code(target.name) and v.id != identifier
        ),
        None,
    )
    if clash is not None:
        raise ValueError(
            f"{target.name} is already a variable, at {clash.id}. The engine names the "
            "column after the folder alone, so two of them would both be renamed. "
            "Use another code."
        )

    # Checked up front rather than discovered mid-copy: the useful answer is
    # about ownership, and it is the same answer whether the dimension folder
    # exists yet or not.
    writable = target.parent if target.parent.is_dir() else _first_existing(target.parent)
    if writable is not None and not os.access(writable, os.W_OK | os.X_OK):
        raise ValueError(_explain_permission(writable))

    source = fsutil.expand(raw_source)
    datasets = _datasets_in(source)
    if dataset_name:
        dataset = next((d for d in datasets if d.name == dataset_name), None)
        if dataset is None:
            raise ValueError(f"{dataset_name} is not in {source} any more")
    else:
        if not datasets:
            raise ValueError(f"Nothing the pipeline can read is in {source} any more")
        dataset = datasets[0]
    wanted = [dataset, *_companions(dataset)]

    staging = target.with_name(f".{target.name}.incoming")
    shutil.rmtree(staging, ignore_errors=True)
    try:
        staging.mkdir(parents=True)
        for item in wanted:
            if item.is_dir():  # a .gdb
                shutil.copytree(item, staging / _copy_name(item))
            else:
                shutil.copy2(item, staging / _copy_name(item))
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
class ImportOutcome:
    """What adding a folder of variables actually did."""

    added: list[InputVariable] = field(default_factory=list)
    #: The request row behind each entry of `added`, in the same order, so the
    #: caller can apply what else the row asked for (its fill and absent).
    added_items: list[dict] = field(default_factory=list)
    #: One entry per variable that did not make it, with the server's own
    #: reason. A batch does not stop at the first failure: the others are
    #: fine, and re-picking the folder to retry the rest would be worse than
    #: being told which one to look at.
    failed: list[dict[str, str]] = field(default_factory=list)


def import_many(
    project: store.ProjectRow,
    dimension: str,
    wanted: list[dict[str, str]],
) -> ImportOutcome:
    """
    Add several variables from one folder, in the order they were listed.

    Each entry is `{source, code, filename, group}`: the folder to copy from,
    the code to file it under, which dataset when the folder holds more than
    one, and the folders between the dimension and the code, if any.

    Sequential rather than parallel: these are large copies onto one disk, so
    doing them at once would not be faster, and a failure halfway through a
    parallel batch is much harder to describe afterwards.
    """
    outcome = ImportOutcome()
    for item in wanted:
        code = (item.get("code") or "").strip()
        source = (item.get("source") or "").strip()
        try:
            outcome.added.append(
                import_folder(
                    project, source, dimension, code, item.get("filename", ""),
                    item.get("group", "") or "",
                )
            )
            outcome.added_items.append(item)
        except ValueError as error:
            outcome.failed.append(
                {"source": source, "code": code, "problem": str(error)}
            )
        except OSError as error:  # noqa: PERF203 — one bad copy must not stop the rest
            outcome.failed.append(
                {"source": source, "code": code, "problem": str(error)}
            )
    return outcome


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


def _inside(base: Path, identifier: str) -> Path | None:
    """`base/identifier`, if that resolves to somewhere inside `base`."""
    candidate = (base / identifier).resolve()
    return candidate if base.resolve() in candidate.parents else None


def remove(project: store.ProjectRow, identifier: str) -> Removal:
    """
    Take a variable out of the project, input and results together.

    Both, because the engine's database is derived rather than authoritative:
    `load_h3_values` truncates `variables` and `archivo_valores` on a full
    rebuild and repopulates them from whatever `.h3.parquet` files it finds
    under `out/`, skipping any whose file has gone. So the output *is* the
    variable as far as everything downstream is concerned.

    `identifier` is the variable's id as `scan` lists it, at whatever depth
    (`soc/SOC_001`, `tec/TEC_001_t/TEC_001_sv003`), and it has to be one it
    lists: the id comes from a URL, and "one of the variables just found on
    disk" is a stronger check than any pattern. Its results are the mirror
    folder under `out/`.

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
    if identifier not in {variable.id for variable in scan(project)}:
        raise ValueError(f"No {identifier} in this project.")
    in_root = data_in(project)
    results_root = outputs.out_dir(project)
    target = _inside(in_root, identifier) if in_root is not None else None
    if target is None:
        raise ValueError(f"No {identifier} in this project.")
    has_input = target.is_dir()

    results: Path | None = None
    if results_root is not None and results_root.is_dir():
        candidate = _inside(results_root, identifier)
        if candidate is not None and candidate.is_dir():
            results = candidate

    # Decided before anything goes, so a half-removed variable is not a state
    # this can end in.
    if not has_input and results is None:
        raise ValueError(f"No {identifier} in this project.")

    by_hand = {
        "input": not has_input or _removable(target),
        "results": results is None or _removable(results),
    }
    if not all(by_hand.values()) and not pipeline.can_remove_as_root():
        stuck = results if not by_hand["results"] else target
        raise ValueError(
            f"Cannot remove {identifier}: {stuck} belongs to {_owner_of(stuck)} and Docker "
            "is not available to do it. The pipeline writes its results as root, so "
            "removing them needs either the engine running or "
            f"`sudo rm -rf {stuck}`."
        )

    removal = Removal(
        id=identifier, inputFiles=_count_files(target) if has_input else 0, outputFiles=0
    )

    # Results first: it is the part that can fail, and failing before the
    # input is gone leaves the variable intact rather than half-deleted.
    if results is not None:
        removal.outputFiles = _count_files(results)
        if by_hand["results"]:
            shutil.rmtree(results)
        else:
            problem = pipeline.remove_as_root(outputs.data_dir(project), f"out/{identifier}")
            if problem:
                raise ValueError(f"Could not remove the results for {identifier}: {problem}")

    if not has_input:
        pass  # results-only: there was never an input to take out
    elif by_hand["input"]:
        shutil.rmtree(target)
    else:
        problem = pipeline.remove_as_root(outputs.data_dir(project), f"in/{identifier}")
        if problem:
            raise ValueError(f"Removed the results, but not the input for {identifier}: {problem}")

    # A dimension (or a group, like `TEC_001_t`) with nothing left in it
    # would still be offered in the picker, which reads the folders. Drop
    # them rather than leave a choice that means nothing, from the variable's
    # parent up to the dimension. Best effort: a root-owned empty folder is
    # untidy, not broken.
    for base, removed in ((in_root, has_input), (results_root, results is not None)):
        if not removed or base is None:
            continue
        dimension_folder = base / identifier.split("/")[0]
        parent = (base / identifier).parent
        while True:
            try:
                if not parent.is_dir() or any(parent.iterdir()):
                    break
                parent.rmdir()
            except OSError:
                break
            if parent == dimension_folder:
                break
            parent = parent.parent

    rows = [row for row in store.folders_of(project.id) if row.name != identifier]
    store.replace_folders(project.id, rows)

    # An incremental load upserts the files it finds and never deletes rows,
    # so the engine's database still holds this variable. The next run has to
    # clear the per-project tables or it comes back.
    engine_state.mark_stale(project.id)
    return removal
