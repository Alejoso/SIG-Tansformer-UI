"""
What the last run left out: variables that produced nothing at all, and runs
that lost files to the system killing the engine's workers.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app import engine_state, main, pipeline, run_health, store

RUN = "2026-11-24_18-29_rf_001"
#: Well before RUN, in UTC as the engine names runs.
BEFORE = 1_700_000_000
#: Well after it.
AFTER = 1_900_000_000

#: What the engine writes for a file whose worker the system killed even when
#: it ran alone (`worker_pool.killed_reason`), with the stage's setting in it.
KILLED_ALONE = (
    "el sistema termino el proceso que lo procesaba, incluso solo, casi siempre por "
    "falta de memoria: sube la memoria del contenedor (APP_MEM_LIMIT, o "
    "run.app_memory del proyecto) o baja los procesos de esta etapa ({setting}=1)"
)
#: And what it writes once for the files a dead worker left behind, before it
#: retries them one at a time: most of them are then read fine.
RETRYING = (
    "3 tarea(s) se quedaron sin proceso: el sistema termino uno de los 4 procesos "
    "(casi siempre por falta de memoria); se reintentan de a una"
)


@pytest.fixture
def engine(tmp_path, monkeypatch) -> Path:
    folder = tmp_path / "engine"
    (folder / "logs" / RUN).mkdir(parents=True)
    (folder / ".env").write_text("APP_MEM_LIMIT=8g\n", encoding="utf-8")
    monkeypatch.setattr(pipeline, "PIPELINE_DIR", folder)
    monkeypatch.delenv("MAPHEX_PIPELINE_LOG_DIR", raising=False)
    # Started after the test makes its inputs, unless a test says otherwise:
    # what a test puts in `in/` was there when the run began.
    _started(folder, time.time() + 3600)
    return folder


def _started(engine: Path, at: float) -> None:
    """The run's own record of when it began, in UTC and naive as the engine writes it."""
    stamp = datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    (engine / "logs" / RUN / "run.json").write_text(
        json.dumps({"execution_id": RUN, "created_at": stamp}), encoding="utf-8")


def _stage_summary(engine: Path, script: str, started_at: float) -> None:
    """A stage's line in the run's manifest, which the engine writes as it ends."""
    with (engine / "logs" / RUN / "run_manifest.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"script": script, "execution_id": RUN, "event": "script_summary",
                                 "status": "ok", "started_at": started_at,
                                 "ended_at": started_at + 5}) + "\n")


@pytest.fixture
def project(data_dir, engine, tmp_path, monkeypatch) -> store.ProjectRow:
    monkeypatch.setattr(engine_state, "STATE_FILE", data_dir / "engine_state.json")
    folder = tmp_path / "project"
    row = store.ProjectRow(id="p-1", name="p-1", mesh_id="", mesh_label="",
                           out_folder=str(folder))
    store.add_project(row)
    engine_state.record_run("p-1", RUN, True, [])
    return row


def _input(project: store.ProjectRow, variable: str, mtime: float = BEFORE) -> Path:
    folder = Path(project.out_folder) / "in" / variable
    folder.mkdir(parents=True)
    (folder / "data.csv").write_text("lat,lon,v\n1,2,3\n", encoding="utf-8")
    os.utime(folder, (mtime, mtime))
    return folder


def _result(project: store.ProjectRow, variable: str, *names: str) -> None:
    folder = Path(project.out_folder) / "out" / variable
    folder.mkdir(parents=True)
    for name in names:
        (folder / name).write_text("x", encoding="utf-8")


def _log(engine: Path, script: str, *messages: str | tuple[str, str]) -> None:
    """A stage's log: each line a message, or a (level, message) pair."""
    lines = [
        json.dumps({"script": script, "level": message[0], "msg": message[1]})
        if isinstance(message, tuple) else json.dumps({"script": script, "msg": message})
        for message in messages
    ]
    (engine / "logs" / RUN / f"{script}.jsonl").write_text("\n".join(lines) + "\n",
                                                          encoding="utf-8")


def test_a_variable_that_produced_nothing_is_a_problem(project):
    _input(project, "amb/AMB_001")
    _result(project, "amb/AMB_001", "a.h3.parquet", "a.h3.html")
    _input(project, "amb/AMB_006")
    (Path(project.out_folder) / "out" / "amb" / "AMB_006").mkdir(parents=True)  # empty
    _input(project, "tec/TEC_009")  # no out folder at all

    missing = run_health.missing_problems(project)
    assert [problem.id for problem in missing] == ["amb/AMB_006", "tec/TEC_009"]
    assert all(problem.status == "missing" and problem.executionId == RUN for problem in missing)
    assert missing[0].source == "data.csv"


def test_a_variable_added_after_the_run_is_not_one(project, engine):
    _started(engine, time.time() - 3600)
    _input(project, "amb/AMB_002", mtime=AFTER)
    assert run_health.missing_problems(project) == []


