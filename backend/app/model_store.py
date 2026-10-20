"""
The model file: a YAML document on disk, per project.

The editor is a plain text editor now, so this stores exactly what was typed —
comments, blank lines, key order and all. Nothing here reformats the file; it
only reads it, writes it, and says whether it parses.

Where the file lives is deliberately one place to change:

    <project out folder>/model/model.yaml

Both parts are module constants, overridable with MAPHEX_MODEL_DIRNAME and
MAPHEX_MODEL_FILENAME. A project with no results folder set falls back to the
app's own data directory, so the screen still works before one is chosen.
"""

from __future__ import annotations

import io
import os
from pathlib import Path

from . import store

#: The folder inside the project's results folder, and the file in it.
MODEL_DIRNAME = os.environ.get("MAPHEX_MODEL_DIRNAME", "model")
MODEL_FILENAME = os.environ.get("MAPHEX_MODEL_FILENAME", "model.yaml")

#: What a project's model file starts as. Mirrors the structure the README
#: documents, with the comments a first-time reader needs.
DEFAULT_MODEL_YAML = """\
# Model definition. Edit freely — this file is yours.
#
# Every variable either carries a weight and a normalization, or is an
# exclusion variable and rules a hexagon out instead. Never both.
#
# normalization: minmax | standard | intervals
#   intervals takes a list of [from, to, result] rows. A null bound is
#   unbounded, and ranges read as (from, to] — exclusive lower, inclusive
#   upper, the same as the engine's bins.

project: new_project
model: suitability_v1
objective: maximize
resolution: 8

variables:
  wind_speed:
    weight: 0.45
    exclusion_variable: false
    normalization: minmax

  terrain_slope:
    weight: 0.15
    exclusion_variable: false
    normalization: standard

  grid_access:
    weight: 0.30
    exclusion_variable: false
    normalization: minmax
    subvariables:
      distance_to_substation:
        weight: 0.60
        exclusion_variable: false
        normalization: minmax
      distance_to_road:
        weight: 0.40
        exclusion_variable: false
        normalization: standard

  land_cover:
    weight: 0.10
    exclusion_variable: false
    normalization: intervals
    intervals:
      - [null, 0.2, 1]
      - [0.2, 0.4, 2]
      - [0.4, 0.6, 3]
      - [0.6, 0.8, 4]
      - [0.8, null, 5]

  protected_area:
    exclusion_variable: true
"""


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
    place, instead of one stranded where the folder used to be.
    """
    path = model_path(project)
    if path.exists():
        return path.read_text(encoding="utf-8"), False

    write_model(project, DEFAULT_MODEL_YAML)
    return DEFAULT_MODEL_YAML, True


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


def structure_errors(text: str) -> list[dict[str, object]]:
    """
    Whether the document means anything to the engine.

    Deliberately shallow: it checks the shape the README documents and leaves
    the rest alone. The editor is meant to be free, so this rejects what cannot
    be run rather than everything that is unusual.
    """
    from ruamel.yaml import YAML  # noqa: PLC0415

    yaml = YAML(typ="safe")
    try:
        document = yaml.load(io.StringIO(text))
    except Exception:
        return []  # a syntax error is already reported; do not pile on

    problems: list[dict[str, object]] = []

    def complain(message: str) -> None:
        problems.append({"message": message, "line": None, "column": None})

    if not isinstance(document, dict):
        complain("The file must be a mapping of keys at the top level.")
        return problems

    variables = document.get("variables")
    if variables is None:
        complain("Missing `variables`: the model needs at least one variable.")
        return problems
    if not isinstance(variables, dict):
        complain("`variables` must be a mapping of names to their settings.")
        return problems

    allowed_normalizations = {"minmax", "standard", "intervals"}

    def check(name: str, body: object, trail: str) -> None:
        where = f"{trail}{name}"
        if not isinstance(body, dict):
            complain(f"`{where}` must be a mapping of settings.")
            return

        exclusive = bool(body.get("exclusion_variable", False))

        if exclusive:
            # An exclusion variable rules a hexagon out, so a weight or a
            # transform on it would never be read.
            for unexpected in ("weight", "normalization", "intervals"):
                if unexpected in body:
                    complain(
                        f"`{where}` is an exclusion variable, so it cannot also set `{unexpected}`."
                    )
        else:
            weight = body.get("weight")
            if weight is None:
                complain(f"`{where}` needs a `weight`, or `exclusion_variable: true`.")
            elif not isinstance(weight, (int, float)) or not 0 <= float(weight) <= 1:
                complain(f"`{where}`: weight must be a number between 0 and 1.")

            normalization = body.get("normalization")
            if normalization is None:
                complain(f"`{where}` needs a `normalization`.")
            elif normalization not in allowed_normalizations:
                complain(
                    f"`{where}`: normalization must be one of "
                    f"{', '.join(sorted(allowed_normalizations))}."
                )
            elif normalization == "intervals":
                rows = body.get("intervals")
                if not isinstance(rows, list) or not rows:
                    complain(f"`{where}` uses intervals, so it needs an `intervals` list.")
                else:
                    for index, row in enumerate(rows, start=1):
                        if not isinstance(row, list) or len(row) != 3:
                            complain(
                                f"`{where}` interval {index} must be [from, to, result]."
                            )
                            continue
                        low, high, result = row
                        if not isinstance(result, (int, float)):
                            complain(f"`{where}` interval {index}: the result must be a number.")
                        for bound, label in ((low, "lower"), (high, "upper")):
                            if bound is not None and not isinstance(bound, (int, float)):
                                complain(
                                    f"`{where}` interval {index}: the {label} bound must be a "
                                    f"number, or null for unbounded."
                                )
                        if (
                            isinstance(low, (int, float))
                            and isinstance(high, (int, float))
                            and low >= high
                        ):
                            complain(
                                f"`{where}` interval {index}: the lower bound must be below the "
                                f"upper one."
                            )

        children = body.get("subvariables")
        if children is not None:
            if not isinstance(children, dict):
                complain(f"`{where}`: subvariables must be a mapping.")
            else:
                for child, child_body in children.items():
                    check(str(child), child_body, f"{where}.")

    for name, body in variables.items():
        check(str(name), body, "")

    return problems


def container_model_path(project: store.ProjectRow) -> str:
    """
    Where the project's model file is *inside* the container.

    The project folder is mounted at `/data`, so the engine sees the model
    beside the data it scores. Built rather than translated from the host
    path, which would be meaningless in there.
    """
    return f"/data/{MODEL_DIRNAME}/{MODEL_FILENAME}"
