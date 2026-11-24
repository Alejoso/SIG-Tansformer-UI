"""
What the last processing run left out, beyond what the output folders say.

`outputs.scan_problems` reads the reason a variable failed from the folder
its results should be in. That covers every variable the engine got far
enough with to write something down. It misses the ones it never reached: a
variable whose folder under `out/` is empty, or absent, has no log and no
note, so it was in no count at all — on the Data screen it was simply one of
the hundred, and on the map it was not there.

The usual way that happens is the engine running out of memory. Its stages
read files in a pool of worker processes; when the system kills one for
using too much, Python reports every file still in that pool as "A process
in the process pool was terminated abruptly" — without naming any of them —
and the stage carries on and reports success. So this module also reads the
last run's logs for that, to say which stage it was and what to change.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import engine_state, inputs, outputs, pipeline, store

#: What the engine's logs say when the system killed a worker, almost always
#: for memory. Python words it the first way for a process pool; the others
#: are what a worker that died outright, or ran out cleanly, leaves.
_KILLED = re.compile(
    r"terminated abruptly|BrokenProcessPool|MemoryError|out of memory|Killed|"
    r"exit code -9|exitcode=-9|signal 9|SIGKILL",
    re.IGNORECASE,
)

#: The engine's setting for how many files each stage reads at once, by the
#: name of the stage's script (which is also its log's name). Fewer at once
#: is less memory at once.
WORKER_SETTINGS = {
    "ingest_to_geoparquet": "INGEST_WORKERS",
    "raster_to_h3": "RASTER_WORKERS",
    "parquet_to_h3": "H3_WORKERS",
    "load_h3_values": "LOAD_WORKERS",
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
    #: The engine's memory as it is set now (`APP_MEM_LIMIT`).
    memoryLimit: str = DEFAULT_MEMORY
    #: The settings worth changing, in the order to try them.
    settings: list[str] = field(default_factory=list)


def _run_started(execution_id: str) -> float | None:
    """
    When a run started, from its id (`2026-11-24_18-29_rf_001`).

    The engine names runs by the container's clock, which is UTC.
    """
    try:
        started = datetime.strptime(execution_id[:16], "%Y-%m-%d_%H-%M")
    except ValueError:
        return None
    return started.replace(tzinfo=timezone.utc).timestamp()


def _labels() -> dict[str, str]:
    return {Path(stage.script).stem: stage.label for stage in pipeline.STAGES}


def memory_crash(project: store.ProjectRow) -> MemoryCrash | None:
    """
    Whether the project's last run lost files to the system killing workers.

    None when it did not, or when there is no run to read.
    """
    state = engine_state.read(project.id)
    execution_id = state.lastExecutionId if state else ""
    if not execution_id:
        return None
    folder = pipeline.manifest_path(execution_id).parent
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
            message = str(entry.get("msg") or entry.get("message") or "")
            if workers is None:
                found = re.search(r"workers=(\d+)", message)
                if found:
                    workers = int(found.group(1))
            if _KILLED.search(message):
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
    memory = pipeline.read_env_file().get("APP_MEM_LIMIT", "").strip() or DEFAULT_MEMORY
    return MemoryCrash(executionId=execution_id, stages=stages, memoryLimit=memory,
                       settings=settings)


def missing_problems(project: store.ProjectRow) -> list[outputs.VariableProblem]:
    """
    Variables that were in the last run and left nothing at all behind.

    Only those whose input was already there when that run started: one
    added since has simply not been processed yet, which is not a failure.
    And only once the project has been processed, for the same reason.
    """
    state = engine_state.read(project.id)
    execution_id = state.lastExecutionId if state else ""
    started = _run_started(execution_id)
    if started is None:
        return []
    root = inputs.data_in(project)
    out = outputs.out_dir(project)
    if root is None or out is None:
        return []

    with_results = {"/".join(parts) for parts in outputs.result_folders(out)}
    crash = memory_crash(project)
    found: list[outputs.VariableProblem] = []
    for variable in inputs.scan(project):
        if variable.processedOnly or variable.problem or variable.id in with_results:
            continue
        try:
            added = (root / variable.id).stat().st_mtime
        except OSError:
            continue
        if added >= started:
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
