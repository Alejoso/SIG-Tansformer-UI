"""
The in-app folder browser and the checks around it: where it may look, what
a new folder may be called, and what an error may say back.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import fsutil, main


@pytest.fixture
def home(tmp_path, monkeypatch) -> Path:
    """A home folder of the test's own, outside Docker (no MAPHEX_BROWSE_ROOT)."""
    folder = tmp_path / "home"
    (folder / "data").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(folder))
    monkeypatch.delenv("MAPHEX_BROWSE_ROOT", raising=False)
    return folder


def _status(path: str, host: str) -> int:
    """The status the app answers a GET with, sent as this Host, through every middleware."""
    sent: list[dict] = []

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET",
        "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "",
        "query_string": b"", "headers": [(b"host", host.encode())],
        "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8765),
    }
    asyncio.run(main.app(scope, receive, send))
    return next(message["status"] for message in sent if message["type"] == "http.response.start")


# ── where it looks ────────────────────────────────────────────────────────


def test_outside_docker_the_browser_stays_in_the_home_folder(home):
    assert fsutil.browse_root() == home.resolve()
    # Asked for somewhere above it, it opens at home instead.
    assert fsutil.list_folders("/").path == str(home.resolve())
    assert fsutil.list_folders("/").parent is None
    with pytest.raises(fsutil.FolderError):
        fsutil.create_folder(str(home.parent), "made-outside-home")
    assert not (home.parent / "made-outside-home").exists()


def test_in_docker_the_browser_stays_in_the_shared_folder(home, tmp_path, monkeypatch):
    shared = tmp_path / "shared"
    shared.mkdir()
    monkeypatch.setenv("MAPHEX_BROWSE_ROOT", str(shared))
    assert fsutil.browse_root() == shared.resolve()


@pytest.mark.parametrize("host", ["localhost:8765", "127.0.0.1:5173", "[::1]:8765", "localhost"])
def test_the_app_answers_as_it_is_served(host):
    # No such route: what matters is that the request got as far as routing.
    assert _status("/api/no-such-route", host) == 404


@pytest.mark.parametrize("host", ["evil.example", "evil.example:8765", "192.168.1.20:8765"])
def test_the_app_refuses_any_other_host(host):
    # A page elsewhere that resolves its own name to 127.0.0.1 (DNS rebinding)
    # would otherwise read and make folders here.
    assert _status("/api/no-such-route", host) == 400


def test_more_hosts_can_be_allowed(monkeypatch):
    monkeypatch.setenv("MAPHEX_ALLOWED_HOSTS", "maphex.lan, 10.0.0.5")
    assert {"maphex.lan", "10.0.0.5", "localhost"} <= set(main.allowed_hosts())


# ── what an error says back ───────────────────────────────────────────────


def test_an_error_names_the_path_as_typed_not_its_variables_values(home, monkeypatch):
    monkeypatch.setenv("MAPHEX_TEST_SECRET", "hunter2")
    with pytest.raises(HTTPException) as refused:
        main.create_folder(main.CreateFolderPayload(parent="/$MAPHEX_TEST_SECRET", name="x"))
    assert refused.value.status_code == 400
    assert "hunter2" not in refused.value.detail
    assert "$MAPHEX_TEST_SECRET" in refused.value.detail

    checked = fsutil.inspect("/$MAPHEX_TEST_SECRET/nowhere")
    assert checked.problem and "hunter2" not in checked.path
    assert checked.path == "/$MAPHEX_TEST_SECRET/nowhere"


def test_a_nul_in_a_path_is_a_plain_refusal(home):
    with pytest.raises(HTTPException) as listed:
        main.list_folders("/tmp/\0x")
    assert listed.value.status_code == 400
    with pytest.raises(HTTPException) as created:
        main.create_folder(main.CreateFolderPayload(parent=f"{home}/\0x", name="x"))
    assert created.value.status_code == 400
    assert "embedded null byte" not in created.value.detail
    assert fsutil.inspect("/tmp/\0x").problem


# ── what a new folder may be called ───────────────────────────────────────


@pytest.mark.parametrize("name", ["two\nlines", "tab\there", "bell\x07", "esc\x1b[31m", "del\x7f"])
def test_a_folder_name_with_a_control_character_is_refused(home, name):
    with pytest.raises(fsutil.FolderError):
        fsutil.create_folder(str(home), name)
    assert [entry.name for entry in home.iterdir()] == ["data"]


def test_a_new_folder_is_made_and_opened(home):
    made = fsutil.create_folder(str(home / "data"), "results 2026")
    assert made.path == str((home / "data" / "results 2026").resolve())
    assert (home / "data" / "results 2026").is_dir()
