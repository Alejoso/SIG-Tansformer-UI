"""
Which column is the value, for a file that has several.

The engine turns a file into one master-table column: one geography and one
value. A file with several value columns (a shapefile with `Tipo_Roca`,
`cohesion_M`, `A_Friccion`) is rejected at ingest ("tiene mas de 1 columna de
valor ... Elige una en transform.yaml value_columns") and not transformed,
until someone says which column is the value. It reads that choice from the
same `transform.yaml` the fill lives in:

    value_columns:
      SOC_028_s: Total_Victimas_Caso                 # every file of the variable
      TEC_032_t: {vias.shp: tipo, datos.xlsx: total} # per file, for a folder of several

Nothing here decides which files need a choice, or what the candidates are.
That is the engine's own detection, run read-only through its helper
(`app/tools/value_columns.py`) inside its image, so this cannot drift from
what the ingest does. This module stores what the user chose, one row per
variable (and per file when its folder holds several) in
`data/value_columns.csv`, and writes it into the document.
"""

from __future__ import annotations

import json
import re
import subprocess
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import inputs, outputs, pipeline, store

CHOICES_CSV = store.DATA_DIR / "value_columns.csv"
#: `code` is the key the engine looks the variable up by (its leaf folder,
#: dimension code in capitals), as the helper reported it when the choice was
#: made. `file` is empty when the choice is for every file of the variable.
CHOICE_FIELDS = ["project_id", "variable_id", "code", "file", "column", "updated_at"]

#: The engine's helper, inside its image.
HELPER = "/app/app/tools/value_columns.py"
#: Where the project's input tree is inside the container.
CONTAINER_IN = "/data/in"


class ChoiceError(ValueError):
    """A choice the engine would not accept, said in words for the screen."""


class Unavailable(RuntimeError):
    """The engine's helper could not be run. The message says why."""


# ── the stored choices ────────────────────────────────────────────────────


def _rows() -> list[dict[str, str]]:
    return store._read(CHOICES_CSV, CHOICE_FIELDS)


def _write_rows(rows: list[dict[str, str]]) -> None:
    store._write(CHOICES_CSV, CHOICE_FIELDS, rows)


def stored(project_id: str) -> list[dict[str, str]]:
    """The project's choices, as stored."""
    return [row for row in _rows() if row["project_id"] == project_id]


def choices_for(project_id: str, variable_id: str) -> dict[str, str]:
    """A variable's choices, by file name ("" for every file of the variable)."""
    return {
        row["file"]: row["column"]
        for row in stored(project_id)
        if row["variable_id"] == variable_id and row["column"]
    }


def _save_row(project_id: str, variable_id: str, code: str, file: str, column: str) -> None:
    """
    One choice. A choice for every file replaces the per-file ones and the
    other way round, so the document never carries both for one variable.
    """
    def same_variable(row: dict[str, str]) -> bool:
        return row["project_id"] == project_id and row["variable_id"] == variable_id

    rows = [
        row for row in _rows()
        if not (same_variable(row) and (not file or row["file"] in ("", file)))
    ]
    rows.append({
        "project_id": project_id,
        "variable_id": variable_id,
        "code": code,
        "file": file,
        "column": column,
        "updated_at": store.now(),
    })
    _write_rows(rows)


def clear(project_id: str, variable_id: str, file: str | None = None) -> bool:
    """
    Drop a variable's choice: one file's, or all of them when `file` is None.
    A choice made for every file (a folder of one) goes with any file named.
    Returns whether anything was there.
    """
    rows = _rows()
    kept = [
        row for row in rows
        if not (
            row["project_id"] == project_id
            and row["variable_id"] == variable_id
            and (file is None or row["file"] in ("", file))
        )
    ]
    if len(kept) == len(rows):
        return False
    _write_rows(kept)
    return True


def forget_project(project_id: str) -> None:
    """Drop a deleted project's rows."""
    rows = _rows()
    kept = [row for row in rows if row["project_id"] != project_id]
    if len(kept) != len(rows):
        _write_rows(kept)


# ── what the engine reads ─────────────────────────────────────────────────

#: Plain enough to write unquoted. Anything else (a leading digit, a space, a
#: colon, a word YAML reads as a boolean or null) is written as a JSON
#: string, which YAML reads as the same text.
_PLAIN = re.compile(r"[A-Za-z_][A-Za-z0-9_.\-]*")
_YAML_WORDS = {"y", "n", "yes", "no", "on", "off", "true", "false", "null"}


def _scalar(text: str) -> str:
    if _PLAIN.fullmatch(text) and text.lower() not in _YAML_WORDS:
        return text
    return json.dumps(text, ensure_ascii=False)


