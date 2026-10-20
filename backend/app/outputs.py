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

#: The rendered map that sits beside each artefact, and the per-variable log
#: next to it — each in both spellings the pipeline uses.
#:
#: Two spellings because the pipeline renames its own output. Its
#: `lint_filenames` step sanitises `data/out` as well as `data/in`, and only
#: `.h3.parquet` is on its list of suffixes to leave alone — so on the run
#: after the one that wrote them, `x.h3.html` becomes `x_h3.html` and
#: `x.pipeline.jsonl` becomes `x_pipeline.jsonl`. Matching only the freshly
#: written spelling meant the sidebar emptied itself on the second run, with
#: the files still sitting there under their other name.
HTML_SUFFIXES = (".h3.html", "_h3.html")
LOG_SUFFIXES = (".pipeline.jsonl", "_pipeline.jsonl")

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


def _strip_suffix(name: str, suffixes: tuple[str, ...]) -> str:
    """The name without whichever of the suffixes it ends with."""
    for suffix in suffixes:
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _sibling_log(html: Path, stem: str) -> Path:
    """
    The per-variable log beside a rendered document.

    Tries both spellings, because the document and its log are not always
    renamed in the same pass — a run can leave `x.h3.html` next to
    `x_pipeline.jsonl`.
    """
    for suffix in LOG_SUFFIXES:
        candidate = html.with_name(stem + suffix)
        if candidate.is_file():
            return candidate
    return html.with_name(stem + LOG_SUFFIXES[0])


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


def _documents(root: Path) -> list[Path]:
    """
    One rendered document per variable, newest spelling first.

    Both spellings often sit in the same folder: the pipeline's lint renames
    `x.h3.html` to `x_h3.html` on one run, and the next run's render writes
    `x.h3.html` again beside it. They are the same map — byte-identical here —
    so listing both would show every variable twice in the sidebar. The
    freshly written spelling wins; the renamed one is only used when it is
    all that is left.
    """
    best: dict[tuple[Path, str], tuple[int, Path]] = {}
    for rank, suffix in enumerate(HTML_SUFFIXES):
        for html in root.rglob(f"*{suffix}"):
            key = (html.parent, _strip_suffix(html.name, HTML_SUFFIXES))
            current = best.get(key)
            if current is None or rank < current[0]:
                best[key] = (rank, html)
    return sorted(path for _, path in best.values())


def scan_variables(project: store.ProjectRow) -> list[VariableLayer]:
    """Every rendered variable under `out/`, alphabetical by label."""
    root = out_dir(project)
    if root is None or not root.is_dir():
        return []

    found: list[VariableLayer] = []
    for html in _documents(root):
        relative = html.relative_to(root)
        parts = relative.parts
        # Expect <dimension>/<CODE>/<name>.h3.html; anything shallower is
        # bookkeeping rather than a variable.
        if len(parts) < 3 or parts[0] in NOT_DIMENSIONS:
            continue

        dimension, code = parts[0], parts[1]
        stem = _strip_suffix(html.name, HTML_SUFFIXES)
        stages, ok, execution_id = _read_variable_log(_sibling_log(html, stem))

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


@dataclass
class ModelLayer:
    """One rendered document from a model run."""

    id: str
    label: str
    description: str
    relpath: str
    filename: str
    sizeBytes: int
    children: list["ModelLayer"]


#: Where the model puts each level of its own result. It renders the whole
#: model, each criterion and each subcriterion separately, which is the tree
#: the sidebar draws — so the folders are read rather than a shape invented.
MODEL_WHOLE = "criterios/global"
MODEL_CRITERIA = "criterios"
MODEL_SUBCRITERIA = "subcriterios"


def _model_document(folder: Path) -> Path | None:
    """The rendered map in a folder, if it has one."""
    for suffix in HTML_SUFFIXES:
        found = sorted(folder.glob(f"*{suffix}"))
        if found:
            return found[0]
    found = sorted(folder.glob("*.html"))
    return found[0] if found else None


def scan_model(project: store.ProjectRow, run: str | None = None) -> ModelLayer | None:
    """
    The newest model run, as the tree it was rendered in.

    `criterios/global` is the whole model, `criterios/<key>` each criterion
    and `subcriterios/<key>/<sub>` each subcriterion beneath it. The engine
    names the folders after the keys in the config, so what the sidebar shows
    is what was written in the model file.
    """
    root = data_dir(project)
    if root is None:
        return None
    runs = scan_model_runs(project)
    chosen = run or (runs[0] if runs else None)
    if chosen is None:
        return None

    base = root / MCDA_RUNS_DIRNAME / chosen
    whole = _model_document(base / MODEL_WHOLE) if (base / MODEL_WHOLE).is_dir() else None

    criteria: list[ModelLayer] = []
    criteria_dir = base / MODEL_CRITERIA
    if criteria_dir.is_dir():
        for folder in sorted(p for p in criteria_dir.iterdir() if p.is_dir()):
            if folder.name == "global":
                continue
            document = _model_document(folder)
            subs: list[ModelLayer] = []
            sub_dir = base / MODEL_SUBCRITERIA / folder.name
            if sub_dir.is_dir():
                for sub in sorted(p for p in sub_dir.iterdir() if p.is_file()):
                    if not any(sub.name.endswith(s) for s in (*HTML_SUFFIXES, ".html")):
                        continue
                    subs.append(
                        ModelLayer(
                            id=_slug(f"{chosen}/sub/{folder.name}/{sub.name}"),
                            label=_humanise(_strip_suffix(sub.name, (*HTML_SUFFIXES, ".html"))),
                            description="Subcriterion",
                            relpath=str(sub.relative_to(root)),
                            filename=sub.name,
                            sizeBytes=sub.stat().st_size,
                            children=[],
                        )
                    )
            if document is None and not subs:
                continue
            criteria.append(
                ModelLayer(
                    id=_slug(f"{chosen}/crit/{folder.name}"),
                    label=_humanise(folder.name),
                    description="Criterion",
                    relpath=str(document.relative_to(root)) if document else "",
                    filename=document.name if document else "",
                    sizeBytes=document.stat().st_size if document else 0,
                    children=subs,
                )
            )

    return ModelLayer(
        id=_slug(f"{chosen}/global"),
        label="Complete model",
        description=f"Run {chosen}",
        relpath=str(whole.relative_to(root)) if whole else "",
        filename=whole.name if whole else "",
        sizeBytes=whole.stat().st_size if whole else 0,
        children=criteria,
    )


def model_document_path(project: store.ProjectRow, node_id: str) -> Path | None:
    """Resolve a model node id back to its file, by re-scanning and matching."""
    root = data_dir(project)
    tree = scan_model(project)
    if root is None or tree is None:
        return None

    def walk(node: ModelLayer):
        yield node
        for child in node.children:
            yield from walk(child)

    for node in walk(tree):
        if node.id == node_id and node.relpath:
            candidate = root / node.relpath
            return candidate if candidate.is_file() else None
    return None


def scan_model_runs(project: store.ProjectRow) -> list[str]:
    """
    Model runs available for this project, newest first.

    The model comes out nested by criterion and subcriterion, which is the
    tree the sidebar draws — see `scan_model`.
    """
    root = data_dir(project)
    if root is None:
        return []
    runs = root / MCDA_RUNS_DIRNAME
    if not runs.is_dir():
        return []
    return sorted((d.name for d in runs.iterdir() if d.is_dir()), reverse=True)
