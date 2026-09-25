"""
The project store: two CSV files on disk.

CSV rather than a database because the point is that you can open it, read it,
and fix it by hand. `projects.csv` is one row per project; `folders.csv` is one
row per folder, tied back by `project_id`. Two files rather than one so a
project with no folders is still a row, and so neither file needs a "type"
column to say what a row means.

Writes are whole-file rewrites through a temporary file and an atomic replace.
The data is tiny and this is a single-user local app, so the simplicity is
worth more than incremental writes — and a crash mid-write cannot leave a
half-written store behind.
"""

from __future__ import annotations

import csv
import os
import tempfile
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path

#: Where the CSVs live. Override with MAPHEX_DATA_DIR.
DATA_DIR = Path(os.environ.get("MAPHEX_DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
PROJECTS_CSV = DATA_DIR / "projects.csv"
FOLDERS_CSV = DATA_DIR / "folders.csv"

PROJECT_FIELDS = [
    "id",
    "name",
    "mesh_id",
    "mesh_label",
    "description",
    "out_folder",
    "created_at",
    "updated_at",
]
FOLDER_FIELDS = ["project_id", "folder_id", "name", "path", "added_at"]


@dataclass
class ProjectRow:
    id: str
    name: str
    mesh_id: str
    mesh_label: str
    description: str = ""
    out_folder: str = ""
    created_at: str = ""
    updated_at: str = ""


@dataclass
class FolderRow:
    project_id: str
    folder_id: str
    name: str
    path: str
    added_at: str = ""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _read(path: Path, fields: list[str]) -> list[dict[str, str]]:
    """Read a CSV, tolerating a missing file and unknown extra columns."""
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as handle:
        rows = []
        for raw in csv.DictReader(handle):
            # Someone editing the file by hand may leave columns out; fill the
            # gaps rather than blowing up on the whole store.
            rows.append({key: (raw.get(key) or "") for key in fields})
        return rows


def _write(path: Path, fields: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", newline="", encoding="utf-8", dir=path.parent, delete=False
    )
    try:
        with handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
        os.replace(handle.name, path)
    except BaseException:
        Path(handle.name).unlink(missing_ok=True)
        raise


# ── projects ──────────────────────────────────────────────────────────────


def read_projects() -> list[ProjectRow]:
    return [ProjectRow(**row) for row in _read(PROJECTS_CSV, PROJECT_FIELDS)]


def write_projects(rows: list[ProjectRow]) -> None:
    _write(PROJECTS_CSV, PROJECT_FIELDS, [asdict(row) for row in rows])


def find_project(project_id: str) -> ProjectRow | None:
    return next((row for row in read_projects() if row.id == project_id), None)


def add_project(row: ProjectRow) -> ProjectRow:
    rows = read_projects()
    rows.append(row)
    write_projects(rows)
    return row


def touch_project(project_id: str) -> None:
    """Bump `updated_at`, so the list can order by recency later."""
    rows = read_projects()
    for row in rows:
        if row.id == project_id:
            row.updated_at = now()
    write_projects(rows)


def delete_project(project_id: str) -> bool:
    """
    Forget a project.

    Only the CSV rows go. Nothing on disk that the project pointed at is
    touched — the folders are the user's data, not ours to remove.
    """
    rows = read_projects()
    remaining = [row for row in rows if row.id != project_id]
    if len(remaining) == len(rows):
        return False
    write_projects(remaining)
    write_folders([f for f in read_folders() if f.project_id != project_id])
    return True


# ── folders ───────────────────────────────────────────────────────────────


def read_folders() -> list[FolderRow]:
    return [FolderRow(**row) for row in _read(FOLDERS_CSV, FOLDER_FIELDS)]


def write_folders(rows: list[FolderRow]) -> None:
    _write(FOLDERS_CSV, FOLDER_FIELDS, [asdict(row) for row in rows])


def folders_of(project_id: str) -> list[FolderRow]:
    return [row for row in read_folders() if row.project_id == project_id]


def add_folders(project_id: str, entries: list[tuple[str, str]]) -> list[FolderRow]:
    """Append (name, path) pairs, skipping paths the project already has."""
    rows = read_folders()
    existing = {row.path for row in rows if row.project_id == project_id}
    for name, path in entries:
        if path in existing:
            continue
        rows.append(
            FolderRow(
                project_id=project_id,
                folder_id=new_id("f"),
                name=name,
                path=path,
                added_at=now(),
            )
        )
        existing.add(path)
    write_folders(rows)
    return folders_of(project_id)


def remove_folder(project_id: str, folder_id: str) -> bool:
    rows = read_folders()
    remaining = [
        row for row in rows if not (row.project_id == project_id and row.folder_id == folder_id)
    ]
    if len(remaining) == len(rows):
        return False
    write_folders(remaining)
    return True


def relocate_folder(project_id: str, folder_id: str, path: str, name: str) -> bool:
    """Point an existing folder row at a new location on disk."""
    rows = read_folders()
    found = False
    for row in rows:
        if row.project_id == project_id and row.folder_id == folder_id:
            row.path = path
            row.name = name
            found = True
    if found:
        write_folders(rows)
    return found