def document_lines(project_id: str, variable_ids: set[str] | None = None) -> list[str]:
    """
    The `value_columns:` block for the project's `transform.yaml`, or nothing
    when no column has been chosen. Only variables still in the input tree
    (`variable_ids`) are written, so a leftover row cannot name a folder
    that is gone.
    """
    by_code: dict[str, dict[str, str]] = {}
    for row in stored(project_id):
        if not row["column"] or not row["code"]:
            continue
        if variable_ids is not None and row["variable_id"] not in variable_ids:
            continue
        by_code.setdefault(row["code"], {})[row["file"]] = row["column"]
    if not by_code:
        return []
    lines = [
        "# The value column of each file with several, chosen on the Data screen.",
        "value_columns:",
    ]
    for code in sorted(by_code):
        files = by_code[code]
        if "" in files:
            lines.append(f"  {_scalar(code)}: {_scalar(files[''])}")
        else:
            pairs = ", ".join(f"{_scalar(name)}: {_scalar(files[name])}" for name in sorted(files))
            lines.append(f"  {_scalar(code)}: {{{pairs}}}")
    return lines


# ── asking the engine ─────────────────────────────────────────────────────


@dataclass
class Candidate:
    name: str
    dtype: str = ""
    #: The first value the engine found in the column, as it read it.
    sample: object = None


@dataclass
class Source:
    """One file (one layer of it) the ingest would read, with several candidates."""

    #: The variable in this app (`soc/SOC_028_s`), and the engine's key for it.
    variableId: str
    code: str
    #: Relative to `in/`.
    path: str
    file: str
    layer: str | None = None
    geoColumns: list[str] = field(default_factory=list)
    candidates: list[Candidate] = field(default_factory=list)
    #: True until a column is chosen: the engine will not transform it.
    needsChoice: bool = False
    chosen: str | None = None
    #: The engine's reason, as it gives it (Spanish), when it has one.
    error: str | None = None
    #: Set when the engine builds this source itself, in its own step, with a
    #: column chosen there: nothing to choose here.
    fixedBy: str | None = None


@dataclass
class State:
    """What the engine says about the project's multi-column files."""

    #: False when the helper could not be run; `error` says why.
    available: bool
    error: str = ""
    sources: list[Source] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def _tree_signature(root: Path) -> tuple:
    """Every file under `in/` with its size and time: what the answer depends on."""
    found = []
    if root.is_dir():
        for path in root.rglob("*"):
            try:
                if path.is_file():
                    stat = path.stat()
                    found.append((path.relative_to(root).as_posix(), stat.st_size, stat.st_mtime_ns))
            except OSError:
                continue
    return tuple(sorted(found))


def _mounted_data_dir() -> Path | None:
    """The host folder the running app container has at `/data`, if it is up."""
    listed = pipeline._run(["docker", "compose", "ps", "-q", pipeline.APP_SERVICE],
                           cwd=pipeline.PIPELINE_DIR, timeout=15)
    container = (listed.stdout or "").strip().splitlines() if listed and listed.returncode == 0 else []
    if not container:
        return None
    template = '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}'
    inspected = pipeline._run(["docker", "inspect", "-f", template, container[0]], timeout=15)
    source = (inspected.stdout or "").strip() if inspected and inspected.returncode == 0 else ""
    return Path(source) if source else None


def _helper_command(folder: Path, transform: str | None) -> tuple[list[str], dict[str, str] | None]:
    """
    How to run the helper over this project's tree.

    `exec` into the running container when it is mounted on this project
    (about a second). Otherwise a one-off `compose run` with the project's
    folder as `DATA_DIR`, like removing as root: the long-lived container
    holds whichever project was mounted last, and reading that one's `in/`
    would answer for the wrong project.
    """
    arguments = [HELPER, CONTAINER_IN, "--json"]
    if transform:
        arguments += ["--transform", transform]
    try:
        mounted = _mounted_data_dir()
        same = mounted is not None and mounted.resolve() == folder.resolve()
    except OSError:
        same = False
    if same:
        return ["docker", "compose", "exec", "-T", pipeline.APP_SERVICE, "python", *arguments], None
    command = [
        "docker", "compose", "run", "--rm", "--no-deps", "-T",
        "--entrypoint", "python", pipeline.APP_SERVICE, *arguments,
    ]
    return command, pipeline.run_full_env(extra={"DATA_DIR": str(folder)})


def run_helper(folder: Path, transform: str | None) -> dict:
    """The helper's JSON for the project's `in/`. Raises Unavailable."""
    status = pipeline.status()
    if not status.pipelineFound or not status.composeAvailable:
        raise Unavailable(" ".join(status.problems) or "The engine cannot be reached.")
    command, env = _helper_command(folder, transform)
    try:
        result = subprocess.run(command, cwd=pipeline.PIPELINE_DIR, capture_output=True,
                                text=True, timeout=180, env=env)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Unavailable(f"Could not run the engine's column check: {error}") from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[-400:]
        raise Unavailable(
            "The engine's column check did not run"
            + (f": {detail}" if detail else ". Are the engine's containers up?")
        )
    text = result.stdout
    start = text.find("{")
    try:
        return json.loads(text[start:] if start >= 0 else text)
    except ValueError as error:
        raise Unavailable(f"The engine's column check answered something unreadable: {error}") from error


