"""
The model file: a YAML document on disk, per project.

The editor is a plain text editor, so this stores exactly what was typed —
comments, blank lines, key order and all. Nothing here reformats the file; it
only reads it, writes it, and says whether the engine could run it.

Where the file lives is deliberately one place to change:

    <project out folder>/model/model.yaml

Both parts are module constants, overridable with MAPHEX_MODEL_DIRNAME and
MAPHEX_MODEL_FILENAME. A project with no results folder set falls back to the
app's own data directory, so the screen still works before one is chosen.

The schema is the engine's, not ours. `MCDA/engine/mcda_score.py` reads

    criteria -> subgroups -> leaves

where a leaf names a `column` of the master table and a `type` saying how its
values become a score from 1 to 5. The key lists and rules below are
transcribed from that file rather than invented here, so a document this app
calls valid is one the engine will actually run. They are copied instead of
imported because the engine lives in a container and this does not.
"""

from __future__ import annotations

import csv
import io
import os
import re
from dataclasses import dataclass
from pathlib import Path

from . import inputs, outputs, store

#: The folder inside the project's results folder, and the file in it.
MODEL_DIRNAME = os.environ.get("MAPHEX_MODEL_DIRNAME", "model")
MODEL_FILENAME = os.environ.get("MAPHEX_MODEL_FILENAME", "model.yaml")


# ── the engine's schema ───────────────────────────────────────────────────
#
# From `_TOP_KEYS` / `_CRIT_KEYS` / `_SG_KEYS` / `_LEAF_KEYS` and the
# `leaf_score` dispatch in mcda_score.py. The engine only *warns* about a key
# it does not know, which means a typo like `binz:` silently drops a leaf's
# cuts and the run still "succeeds" — worth saying out loud here.

TOP_KEYS = frozenset(
    {
        "notes",
        "criteria",
        "markers",
        "global_agg",
        "global_on_missing",
        "fill",
        "on_missing",
        "exclude_columns",
        "exclude_thresholds",
        "alert_columns",
        "alert_thresholds",
        "prioritized",
    }
)
CRITERION_KEYS = frozenset({"key", "nombre", "weight", "subgroups", "agg", "on_missing"})
SUBGROUP_KEYS = frozenset(
    {
        "key",
        "nombre",
        "weight",
        "leaves",
        "combine",
        "normalize",
        "absent",
        "domain",
        "min_coverage",
        "agg",
        "on_missing",
    }
)
LEAF_KEYS = frozenset(
    {
        "code",
        "column",
        "site",
        "type",
        "weight",
        "nombre",
        "bins",
        "map",
        "absent",
        "direction",
        "out_min",
        "out_max",
        "vmin",
        "vmax",
        "clip",
        "impute",
    }
)

#: What `leaf_score` knows how to do, and what each one needs with it.
LEAF_TYPES = frozenset({"range", "map", "direct", "minmax", "zscore"})
#: Which half of the country a leaf applies to.
SITES = frozenset({"both", "onshore", "offshore"})

#: The engine's tolerance when it checks that weights add to 1.
WEIGHT_TOLERANCE = 0.005


# ── what the project has to score ─────────────────────────────────────────


@dataclass(frozen=True)
class MasterVariable:
    """One column of the master table, as the engine recorded writing it."""

    #: The column in the master table. This is what a leaf's `column` must be.
    column: str
    #: The hyphenated label, which the engine's own configs use as `code`.
    code: str
    #: The dimension folder it came from.
    dimension: str


#: The engine's uppercasing of a leading `abc_123`, from `app/lib/shared.py`.
_DIM_CODE = re.compile(r"^[a-z]{3}_[0-9]{3}(?=_|$)", re.IGNORECASE)


def _format_code(name: str) -> str:
    return _DIM_CODE.sub(lambda match: match.group(0).upper(), name)


def master_variables(project: store.ProjectRow) -> list[MasterVariable]:
    """
    The master table's columns, from the newest export's own manifest.

    Every pipeline run writes `<id>.variables.csv` beside the master parquet,
    listing `columna_maestra` against the folder it came from. That file is
    the authority on what a leaf may name: the column is usually the folder's
    code, but `build_variable_key` appends the file name or the value column
    when a folder is ambiguous, and guessing would produce a config that
    parses and then scores nothing.
    """
    root = outputs.out_dir(project)
    if root is None:
        return []
    exports = sorted(
        root.glob("maestro/*/tabla_maestra_programa_*.variables.csv"),
        key=lambda path: path.stat().st_mtime if path.exists() else 0,
    )
    if not exports:
        return []
    try:
        text = exports[-1].read_text(encoding="utf-8")
    except OSError:
        return []

    found: list[MasterVariable] = []
    for row in csv.DictReader(io.StringIO(text)):
        column = (row.get("columna_maestra") or "").strip()
        if not column:
            continue
        found.append(
            MasterVariable(
                column=column,
                code=(row.get("nombre_columna") or column).strip(),
                dimension=(row.get("dimension") or "").strip(),
            )
        )
    return found