def test_a_project_never_processed_has_none(data_dir, engine, tmp_path, monkeypatch):
    monkeypatch.setattr(engine_state, "STATE_FILE", data_dir / "engine_state.json")
    row = store.ProjectRow(id="p-2", name="p-2", mesh_id="", mesh_label="",
                           out_folder=str(tmp_path / "fresh"))
    store.add_project(row)
    _input(row, "amb/AMB_001")
    assert run_health.missing_problems(row) == []
    assert run_health.memory_crash(row) is None


def test_workers_killed_by_the_system_are_found(project, engine):
    _log(engine, "ingest_to_geoparquet",
         "encontrados 237 archivos para procesar (workers=2)",
         *["error inesperado procesando archivo: A process in the process pool was "
           "terminated abruptly while the future was running or pending."] * 3,
         "ingestion completada: ok=0, skip=135, error=3")
    _log(engine, "raster_to_h3", "ok=25/26")

    crash = run_health.memory_crash(project)
    assert crash is not None and crash.executionId == RUN
    assert [(s.script, s.failed, s.workers, s.workersSetting) for s in crash.stages] == [
        ("ingest_to_geoparquet", 3, 2, "INGEST_WORKERS")]
    assert crash.stages[0].label == "Ingest vectors to GeoParquet"
    assert crash.memoryLimit == "8g"
    assert crash.settings == ["APP_MEM_LIMIT", "INGEST_WORKERS"]


def test_a_clean_run_has_no_crash(project, engine):
    _log(engine, "ingest_to_geoparquet", "ingestion completada: ok=4, skip=0, error=0")
    assert run_health.memory_crash(project) is None


def test_the_problems_route_blames_memory_only_for_that_run(project, engine):
    _log(engine, "ingest_to_geoparquet", "A process in the process pool was terminated abruptly")
    _input(project, "amb/AMB_006")
    # Stopped partway in an earlier run: not this run's crash.
    _input(project, "amb/AMB_028")
    _result(project, "amb/AMB_028", "x.parquet")
    (Path(project.out_folder) / "out" / "amb" / "AMB_028" / "x.pipeline.jsonl").write_text(
        json.dumps({"execution_id": "2026-11-24_17-24_rf_001", "stage": "INGESTA",
                    "status": "ok"}) + "\n", encoding="utf-8")

    problems = {problem.id: problem for problem in main.list_problems("p-1")}
    assert problems["amb/AMB_006"].status == "missing"
    assert problems["amb/AMB_006"].cause == "memory"
    assert problems["amb/AMB_028"].status == "unfinished"
    assert problems["amb/AMB_028"].cause == ""
    assert main.memory_crash("p-1").settings == ["APP_MEM_LIMIT", "INGEST_WORKERS"]


# ── when the run started, and what was there by then ──────────────────────


def test_the_run_started_when_its_run_json_says(engine):
    # 18:29 on the clock of the machine that named it, five hours behind UTC
    (engine / "logs" / RUN / "run.json").write_text(
        json.dumps({"execution_id": RUN, "created_at": "2026-11-24T23:29:07"}), encoding="utf-8")
    expected = datetime(2026, 11, 24, 23, 29, 7, tzinfo=timezone.utc).timestamp()
    assert run_health._run_started(RUN) == expected


def test_without_run_json_the_id_is_read_on_this_machine_s_clock(engine):
    (engine / "logs" / RUN / "run.json").unlink()
    # The runner names the run by the clock of the machine it runs on, which
    # is this one: the backend starts it (and in Docker both are the container's).
    assert run_health._run_started(RUN) == datetime(2026, 11, 24, 18, 29).timestamp()


def test_a_variable_copied_in_after_the_run_with_its_old_dates_is_not_missing(project, engine):
    _started(engine, time.time() - 3600)
    # cp -a, rsync -a and unzip keep the dates the files had elsewhere
    _input(project, "amb/AMB_003", mtime=BEFORE)
    assert run_health.missing_problems(project) == []


def test_a_variable_the_lint_renamed_during_the_run_is_still_missing(project, engine):
    now = time.time()
    _started(engine, now - 3600)
    # The lint renames before the ingest lists its files, so a rename then
    # lands between the two: still a variable that run read.
    _stage_summary(engine, "ingest_to_geoparquet", started_at=now + 3600)
    _input(project, "amb/AMB_004", mtime=now)
    assert [problem.id for problem in run_health.missing_problems(project)] == ["amb/AMB_004"]


def test_a_variable_in_a_folder_the_engine_skips_is_not_missing(project):
    # The engine's results for these land in folders it does not load from
    # (`outputs.is_variable_folder`), so they never have any to find.
    _input(project, "amb/bck/AMB_001")
    _input(project, "amb/_viejo/AMB_002")
    _input(project, "tec/render/TEC_009")
    _input(project, "soc/SOC_001")
    assert [problem.id for problem in run_health.missing_problems(project)] == ["soc/SOC_001"]


# ── what the current engine says when it runs out of memory ───────────────


