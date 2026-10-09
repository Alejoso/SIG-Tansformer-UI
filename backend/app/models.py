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
    missingFolders: int = 0


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
