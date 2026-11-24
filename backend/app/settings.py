"""
A project's settings, and how they reach the engine.

Two of them do something to the data: the resolution it is computed at, and
the one the maps are drawn at. They are kept per project in `projects.csv`
and applied to the engine before a run.

Three more are switches the engine reads from its environment, kept beside
them and off unless turned on (`Options`): a CSV of the master table, CSVs of
the model's tables, and keeping the machine awake while a run is going.
Those are passed with each run rather than written into `.env`: both
runners read them from the environment they are started with.

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


@dataclass(frozen=True)
class Options:
    """
    The switches a project passes to the engine with every run. None changes
    a result. The ones that cost disk or time are off by default; the H3 code
    in the tooltips is on, as the engine has drawn its maps since 2026-11-20.
    """

    #: The master table as CSV beside its parquet (`EXPORT_CSV`). Gigabytes
    #: on a real project, and only for opening it outside the engine.
    masterCsv: bool = False
    #: The model's criteria and subcriteria tables as CSV beside their parquet
    #: (`MCDA_TABLES_CSV`). Hundreds of megabytes, and seconds per run.
    modelTablesCsv: bool = False
    #: Hold off sleep while a run is going (`KEEP_AWAKE`): the runner puts
    #: itself under `systemd-inhibit` where there is one. A laptop that
    #: suspends halfway through a load leaves it stopped until it wakes.
    keepAwake: bool = False
    #: Each model run also writes the statistics of its scores
    #: (`aggregate/stats.csv`: n, min, max, mean, deviation, quartiles of the
    #: global score, each criterion and subcriterion; `MCDA_STATS_CSV`).
    scoreStatsCsv: bool = False
    #: Every map's tooltip shows the H3 code of the hexagon under the cursor
    #: (`MAP_TOOLTIP_H3`). Turning it either way redraws the maps on the next
    #: run.
    mapTooltipH3: bool = True


#: Each option, its column in `projects.csv`, the variable the engine reads,
#: and its default.
OPTION_FIELDS = (
    ("masterCsv", "export_csv", "EXPORT_CSV", False),
    ("modelTablesCsv", "mcda_tables_csv", "MCDA_TABLES_CSV", False),
    ("keepAwake", "keep_awake", "KEEP_AWAKE", False),
    ("scoreStatsCsv", "mcda_stats_csv", "MCDA_STATS_CSV", False),
    ("mapTooltipH3", "map_tooltip_h3", "MAP_TOOLTIP_H3", True),
)


def _stored(raw: str, default: bool) -> bool:
    """A switch as stored: `1` on, `0` off, blank (or anything else) its default."""
    value = (raw or "").strip()
    return True if value == "1" else False if value == "0" else default


def options_of(project: store.ProjectRow) -> Options:
    """This project's switches: as stored, or each one's default."""
    return Options(**{
        name: _stored(getattr(project, column), default)
        for name, column, _, default in OPTION_FIELDS
    })


def save_options(project: store.ProjectRow, options: Options) -> store.ProjectRow:
    """Store them. They reach the engine with the next run."""
    rows = store.read_projects()
    for row in rows:
        if row.id == project.id:
            for name, column, _, default in OPTION_FIELDS:
                # its default as blank, so a change of default reaches it
                wanted = getattr(options, name)
                setattr(row, column, "" if wanted == default else "1" if wanted else "0")
            row.updated_at = store.now()
    store.write_projects(rows)
    saved = store.find_project(project.id)
    return saved if saved else project


def option_env(project: store.ProjectRow) -> dict[str, str]:
    """
    The variables to run the engine with: `1` or `0` for each switch.

    `0` rather than leaving it out, because the engine's `.env` may set one
    of them, and a value in the environment the runner starts with wins over
    the file (its `OVERRIDE_VARS`). Off here means off.
    """
    options = options_of(project)
    return {
        variable: "1" if getattr(options, name) else "0"
        for name, _, variable, _ in OPTION_FIELDS
    }


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
            # The switches go back to their defaults with them: "Default
            # values" is the whole dialog.
            for _, column, _, _ in OPTION_FIELDS:
                setattr(row, column, "")
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
