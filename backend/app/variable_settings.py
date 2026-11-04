"""
What to do with each variable's missing values: how to fill its gaps, and what
the model scores where a gap is left.

The engine splits that in two, and so does this module:

* **fill** belongs to processing. After the master table is exported, the
  engine's step 13.5 (`app/pipeline/fill_master.py`) fills each column's empty
  hexagons with a chain of methods, each one filling what the previous left
  (`spatial`, then `median`, say), inside a domain: `land`, `sea` or `all`.
  It reads that from a `transform.yaml`, which this module writes into the
  project's folder before a run (`config/transform.yaml`) and hands to the
  engine as `PROJECT_TRANSFORM`.
* **absent** belongs to the model. It is the 1-5 score a hexagon gets for a
  variable when it still has no value, and the engine asks for it on every
  leaf. It is kept here as the variable's default, and the model file this
  app writes for a project starts from it.

So every variable has both, with a default that depends on what kind of file
it is, and the Data screen shows them when the variable is added and lets them
be changed afterwards. Stored like the rest of the app's own records: a CSV
that can be opened and fixed by hand, `data/variable_settings.csv`, one row
per variable that has been changed from its default.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from pathlib import Path

from . import model_store, outputs, store

SETTINGS_CSV = store.DATA_DIR / "variable_settings.csv"
SETTINGS_FIELDS = ["project_id", "variable_id", "fill", "fill_domain", "absent", "updated_at"]

#: Where the generated `transform.yaml` goes inside the project folder, and
#: where the engine sees it (the project folder is mounted at `/data`).
TRANSFORM_RELPATH = Path(os.environ.get("MAPHEX_TRANSFORM_RELPATH", "config/transform.yaml"))
CONTAINER_TRANSFORM = f"/data/{TRANSFORM_RELPATH.as_posix()}"

#: The fill methods the engine has, in the short form this app writes. The
#: engine has a few more that need options (`quantile` with `q`, `proxy`
#: with `column`); those are for the engine's own projects. A number is a
#: fixed value (`constant`).
FILL_METHODS = ("spatial", "nearest", "idw", "region", "mean", "median")
#: `land` is every hexagon inside a municipality, `sea` the rest. A domain is
#: filled only from itself, so the sea never fills the land or the other way.
FILL_DOMAINS = ("all", "land", "sea")
#: No fill at all: the gaps stay, and `absent` scores them.
NO_FILL = "none"

#: The defaults, by the kind of file.
#:
#: A raster or a table is a measurement that should exist everywhere (wind
#: speed, a municipal rate), so a gap there is missing data: the neighbours'
#: mean, then the median of the variable for whatever is still empty. A
#: vector is usually a layer of where something is (a protected area, a
#: road), and a hexagon outside it is not a gap but an answer; spreading the
#: neighbours into it would invent presence. So vectors are not filled, and
#: `absent` decides what "not there" scores.
DEFAULT_FILL_BY_KIND = {
    "raster": "spatial, median",
    "table": "spatial, median",
    "vector": NO_FILL,
}
DEFAULT_FILL_DOMAIN = "all"
#: 1, the conservative choice: a hexagon with no value is treated as the
#: worst case until someone says otherwise. Where "no data" means "no
#: restriction" (no hazard recorded, no protected area), 5 is the answer, and
#: that is a decision per variable.
DEFAULT_ABSENT = 1.0

_KIND_BY_FORMAT = {
    "GEOTIFF": "raster",
    "CSV": "table",
    "EXCEL": "table",
}


@dataclass(frozen=True)
class VariableSettings:
    """A variable's fill and absent, and whether they are its defaults."""

    fill: str
    fillDomain: str
    absent: float
    #: True when nothing has been changed: the values are the defaults for
    #: the variable's kind of file, and follow them if those change.
    isDefault: bool


class SettingsError(ValueError):
    """A value the engine would not accept, said in words for the screen."""


def kind_of(file_format: str) -> str:
    """raster, table or vector, from the format label `inputs` gives a file."""
    return _KIND_BY_FORMAT.get(file_format.upper(), "vector")


def defaults_for(file_format: str) -> VariableSettings:
    return VariableSettings(
        fill=DEFAULT_FILL_BY_KIND[kind_of(file_format)],
        fillDomain=DEFAULT_FILL_DOMAIN,
        absent=DEFAULT_ABSENT,
        isDefault=True,
    )


