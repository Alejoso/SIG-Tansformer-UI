"""
Maphex backend.

Projects and their data folders live in CSV here; the layer tree and the
model file are read from the project's own folder; and processing drives the
SIG-Transformer pipeline in Docker. What is left in the frontend's mocks is
the model run and the settings screen. Endpoints are added here as they stop
being pretend.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import (
    countries,
    engine_state,
    fsutil,
    inputs,
    model_store,
    outputs,
    pipeline,
    runs,
    store,
)
from .models import (
    AbortResult,
    ImportPayload,
    ImportPlan,
    InputVariable,
    Mesh,
    LayerNode,
    LayerTree,
    ModelFile,
    ModelIssue,
    NewProjectPayload,
    PickFolderPayload,
    PickFolderResult,
    PlanImportPayload,
    ProcessPayload,
    Removal,
    PipelineReadiness,
    PipelineRun,
    PipelineStageState,
    Project,
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


def _to_project(row: store.ProjectRow) -> Project:
    # Counted from the engine's input tree rather than from our folder rows:
    # the tree is what gets processed, and it holds data put there by hand
    # as well as data this app copied in.
    variables = inputs.scan(row)
    return Project(
        id=row.id,
        name=row.name,
        meshId=row.mesh_id,
        meshLabel=row.mesh_label or _mesh_label(row.mesh_id),
        status="draft",
        description=row.description,
        outFolder=row.out_folder,
        variableCount=len(variables),
        hexagonCount=0,
        updatedAt=row.updated_at or row.created_at,
        unreadableVariables=sum(1 for variable in variables if variable.problem),
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
    # Create the input folder now, while we still can — see `inputs.prepare`.
    inputs.prepare(row)
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


# ── the rendered layers ───────────────────────────────────────────────────


@app.get("/api/projects/{project_id}/layers")
def list_layers(project_id: str) -> LayerTree:
    """
    What the pipeline has actually rendered for this project.

    Read off disk, not from a database — the pipeline writes its results as
    files and this is the same view a person would get listing the folder.

    Variables come back flat because that is how the pipeline writes them: a
    mirror of the input tree, one folder per code. The model side is a tree
    because its output nests by criterion, and it is empty until a model run
    exists.
    """
    project = _require_project(project_id)

    variables = [
        LayerNode(
            id=variable.id,
            label=variable.label,
            # The code and the dimension are what identify a variable in the
            # pipeline's own documentation, so both are worth showing.
            description=f"{variable.code} · {variable.dimension}",
            filename=variable.filename,
            hasDocument=True,
            ok=variable.ok,
        )
        for variable in outputs.scan_variables(project)
    ]

    runs = outputs.scan_model_runs(project)
    return LayerTree(
        model={
            "combined": LayerNode(
                id="model",
                label="Complete model",
                description=(
                    f"Run {runs[0]}" if runs else "No model run yet — apply the model to make one"
                ),
                hasDocument=bool(runs),
            ),
            "variables": [],
        },
        inputs=variables,
    )


@app.api_route("/api/projects/{project_id}/layers/{node_id}/document", methods=["GET", "HEAD"])
def get_layer_document(project_id: str, node_id: str) -> FileResponse:
    """
    The rendered HTML for one layer.

    Streamed straight from disk: these are megabytes of pydeck document and
    the browser displays them in an iframe, so there is nothing to be gained
    by reading them into memory first.

    HEAD is declared alongside GET because the UI asks that way before
    pointing an iframe at it — an iframe loads an error page as readily as a
    document, so existence has to be checked separately. FastAPI does not add
    HEAD to a GET route on its own, and without it the check 405s and every
    layer looks missing.
    """
    project = _require_project(project_id)
    path = outputs.document_path(project, node_id)
    if path is None:
        raise HTTPException(status_code=404, detail=f"No rendered layer {node_id}")
    return FileResponse(path, media_type="text/html")


# ── processing ────────────────────────────────────────────────────────────


def _to_run(state: runs.RunState) -> PipelineRun:
    return PipelineRun(
        projectId=state.projectId,
        status=state.status,
        executionId=state.executionId,
        percent=state.percent,
        statusText=state.statusText,
        stages=[PipelineStageState(**vars(stage)) for stage in state.stages],
        startedAt=state.startedAt,
        finishedAt=state.finishedAt,
        error=state.error,
        hexagonCount=state.hexagonCount,
        skippedFiles=state.skippedFiles,
        erroredFiles=state.erroredFiles,
        reset=state.reset,
        resetReason=state.resetReason,
        rebuildEverything=state.rebuildEverything,
        logTail=state.logTail,
    )


@app.get("/api/pipeline")
def pipeline_readiness() -> PipelineReadiness:
    """
    Whether the engine could be driven right now.

    Asked before offering to process, because every reason it cannot be is
    something only the user can fix — Docker not running, WSL integration
    off, the pipeline checked out somewhere else. A generic failure once the
    run has started would be far harder to act on.
    """
    status = pipeline.status()
    return PipelineReadiness(
        ready=status.ready,
        pipelineDir=status.pipelineDir,
        dataDir=str(pipeline.engine_data_dir()),
        perProjectData=pipeline.honours_data_dir(),
        pipelineFound=status.pipelineFound,
        dockerAvailable=status.dockerAvailable,
        composeAvailable=status.composeAvailable,
        appRunning=status.appRunning,
        dbRunning=status.dbRunning,
        problems=status.problems,
    )


@app.post("/api/pipeline/up")
def pipeline_up() -> PipelineReadiness:
    """
    Start Postgres and the engine container.

    Separate from processing so the wait happens once, visibly, rather than
    inside the first run — the containers take a few seconds the first time
    and `run_full.sh` would do it silently.
    """
    result = pipeline.compose_up()
    if result is None:
        raise HTTPException(status_code=503, detail="Could not run `docker compose up`.")
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[-600:]
        raise HTTPException(status_code=503, detail=detail or "`docker compose up` failed.")
    return pipeline_readiness()


@app.post("/api/projects/{project_id}/process", status_code=202)
def start_processing(project_id: str, payload: ProcessPayload | None = None) -> PipelineRun:
    """
    Start a full pipeline pass over the project's folder.

    Returns immediately with the run's starting state: the pass takes minutes,
    so the UI polls rather than waits. 202 rather than 201 because what comes
    back describes work that has been accepted, not a finished thing.

    `rebuildEverything` forces the H3 master, grid and tiles to be rebuilt
    too — minutes of work the script otherwise decides on for itself, and an
    escape hatch rather than the normal path.
    """
    project = _require_project(project_id)

    status = pipeline.status()
    if not status.ready:
        raise HTTPException(status_code=503, detail=" ".join(status.problems))

    folder = outputs.data_dir(project)
    if folder is None or not folder.is_dir():
        raise HTTPException(
            status_code=400,
            detail="This project's folder is missing. Point it somewhere that exists first.",
        )

    # Older checkouts of the pipeline assign over the DATA_DIR they are
    # given, so a project pointed anywhere else would have its run read and
    # write one folder while the map and the model file read another — and
    # nothing would say so, because the run would succeed and the layers
    # simply would not change. Refuse that, naming both paths. Where the
    # script does honour it, any folder works and this does not apply.
    if not pipeline.honours_data_dir():
        engine_folder = pipeline.engine_data_dir()
        if folder.resolve() != engine_folder.resolve():
            raise HTTPException(
                status_code=400,
                detail=(
                    f"This copy of the pipeline only processes {engine_folder}, so this "
                    f"project's folder ({folder}) would be ignored — the run would write "
                    "somewhere the map never reads. Point the project there, or update "
                    "the pipeline: run_full.sh needs DATA_DIR=\"${DATA_DIR:-${ROOT_DIR}/data}\" "
                    "so the override it already advertises takes effect."
                ),
            )

    # Create what the run needs as us, in case nothing has yet — otherwise
    # `run_full.sh`'s own `docker compose up` makes them as root and its very
    # next line, a host-side mkdir, fails.
    pipeline.prepare_host_folders(folder)

    # One database serves every project, and nothing in it is scoped to one —
    # so a run clears the per-project tables when it must, and reuses the H3
    # master, which belongs to the boundaries rather than to any project.
    reset, reason = engine_state.plan_reload(project)

    try:
        run = runs.start(
            project,
            folder if pipeline.honours_data_dir() else None,
            reset=reset,
            reset_reason=reason,
            rebuild_everything=payload.rebuildEverything if payload else False,
        )
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return _to_run(run.snapshot())


@app.get("/api/projects/{project_id}/process")
def get_processing(project_id: str) -> PipelineRun | None:
    """
    How far the run has got.

    Polled rather than pushed. An SSE stream would be a better fit for a
    thirteen-minute job, but this is a local server on a loopback connection
    and a poll every second costs nothing, while reconnecting a dropped
    stream is real work. The shape here is already the shape a stream would
    send, so swapping the transport later touches neither side's logic.

    Answers for a run this server never started, too: the pipeline runs in
    its own process group and outlives a backend restart, so when nothing is
    held in memory the engine's logs are read instead.
    """
    project = _require_project(project_id)
    run = runs.current_or_adopted(project)
    # `null`, not 404: a project that has never been processed is the normal
    # state, not an error. A 404 here would be handled fine in code and still
    # logged as a failed request by the browser, so every fresh project would
    # open with errors in the console for people to wonder about.
    return None if run is None else _to_run(run.snapshot())


@app.post("/api/projects/{project_id}/process/abort")
def abort_processing(project_id: str) -> AbortResult:
    """
    Stop a run that is going.

    The engine keeps whatever it had already written: it loads variable by
    variable and commits as it goes, so a stopped run leaves partial output
    rather than rolling back. Processing again picks up from there.
    """
    _require_project(project_id)
    run = runs.current(project_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No run for this project.")
    return AbortResult(detail=run.abort())


# ── the data the engine will read ─────────────────────────────────────────


@app.get("/api/projects/{project_id}/inputs")
def list_inputs(project_id: str) -> list[InputVariable]:
    """
    The variables in the project's input tree.

    Read from disk, not from our own records: the pipeline walks that tree,
    so it is the only thing that decides what gets processed. Data someone
    dropped in by hand appears here too, which is the point — the screen
    should show what will actually run, not what we remember adding.
    """
    project = _require_project(project_id)
    return [InputVariable(**vars(variable)) for variable in inputs.scan(project)]


@app.get("/api/projects/{project_id}/inputs/dimensions")
def list_dimensions(project_id: str) -> list[str]:
    """The dimension folders that already exist, to offer rather than make people type."""
    project = _require_project(project_id)
    return inputs.dimensions(project)


@app.post("/api/projects/{project_id}/inputs/plan")
def plan_import(project_id: str, payload: PlanImportPayload) -> ImportPlan:
    """
    What adding this folder would do.

    A dry run, so the copy is never a surprise: it names the dataset it
    found, the companion files that have to travel with it, and where it
    would land. Problems come back here rather than as a failed import.
    """
    project = _require_project(project_id)
    return ImportPlan(**vars(inputs.plan(project, payload.path, payload.dimension)))


@app.post("/api/projects/{project_id}/inputs", status_code=201)
def add_input(project_id: str, payload: ImportPayload) -> InputVariable:
    """
    Copy a folder's dataset into the project as one variable.

    Copied, not moved or referenced. The pipeline reads its own tree and
    nothing else, so a path recorded elsewhere is not input to anything —
    and the copy means the project survives the source being unplugged.
    """
    project = _require_project(project_id)
    try:
        variable = inputs.import_folder(project, payload.path, payload.dimension, payload.code)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return InputVariable(**vars(variable))


@app.delete("/api/projects/{project_id}/inputs/{dimension}/{code}")
def remove_input(project_id: str, dimension: str, code: str) -> Removal:
    """
    Take a variable out of the project, input and results together.

    Both: the engine rebuilds its database from `out/`, so a variable whose
    output survives is loaded straight back on the next run — see
    `inputs.remove`. The folder it was copied from is untouched.

    Returns what went, so the UI can say how much rather than guess.
    """
    project = _require_project(project_id)
    try:
        removal = inputs.remove(project, dimension, code)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return Removal(**vars(removal))


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