def test_the_current_engine_counts_only_the_files_that_died_alone(project, engine):
    _log(engine, "ingest_to_geoparquet",
         ("INFO", "encontrados 237 archivos para procesar (workers=4)"),
         ("WARNING", RETRYING),
         ("INFO", "[7/237] ok big.shp: ok=1 skip=0"),
         ("INFO", "[9/237] ok bigger.shp: ok=1 skip=0"),
         ("ERROR", "biggest.shp: NO transformado - "
                   + KILLED_ALONE.format(setting="INGEST_WORKERS")),
         ("INFO", "ingestion completada: ok=2, skip=234, error=1"))
    crash = run_health.memory_crash(project)
    assert crash is not None
    assert [(s.script, s.failed, s.workers, s.workersSetting) for s in crash.stages] == [
        ("ingest_to_geoparquet", 1, 4, "INGEST_WORKERS")]


def test_files_retried_one_at_a_time_and_read_are_no_crash(project, engine):
    _log(engine, "ingest_to_geoparquet",
         ("WARNING", RETRYING),
         ("INFO", "[7/237] ok big.shp: ok=1 skip=0"),
         ("INFO", "ingestion completada: ok=3, skip=234, error=0"))
    assert run_health.memory_crash(project) is None


def test_step_10_5_running_out_of_memory_names_h3_workers(project, engine):
    _log(engine, "apply_variable_fixes",
         ("ERROR", "AMB_028: fallo la correccion del paso 10.5: "
                   + KILLED_ALONE.format(setting="H3_WORKERS")))
    crash = run_health.memory_crash(project)
    assert crash is not None
    assert [(s.script, s.failed, s.workersSetting) for s in crash.stages] == [
        ("apply_variable_fixes", 1, "H3_WORKERS")]
    assert crash.settings == ["APP_MEM_LIMIT", "H3_WORKERS"]


def test_the_raster_stage_says_how_many_it_read_at_once(project, engine):
    _log(engine, "raster_to_h3",
         ("INFO", "Encontrados 26 rasters para procesar"),
         ("INFO", "Procesando en paralelo con 6 workers"),
         ("ERROR", "error inesperado procesando big.tif: A process in the process pool was "
                   "terminated abruptly while the future was running or pending."))
    crash = run_health.memory_crash(project)
    assert crash is not None
    assert [(s.script, s.failed, s.workers) for s in crash.stages] == [("raster_to_h3", 1, 6)]


def test_a_file_named_killed_is_no_crash(project, engine):
    _log(engine, "ingest_to_geoparquet",
         ("INFO", "[4/9] ok killed_wildlife_2020.shp: ok=1 skip=0"),
         ("INFO", "[5/9] ok Killed en vias.shp: ok=1 skip=0"),
         "[6/9] ok KILLED_2021.csv: ok=1 skip=0",
         ("WARNING", "[7/9] fauna_killed.gpkg: NO transformado - sin referencia geografica"))
    assert run_health.memory_crash(project) is None


def test_the_memory_is_what_the_run_had(project, engine):
    _log(engine, "ingest_to_geoparquet", "A process in the process pool was terminated abruptly")
    config = engine / "logs" / RUN / "effective_config.env"
    config.write_text("export APP_MEM_LIMIT=8g\nexport PROJECT_APP_MEMORY=6g\n", encoding="utf-8")
    assert run_health.memory_crash(project).memoryLimit == "6g"
    # without a project's own memory, the engine's as the run had it, not as the file has it now
    config.write_text("export APP_MEM_LIMIT=12g\nexport RASTER_WORKERS=1\n", encoding="utf-8")
    assert run_health.memory_crash(project).memoryLimit == "12g"


def test_a_file_whose_worker_died_alone_is_blamed_on_memory(project, engine):
    _input(project, "amb/AMB_050")
    reason = KILLED_ALONE.format(setting="INGEST_WORKERS")
    out = Path(project.out_folder) / "out" / "amb" / "AMB_050"
    out.mkdir(parents=True)
    (out / "big.pipeline.jsonl").write_text(
        json.dumps({"execution_id": RUN, "stage": "INGESTA", "status": "error",
                    "details": {"archivo_origen": "big.shp", "error": reason}}) + "\n",
        encoding="utf-8")
    # Even with no stage log to read: the reason says it.
    problems = {problem.id: problem for problem in main.list_problems("p-1")}
    assert problems["amb/AMB_050"].status == "error"
    assert problems["amb/AMB_050"].cause == "memory"


def test_the_problems_route_reads_the_logs_once(project, engine, monkeypatch):
    _log(engine, "ingest_to_geoparquet", "A process in the process pool was terminated abruptly")
    _input(project, "amb/AMB_006")
    calls = []
    real = run_health.memory_crash

    def counted(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(run_health, "memory_crash", counted)
    problems = main.list_problems("p-1")
    assert [problem.cause for problem in problems] == ["memory"]
    assert len(calls) == 1
