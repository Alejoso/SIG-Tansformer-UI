"""
Discovering what the pipeline actually produced.

A project's folder is the pipeline's `DATA_DIR`: inputs under `in/`, results
under `out/`. Variables come out as a flat mirror of how they went in —

    <DATA_DIR>/in/<dimension>/<CODE>/<name>.shp
    <DATA_DIR>/out/<dimension>/<CODE>/<name>.h3.parquet
                                      <name>.h3.html
                                      <name>.pipeline.jsonl

— which is why the input side of the sidebar is a flat list, while the model,
which comes out nested by criterion and subcriterion, is a tree.

Nothing here runs the pipeline. It reads what is on disk, so it works whether
or not Docker is up.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import store

#: The rendered map that sits beside each artefact.
HTML_SUFFIX = ".h3.html"
#: The per-variable log the pipeline writes next to it.
LOG_SUFFIX = ".pipeline.jsonl"

#: Folders under `out/` that hold pipeline bookkeeping rather than variables.
NOT_DIMENSIONS = {"exports", "maestro", "verify", "render", "bck"}


def data_dir(project: store.ProjectRow) -> Path | None:
    """
    The project's `DATA_DIR`, or None when it has no folder set.

    This is the same directory the pipeline is pointed at — the contract's
    advice for separating projects is simply to change it.
    """
    raw = project.out_folder.strip()
    if not raw:
        return None
    return Path(os.path.expandvars(os.path.expanduser(raw)))


def out_dir(project: store.ProjectRow) -> Path | None:
    root = data_dir(project)
    return None if root is None else root / "out"


def _slug(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_")


def _humanise(stem: str, code: str = "") -> str:
    """
    A readable name for a layer.

    `pct_exito_mw_onshore` → `Pct exito mw onshore`.

    Some files are named after their code and nothing else — `soe_001_SOE-001`
    inside `SOE_001` — which would read as "Soe 001 SOE 001". When stripping
    the code leaves nothing behind, the code itself is the only name there is.
    """
    normal = _slug(stem).lower()
    key = _slug(code).lower()

    if key:
        for _ in range(2):  # it can appear at both ends
            if normal.startswith(key):
                normal = normal[len(key):].strip("_")
            elif normal.endswith(key):
                normal = normal[: -len(key)].strip("_")

    if not normal:
        return code.replace("_", " ")

    words = normal.replace("_", " ").strip()
    return words[:1].upper() + words[1:]


@dataclass
class VariableLayer:
    """One rendered variable, and how its run went."""

    id: str
    label: str
    #: The variable code, e.g. REG_001.
    code: str
    #: The dimension folder it came from, e.g. 10_socioeconomico.
    dimension: str
    #: Path to the rendered HTML, relative to `out/`.
    relpath: str
    #: The file's own name, so the UI can say which document is on screen.
    filename: str
    sizeBytes: int
    #: Stage names from the per-variable log, in order.
    stages: list[str] = field(default_factory=list)
    #: True when every stage it logged reported ok.
    ok: bool = True
    #: The run that produced it.
    executionId: str = ""


def _read_variable_log(log_path: Path) -> tuple[list[str], bool, str]:
    """
    Stages and status from a `.pipeline.jsonl`.

    Worth reading because the pipeline deliberately carries on past a bad
    file: a variable can be present and still have failed, and a clean exit
    code says nothing about it either way.
    """
    stages: list[str] = []
    ok = True
    execution_id = ""

    if not log_path.exists():
        return stages, ok, execution_id

    for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        execution_id = entry.get("execution_id", execution_id) or execution_id
        if entry.get("event") == "variable_stage":
            stages.append(str(entry.get("stage", "?")))
            if entry.get("status") not in ("ok", None):
                ok = False
        elif entry.get("level") == "ERROR" or entry.get("status") == "error":
            ok = False

    return stages, ok, execution_id


def scan_variables(project: store.ProjectRow) -> list[VariableLayer]:
    """Every rendered variable under `out/`, alphabetical by label."""
    root = out_dir(project)
    if root is None or not root.is_dir():
        return []

    found: list[VariableLayer] = []
    for html in sorted(root.rglob(f"*{HTML_SUFFIX}")):
        relative = html.relative_to(root)
        parts = relative.parts
        # Expect <dimension>/<CODE>/<name>.h3.html; anything shallower is
        # bookkeeping rather than a variable.
        if len(parts) < 3 or parts[0] in NOT_DIMENSIONS:
            continue

        dimension, code = parts[0], parts[1]
        stem = html.name[: -len(HTML_SUFFIX)]
        stages, ok, execution_id = _read_variable_log(html.with_name(stem + LOG_SUFFIX))

        found.append(
            VariableLayer(
                id=_slug(str(relative)),
                label=_humanise(stem, code),
                code=code,
                dimension=dimension,
                relpath=str(relative),
                filename=html.name,
                sizeBytes=html.stat().st_size,
                stages=stages,
                ok=ok,
                executionId=execution_id,
            )
        )

    found.sort(key=lambda v: v.label.lower())
    return found


def document_path(project: store.ProjectRow, node_id: str) -> Path | None:
    """
    Resolve a node id back to its file.

    Resolved by re-scanning and matching ids rather than by joining the id
    onto a path: an id never reaches the filesystem, so a crafted one cannot
    escape `out/`.
    """
    root = out_dir(project)
    if root is None:
        return None
    for variable in scan_variables(project):
        if variable.id == node_id:
            candidate = root / variable.relpath
            return candidate if candidate.is_file() else None
    return None


# ── the model side ────────────────────────────────────────────────────────

#: Where `mcda_score.py` writes its runs, relative to DATA_DIR.
MCDA_RUNS_DIRNAME = os.environ.get("MAPHEX_MCDA_RUNS_DIRNAME", "MCDA/runs")


def scan_model_runs(project: store.ProjectRow) -> list[str]:
    """
    Model runs available for this project, newest first.

    The model comes out nested by criterion and subcriterion, which is the
    tree the sidebar draws. Nothing has produced one yet, so this returns an
    empty list and the UI says so rather than inventing a shape.
    """
    root = data_dir(project)
    if root is None:
        return []
    runs = root / MCDA_RUNS_DIRNAME
    if not runs.is_dir():
        return []
    return sorted((d.name for d in runs.iterdir() if d.is_dir()), reverse=True)