# ── checking what was typed ───────────────────────────────────────────────


def parse_fill(text: str) -> list[object]:
    """
    A fill chain as typed (`spatial, median`) to the list the engine reads.

    Empty for `none`. Raises SettingsError with a readable reason otherwise,
    using the engine's own rules: known methods, numbers as fixed values, and
    `none` only on its own.
    """
    tokens = [token.strip() for token in text.replace(";", ",").split(",") if token.strip()]
    if not tokens or tokens == [NO_FILL]:
        return []
    chain: list[object] = []
    for token in tokens:
        if token == NO_FILL:
            raise SettingsError("`none` means no fill, so it goes on its own.")
        try:
            chain.append(float(token))
            continue
        except ValueError:
            pass
        if token not in FILL_METHODS:
            raise SettingsError(
                f"`{token}` is not a fill method. Use {', '.join(FILL_METHODS)}, a number "
                f"(a fixed value), or `{NO_FILL}`."
            )
        if token in chain:
            raise SettingsError(f"`{token}` is in the chain twice.")
        chain.append(token)
    return chain


def normalise_fill(text: str) -> str:
    """The chain written back the one way it is stored and shown."""
    chain = parse_fill(text)
    if not chain:
        return NO_FILL
    return ", ".join(f"{step:g}" if isinstance(step, float) else str(step) for step in chain)


def check(fill: str, fill_domain: str, absent: object) -> tuple[str, str, float]:
    """The three values, checked and normalised, or a SettingsError."""
    if fill_domain not in FILL_DOMAINS:
        raise SettingsError(f"The fill domain must be one of {', '.join(FILL_DOMAINS)}.")
    try:
        score = float(absent)  # type: ignore[arg-type]
    except (TypeError, ValueError) as error:
        raise SettingsError("`absent` must be a score from 1 to 5.") from error
    if not 1.0 <= score <= 5.0:
        raise SettingsError("`absent` must be a score from 1 to 5.")
    return normalise_fill(fill), fill_domain, score


# ── the stored values ─────────────────────────────────────────────────────


def _rows() -> list[dict[str, str]]:
    return store._read(SETTINGS_CSV, SETTINGS_FIELDS)


def _write_rows(rows: list[dict[str, str]]) -> None:
    store._write(SETTINGS_CSV, SETTINGS_FIELDS, rows)


def stored(project_id: str) -> dict[str, dict[str, str]]:
    """The rows changed from their defaults, by variable id."""
    return {row["variable_id"]: row for row in _rows() if row["project_id"] == project_id}


def settings_for(project_id: str, variable_id: str, file_format: str,
                 rows: dict[str, dict[str, str]] | None = None) -> VariableSettings:
    """A variable's settings: what was saved for it, or its defaults."""
    row = (rows if rows is not None else stored(project_id)).get(variable_id)
    if row is None:
        return defaults_for(file_format)
    default = defaults_for(file_format)
    try:
        absent = float(row["absent"]) if row["absent"] else default.absent
    except ValueError:
        absent = default.absent
    return VariableSettings(
        fill=row["fill"] or default.fill,
        fillDomain=row["fill_domain"] if row["fill_domain"] in FILL_DOMAINS else default.fillDomain,
        absent=absent,
        isDefault=False,
    )


def save(project_id: str, variable_id: str, fill: str, fill_domain: str, absent: object,
         file_format: str = "") -> None:
    """
    Store a variable's values. Raises SettingsError when one is not valid.

    Values equal to the defaults for its kind of file (`file_format`) are not
    stored: the variable keeps following the defaults, as if never changed.
    """
    fill, fill_domain, score = check(fill, fill_domain, absent)
    if file_format:
        default = defaults_for(file_format)
        if (fill, fill_domain, score) == (default.fill, default.fillDomain, default.absent):
            reset(project_id, variable_id)
            return
    rows = [row for row in _rows()
            if not (row["project_id"] == project_id and row["variable_id"] == variable_id)]
    rows.append({
        "project_id": project_id,
        "variable_id": variable_id,
        "fill": fill,
        "fill_domain": fill_domain,
        "absent": f"{score:g}",
        "updated_at": store.now(),
    })
    _write_rows(rows)


