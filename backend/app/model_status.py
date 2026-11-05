"""
Whether the model's last run still describes the data.

The model scores the master table, and the master table is rebuilt by every
processing run. A run of the model made before that is still what the map
shows, and nothing said it might be out of date. Two things can make it so:

* **the data moved under it.** The engine works that out for itself: after
  processing, and after each model run, its `model_status.py` compares the
  columns of the master each model last ran on with the current one and
  writes `out/model_status.json`. Each changed column is weighed by what it
  does in the model (a scored leaf, an exclusion, an alert, a leaf weighted
  zero), so the answer is not just "something changed" but how much it
  matters: `rerun` > `remask` > `alerts_only` > `informative_only` >
  `up_to_date`, plus `never_run` and `unknown`.
* **the model file moved.** Edited and saved since the last Apply. That one
  is checked here as well, against the copy the run kept of the file it ran
  (`config_used.yaml`), because it changes the moment the file is saved and
  the engine only looks after a run.

The file's shape is the engine's contract (agreed with its `model_status.py`):

    {"generated_at": "...", "master": {"path": "...", "run": "<exec id>"},
     "models": {"<model>": {"status": "...", "last_run": "...",
       "last_run_master": "...", "config_changed": false,
       "changed": [{"column": "SOC_001", "role": "score", "leaves": ["SOC-001"]}],
       "reason": "..."}}}

For the engine to write it for this app's projects, which load none of its
own, a run is told where the model and its runs are (`env`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from . import model_store, outputs, store

#: Where the engine writes it, relative to DATA_DIR.
STATUS_RELPATH = Path("out/model_status.json")

#: From strongest to weakest, as the engine ranks them.
LEVELS = ("rerun", "remask", "alerts_only", "informative_only", "up_to_date")


@dataclass
class ChangedColumn:
    """A column of the master that changed, and what it is to the model."""

    column: str
    #: score, exclusion, alert, informative or unused.
    role: str
    #: The leaves that read it, by code.
    leaves: list[str] = field(default_factory=list)


@dataclass
class ModelStatus:
    """What the screens need to say whether to apply the model again."""

    #: Everything taken together: one of `LEVELS`, `never_run` or `unknown`.
    status: str
    #: What the engine's file says on its own, or empty without one (or when
    #: it is older than the last run, and so says nothing about it).
    engineStatus: str = ""
    #: The model file differs from the one the last run used.
    configChanged: bool = False
    #: The newest run of the model, which the map draws.
    lastRun: str = ""
    #: When the engine last checked, and the processing run whose master
    #: it checked against.
    checkedAt: str = ""
    masterRun: str = ""
    changed: list[ChangedColumn] = field(default_factory=list)
    #: In a sentence, for the screen.
    reason: str = ""


def env(project: store.ProjectRow) -> dict[str, str]:
    """
    What a run needs to have the engine refresh `model_status.json` for this
    project: where the model file and its runs are inside the container.
    Nothing when there is no model file yet, since there is nothing to check.
    """
    if not model_store.model_path(project).is_file():
        return {}
    return {
        "MCDA_STATUS_CONFIG": model_store.container_model_path(project),
        "MCDA_RUNS_DIR": f"/data/{outputs.MCDA_RUNS_DIRNAME}",
    }


def _read_status_file(project: store.ProjectRow) -> dict | None:
    root = outputs.data_dir(project)
    if root is None:
        return None
    try:
        data = json.loads((root / STATUS_RELPATH).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _config_used(run_folder: Path) -> Path | None:
    """The copy of the model file a run kept, in its folder or one below it."""
    direct = run_folder / "config_used.yaml"
    if direct.is_file():
        return direct
    found = sorted(run_folder.glob("*/config_used.yaml"))
    return found[0] if found else None


def _same_model(current: str, used: str) -> bool:
    """
    Whether two model files say the same thing.

    Compared parsed, so a comment or the spacing does not count as a change:
    the engine would score the same either way. A file that does not parse
    is compared as text.
    """
    from ruamel.yaml import YAML  # noqa: PLC0415

    try:
        return YAML(typ="safe").load(current) == YAML(typ="safe").load(used)
    except Exception:  # noqa: BLE001 - not YAML, so text is all there is
        return current.strip() == used.strip()


def config_changed(project: store.ProjectRow, run: str) -> bool:
    """Whether the model file has changed since `run` used it."""
    root = outputs.data_dir(project)
    path = model_store.model_path(project)
    if root is None or not path.is_file():
        return False
    used = _config_used(root / outputs.MCDA_RUNS_DIRNAME / run)
    if used is None:
        return False
    try:
        return not _same_model(
            path.read_text(encoding="utf-8"), used.read_text(encoding="utf-8")
        )
    except OSError:
        return False


def _pick_model(models: dict, newest: str) -> dict | None:
    """
    This project's entry. It has one model file, so normally the file holds
    one model; otherwise the one whose last run is the newest here.
    """
    entries = [entry for entry in models.values() if isinstance(entry, dict)]
    if len(entries) == 1:
        return entries[0]
    return next((entry for entry in entries if entry.get("last_run") == newest), None)


def _older_than(stamp: str, folder: Path) -> bool:
    """Whether an ISO time is before the folder was last written."""
    try:
        checked = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
        return checked < folder.stat().st_mtime
    except (ValueError, OSError):
        return False


def status(project: store.ProjectRow) -> ModelStatus:
    """The model's state for this project, from the engine's file and the model file."""
    runs = outputs.scan_model_runs(project)
    if not runs:
        return ModelStatus(status="never_run", reason="The model has not been applied yet.")
    newest = runs[0]
    root = outputs.data_dir(project)
    result = ModelStatus(status="unknown", lastRun=newest)

    data = _read_status_file(project)
    entry = None
    if data is not None:
        result.checkedAt = str(data.get("generated_at") or "")
        result.masterRun = str((data.get("master") or {}).get("run") or "")
        entry = _pick_model(data.get("models") or {}, newest)
        # Written before the newest run finished, it describes an older one:
        # the newest may already have used the current master.
        if (
            entry is not None
            and entry.get("last_run") not in (None, "", newest)
            and root is not None
            and _older_than(result.checkedAt, root / outputs.MCDA_RUNS_DIRNAME / newest)
        ):
            entry = None

    if entry is not None:
        result.engineStatus = str(entry.get("status") or "")
        result.reason = str(entry.get("reason") or "")
        result.changed = [
            ChangedColumn(
                column=str(item.get("column", "")),
                role=str(item.get("role", "")),
                leaves=[str(leaf) for leaf in item.get("leaves") or []],
            )
            for item in entry.get("changed") or []
            if isinstance(item, dict)
        ]
        # `never_run` from the engine means it found none of this project's
        # runs, and there is at least one: that is not knowing.
        if result.engineStatus in LEVELS:
            result.status = result.engineStatus

    result.configChanged = config_changed(project, newest) or bool(
        entry and entry.get("config_changed")
    )
    if result.configChanged:
        result.status = "rerun"
        if not result.reason or result.engineStatus in ("up_to_date", "informative_only", ""):
            result.reason = "The model file has changed since it was last applied."
    elif result.status == "unknown" and not result.reason:
        result.reason = (
            "The engine has not checked this model against the current data yet. "
            "Processing again, or applying the model, writes that check."
        )
    return result
