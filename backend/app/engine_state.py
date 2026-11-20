"""
What each project's database currently holds.

Every project runs on a database of its own (`pipeline.project_database`):
the engine's tables are not scoped to a project (`variables` is keyed by
`variable_key` alone, and `archivo_valores` hangs off that), so two projects
in one database would merge their variables into one master table, and a
project on another mesh would rebuild the master under the other. One
database each makes that impossible, and lets every project keep its master
between runs.

Within its own database a project still runs incrementally, and this module
keeps, per project, what its database was last loaded with, so a run clears
the project's tables (`RESET_FILES=1`, which truncates `archivos`,
`variables` and `archivo_valores` and leaves the master alone) only when it
has to:

* nothing is recorded for the project (its first run here, or a record from
  before projects had a database each);
* a variable was removed from the project;
* the last run did not finish, so the load may have stopped halfway;
* someone ran the pipeline on the project's database outside this app, so we
  cannot vouch for it;
* results that were loaded have gone from disk.

Another project running in between no longer matters: it runs on its own
database.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from . import outputs, pipeline, store

#: Beside the CSVs, for the same reason: you can open it and read it.
STATE_FILE = store.DATA_DIR / "engine_state.json"


@dataclass
class ProjectState:
    """Our record of what is in one project's database."""

    #: The engine's id for the last run on it, so a run started outside this
    #: app on the same database (in a terminal, by someone else) is noticed.
    lastExecutionId: str = ""
    #: Changed in a way an incremental load cannot express.
    stale: bool = False
    #: The results the database was loaded from, as `<dimension>/<CODE>` (or
    #: deeper, for a nested variable). Compared against what is on disk now:
    #: a result removed outside this app would otherwise stay in the master
    #: table with nothing behind it.
    lastOutputs: list[str] = field(default_factory=list)


def _read_all() -> dict[str, ProjectState]:
    try:
        raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    # The file from before projects had a database each (one `lastProjectId`
    # for the one shared database) has no `projects`: it says nothing about
    # the new databases, so every project starts without a record.
    projects = raw.get("projects") if isinstance(raw, dict) else None
    if not isinstance(projects, dict):
        return {}
    states = {}
    for project_id, item in projects.items():
        if not isinstance(item, dict):
            continue
        states[str(project_id)] = ProjectState(
            lastExecutionId=str(item.get("lastExecutionId", "")),
            stale=bool(item.get("stale", False)),
            lastOutputs=[str(x) for x in item.get("lastOutputs", [])],
        )
    return states


def read(project_id: str) -> ProjectState | None:
    """The record for one project, or None when there is none."""
    return _read_all().get(project_id)


def _write_all(states: dict[str, ProjectState]) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = STATE_FILE.with_suffix(".json.tmp")
        payload = {"projects": {key: vars(value) for key, value in sorted(states.items())}}
        temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, STATE_FILE)
    except OSError:
        # Losing this costs a needless clear of the project's tables, not
        # correctness: no record reads as "we cannot vouch for the database".
        pass


def mark_stale(project_id: str) -> None:
    """Record that this project needs its tables cleared before loading again."""
    states = _read_all()
    state = states.setdefault(project_id, ProjectState())
    if not state.stale:
        state.stale = True
        _write_all(states)


def output_set(project: store.ProjectRow) -> list[str]:
    """
    The results currently on disk, as the engine would find them.

    Mirrors what `load_h3_values` picks up: a folder per variable under
    `out/<dimension>/`, at any depth (`tec/TEC_001_t/TEC_001_sv003`),
    skipping the pipeline's own products.
    """
    root = outputs.out_dir(project)
    if root is None or not root.is_dir():
        return []
    return ["/".join(parts) for parts in outputs.result_folders(root, outputs.LOADED_SUFFIXES)]


def _run_database(folder: Path) -> str:
    """The `POSTGRES_DB` a logged run was given, from its `invocation.json`."""
    try:
        raw = json.loads((folder / "invocation.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    variables = raw.get("variables") if isinstance(raw, dict) else None
    return str(variables.get("POSTGRES_DB", "")) if isinstance(variables, dict) else ""


def _newest_execution(database: str) -> str:
    """The most recent processing run on `database` in the engine's logs, whoever started it."""
    log_dir = pipeline.manifest_path("x").parent.parent
    if not log_dir.is_dir():
        return ""
    folders = [f for f in log_dir.iterdir()
               if f.is_dir() and "_rf_" in f.name and (f / "run.json").is_file()
               and _run_database(f) == database]
    if not folders:
        return ""
    return max(folders, key=lambda f: f.stat().st_mtime).name


def plan_reload(project: store.ProjectRow) -> tuple[bool, str]:
    """
    Whether this run must clear the project's tables first, and why.

    The reason is carried through to the UI rather than kept here: "this is
    taking longer because a variable was removed" is the sort of thing that
    otherwise looks like the app being slow at random.
    """
    state = read(project.id)

    if state is None:
        return True, "nothing is recorded about what this project's database holds"
    if state.stale:
        return True, "a variable was removed, or the last run did not finish"

    newest = _newest_execution(pipeline.project_database(project.id))
    if newest and state.lastExecutionId and newest != state.lastExecutionId:
        return True, "the pipeline was run on this project's database outside this app"

    gone = sorted(set(state.lastOutputs) - set(output_set(project)))
    if gone:
        return True, f"results that were loaded have gone from disk ({', '.join(gone)})"

    return False, ""


def record_run(
    project_id: str,
    execution_id: str,
    succeeded: bool,
    loaded: list[str] | None = None,
) -> None:
    """
    Remember what the project's database now holds.

    A run that did not finish leaves it marked stale: the load may have
    stopped halfway through, and a needless clear next time costs seconds
    where a wrong master table costs a result nobody questions.
    """
    states = _read_all()
    states[project_id] = ProjectState(
        lastExecutionId=execution_id,
        stale=not succeeded,
        lastOutputs=loaded if loaded is not None else [],
    )
    _write_all(states)