def reset(project_id: str, variable_id: str) -> bool:
    """Back to the defaults for its kind of file. Returns whether there was a row."""
    rows = _rows()
    kept = [row for row in rows
            if not (row["project_id"] == project_id and row["variable_id"] == variable_id)]
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


def _columns_by_folder(project: store.ProjectRow) -> dict[str, list[str]]:
    """
    The master columns each input folder became, from the last run's own
    record (`out/maestro/<run>/<id>.variables.csv`).

    Its `ruta_h3` is the result's path, `/data/out/<dimension>/<CODE>/...`,
    which is the variable's id in this app. A folder can become several
    columns (one per sub-dataset), and then a fill applies to all of them.
    """
    root = outputs.out_dir(project)
    if root is None:
        return {}
    exports = sorted(
        root.glob("maestro/*/tabla_maestra_programa_*.variables.csv"),
        key=lambda path: path.stat().st_mtime if path.exists() else 0,
    )
    if not exports:
        return {}
    import csv  # noqa: PLC0415
    import io  # noqa: PLC0415

    try:
        text = exports[-1].read_text(encoding="utf-8")
    except OSError:
        return {}
    found: dict[str, list[str]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        column = (row.get("columna_maestra") or "").strip()
        parts = Path((row.get("ruta_h3") or "").strip()).parts
        if not column or "out" not in parts:
            continue
        rest = parts[parts.index("out") + 1:]
        if len(rest) >= 2:
            found.setdefault(f"{rest[0]}/{rest[1]}", []).append(column)
    return found


def master_columns(project: store.ProjectRow, variable,
                   by_folder: dict[str, list[str]] | None = None) -> list[str]:
    """
    The master-table columns a variable becomes: what the last run recorded
    for its folder, or, before it has been processed, the folder's code with
    its dimension prefix uppercased, which is what the engine names a folder
    holding one dataset.
    """
    by_folder = _columns_by_folder(project) if by_folder is None else by_folder
    return by_folder.get(variable.id) or [model_store._format_code(variable.code)]


def transform_document(project: store.ProjectRow, variables: list) -> str:
    """
    The `transform.yaml` the engine reads at step 13.5: one `fill` entry per
    variable that is filled. Variables with `none` are left out, which is how
    the engine says "do not fill this one".
    """
    rows = stored(project.id)
    by_folder = _columns_by_folder(project)
    lines = [
        "# Written by Maphex from each variable's settings on the Data screen.",
        "# Edit them there: this file is rewritten before every run.",
        "# The engine fills each column's gaps with the chain, in order, inside the",
        "# domain (land = hexagons in a municipality, sea = the rest, all = both).",
        "fill:",
    ]
    entries = 0
    for variable in variables:
        if getattr(variable, "processedOnly", False) or getattr(variable, "problem", ""):
            continue
        settings = settings_for(project.id, variable.id, variable.format, rows)
        chain = parse_fill(settings.fill)
        if not chain:
            continue
        steps = ", ".join(f"{step:g}" if isinstance(step, float) else str(step) for step in chain)
        for column in master_columns(project, variable, by_folder):
            lines.append(f"  {column}: {{{settings.fillDomain}: [{steps}]}}")
            entries += 1
    if not entries:
        lines[-1] = "fill: {}"
    return "\n".join(lines) + "\n"


def write_transform(project: store.ProjectRow, variables: list) -> Path | None:
    """
    Write the project's `transform.yaml` and return where. None when the
    project has no folder to write it into.
    """
    root = outputs.data_dir(project)
    if root is None:
        return None
    path = root / TRANSFORM_RELPATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(transform_document(project, variables), encoding="utf-8")
    return path


def absent_by_column(project: store.ProjectRow, variables: list) -> dict[str, float]:
    """Each variable's `absent`, by the column it becomes, for a new model file."""
    rows = stored(project.id)
    by_folder = _columns_by_folder(project)
    found: dict[str, float] = {}
    for variable in variables:
        settings = settings_for(project.id, variable.id, variable.format, rows)
        for column in master_columns(project, variable, by_folder):
            found[column] = settings.absent
    return found


def as_dict(settings: VariableSettings) -> dict[str, object]:
    return asdict(settings)
