"""
Each project runs on a database of its own: its name, what every run of the
project is given, and the record of what each project's database holds.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import engine_state, main, pipeline, store


@pytest.fixture
def engine(tmp_path, monkeypatch) -> Path:
    """An engine folder with a `.env` naming the main database, and its logs."""
    folder = tmp_path / "engine"
    (folder / "logs").mkdir(parents=True)
    (folder / ".env").write_text(
        "POSTGRES_DB=sigdb\nPOSTGRES_USER=user\nPOSTGRES_PASSWORD=secret\n", encoding="utf-8"
    )
    monkeypatch.setattr(pipeline, "PIPELINE_DIR", folder)
    monkeypatch.delenv("MAPHEX_PIPELINE_LOG_DIR", raising=False)
    for name in ("POSTGRES_DB", "DATABASE_URL", "POSTGRES_USER", "POSTGRES_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    return folder


@pytest.fixture
def state_file(data_dir, monkeypatch) -> Path:
    path = data_dir / "engine_state.json"
    monkeypatch.setattr(engine_state, "STATE_FILE", path)
    return path


def _row(project_id: str, folder: Path) -> store.ProjectRow:
    return store.ProjectRow(id=project_id, name=project_id, mesh_id="", mesh_label="",
                            out_folder=str(folder))


def _logged_run(engine: Path, execution_id: str, database: str) -> None:
    folder = engine / "logs" / execution_id
    folder.mkdir()
    (folder / "run.json").write_text("{}", encoding="utf-8")
    (folder / "invocation.json").write_text(
        json.dumps({"command": "./run_full.sh", "variables": {"POSTGRES_DB": database}}),
        encoding="utf-8",
    )


# ── the name ──────────────────────────────────────────────────────────────


def test_every_project_gets_a_database_of_its_own(engine):
    first = pipeline.project_database("p-534c4487bf9e")
    second = pipeline.project_database("p-6c97d3767a07")
    assert first == "sigdb_maphex_534c4487bf9e"
    assert first != second
    assert first != pipeline.main_database()


def test_the_name_is_a_valid_postgres_name_whatever_the_id(engine):
    name = pipeline.project_database("P-Weird id/../" + "x" * 80)
    assert name == name.lower() and len(name) <= 63
    assert all(c.isalnum() or c == "_" for c in name)


def test_runs_are_given_the_project_database_and_its_url(engine, monkeypatch):
    # Even a POSTGRES_DB / DATABASE_URL where the backend runs does not win
    # over the project's own.
    monkeypatch.setenv("POSTGRES_DB", "sigdb_shared")
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:secret@db:5432/sigdb_shared?sslmode=disable")
    env = pipeline.project_database_env("p-abc123")
    assert env["POSTGRES_DB"] == "sigdb_maphex_abc123"
    assert env["DATABASE_URL"] == "postgresql://user:secret@db:5432/sigdb_maphex_abc123?sslmode=disable"


def test_both_runners_get_it(engine, data_dir, tmp_path):
    env = main._engine_env(_row("p-abc123", tmp_path / "project"))
    assert env["POSTGRES_DB"] == "sigdb_maphex_abc123"
    assert env["DATABASE_URL"].endswith("/sigdb_maphex_abc123")
    for full in (pipeline.run_full_env(extra=env), pipeline.model_env(tmp_path / "project", extra=env)):
        assert full["POSTGRES_DB"] == "sigdb_maphex_abc123"
        assert full["DATABASE_URL"].endswith("/sigdb_maphex_abc123")


# ── what each database holds ──────────────────────────────────────────────


def test_a_project_without_a_record_starts_clean(engine, state_file, tmp_path):
    reset, reason = engine_state.plan_reload(_row("p-a", tmp_path / "a"))
    assert reset and "nothing is recorded" in reason


def test_another_project_running_in_between_changes_nothing(engine, state_file, tmp_path):
    a, b = _row("p-a", tmp_path / "a"), _row("p-b", tmp_path / "b")
    _logged_run(engine, "2026-11-20_10-00_rf_001", pipeline.project_database("p-a"))
    engine_state.record_run("p-a", "2026-11-20_10-00_rf_001", True, [])
    _logged_run(engine, "2026-11-20_10-05_rf_002", pipeline.project_database("p-b"))
    engine_state.record_run("p-b", "2026-11-20_10-05_rf_002", True, [])
    assert engine_state.plan_reload(a) == (False, "")
    assert engine_state.plan_reload(b) == (False, "")


def test_a_run_outside_the_app_on_the_same_database_is_noticed(engine, state_file, tmp_path):
    a = _row("p-a", tmp_path / "a")
    _logged_run(engine, "2026-11-20_10-00_rf_001", pipeline.project_database("p-a"))
    engine_state.record_run("p-a", "2026-11-20_10-00_rf_001", True, [])
    _logged_run(engine, "2026-11-20_10-07_rf_003", pipeline.project_database("p-a"))
    reset, reason = engine_state.plan_reload(a)
    assert reset and "outside this app" in reason


def test_stale_and_failed_runs_are_per_project(engine, state_file, tmp_path):
    a, b = _row("p-a", tmp_path / "a"), _row("p-b", tmp_path / "b")
    engine_state.record_run("p-a", "", True, [])
    engine_state.record_run("p-b", "", False, [])
    assert engine_state.plan_reload(a) == (False, "")
    assert engine_state.plan_reload(b)[0]
    engine_state.mark_stale("p-a")
    assert engine_state.plan_reload(a)[0]
    engine_state.record_run("p-a", "", True, [])
    assert engine_state.plan_reload(a) == (False, "")


def test_the_record_from_the_shared_database_is_not_trusted(engine, state_file, tmp_path):
    state_file.write_text(json.dumps({"lastProjectId": "p-a", "lastExecutionId": "x",
                                      "stale": [], "lastOutputs": []}), encoding="utf-8")
    reset, _ = engine_state.plan_reload(_row("p-a", tmp_path / "a"))
    assert reset


# ── refusing up front what the engine would refuse mid-run ────────────────


class _Started(Exception):
    """Raised by the stand-in runners: the route got as far as starting a run."""

    def __init__(self, **kwargs):
        super().__init__("started")
        self.kwargs = kwargs


@pytest.fixture
def ready_engine(engine, data_dir, monkeypatch):
    """
    An engine that looks ready, with every call to Docker captured instead of
    made, and runners that only record what they were asked to start.
    """
    import subprocess

    from app import model_store, outputs, runs, settings as project_settings

    (engine / pipeline.RUN_SCRIPT).write_text(
        'DATA_DIR="${DATA_DIR:-${ROOT_DIR}/data}"\n', encoding="utf-8"
    )
    calls: list[dict] = []

    def fake_run(command, cwd=None, timeout=30, env=None):
        calls.append({"command": command, "env": env})
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(pipeline, "_run", fake_run)
    monkeypatch.setattr(pipeline, "machine_fit", lambda env: {})
    monkeypatch.setattr(pipeline, "status", lambda: pipeline.PipelineStatus(
        pipelineDir=str(engine), pipelineFound=True, dockerAvailable=True,
        composeAvailable=True, appRunning=True, dbRunning=True,
    ))
    monkeypatch.setattr(project_settings, "apply_to_engine", lambda project: False)
    monkeypatch.setattr(main.inputs, "scan", lambda project: [])
    monkeypatch.setattr(outputs, "scan_variables", lambda project: ["tec/TEC_001"])
    monkeypatch.setattr(model_store, "read_model", lambda project: ("", False))

    def fake_start(*args, **kwargs):
        raise _Started(**kwargs)

    monkeypatch.setattr(runs, "start", fake_start)
    monkeypatch.setattr(runs, "start_model", fake_start)
    return calls


def _stored(project_id: str, folder: Path) -> store.ProjectRow:
    folder.mkdir(parents=True, exist_ok=True)
    row = store.ProjectRow(id=project_id, name=project_id, mesh_id="dane_colombia",
                           mesh_label="", mesh_source="dane_colombia", out_folder=str(folder))
    store.add_project(row)
    return row


def _up_calls(calls: list[dict]) -> list[dict]:
    return [call for call in calls if call["command"][:4] == ["docker", "compose", "up", "-d"]]


def test_a_model_run_before_the_project_was_processed_is_refused(ready_engine, state_file, tmp_path):
    from fastapi import HTTPException

    row = _stored("p-never", tmp_path / "never")
    with pytest.raises(HTTPException) as refused:
        main.start_model_run(row.id)
    assert refused.value.status_code == 400
    assert "Process" in refused.value.detail and "database" in refused.value.detail
    # Nothing was started, not even the containers.
    assert _up_calls(ready_engine) == []


def test_a_model_run_after_a_failed_first_run_is_refused(ready_engine, state_file, tmp_path):
    from fastapi import HTTPException

    row = _stored("p-failed", tmp_path / "failed")
    engine_state.record_run(row.id, "2026-11-20_10-00_rf_001", False, [])
    with pytest.raises(HTTPException) as refused:
        main.start_model_run(row.id)
    assert refused.value.status_code == 400


def test_a_model_run_after_processing_starts(ready_engine, state_file, tmp_path):
    row = _stored("p-done", tmp_path / "done")
    engine_state.record_run(row.id, "2026-11-20_10-00_rf_001", True, [])
    # A variable removed since leaves the record stale, but the database is there.
    engine_state.mark_stale(row.id)
    with pytest.raises(_Started):
        main.start_model_run(row.id)


def test_a_record_written_before_the_processed_flag_still_counts(ready_engine, state_file, tmp_path):
    row = _stored("p-old", tmp_path / "old")
    state_file.write_text(json.dumps({"projects": {row.id: {
        "lastExecutionId": "2026-11-20_10-00_rf_001", "stale": False, "lastOutputs": []}}}),
        encoding="utf-8")
    with pytest.raises(_Started):
        main.start_model_run(row.id)


@pytest.mark.parametrize("env_data_dir", ["", "DATA_DIR=./data\n", "DATA_DIR=elsewhere\n"])
def test_a_project_on_the_engine_data_folder_is_refused(ready_engine, state_file, engine,
                                                        env_data_dir):
    from fastapi import HTTPException

    if env_data_dir:
        with (engine / ".env").open("a", encoding="utf-8") as env:
            env.write(env_data_dir)
    main_folder = engine / ("elsewhere" if "elsewhere" in env_data_dir else "data")
    main_folder.mkdir()
    # Through a symlink, as the engine compares real paths.
    link = engine.parent / "linked-data"
    link.symlink_to(main_folder)
    row = _stored("p-main", link)
    engine_state.record_run(row.id, "x", True, [])
    for start in (main.start_processing, main.start_model_run):
        with pytest.raises(HTTPException) as refused:
            start(row.id)
        assert refused.value.status_code == 400
        assert "engine's own data folder" in refused.value.detail
    assert _up_calls(ready_engine) == []


def test_creating_a_project_on_the_engine_data_folder_is_refused(ready_engine, engine):
    from fastapi import HTTPException

    from app.models import NewProjectPayload

    (engine / "data").mkdir()
    with pytest.raises(HTTPException) as refused:
        main.create_project(NewProjectPayload(name="X", meshId="dane_colombia",
                                              outFolder=str(engine / "data" / ".")))
    assert refused.value.status_code == 400
    assert "engine's own data folder" in refused.value.detail
    assert store.read_projects() == []


def test_a_folder_of_its_own_is_not_refused(ready_engine, state_file, tmp_path):
    row = _stored("p-own", tmp_path / "own")
    with pytest.raises(_Started):
        main.start_processing(row.id)


def test_processing_and_the_model_bring_the_container_up_the_same_way(
    ready_engine, state_file, tmp_path, monkeypatch
):
    """
    compose recreates the app container whenever its configuration changes,
    and `DATABASE_URL` is part of it. `run_full.sh` brings the containers up
    with the URL it is given, the project's; `compose_up` has to use the same
    one, or every switch between processing and the model recreates it.
    """
    from app import settings as project_settings

    row = _stored("p-same", tmp_path / "same")
    engine_state.record_run(row.id, "x", True, [])
    with pytest.raises(_Started):
        main.start_model_run(row.id)
    model_up = _up_calls(ready_engine)
    assert len(model_up) == 1
    wanted = pipeline.project_database_env(row.id)["DATABASE_URL"]
    assert model_up[0]["env"]["DATABASE_URL"] == wanted
    # What run_full.sh is handed, and so brings the containers up with.
    full = pipeline.run_full_env(extra=main._engine_env(row))
    assert full["DATABASE_URL"] == wanted
    assert model_up[0]["env"]["DATA_DIR"] == str(tmp_path / "same")

    # Processing after a change of resolution brings them up itself, the same way.
    monkeypatch.setattr(project_settings, "apply_to_engine", lambda project: True)
    with pytest.raises(_Started):
        main.start_processing(row.id)
    process_up = _up_calls(ready_engine)[1:]
    assert len(process_up) == 1 and process_up[0]["env"]["DATABASE_URL"] == wanted


def test_stage_commands_use_the_project_database(engine):
    stage = next(stage for stage in pipeline.STAGES if stage.needs_db)
    command = pipeline.stage_command(stage, "2026-11-20_10-00_rf_001", "p-abc123")
    assert "DATABASE_URL=" + pipeline.database_url("sigdb_maphex_abc123") in command
    assert not any(part.endswith("/sigdb") for part in command)


# ── the record is read, changed and written under a lock ──────────────────


def test_concurrent_writes_to_the_record_lose_nothing(state_file, monkeypatch):
    """
    `record_run` (a run finishing) and `mark_stale` (a variable removed) can
    happen at once. Without a lock both read the file, and the second write
    drops what the first added.
    """
    import threading

    original = engine_state._write_all
    first_writing = threading.Event()
    second_done = threading.Event()

    def slow_first_write(states):
        if threading.current_thread().name == "first":
            first_writing.set()
            # Without a lock the second finishes in here; with one it waits
            # for this write, so this only times out.
            second_done.wait(timeout=0.5)
        original(states)

    monkeypatch.setattr(engine_state, "_write_all", slow_first_write)
    first = threading.Thread(name="first",
                             target=lambda: engine_state.record_run("p-a", "x", True, []))
    first.start()
    assert first_writing.wait(timeout=5)

    def second():
        engine_state.mark_stale("p-b")
        second_done.set()

    other = threading.Thread(name="second", target=second)
    other.start()
    first.join(timeout=5)
    other.join(timeout=5)
    assert engine_state.read("p-a") is not None
    assert engine_state.read("p-b") is not None and engine_state.read("p-b").stale


# ── deleting a project ────────────────────────────────────────────────────


def test_deleting_a_project_drops_nothing_in_the_engine(ready_engine, tmp_path):
    """No database is touched: maphex has no route into the db container."""
    row = _stored("p-gone", tmp_path / "gone")
    main.delete_project(row.id)
    assert store.find_project(row.id) is None
    assert ready_engine == []


# ── what a reload asks of the engine ──────────────────────────────────────


def test_a_reload_clears_the_database_but_reuses_the_converted_files():
    """`RESET_FILES=1` also forces the engine to ingest, sample and convert every file
    again (it empties `archivos`, the record of what each output was made from), so a
    project whose last run died reprocessed everything on the next one, which was then
    more likely to die too. Reloading the database is `H3_VALUES_FULL_REBUILD=1`: it
    empties the project's variables and loads every result again, and the engine still
    skips the files whose outputs are current."""
    env = pipeline.reload_env(reset=True)
    assert env["H3_VALUES_FULL_REBUILD"] == "1"
    assert env.get("RESET_FILES", "0") == "0"
    for flag in ("FORCE_REPROCESS", "FORCE_H3_REBUILD"):
        assert env.get(flag, "0") == "0"
    assert env["FORCE_MASTER_REBUILD"] == "0"
    # nothing to clear: an incremental load
    quiet = pipeline.reload_env(reset=False)
    assert quiet.get("H3_VALUES_FULL_REBUILD", "0") == "0" and quiet.get("RESET_FILES", "0") == "0"
