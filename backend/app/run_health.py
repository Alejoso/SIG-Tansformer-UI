"""
What the last processing run left out, beyond what the output folders say.

`outputs.scan_problems` reads the reason a variable failed from the folder
its results should be in. That covers every variable the engine got far
enough with to write something down. It misses the ones it never reached: a
variable whose folder under `out/` is empty, or absent, has no log and no
note, so it was in no count at all. On the Data screen it was simply one of
the hundred, and on the map it was not there.

The usual way that happens is the engine running out of memory. Its stages
read files in a pool of worker processes, and the system kills one that uses
too much. An engine from before its `worker_pool` then reported every file
still in that pool as "A process in the process pool was terminated
abruptly", naming none of them, and carried on and reported success. The
current one retries those files one at a time (most then read fine) and
names each file that died even alone, in the stage's log and in the
variable's own. So this module also reads the last run's logs for either, to
say which stage it was and what to change.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import engine_state, inputs, outputs, pipeline, store

#: What the current engine writes for a file whose worker the system killed
#: even when it ran alone (`worker_pool.killed_reason`): in the stage's log, as
#: an ERROR, and as the error in that variable's own log. Step 10.5 words it
#: the same, after "fallo la correccion del paso 10.5: ". The warning it
#: writes first, "N tarea(s) se quedaron sin proceso ... se reintentan de a
#: una", is not a failure: most of those files are then read fine.
KILLED_ALONE = "el sistema termino el proceso que lo procesaba"

#: What an engine from before that wrote instead, once per file it gave up
#: on: Python's words for a process pool whose worker died, and what a worker
#: that died outright, or ran out cleanly, leaves. Case-sensitive and whole
#: words, and (as for KILLED_ALONE) only on lines above INFO: these are
#: read out of messages that also carry file names, and a dataset called
#: `killed_wildlife_2020.shp` is not a crash.
_KILLED_BEFORE = re.compile(
    r"terminated abruptly|\bBrokenProcessPool\b|\bMemoryError\b|\b[Oo]ut of memory\b|"
    r"\bKilled\b|exit code -9\b|exitcode=-9\b|\bsignal 9\b|\bSIGKILL\b"
)

#: Levels that never carry a failure, when a line has one.
_QUIET_LEVELS = frozenset({"DEBUG", "INFO"})

#: How many files a stage reads at once, as its log says it: ingest and the
#: H3 conversion as `workers=N`, the raster stage as "en paralelo con N workers".
_WORKERS = (
    re.compile(r"workers=(\d+)"),
    re.compile(r"en paralelo con (\d+) workers"),
)


def _counts_as_killed(entry: dict) -> bool:
    """Whether one line of a stage's log is a file lost to the system killing its worker."""
    if str(entry.get("level") or "").upper() in _QUIET_LEVELS:
        return False
    message = str(entry.get("msg") or entry.get("message") or "")
    return KILLED_ALONE in message or bool(_KILLED_BEFORE.search(message))


#: The engine's setting for how many files each stage reads at once, by the
#: name of the stage's script (which is also its log's name). Fewer at once
#: is less memory at once.
WORKER_SETTINGS = {
    "ingest_to_geoparquet": "INGEST_WORKERS",
    "raster_to_h3": "RASTER_WORKERS",
    "parquet_to_h3": "H3_WORKERS",
    "load_h3_values": "LOAD_WORKERS",
    # Step 10.5 reads in a pool of H3_WORKERS processes, and names it.
    "apply_variable_fixes": "H3_WORKERS",
}

#: The engine's own default for its memory, as its compose file has it.
DEFAULT_MEMORY = "8g"


@dataclass
class KilledStage:
    """One stage that lost workers to the system."""

    #: The script, as the engine names its log: `ingest_to_geoparquet`.
    script: str
    #: What the stage does, as the processing screen calls it.
    label: str
    #: How many files it gave up on because of it.
    failed: int
    #: How many it was reading at once, when its log says.
    workers: int | None
    #: The setting that lowers that, when there is one.
    workersSetting: str | None


@dataclass
class MemoryCrash:
    """The last run lost work to the system killing the engine's processes."""

    executionId: str
    stages: list[KilledStage] = field(default_factory=list)
    #: The engine's memory as that run had it (see `_run_memory`).
    memoryLimit: str = DEFAULT_MEMORY
    #: The settings worth changing, in the order to try them.
    settings: list[str] = field(default_factory=list)


def _run_folder(execution_id: str) -> Path:
    """Where the engine keeps one run's logs: `logs/<execution_id>/`."""
    return pipeline.manifest_path(execution_id).parent


def _run_started(execution_id: str) -> float | None:
    """
    When a run started.

    From its `run.json`, whose `created_at` the engine writes from inside its
    container, in UTC and without saying so. Not from the id
    (`2026-11-24_18-29_rf_001`): the runner names the run by the clock of
    the machine it runs on, which outside Docker is the local one, hours away
    from UTC here. The id is the fallback when there is no `run.json`, read
    on this machine's clock: the backend starts the runner, so the two share
    one (in Docker, the container's).
    """
    try:
        meta = json.loads((_run_folder(execution_id) / "run.json").read_text(encoding="utf-8"))
        created = datetime.fromisoformat(str(meta["created_at"]))
    except (OSError, ValueError, KeyError, TypeError):
        created = None
    if created is not None:
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        return created.timestamp()
    try:
        return datetime.strptime(execution_id[:16], "%Y-%m-%d_%H-%M").timestamp()
    except ValueError:
        return None


#: The stage that lists the input tree first. The lint before it renames
#: files, and so touches their dates, after the run has started.
_FIRST_READER = "ingest_to_geoparquet"


