"""
A project's settings, and how they reach the engine.

Two of them do something: the resolution the data is computed at, and the one
the maps are drawn at. They are kept per project in `projects.csv` and applied
to the engine before a run.

Applied, not merely passed. The engine has one database and one `.env`, so
these are really properties of *the engine as it is configured right now*;
holding them per project is a convenience, and what it means is "set the
engine to this before running this project". Switching between projects that
disagree about the processing resolution therefore costs a master rebuild —
the engine notices the change itself and does it, and this module makes sure
the record of what the database holds is cleared with it.

`H3_RES` in particular has to be written into the file rather than exported:
see `pipeline.write_env_values` for why exporting it alone would rebuild the
master on every run, forever.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import engine_state, pipeline, store

#: H3 defines 0 (coarsest) through 15 (finest).
MIN_RESOLUTION = 0
MAX_RESOLUTION = 15

#: What the engine falls back to with nothing set: `H3_RES` defaults to 8 in
#: its `run_full.sh`, `RENDER_H3_RES` to 6 in `app/lib/shared.py`.
ENGINE_PROCESSING_DEFAULT = 8
ENGINE_RENDER_DEFAULT = 6

#: The engine works in WGS 84 throughout and nothing exposes a choice, so this
#: is shown and not offered.
COORDINATE_SYSTEM = "EPSG:4326"


@dataclass(frozen=True)
class Resolutions:
    processing: int
    render: int


def _as_resolution(raw: str, fallback: int) -> int:
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return fallback
    return value if MIN_RESOLUTION <= value <= MAX_RESOLUTION else fallback


def engine_defaults() -> Resolutions:
    """
    What the engine is set to with no project asking for anything.

    Read from its `.env` rather than assumed, so a project that has never had
    its settings touched follows whatever the engine was configured with by
    hand — which is the honest answer to "what resolution is this?" before
    anyone has chosen one here.
    """
    env = pipeline.read_env_file()
    return Resolutions(
        processing=_as_resolution(env.get("H3_RES", ""), ENGINE_PROCESSING_DEFAULT),
        render=_as_resolution(env.get("RENDER_H3_RES", ""), ENGINE_RENDER_DEFAULT),
    )


def of(project: store.ProjectRow) -> Resolutions:
    """This project's resolutions, falling back to the engine's own."""
    defaults = engine_defaults()
    return Resolutions(
        processing=_as_resolution(project.h3_res, defaults.processing),
        render=_as_resolution(project.render_h3_res, defaults.render),
    )


def save(project: store.ProjectRow, resolutions: Resolutions) -> store.ProjectRow:
    """
    Store them, and note when the processing resolution has moved.

    Changing it invalidates everything already in the database: every value is
    keyed by a hexagon of the old size. The engine works that out for itself —
    it compares against `pipeline_state.maestro_config` and rebuilds — but our
    own record of what the database holds would not know, so it is marked
    stale and the next run clears the project's tables with it.
    """
    before = of(project)
    rows = store.read_projects()
    for row in rows:
        if row.id == project.id:
            row.h3_res = str(resolutions.processing)
            row.render_h3_res = str(resolutions.render)
            row.updated_at = store.now()
    store.write_projects(rows)

    if resolutions.processing != before.processing:
        engine_state.mark_stale(project.id)

    saved = store.find_project(project.id)
    return saved if saved else project


def clear(project: store.ProjectRow) -> store.ProjectRow:
    """
    Forget this project's choices and take the engine's again.

    "Default values" in the settings dialog.

    Worth having beyond undo: once a number is written here there is
    otherwise no way back to "whatever the engine is set to", and the two are
    not the same thing even when they read the same — one tracks the engine,
    the other pins a value that would stay put when the engine moves.
    """
    before = of(project)
    rows = store.read_projects()
    for row in rows:
        if row.id == project.id:
            row.h3_res = ""
            row.render_h3_res = ""
            row.updated_at = store.now()
    store.write_projects(rows)

    saved = store.find_project(project.id)
    saved = saved if saved else project
    if of(saved).processing != before.processing:
        engine_state.mark_stale(project.id)
    return saved


def apply_to_engine(project: store.ProjectRow) -> bool:
    """
    Set the engine to this project's resolutions. Returns whether it changed.

    A change means the app container has to be recreated before it would see
    it, which is the caller's job — `compose_up(recreate=True)`.
    """
    resolutions = of(project)
    return pipeline.write_env_values(
        {
            "H3_RES": str(resolutions.processing),
            "RENDER_H3_RES": str(resolutions.render),
        }
    )
