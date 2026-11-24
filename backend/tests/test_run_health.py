"""
What the last run left out: variables that produced nothing at all, and runs
that lost files to the system killing the engine's workers.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app import engine_state, main, pipeline, run_health, store

RUN = "2026-11-24_18-29_rf_001"
#: Well before RUN, in UTC as the engine names runs.
BEFORE = 1_700_000_000
#: Well after it.
AFTER = 1_900_000_000


@pytest.fixture
def engine(tmp_path, monkeypatch) -> Path:
    folder = tmp_path / "engine"
    (folder / "logs" / RUN).mkdir(parents=True)
    (folder / ".env").write_text("APP_MEM_LIMIT=8g\n", encoding="utf-8")
    monkeypatch.setattr(pipeline, "PIPELINE_DIR", folder)
    monkeypatch.delenv("MAPHEX_PIPELINE_LOG_DIR", raising=False)
    return folder


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


def _log(engine: Path, script: str, *messages: str) -> None:
    lines = [json.dumps({"script": script, "msg": message}) for message in messages]
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


def test_a_variable_added_after_the_run_is_not_one(project):
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