def _inputs_listed(execution_id: str) -> float | None:
    """
    When the run took stock of its inputs: when its ingest started, by the
    run's manifest, or the run's start when the ingest never wrote its line
    there (it writes it as it ends).

    `started_at` there is the stage's own clock reading, in seconds since the
    epoch, so no time zone comes into it.
    """
    try:
        lines = (_run_folder(execution_id) / "run_manifest.jsonl").read_text(
            encoding="utf-8", errors="replace").splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("script") == _FIRST_READER and entry.get("event") == "script_summary":
            started = entry.get("started_at")
            if isinstance(started, (int, float)):
                return float(started)
    return _run_started(execution_id)


def _added(folder: Path) -> float:
    """
    When a variable's folder arrived in the input tree, as near as can be told.

    Its `st_ctime`, not its `st_mtime`. The modification time is whatever the
    copy says: `cp -a`, `rsync -a` and `unzip` keep the one the data had
    elsewhere, so a variable added after the run read as one that run had
    and lost. The change time is the kernel's, and no copy can carry it
    over: it is when the folder was made, moved in or renamed, or last had
    an entry added, removed or renamed. That errs towards "added later",
    which is the safe side: a variable merely not listed is better than one
    listed as failed when it never ran.

    The run's own list of its inputs would be better still, but the logs do
    not hold one. The ingest names only the files it did something with
    (an unchanged one is skipped without a word, a raster too), by file name
    rather than by variable, and the engine from before `worker_pool` named
    none of the files it lost, which are exactly the ones this is for.
    """
    return folder.stat().st_ctime


def _labels() -> dict[str, str]:
    return {Path(stage.script).stem: stage.label for stage in pipeline.STAGES}


def _workers(message: str) -> int | None:
    for pattern in _WORKERS:
        found = pattern.search(message)
        if found:
            return int(found.group(1))
    return None


def _run_memory(execution_id: str) -> str:
    """
    The engine's memory as that run had it, not as it is set now.

    The runner writes what it ran with to `effective_config.env`: the
    project's own memory (`PROJECT_APP_MEMORY`) when it has one, which is
    what the container got, else `APP_MEM_LIMIT`. A run from before that
    file falls back to the engine's `.env` as it is now.
    """
    for source in (_run_folder(execution_id) / "effective_config.env", None):
        values = pipeline.read_env_file(source)
        for key in ("PROJECT_APP_MEMORY", "APP_MEM_LIMIT"):
            value = values.get(key, "").strip()
            if value:
                return value
    return DEFAULT_MEMORY


def memory_crash(project: store.ProjectRow) -> MemoryCrash | None:
    """
    Whether the project's last run lost files to the system killing workers.

    None when it did not, or when there is no run to read.
    """
    state = engine_state.read(project.id)
    execution_id = state.lastExecutionId if state else ""
    if not execution_id:
        return None
    folder = _run_folder(execution_id)
    if not folder.is_dir():
        return None

    labels = _labels()
    stages: list[KilledStage] = []
    for log in sorted(folder.glob("*.jsonl")):
        script = log.stem
        if script in ("run_manifest", "stages"):
            continue
        failed = 0
        workers: int | None = None
        try:
            lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict):
                continue
            if workers is None:
                workers = _workers(str(entry.get("msg") or entry.get("message") or ""))
            if _counts_as_killed(entry):
                failed += 1
        if failed:
            stages.append(KilledStage(
                script=script,
                label=labels.get(script, script.replace("_", " ")),
                failed=failed,
                workers=workers,
                workersSetting=WORKER_SETTINGS.get(script),
            ))
    if not stages:
        return None

    settings = ["APP_MEM_LIMIT"]
    settings += [stage.workersSetting for stage in stages
                 if stage.workersSetting and stage.workersSetting not in settings]
    return MemoryCrash(executionId=execution_id, stages=stages,
                       memoryLimit=_run_memory(execution_id), settings=settings)


#: Not given: `missing_problems` reads the crash itself.
_UNREAD = object()


def missing_problems(
    project: store.ProjectRow, crash: MemoryCrash | None | object = _UNREAD
) -> list[outputs.VariableProblem]:
    """
    Variables that were in the last run and left nothing at all behind.

    Only those whose input was already there when that run read its inputs
    (`_added`, `_inputs_listed`): one added since has simply not been
    processed yet, which is not a failure. And only once the project has
    been processed, for the same reason. Not those inside a folder the
    engine keeps for itself (`outputs.is_variable_folder`: `bck`, `render`,
    `_viejo`...): the engine writes their results where its loader, and
    `result_folders`, never look, so they would be listed every time.

    `crash` is `memory_crash(project)` when the caller has it already, so
    one request reads the run's logs once.
    """
    state = engine_state.read(project.id)
    execution_id = state.lastExecutionId if state else ""
    listed = _inputs_listed(execution_id) if execution_id else None
    if listed is None:
        return []
    root = inputs.data_in(project)
    out = outputs.out_dir(project)
    if root is None or out is None:
        return []

    with_results = {"/".join(parts) for parts in outputs.result_folders(out)}
    if crash is _UNREAD:
        crash = memory_crash(project)
    found: list[outputs.VariableProblem] = []
    for variable in inputs.scan(project):
        if variable.processedOnly or variable.problem or variable.id in with_results:
            continue
        if not all(outputs.is_variable_folder(part) for part in variable.id.split("/")):
            continue
        try:
            added = _added(root / variable.id)
        except OSError:
            continue
        if added >= listed:
            continue
        found.append(outputs.VariableProblem(
            id=variable.id,
            dimension=variable.dimension,
            code=variable.code,
            status="missing",
            stage="",
            stageLabel="",
            reason="",
            source=variable.filename,
            executionId=execution_id,
            cause="memory" if crash else "",
        ))
    return found
