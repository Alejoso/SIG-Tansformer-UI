"""
What the engine's one database currently holds.

The pipeline has a single Postgres, and nothing in it is scoped to a project:
`variables` is keyed by `variable_key` alone, and `archivo_valores` hangs off
that. So the database holds *one* project's results at a time — whichever ran
last — and loading a second project's variables on top of the first would
merge them into one master table with no indication that two datasets had
been mixed.

Today that cannot happen only because `.env` sets `FORCE_MASTER_REBUILD=1`,
which truncates everything on every run. It is also why a run takes five and
a half minutes to do fifty seconds of work: the H3 master, the grid and the
PMTiles are rebuilt each time, and none of them depend on the project at all
— they come from the boundaries in `admin/`.

Those are separable. `RESET_ARCHIVOS=1` truncates `archivos`, `variables` and
`archivo_valores` and leaves the master alone, which is exactly what switching
projects needs. So this module tracks what the database last had in it, and a
run clears those tables only when it has to:

* another project ran last — otherwise its variables are still in there;
* a variable was removed from this project — an incremental load never
  deletes rows, it only upserts the files it finds;
* the last run did not finish — the load may have stopped halfway;
* someone ran the pipeline outside this app, so we cannot vouch for it.

Everything else runs incrementally and reuses the master.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from . import pipeline, store

#: Beside the CSVs, for the same reason: you can open it and read it.
STATE_FILE = store.DATA_DIR / "engine_state.json"


@dataclass
class EngineState:
    """Our record of what is in the engine's database."""

    #: The project whose variables the database holds.
    lastProjectId: str = ""
    #: The engine's id for that run, so a run started outside this app — in a
    #: terminal, by someone else — can be noticed.
    lastExecutionId: str = ""
    #: Projects that have changed in a way an incremental load cannot express.
    stale: list[str] = field(default_factory=list)


def read() -> EngineState:
    try:
        raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return EngineState()
    return EngineState(
        lastProjectId=str(raw.get("lastProjectId", "")),
        lastExecutionId=str(raw.get("lastExecutionId", "")),
        stale=[str(item) for item in raw.get("stale", [])],
    )


def _write(state: EngineState) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = STATE_FILE.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(vars(state), indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, STATE_FILE)
    except OSError:
        # Losing this costs a needless full reload, not correctness: an
        # unreadable state reads as "we cannot vouch for the database".
        pass


def mark_stale(project_id: str) -> None:
    """Record that this project needs its tables cleared before loading again."""
    state = read()
    if project_id not in state.stale:
        state.stale.append(project_id)
        _write(state)


def _newest_execution() -> str:
    """The most recent run in the engine's logs, whoever started it."""
    log_dir = pipeline.manifest_path("x").parent.parent
    if not log_dir.is_dir():
        return ""
    folders = [f for f in log_dir.iterdir() if f.is_dir() and (f / "run.json").is_file()]
    if not folders:
        return ""
    return max(folders, key=lambda f: f.stat().st_mtime).name


def plan_reload(project: store.ProjectRow) -> tuple[bool, str]:
    """
    Whether this run must clear the database first, and why.

    The reason is carried through to the UI rather than kept here: "this is
    taking longer because another project ran last" is the sort of thing that
    otherwise looks like the app being slow at random.
    """
    state = read()

    if not state.lastProjectId:
        return True, "nothing is recorded about what the database holds"
    if state.lastProjectId != project.id:
        return True, "another project ran last, and its variables are still loaded"
    if project.id in state.stale:
        return True, "a variable was removed since the last run"

    newest = _newest_execution()
    if newest and state.lastExecutionId and newest != state.lastExecutionId:
        return True, "the pipeline was run outside this app since last time"

    return False, ""


def record_run(project_id: str, execution_id: str, succeeded: bool) -> None:
    """
    Remember what the database now holds.

    A run that did not finish leaves it marked stale: the load may have
    stopped halfway through, and a needless clear next time costs seconds
    where a wrong master table costs a result nobody questions.
    """
    state = read()
    state.lastProjectId = project_id
    state.lastExecutionId = execution_id
    if succeeded:
        state.stale = [item for item in state.stale if item != project_id]
    elif project_id not in state.stale:
        state.stale.append(project_id)
    _write(state)