def _variables_from_inputs(project: store.ProjectRow) -> list[MasterVariable]:
    """
    The same list, worked out from the input tree when nothing has run yet.

    The column is the folder's code with its dimension prefix uppercased,
    which is what `leaf_var_name` produces for a folder holding one dataset —
    the ordinary case. A folder with several would be disambiguated by the
    loader, so the generated file says as much in a comment.
    """
    return [
        MasterVariable(
            column=_format_code(variable.code),
            code=_format_code(variable.code).replace("_", "-", 1),
            dimension=variable.dimension,
        )
        for variable in inputs.scan(project)
        if not variable.problem
    ]


def _shares(count: int) -> list[float]:
    """
    `count` weights adding to exactly 1, to three decimals.

    The remainder goes on the last one rather than being spread, so the
    numbers stay readable and the engine's "weights add to 1" check passes
    instead of complaining about a third of a thousandth.
    """
    if count <= 0:
        return []
    each = round(1.0 / count, 3)
    weights = [each] * count
    weights[-1] = round(1.0 - each * (count - 1), 3)
    return weights


#: The header of a generated file: what the schema means, in one place.
_PREAMBLE = """\
# The model for this project, in the shape the engine reads.
#
# Every hexagon is scored 1-5 by each leaf. The leaves of a subgroup are
# averaged by their weights, the subgroups of a criterion likewise, and the
# criteria into the one score the map shows:
#
#   criteria -> subgroups -> leaves
#
# Weights add to 1 within each level.
#
# A leaf names a `column` of the master table and a `type` saying how its
# values become a score:
#
#   minmax   the range present in the data, stretched onto 1-5. No settings.
#   zscore   the same, but around the mean (z of -2..2 becomes 1..5).
#   range    your own cuts: `bins` of [from, to, score], null for unbounded,
#            read as (from, to] — exclusive below, inclusive above.
#   map      an exact value to a score, for categories.
#   direct   the value already is a 1-5 score; use it as it stands.
#
# On a minmax or zscore leaf, `direction: cost` inverts it — for a variable
# where a high value is worse. On a range leaf, write the cuts whichever way
# round you mean.
#
# Edit this freely. The engine reads the file, so it has the final word on
# what is in it; this app only checks the shape before handing it over.
"""

#: The zoning block, which makes the file self-contained.
_ZONING = """\
# Zoning: which hexagons are ruled out before scoring, and which codes must
# be kept whatever else is dropped. Empty, so nothing is excluded.
#
# These keys being here at all is what makes the engine treat this file as
# self-contained. Without them it falls back to its own MCDA/config/zoning.yaml,
# which names variables this project does not have.
exclude_columns: []
exclude_thresholds: []
prioritized: []
"""

#: What a project with nothing processed yet gets: the shape, commented out.
_EMPTY_MODEL = """\
# Nothing has been processed yet, so there are no columns to score. Add
# variables on the Data screen and process them, then this file can name
# them. The shape is below, commented out — fill in your own columns, or
# delete this file and reopen the screen to have it written from the data.
#
# criteria:
#   - key: example
#     nombre: An example criterion
#     weight: 1.0
#     subgroups:
#       - key: variables
#         weight: 1.0
#         leaves:
#           - {code: ABC-001, column: ABC_001, site: both, type: minmax}

criteria: []

"""


