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
