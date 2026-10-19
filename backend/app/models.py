"""
Wire models.

These mirror `frontend/src/types.ts` field for field, including the camelCase
names — the UI is the only client, so matching its shape exactly is worth more
than Python naming conventions here.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class Project(BaseModel):
    id: str
    name: str
    meshId: str
    meshLabel: str
    status: str
    description: str = ""
    outFolder: str = ""
    variableCount: int = 0
    hexagonCount: int = 0
    updatedAt: str = ""
    #: How many of the project's folders are no longer on disk. The UI uses
    #: this to flag a project in the list without fetching its folders.
    #: Variables whose folder is not one dataset the engine can read. It
    #: skips them, so this is worth seeing without opening the project.
    unreadableVariables: int = 0


class NewProjectPayload(BaseModel):
    name: str
    meshId: str
    outFolder: str = ""
    description: str = ""

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A project needs a name")
        return value.strip()


class Mesh(BaseModel):
    """A study area to build a project on. Today that means a country."""

    id: str
    label: str
    continent: str = ""
    iso: str = ""
    #: Every name and code this row answers to, joined, so the UI can filter
    #: on one field without knowing which of them exist.
    search: str = ""


class DataFolder(BaseModel):
    id: str
    name: str
    path: str
    fileCount: int = 0
    sizeBytes: int = 0
    state: str = "pending"
    #: False when the recorded path is no longer a directory on this machine.
    #: The UI offers to re-point it or drop the project when this is False.
    exists: bool = True


class AddFoldersPayload(BaseModel):
    #: Absolute paths. The browser cannot read a real path from a file picker,
    #: so the UI sends what the user typed and the server is what validates it.
    paths: list[str] = Field(default_factory=list)


class RelocatePayload(BaseModel):
    path: str


class InspectResult(BaseModel):
    path: str
    exists: bool
    isDirectory: bool
    fileCount: int = 0
    sizeBytes: int = 0
    #: Human-readable reason when the path cannot be used.
    problem: str | None = None


class LayerNode(BaseModel):
    id: str
    label: str
    description: str = ""
    children: list["LayerNode"] = Field(default_factory=list)
    hasDocument: bool = True
    #: The file behind this layer, so the UI can name what is on screen.
    filename: str = ""
    #: False when the pipeline logged a problem for this variable. A rendered
    #: layer can still have failed — the pipeline carries on past bad files.
    ok: bool = True


class LayerTree(BaseModel):
    model: dict[str, object]
    inputs: list[LayerNode]


class ModelIssue(BaseModel):
    message: str
    #: 1-based, when the parser gives a position. Structural problems have none.
    line: int | None = None
    column: int | None = None


class ModelFile(BaseModel):
    #: Absolute path on the machine running the server, so the UI can say where
    #: it is writing rather than naming a file that could be anywhere.
    path: str
    text: str
    #: True when the file did not exist and was seeded with the default.
    created: bool = False
    syntaxErrors: list[ModelIssue] = Field(default_factory=list)
    structureErrors: list[ModelIssue] = Field(default_factory=list)


class SaveModelPayload(BaseModel):
    text: str


class PickFolderPayload(BaseModel):
    #: Where the dialog should open. Usually whatever is already in the field,
    #: so the user does not restart from home every time.
    startAt: str | None = None


class PickFolderResult(BaseModel):
    path: str | None = None
    #: Set when no native dialog could be opened, so the UI can say why
    #: instead of silently doing nothing.
    unavailable: str | None = None


class PipelineStageState(BaseModel):
    number: float
    key: str
    label: str
    #: pending | running | ok | skipped | failed | aborted
    status: str
    #: The stage's own counts, in its own words — "variables db 12,
    #: archivo valores db 9096593". Not curated into fixed fields: each stage
    #: reports different things and upstream adds counters.
    detail: str = ""
    durationSeconds: float | None = None


class PipelineRun(BaseModel):
    projectId: str
    #: starting | running | done | failed | aborted
    status: str
    #: The engine's own id for the run, once it has announced one.
    executionId: str = ""
    percent: int = 0
    statusText: str = ""
    stages: list[PipelineStageState] = Field(default_factory=list)
    startedAt: float = 0.0
    finishedAt: float | None = None
    error: str = ""
    hexagonCount: int | None = None
    #: Input files the engine skipped or failed on and carried on past. A run
    #: can finish successfully with variables missing; these are what say so.
    skippedFiles: int = 0
    erroredFiles: int = 0
    #: The last few hundred lines of the engine's output.
    logTail: list[str] = Field(default_factory=list)


class PipelineReadiness(BaseModel):
    """Whether a run could start at all, and what to fix if not."""

    ready: bool
    pipelineDir: str
    #: The folder the engine processes when a project does not choose one.
    dataDir: str = ""
    #: True when the pipeline honours a DATA_DIR, so each project can keep its
    #: data in its own folder. False on an older checkout, where a project has
    #: to point at `dataDir` itself.
    perProjectData: bool = False
    pipelineFound: bool
    dockerAvailable: bool
    composeAvailable: bool
    appRunning: bool
    dbRunning: bool
    problems: list[str] = Field(default_factory=list)


class AbortResult(BaseModel):
    #: What was actually stopped, which is not always everything — see
    #: `Run.abort`.
    detail: str


class InputVariable(BaseModel):
    """One variable in the engine's input tree, as the pipeline will see it."""

    #: `<dimension>/<CODE>` — both its identity and where it lives.
    id: str
    dimension: str
    code: str
    filename: str = ""
    format: str = ""
    sizeBytes: int = 0
    fileCount: int = 0
    #: Where it was copied from. Empty for data put there by hand.
    source: str = ""
    #: The source folder has moved. Informational — the data is already in
    #: the project, so nothing is broken.
    sourceMissing: bool = False
    #: Set when the folder is not one readable dataset.
    problem: str = ""


class ImportPlan(BaseModel):
    """What adding a folder would copy, and where, before anything is written."""

    source: str
    filename: str = ""
    format: str = ""
    sizeBytes: int = 0
    files: list[str] = Field(default_factory=list)
    dimension: str = ""
    code: str = ""
    problem: str = ""


class Removal(BaseModel):
    """What removing a variable took away, so the UI can say it plainly."""

    id: str
    inputFiles: int
    #: Files deleted from `out/`. Non-zero means processed results went too —
    #: which is the point: the engine rebuilds its database from `out/`, so a
    #: variable whose output survives comes back on the next run.
    outputFiles: int


class PlanImportPayload(BaseModel):
    path: str
    #: The dimension being considered, which decides the suggested code.
    dimension: str = ""


class ImportPayload(BaseModel):
    path: str
    dimension: str
    code: str