def default_model(project: store.ProjectRow) -> str:
    """
    A runnable model built from what this project actually holds.

    One criterion per dimension, one subgroup under each, and a leaf per
    variable using `minmax` — the one type that needs no numbers chosen in
    advance, since it reads the range out of the data. So the file the screen
    opens with is a model the engine can score, rather than an example of a
    model about something else.
    """
    found = master_variables(project)
    from_disk = bool(found)
    if not found:
        found = _variables_from_inputs(project)

    if not found:
        return _PREAMBLE + "\n" + _EMPTY_MODEL + "\n" + _ZONING

    by_dimension: dict[str, list[MasterVariable]] = {}
    for variable in found:
        by_dimension.setdefault(variable.dimension or "sin_dimension", []).append(variable)

    lines = [_PREAMBLE, "#\n"]
    if from_disk:
        lines.append(
            "# The columns below are the ones the last run wrote into the master table.\n"
        )
    else:
        lines.append(
            "# Nothing has been processed yet, so these columns are what the loader will\n"
            "# most likely name: the variable's folder, with its code uppercased. A folder\n"
            "# holding more than one dataset gets the file name appended, so check them\n"
            "# against out/maestro/<run>/*.variables.csv after the first run.\n"
        )
    lines.append("\ncriteria:\n")

    dimension_weights = _shares(len(by_dimension))
    for (dimension, variables), weight in zip(by_dimension.items(), dimension_weights):
        lines.append(f"  - key: {dimension.lower()}\n")
        if dimension != dimension.lower():
            lines.append(f"    nombre: {dimension}\n")
        lines.append(f"    weight: {weight}\n")
        lines.append("    subgroups:\n")
        lines.append("      - key: variables\n")
        lines.append("        weight: 1.0\n")
        lines.append("        leaves:\n")
        leaf_weights = _shares(len(variables))
        for variable, leaf_weight in zip(variables, leaf_weights):
            weight_part = f", weight: {leaf_weight}" if len(variables) > 1 else ""
            lines.append(
                f"          - {{code: {variable.code}, column: {variable.column}, "
                f"site: both, type: minmax{weight_part}}}\n"
            )
        lines.append("\n")

    lines.append(_ZONING)
    return "".join(lines)


def model_path(project: store.ProjectRow) -> Path:
    """
    Where this project's model file lives.

    Inside the results folder when there is one, so the model travels with the
    project's own data. Without one, the app's data directory keeps it
    somewhere rather than refusing to open the screen at all.
    """
    if project.out_folder.strip():
        root = Path(os.path.expandvars(os.path.expanduser(project.out_folder.strip())))
    else:
        root = store.DATA_DIR / "projects" / project.id
    return root / MODEL_DIRNAME / MODEL_FILENAME


def read_model(project: store.ProjectRow) -> tuple[str, bool]:
    """
    The file's contents, and whether it had to be created.

    Seeding on first read rather than at project creation means a project made
    before the results folder was chosen still gets its file in the right
    place, instead of one stranded where the folder used to be. It also means
    the default is written once the project's variables are known, so it can
    name them.
    """
    path = model_path(project)
    if path.exists():
        return path.read_text(encoding="utf-8"), False

    seeded = default_model(project)
    write_model(project, seeded)
    return seeded, True


