"""
Maphex backend.

Scope is deliberately narrow: projects and their data folders, stored in CSV.
Everything else the UI needs — meshes, the layer tree, the model, processing —
is still served from mocks in the frontend. Endpoints are added here as they
stop being pretend.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import countries, fsutil, model_store, store
from .models import (
    AddFoldersPayload,
    DataFolder,
    InspectResult,
    Mesh,
    ModelFile,
    ModelIssue,
    NewProjectPayload,
    PickFolderPayload,
    PickFolderResult,
    Project,
    RelocatePayload,
    SaveModelPayload,
)

app = FastAPI(title="Maphex", version="0.1.0")

# Vite proxies /api in dev so this is same-origin, but allowing the dev server
# directly means the UI also works if someone points it straight at uvicorn.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def _mesh_label(mesh_id: str) -> str:
    """The stored label, so an old project still reads correctly if the
    reference data is later swapped for a different edition."""
    return next(
        (c["label"] for c in countries.list_countries() if c["id"] == mesh_id),
        mesh_id,
    )


def _to_folder(row: store.FolderRow) -> DataFolder:
    """
    Turn a stored row into what the UI sees.

    Existence is checked on every read rather than cached: the whole point of
    recording a path is that the folder might move or vanish between visits.
    """
    exists = fsutil.folder_exists(row.path)
    files, size = (0, 0)
    if exists:
        files, size = fsutil.measure(fsutil.expand(row.path))
    return DataFolder(
        id=row.folder_id,
        name=row.name,
        path=row.path,
        fileCount=files,
        sizeBytes=size,
        state="pending",
        exists=exists,
    )


def _to_project(row: store.ProjectRow) -> Project:
    folders = store.folders_of(row.id)
    missing = sum(1 for folder in folders if not fsutil.folder_exists(folder.path))
    return Project(
        id=row.id,
        name=row.name,
        meshId=row.mesh_id,
        meshLabel=row.mesh_label or _mesh_label(row.mesh_id),
        status="draft",
        description=row.description,
        outFolder=row.out_folder,
        variableCount=len(folders),
        hexagonCount=0,
        updatedAt=row.updated_at or row.created_at,
        missingFolders=missing,
    )


def _require_project(project_id: str) -> store.ProjectRow:
    row = store.find_project(project_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"No project {project_id}")
    return row


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"ok": True, "store": str(store.DATA_DIR)}


@app.get("/api/meshes")
def list_meshes() -> list[Mesh]:
    """
    The study areas a project can be built on: every country in Natural
    Earth's 110m set, read through GeoPandas.

    Names only for now. The polygons are loaded with them, ready for the step
    that hands one to h3 to build the hexagon mesh.
    """
    return [Mesh(**country) for country in countries.list_countries()]


# ── projects ──────────────────────────────────────────────────────────────


@app.get("/api/projects")
def list_projects() -> list[Project]:
    # Newest first; a blank timestamp sorts last rather than crashing.
    rows = sorted(store.read_projects(), key=lambda r: r.created_at or "", reverse=True)
    return [_to_project(row) for row in rows]


@app.post("/api/projects", status_code=201)
def create_project(payload: NewProjectPayload) -> Project:
    row = store.ProjectRow(
        id=store.new_id("p"),
        name=payload.name,
        mesh_id=payload.meshId,
        mesh_label=_mesh_label(payload.meshId),
        description=payload.description,
        out_folder=payload.outFolder,
        created_at=store.now(),
        updated_at=store.now(),
    )
    store.add_project(row)
    return _to_project(row)


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> Project:
    return _to_project(_require_project(project_id))


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: str) -> None:
    """
    Forget a project.

    This removes rows from the CSVs and nothing else. The folders it pointed
    at are the user's data and are left exactly where they are.
    """
    if not store.delete_project(project_id):
        raise HTTPException(status_code=404, detail=f"No project {project_id}")


# ── folders ───────────────────────────────────────────────────────────────


@app.get("/api/projects/{project_id}/folders")
def list_folders(project_id: str) -> list[DataFolder]:
    _require_project(project_id)
    return [_to_folder(row) for row in store.folders_of(project_id)]


@app.post("/api/projects/{project_id}/folders")
def add_folders(project_id: str, payload: AddFoldersPayload) -> list[DataFolder]:
    _require_project(project_id)

    entries: list[tuple[str, str]] = []
    for raw in payload.paths:
        result = fsutil.inspect(raw)
        if result.problem:
            raise HTTPException(status_code=400, detail=f"{raw}: {result.problem}")
        entries.append((Path(result.path).name, result.path))

    store.add_folders(project_id, entries)
    store.touch_project(project_id)
    return [_to_folder(row) for row in store.folders_of(project_id)]


@app.delete("/api/projects/{project_id}/folders/{folder_id}", status_code=204)
def remove_folder(project_id: str, folder_id: str) -> None:
    _require_project(project_id)
    if not store.remove_folder(project_id, folder_id):
        raise HTTPException(status_code=404, detail=f"No folder {folder_id}")
    store.touch_project(project_id)


@app.put("/api/projects/{project_id}/folders/{folder_id}/path")
def relocate_folder(project_id: str, folder_id: str, payload: RelocatePayload) -> DataFolder:
    """Point a folder row at a new location, for when the old one has moved."""
    _require_project(project_id)

    result = fsutil.inspect(payload.path)
    if result.problem:
        raise HTTPException(status_code=400, detail=result.problem)

    if not store.relocate_folder(project_id, folder_id, result.path, Path(result.path).name):
        raise HTTPException(status_code=404, detail=f"No folder {folder_id}")

    store.touch_project(project_id)
    row = next(r for r in store.folders_of(project_id) if r.folder_id == folder_id)
    return _to_folder(row)


# ── the model file ────────────────────────────────────────────────────────


def _describe_model(project: store.ProjectRow, text: str, created: bool = False) -> ModelFile:
    """Pair the file with what is wrong with it, so one round trip tells all."""
    syntax = [ModelIssue(**issue) for issue in model_store.parse_errors(text)]
    structure = [ModelIssue(**issue) for issue in model_store.structure_errors(text)]
    return ModelFile(
        path=str(model_store.model_path(project)),
        text=text,
        created=created,
        syntaxErrors=syntax,
        structureErrors=structure,
    )


@app.get("/api/projects/{project_id}/model")
def get_model(project_id: str) -> ModelFile:
    """
    The project's model file, created from the default if it is not there yet.

    The text comes back exactly as stored — comments, spacing and key order
    intact — because the editor is a text editor and round-tripping through a
    parser would quietly rewrite what someone typed.
    """
    project = _require_project(project_id)
    text, created = model_store.read_model(project)
    return _describe_model(project, text, created)


@app.put("/api/projects/{project_id}/model")
def save_model(project_id: str, payload: SaveModelPayload) -> ModelFile:
    """
    Write the file.

    Saving does not require the document to be valid. Refusing to save work in
    progress would mean losing it, and the errors come back in the response
    either way.
    """
    project = _require_project(project_id)
    model_store.write_model(project, payload.text)
    store.touch_project(project_id)
    return _describe_model(project, payload.text)


@app.post("/api/projects/{project_id}/model/apply")
def apply_model(project_id: str, payload: SaveModelPayload) -> ModelFile:
    """
    Write the file, then — eventually — run the model from it.

    Only the write is implemented. The run is the next step.
    """
    project = _require_project(project_id)
    model_store.write_model(project, payload.text)
    store.touch_project(project_id)
    return _describe_model(project, payload.text)


# ── filesystem ────────────────────────────────────────────────────────────


@app.post("/api/fs/inspect")
def inspect_path(payload: RelocatePayload) -> InspectResult:
    """Check a path before it is committed, so the UI can validate as you type."""
    return fsutil.inspect(payload.path)


@app.post("/api/fs/pick-folder")
def pick_folder(payload: PickFolderPayload | None = None) -> PickFolderResult:
    """
    Open a folder chooser on this machine.

    Blocks until the dialog is answered, so the request is as long as the user
    is slow — bounded by a timeout in fsutil. FastAPI runs sync endpoints in a
    worker thread, so the rest of the API keeps serving meanwhile.
    """
    return fsutil.pick_folder(payload.startAt if payload else None)


# ── the built frontend ────────────────────────────────────────────────────

_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(_DIST / "index.html")
