"""
The engine's `.env` as a screen of settings: every one listed with its
default, the ones that would break the installation shown and not offered,
the password never sent, and what is written checked first.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import engine_config, main, pipeline, runs

ENGINE_EXAMPLE = Path("/home/w/Vento/sig-multicriterio-v2/.env.example")

ENV = """\
# the machine's own
POSTGRES_USER=user
POSTGRES_PASSWORD=very-secret
POSTGRES_DB=sigdb
COMPOSE_PROJECT_NAME=sigmc
DATA_DIR=./data
APP_MEM_LIMIT=12g                     # more than the example
DB_MEM_LIMIT=6g
PG_SHARED_BUFFERS=2GB
PG_WAL_LEVEL=minimal
PG_MAX_WAL_SENDERS=0
FORCE_MASTER_REBUILD=1
"""


@pytest.fixture
def engine(tmp_path, monkeypatch) -> Path:
    folder = tmp_path / "engine"
    folder.mkdir()
    if ENGINE_EXAMPLE.is_file():
        shutil.copy(ENGINE_EXAMPLE, folder / ".env.example")
    else:  # pragma: no cover  (the engine is not checked out beside this app)
        pytest.skip("needs the engine's .env.example")
    (folder / ".env").write_text(ENV, encoding="utf-8")
    monkeypatch.setattr(pipeline, "PIPELINE_DIR", folder)
    monkeypatch.setattr(runs, "anything_running", lambda: False)
    return folder


def _settings(described: dict) -> dict[str, dict]:
    return {s["key"]: s for section in described["sections"] for s in section["settings"]}


def test_every_setting_of_the_engine_is_listed_with_its_default(engine):
    settings = _settings(engine_config.describe())
    example = engine_config.engine_defaults()
    assert set(example) <= set(settings)
    assert settings["APP_MEM_LIMIT"]["value"] == "12g"
    assert settings["APP_MEM_LIMIT"]["default"] == "8g"
    assert not settings["APP_MEM_LIMIT"]["isDefault"]
    # not in .env: the engine's default, and said to be the default
    assert settings["PG_WORK_MEM"]["isSet"] is False and settings["PG_WORK_MEM"]["isDefault"]
    assert settings["PG_WORK_MEM"]["default"] == "64MB"


def test_a_setting_only_shown_commented_out_is_off_by_default(engine):
    settings = _settings(engine_config.describe())
    assert settings["INSTALL_PROFILERS"]["default"] == ""
    assert settings["INSTALL_PROFILERS"]["isDefault"]
    # an example command line in a comment is not a setting
    assert "FORCE_REPROCESS" not in settings and "PROFILER" not in settings


def test_the_password_never_leaves_the_server(engine):
    described = engine_config.describe()
    assert "very-secret" not in repr(described)
    password = _settings(described)["POSTGRES_PASSWORD"]
    assert password["isSet"] and password["value"] == "" and password["readOnly"]


def test_what_would_break_the_installation_is_not_offered(engine):
    settings = _settings(engine_config.describe())
    for key in ("POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_PORT",
                "DATABASE_URL", "COMPOSE_PROJECT_NAME", "H3_RES", "RENDER_H3_RES"):
        assert settings[key]["readOnly"], key
        with pytest.raises(engine_config.ConfigError):
            engine_config.save({key: "x"})
    assert not settings["APP_MEM_LIMIT"]["readOnly"]


def test_a_setting_the_catalogue_does_not_know_still_appears(engine):
    described = engine_config.describe()
    other = next(s for s in described["sections"] if s["title"] == engine_config.OTHER_SECTION)
    assert "FORCE_MASTER_REBUILD" in [s["key"] for s in other["settings"]]


def test_saving_edits_the_line_in_place_and_keeps_the_comments(engine):
    engine_config.save({"APP_MEM_LIMIT": "16g", "RASTER_WORKERS": "2"})
    text = (engine / ".env").read_text()
    assert "APP_MEM_LIMIT=16g                     # more than the example" in text
    assert "# the machine's own" in text
    assert text.rstrip().endswith("RASTER_WORKERS=2")
    assert pipeline.read_env_file()["RASTER_WORKERS"] == "2"


def test_back_to_the_default(engine):
    engine_config.save({"RASTER_WORKERS": "2", "INSTALL_PROFILERS": "1"})
    described = engine_config.save({"APP_MEM_LIMIT": None, "RASTER_WORKERS": None,
                                    "INSTALL_PROFILERS": ""})
    settings = _settings(described)
    values = pipeline.read_env_file()
    # a default with a value: written back
    assert values["APP_MEM_LIMIT"] == "8g" and settings["APP_MEM_LIMIT"]["isDefault"]
    # off by default, or worked out by the engine: no line at all
    assert "RASTER_WORKERS" not in values and "INSTALL_PROFILERS" not in values
    assert "POSTGRES_PASSWORD=very-secret" in (engine / ".env").read_text()


@pytest.mark.parametrize("changes, message", [
    ({"APP_MEM_LIMIT": "lots"}, "a size like 8g"),
    ({"PG_WORK_MEM": "64mb"}, "a size like 512MB"),
    ({"PG_CHECKPOINT_TIMEOUT": "soon"}, "a time like 30min"),
    ({"PG_WAL_LEVEL": "maximal"}, "one of minimal, replica, logical"),
    ({"FIT_TO_MACHINE": "yes"}, "1 (on) or 0 (off)"),
    ({"MAX_WORKERS": "0"}, "at least 1"),
    ({"RASTER_WORKERS": "2.5"}, "a whole number"),
    ({"DATA_DIR": "./data; rm -rf /"}, "no spaces"),
    ({"PROJECT": "$(whoami)"}, "no spaces"),
    ({"APP_CPUS": ""}, "needs a value"),
    ({"NOT_A_SETTING": "1"}, "not a setting of the engine"),
    ({"PG_MAX_WAL_SENDERS": "10"}, "must be 0 with the minimal WAL level"),
    ({"PG_SHARED_BUFFERS": "4GB"}, "no more than 40%"),
])
def test_values_the_engine_would_not_accept_are_refused(engine, changes, message):
    before = (engine / ".env").read_text()
    with pytest.raises(engine_config.ConfigError, match=re.escape(message)):
        engine_config.save(changes)
    assert (engine / ".env").read_text() == before


def test_two_settings_changed_together_are_checked_together(engine):
    engine_config.save({"PG_WAL_LEVEL": "replica", "PG_MAX_WAL_SENDERS": "10"})
    assert pipeline.read_env_file()["PG_MAX_WAL_SENDERS"] == "10"


def test_without_a_env_nothing_is_written(engine):
    (engine / ".env").unlink()
    assert engine_config.describe()["envExists"] is False
    with pytest.raises(engine_config.ConfigError, match="no .env yet"):
        engine_config.save({"APP_MEM_LIMIT": "16g"})
    assert not (engine / ".env").exists()


def test_the_api_refuses_while_a_run_is_going(engine, monkeypatch):
    from app.models import SaveEngineConfigPayload

    def put(changes):
        return main.save_engine_config(SaveEngineConfigPayload(changes=changes))

    assert main.get_engine_config().envExists
    saved = put({"APP_MEM_LIMIT": "16g"})
    assert _settings(saved.model_dump())["APP_MEM_LIMIT"]["value"] == "16g"
    with pytest.raises(HTTPException) as bad:
        put({"APP_MEM_LIMIT": "x"})
    assert bad.value.status_code == 400
    monkeypatch.setattr(runs, "anything_running", lambda: True)
    with pytest.raises(HTTPException) as busy:
        put({"APP_MEM_LIMIT": "4g"})
    assert busy.value.status_code == 409
    assert pipeline.read_env_file()["APP_MEM_LIMIT"] == "16g"