def write_model(project: store.ProjectRow, text: str) -> Path:
    """Write the text verbatim. Nothing is reformatted or reordered."""
    path = model_path(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def parse_errors(text: str) -> list[dict[str, object]]:
    """
    Syntax errors from the YAML parser, with positions where it gives them.

    The frontend parses too, so this is rarely the first thing to complain —
    but it is the parser that will actually read the file, so it has the final
    word.
    """
    from ruamel.yaml import YAML  # noqa: PLC0415 — only needed when validating
    from ruamel.yaml.error import MarkedYAMLError

    yaml = YAML(typ="safe")
    try:
        yaml.load(io.StringIO(text))
    except MarkedYAMLError as error:
        mark = error.problem_mark
        return [
            {
                "message": (error.problem or str(error)).strip(),
                "line": (mark.line + 1) if mark else None,
                "column": (mark.column + 1) if mark else None,
            }
        ]
    except Exception as error:  # noqa: BLE001 — any parser failure is a user-facing error
        return [{"message": str(error).strip(), "line": None, "column": None}]
    return []


# ── validation ────────────────────────────────────────────────────────────


def _line_of(node: object, key: object = None) -> int | None:
    """
    Which line a node, or one key inside it, sits on.

    Only the round-trip loader records this. Worth the slower parse: a config
    is a couple of hundred lines of nested lists, and "a leaf needs a column"
    without a line number means reading all of them.
    """
    marker = getattr(node, "lc", None)
    if marker is None:
        return None
    try:
        if key is None:
            return int(marker.line) + 1
        if isinstance(key, int):
            position = marker.item(key)
        else:
            position = marker.key(key)
    except (AttributeError, KeyError, IndexError, TypeError):
        return None
    return None if position is None else int(position[0]) + 1


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class _Problems:
    """Collects what is wrong, each with where it is and how much it matters."""

    def __init__(self) -> None:
        self.found: list[dict[str, object]] = []

    def add(self, message: str, line: int | None, severity: str = "error") -> None:
        self.found.append(
            {"message": message, "line": line, "column": None, "severity": severity}
        )

    def error(self, message: str, line: int | None = None) -> None:
        self.add(message, line, "error")

    def warn(self, message: str, line: int | None = None) -> None:
        self.add(message, line, "warning")


def _check_unknown_keys(
    problems: _Problems, node: object, allowed: frozenset[str], where: str
) -> None:
    """
    Keys the engine does not read.

    A warning, because that is what the engine calls it — but the one worth
    reading, since a mistyped `binz:` leaves a leaf with no cuts and the run
    finishes anyway, scoring nothing for it.
    """
    if not isinstance(node, dict):
        return
    for key in node:
        if str(key) not in allowed:
            problems.warn(
                f"{where}: `{key}` is not a key the engine reads, so it will be ignored.",
                _line_of(node, key),
            )


def _check_bins(problems: _Problems, bins: object, where: str, line: int | None) -> None:
    """`bins` of [from, to, score], null unbounded, read as (from, to]."""
    if not isinstance(bins, list) or not bins:
        problems.error(f"{where}: `bins` must be a non-empty list of [from, to, score].", line)
        return
    for index, row in enumerate(bins):
        at = _line_of(bins, index) or line
        if not isinstance(row, list) or len(row) != 3:
            problems.error(f"{where}: bin {index + 1} must be [from, to, score].", at)
            continue
        low, high, score = row
        if not _is_number(score):
            problems.error(f"{where}: bin {index + 1} needs a number for its score.", at)
        for bound, label in ((low, "lower"), (high, "upper")):
            if bound is not None and not _is_number(bound):
                problems.error(
                    f"{where}: bin {index + 1}'s {label} bound must be a number, "
                    "or null for unbounded.",
                    at,
                )
        if _is_number(low) and _is_number(high) and float(low) >= float(high):
            problems.error(
                f"{where}: bin {index + 1} reads as ({low}, {high}], which is empty — "
                "the lower bound must be below the upper one.",
                at,
            )


def _check_leaf(problems: _Problems, leaf: object, where: str, line: int | None) -> None:
    if not isinstance(leaf, dict):
        problems.error(f"{where} must be a mapping of leaf settings.", line)
        return

    _check_unknown_keys(problems, leaf, LEAF_KEYS, where)

    if not str(leaf.get("code", "")).strip():
        problems.warn(
            f"{where}: no `code`. The engine only uses it to name this leaf in its "
            "report and to match `prioritized`, but without one it is called `?`.",
            line,
        )

    column = leaf.get("column")
    if column is None or not str(column).strip():
        problems.error(
            f"{where} needs a `column`: the master table column holding its values.",
            _line_of(leaf, "column") or line,
        )

    site = leaf.get("site", "both")
    if str(site) not in SITES:
        problems.error(
            f"{where}: `site` must be one of {', '.join(sorted(SITES))} — "
            f"`{site}` would never apply, so the leaf would be skipped.",
            _line_of(leaf, "site") or line,
        )

    kind = leaf.get("type")
    kind_line = _line_of(leaf, "type") or line
    if kind is None:
        problems.error(f"{where} needs a `type`: how its values become a 1-5 score.", line)
        return
    if str(kind) not in LEAF_TYPES:
        problems.error(
            f"{where}: `type: {kind}` is not one the engine scores. Use one of "
            f"{', '.join(sorted(LEAF_TYPES))}.",
            kind_line,
        )
        return

    if kind == "range":
        if "bins" not in leaf:
            problems.error(f"{where}: a `range` leaf needs `bins`.", kind_line)
        else:
            _check_bins(problems, leaf["bins"], where, _line_of(leaf, "bins") or line)
    elif kind == "map":
        mapping = leaf.get("map")
        if not isinstance(mapping, dict) or not mapping:
            problems.error(
                f"{where}: a `map` leaf needs a `map` of value to score.",
                _line_of(leaf, "map") or kind_line,
            )
        else:
            for key, score in mapping.items():
                if not _is_number(score):
                    problems.error(
                        f"{where}: `map` entry `{key}` must give a number.",
                        _line_of(mapping, key) or kind_line,
                    )

    weight = leaf.get("weight")
    if weight is not None and not _is_number(weight):
        problems.error(f"{where}: `weight` must be a number.", _line_of(leaf, "weight") or line)

    direction = leaf.get("direction")
    if direction is not None and str(direction) not in {"cost", "benefit"}:
        problems.warn(
            f"{where}: `direction` is read only as `cost`, which inverts the score. "
            f"`{direction}` leaves it as it is.",
            _line_of(leaf, "direction") or line,
        )


def _leaf_weight_sums(problems: _Problems, subgroup: dict, where: str) -> None:
    """
    Whether a subgroup's leaves add to 1, with the engine's own exemptions.

    From `validate_weights`: a subgroup that normalizes, or combines with
    `min`, is not a weighted average at all; and onshore and offshore leaves
    never cover the same hexagon, so each domain is summed on its own.
    """
    if subgroup.get("normalize") is not None or subgroup.get("combine") == "min":
        return
    leaves = subgroup.get("leaves")
    if not isinstance(leaves, list) or not leaves:
        return

    sites = {str(leaf.get("site", "both")) for leaf in leaves if isinstance(leaf, dict)}
    partitions = ["both"] if sites <= {"both"} else ["onshore", "offshore"]
    for site in partitions:
        applicable = [
            leaf
            for leaf in leaves
            if isinstance(leaf, dict)
            and (site == "both" or str(leaf.get("site", "both")) in ("both", site))
        ]
        weights = [leaf.get("weight") for leaf in applicable]
        if len(applicable) <= 1 and all(weight is None for weight in weights):
            continue  # a single leaf carries the subgroup whatever it says
        total = sum(float(w) if _is_number(w) else 1.0 for w in weights)
        if abs(total - 1.0) > WEIGHT_TOLERANCE:
            tag = "" if site == "both" else f" [{site}]"
            # A leaf with no weight counts as 1, so two unweighted leaves add
            # to 2 — worth saying, because nothing in the file says otherwise.
            unweighted = (
                " A leaf with no `weight` counts as 1."
                if any(not _is_number(weight) for weight in weights)
                else ""
            )
            problems.warn(
                f"{where}{tag}: its leaves' weights add to {total:.4f}, not 1."
                f"{unweighted} The engine divides by the total either way, so the shares "
                "still hold — they just are not the numbers written here.",
                _line_of(subgroup, "leaves"),
            )


def _check_subgroup(problems: _Problems, subgroup: object, where: str, line: int | None) -> None:
    if not isinstance(subgroup, dict):
        problems.error(f"{where} must be a mapping.", line)
        return

    _check_unknown_keys(problems, subgroup, SUBGROUP_KEYS, where)

    if not str(subgroup.get("key", "")).strip():
        problems.error(f"{where} needs a `key`: its name in the results.", line)

    weight = subgroup.get("weight")
    if weight is None:
        problems.error(
            f"{where} needs a `weight`. Without one the engine reads it as 0 and the "
            "subgroup contributes nothing.",
            line,
        )
    elif not _is_number(weight):
        problems.error(f"{where}: `weight` must be a number.", _line_of(subgroup, "weight") or line)

    combine = subgroup.get("combine")
    if combine is not None and str(combine) not in {"min", "nanmean"}:
        problems.warn(
            f"{where}: `combine` is read only as `min`. `{combine}` means the default, "
            "a weighted mean.",
            _line_of(subgroup, "combine") or line,
        )

    domain = subgroup.get("domain")
    if domain is not None and str(domain) not in SITES:
        problems.error(
            f"{where}: `domain` must be one of {', '.join(sorted(SITES))}.",
            _line_of(subgroup, "domain") or line,
        )

    leaves = subgroup.get("leaves")
    leaves_line = _line_of(subgroup, "leaves") or line
    if leaves is None:
        problems.error(f"{where} needs `leaves`: the variables it scores.", line)
        return
    if not isinstance(leaves, list):
        problems.error(f"{where}: `leaves` must be a list.", leaves_line)
        return
    if not leaves:
        problems.error(f"{where}: `leaves` is empty, so the subgroup scores nothing.", leaves_line)
        return

    for index, leaf in enumerate(leaves):
        code = leaf.get("code") if isinstance(leaf, dict) else None
        label = str(code) if code else f"leaf {index + 1}"
        _check_leaf(problems, leaf, f"{where}/{label}", _line_of(leaves, index) or leaves_line)

    _leaf_weight_sums(problems, subgroup, where)


def structure_errors(text: str) -> list[dict[str, object]]:
    """
    Whether the document is a model the engine could score.

    Checks the schema `mcda_score.py` reads — criteria, subgroups, leaves —
    and nothing beyond it. Two kinds of finding come back: an error is
    something the engine would crash on or silently drop, a warning is
    something it tolerates but probably not as intended. Only syntax stops
    Apply; these are reported and left to the person reading them, because
    the engine has the final word on its own config.
    """
    from ruamel.yaml import YAML  # noqa: PLC0415

    # Round-trip rather than safe: it records line numbers, which is the
    # difference between a message you can act on and one you have to hunt.
    yaml = YAML(typ="rt")
    try:
        document = yaml.load(io.StringIO(text))
    except Exception:
        return []  # a syntax error is already reported; do not pile on

    problems = _Problems()

    if document is None:
        problems.warn("The file is empty.", None)
        return problems.found
    if not isinstance(document, dict):
        problems.error("The file must be a mapping of keys at the top level.", None)
        return problems.found

    _check_unknown_keys(problems, document, TOP_KEYS, "top level")

    criteria = document.get("criteria")
    criteria_line = _line_of(document, "criteria")
    if criteria is None:
        problems.error(
            "Missing `criteria`: the engine scores a list of criteria, each with "
            "subgroups, each with leaves.",
            None,
        )
        return problems.found
    if not isinstance(criteria, list):
        problems.error("`criteria` must be a list.", criteria_line)
        return problems.found
    if not criteria:
        problems.warn(
            "`criteria` is empty, so there is nothing to score yet. Process some "
            "variables on the Data screen and they can be named here.",
            criteria_line,
        )
        return problems.found

    for index, criterion in enumerate(criteria):
        line = _line_of(criteria, index) or criteria_line
        if not isinstance(criterion, dict):
            problems.error(f"Criterion {index + 1} must be a mapping.", line)
            continue

        key = str(criterion.get("key", "")).strip()
        where = key or f"criterion {index + 1}"
        _check_unknown_keys(problems, criterion, CRITERION_KEYS, where)

        if not key:
            problems.error(f"{where} needs a `key`: its name in the results.", line)

        weight = criterion.get("weight")
        if weight is None:
            problems.error(
                f"{where} needs a `weight`. Without one the engine reads it as 0 and "
                "the criterion contributes nothing to the score.",
                line,
            )
        elif not _is_number(weight):
            problems.error(
                f"{where}: `weight` must be a number.", _line_of(criterion, "weight") or line
            )

        subgroups = criterion.get("subgroups")
        subgroups_line = _line_of(criterion, "subgroups") or line
        if subgroups is None:
            problems.error(f"{where} needs `subgroups`.", line)
            continue
        if not isinstance(subgroups, list):
            problems.error(f"{where}: `subgroups` must be a list.", subgroups_line)
            continue
        if not subgroups:
            problems.error(
                f"{where}: `subgroups` is empty, so the criterion scores nothing.",
                subgroups_line,
            )
            continue

        for position, subgroup in enumerate(subgroups):
            label = (
                str(subgroup.get("key", "")).strip() or f"subgroup {position + 1}"
                if isinstance(subgroup, dict)
                else f"subgroup {position + 1}"
            )
            _check_subgroup(
                problems,
                subgroup,
                f"{where}/{label}",
                _line_of(subgroups, position) or subgroups_line,
            )

        total = sum(
            float(sub.get("weight", 0)) if isinstance(sub, dict) and _is_number(sub.get("weight"))
            else 0.0
            for sub in subgroups
        )
        if abs(total - 1.0) > WEIGHT_TOLERANCE:
            problems.warn(
                f"{where}: its subgroups' weights add to {total:.4f}, not 1.",
                subgroups_line,
            )

    total = sum(
        float(criterion.get("weight", 0))
        if isinstance(criterion, dict) and _is_number(criterion.get("weight"))
        else 0.0
        for criterion in criteria
    )
    if abs(total - 1.0) > WEIGHT_TOLERANCE:
        problems.warn(
            f"The criteria's weights add to {total:.4f}, not 1. The engine divides by "
            "the total, so the proportions still hold — but the numbers here no longer "
            "read as shares of the whole.",
            criteria_line,
        )

    return problems.found


def container_model_path(project: store.ProjectRow) -> str:
    """
    Where the project's model file is *inside* the container.

    The project folder is mounted at `/data`, so the engine sees the model
    beside the data it scores. Built rather than translated from the host
    path, which would be meaningless in there.
    """
    return f"/data/{MODEL_DIRNAME}/{MODEL_FILENAME}"