def _variable_for(path: str, ids: list[str]) -> str:
    """The variable a source belongs to: the deepest id its folder is in."""
    parent = Path(path).parent.as_posix()
    best = ""
    for identifier in ids:
        if (parent == identifier or parent.startswith(identifier + "/")) and len(identifier) > len(best):
            best = identifier
    return best or parent


def _to_source(raw: dict, ids: list[str]) -> Source:
    return Source(
        variableId=_variable_for(str(raw.get("path") or raw.get("file") or ""), ids),
        code=str(raw.get("variable") or ""),
        path=str(raw.get("path") or ""),
        file=str(raw.get("file") or ""),
        layer=raw.get("layer"),
        geoColumns=[str(name) for name in raw.get("geo_columns") or []],
        candidates=[
            Candidate(name=str(item.get("name")), dtype=str(item.get("dtype") or ""),
                      sample=item.get("sample"))
            for item in raw.get("value_columns") or []
        ],
        needsChoice=bool(raw.get("needs_choice")) and not raw.get("fixed_by"),
        chosen=raw.get("chosen"),
        error=raw.get("error"),
        fixedBy=raw.get("fixed_by") or None,
    )


#: The last answer per project: (tree signature, choices document, sources).
#: The tree decides the candidates and the document decides `chosen`, so the
#: candidates of an answer stay good for checking a choice as long as the
#: tree has not changed, whatever was chosen since.
_cache: dict[str, tuple[tuple, str, list[Source]]] = {}
_cache_lock = threading.Lock()


def _all_sources(project: store.ProjectRow, *, fresh_choices: bool) -> list[Source]:
    """
    Every source the ingest would read, as the engine sees it. With
    `fresh_choices`, `chosen` reflects what is stored now; without, an answer
    from before the last choice is good enough (only the candidates are used).
    """
    from . import variable_settings  # noqa: PLC0415 (it imports this module)

    folder = outputs.data_dir(project)
    root = inputs.data_in(project)
    if folder is None or root is None or not root.is_dir():
        return []
    variables = inputs.scan(project)
    signature = _tree_signature(root)
    document = "\n".join(document_lines(project.id, {v.id for v in variables}))
    with _cache_lock:
        cached = _cache.get(project.id)
    if cached and cached[0] == signature and (not fresh_choices or cached[1] == document):
        return cached[2]
    # The helper reads `chosen` from the transform file, so it has to say
    # what is stored now. It is rewritten before every run anyway.
    written = variable_settings.write_transform(project, variables)
    transform = variable_settings.CONTAINER_TRANSFORM if written else None
    raw = run_helper(folder, transform)
    ids = [variable.id for variable in variables]
    sources = [_to_source(item, ids) for item in raw.get("sources") or []]
    with _cache_lock:
        _cache[project.id] = (signature, document, sources)
    return sources


def _worth_showing(source: Source) -> bool:
    return bool(source.needsChoice or source.chosen or source.fixedBy)


def state(project: store.ProjectRow) -> State:
    """The files that need a column chosen, and those that have one."""
    try:
        sources = _all_sources(project, fresh_choices=True)
    except Unavailable as error:
        return State(available=False, error=str(error))
    return State(available=True, sources=[source for source in sources if _worth_showing(source)])


def choose(project: store.ProjectRow, variable_id: str, column: str, file: str = "") -> None:
    """
    Store a variable's value column, checked against the engine's candidates.
    Raises ChoiceError when it is not one of them, Unavailable when the
    engine cannot be asked.
    """
    column = column.strip()
    file = file.strip()
    if not column:
        raise ChoiceError("Say which column is the value.")
    sources = [source for source in _all_sources(project, fresh_choices=False)
               if source.variableId == variable_id]
    with_choice = [source for source in sources if len(source.candidates) > 1 or source.chosen]
    if not with_choice:
        raise ChoiceError(
            f"The engine finds no file with several value columns in {variable_id}, "
            "so there is nothing to choose."
        )
    files = sorted({source.file for source in sources})
    if file:
        matching = [source for source in with_choice if source.file == file]
        if not matching:
            raise ChoiceError(f"{file} is not a file of {variable_id} with several value columns.")
    else:
        if len({source.file for source in with_choice}) > 1:
            raise ChoiceError(
                f"{variable_id} has several files with several value columns: say which one."
            )
        matching = with_choice
    names = sorted({candidate.name for source in matching for candidate in source.candidates})
    if column not in names:
        raise ChoiceError(
            f"`{column}` is not one of the value columns the engine found: {', '.join(names)}."
        )
    # One file in the folder: the choice is the variable's, as the engine
    # writes it for a folder of one. Several: the choice is that file's.
    scope = "" if len(files) <= 1 else (file or matching[0].file)
    _save_row(project.id, variable_id, matching[0].code, scope, column)
