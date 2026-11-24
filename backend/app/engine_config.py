"""
The engine's own configuration, its `.env`, as a screen of settings.

The engine is configured by one file per machine (`.env` beside its
`run_full.sh`): database credentials, the size of its containers, Postgres
tuning, the workers of each stage. Until now the only way to change any of it
was to open that file by hand. This module lists every setting with what it
does, what it is now and what it is by default, and writes the ones changed.

Where the list comes from:

* The defaults are the engine's: its `.env.example`, which is the file every
  installation starts from. A setting it only shows commented out
  (`# INSTALL_PROFILERS=1`) is off by default.
* The labels and descriptions are ours (`CATALOGUE`), in English like the
  rest of the app; the engine's own comments are in Spanish.
* A setting the engine has that the catalogue does not know (a newer engine)
  still appears, under "Other settings", with its name and its default: a
  screen that silently dropped settings would be worse than a plain one.

Some are shown and not offered (`readOnly`):

* the connection (user, password, database, port, URL): Postgres created the
  database with them, so changing them here would lock the engine out of it;
* the Docker project name, which names the database's volume: another name
  starts an empty database;
* the two resolutions, which each project sets for itself before its runs.

The password never leaves the server: it is described as set or not set.

Nothing is written while a run is going: the runners read the file when they
start, and the database settings recreate the db container on the next run.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import pipeline


class ConfigError(ValueError):
    """A value the engine would not accept, said in words."""


# ── the catalogue ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Setting:
    key: str
    label: str
    description: str
    #: How the value is checked: int, float, flag (0/1), dockerSize (8g),
    #: pgSize (512MB), pgDuration (30min), choice, path, text.
    kind: str = "text"
    choices: tuple[str, ...] = ()
    minimum: float | None = None
    maximum: float | None = None
    #: Why it is shown and not offered, or "" when it can be changed.
    readOnly: str = ""
    secret: bool = False
    #: Blank allowed: the engine then works it out (the workers of a stage).
    optional: bool = False


@dataclass(frozen=True)
class Section:
    title: str
    #: When a change here takes effect.
    applies: str
    settings: tuple[Setting, ...] = field(default_factory=tuple)


_INSTALLED = (
    "Set when the engine was installed: Postgres created the database with these, so "
    "changing them here would lock the engine out of it. Change them in the engine's "
    ".env by hand if you really mean to."
)
_PER_PROJECT = "Set per project, in each project's settings, before each of its runs."
_AUTOMATIC = "Blank: the engine decides from the CPUs and memory it has."

CATALOGUE: tuple[Section, ...] = (
    Section("Connection", "Fixed at installation.", (
        Setting("POSTGRES_USER", "Database user", "The user the engine connects as.",
                readOnly=_INSTALLED),
        Setting("POSTGRES_PASSWORD", "Database password", "Its password. Never shown here.",
                readOnly=_INSTALLED, secret=True),
        Setting("POSTGRES_DB", "Main database",
                "The engine's main database. Every project of this app runs on one of its "
                "own, named after it.", readOnly=_INSTALLED),
        Setting("POSTGRES_PORT", "Database port",
                "The port Postgres is published on, on this machine only.", kind="int",
                readOnly=_INSTALLED),
        Setting("DATABASE_URL", "Database URL",
                "Optional: built from the values above when blank.", readOnly=_INSTALLED,
                secret=True),
    )),
    Section("Docker", "Fixed at installation.", (
        Setting("COMPOSE_PROJECT_NAME", "Docker project name",
                "Prefixes the engine's containers and names the database's volume.",
                readOnly="It names the database's volume: with another name Docker starts a "
                         "new, empty database and the current one looks deleted."),
    )),
    Section("Folders and default project", "On the next run.", (
        Setting("DATA_DIR", "Main data folder",
                "The engine's own data folder, for runs started from a terminal. Projects "
                "here each use the folder they were created with, never this one.",
                kind="path"),
        Setting("PROJECT", "Default engine project",
                "The engine project a terminal run loads when it is given none. Runs from "
                "this app never load one.", optional=True),
    )),
    Section("CPUs and memory", "On the next run: the runners apply them to the running "
            "containers without recreating them.", (
        Setting("FIT_TO_MACHINE", "Fit to this machine",
                "On: any size below that is more than Docker can give on this computer is "
                "lowered to what it can, and the run says so. Off: used as written.",
                kind="flag"),
        Setting("APP_CPUS", "Engine CPUs", "CPUs of the engine's container.", kind="float",
                minimum=0.5, maximum=1024),
        Setting("APP_MEM_LIMIT", "Engine memory",
                "Memory of the engine's container. Too little and the system kills its "
                "processes mid-run (\"terminated abruptly\").", kind="dockerSize"),
        Setting("DB_CPUS", "Database CPUs", "CPUs of the database's container.", kind="float",
                minimum=0.5, maximum=1024),
        Setting("DB_MEM_LIMIT", "Database memory", "Memory of the database's container.",
                kind="dockerSize"),
        Setting("DB_SHM_SIZE", "Database shared memory",
                "Shared memory of the database, for its parallel queries (Docker's default "
                "is 64m).", kind="dockerSize"),
        Setting("MAX_APP_CPUS", "Most CPUs a project may ask for",
                "A ceiling on what any project's own settings request.", kind="float",
                minimum=0.5, maximum=1024),
        Setting("MAX_APP_MEMORY", "Most memory a project may ask for",
                "A ceiling on what any project's own settings request.", kind="dockerSize"),
        Setting("MAX_WORKERS", "Most workers per stage",
                "A ceiling on the parallel processes of any stage.", kind="int", minimum=1,
                maximum=1024),
    )),
    Section("Workers per stage", "On the next run. A project's own settings win over these.", (
        Setting("INGEST_WORKERS", "Ingest workers",
                "Files read in parallel by the ingest. 0 reads them one at a time. "
                + _AUTOMATIC, kind="int", minimum=0, maximum=1024, optional=True),
        Setting("RASTER_WORKERS", "Raster workers",
                "Rasters sampled in parallel. Each holds a whole raster band and the master's "
                "cells, so on a machine short of memory 1 or 2 is safest. " + _AUTOMATIC,
                kind="int", minimum=1, maximum=1024, optional=True),
        Setting("H3_WORKERS", "H3 conversion workers",
                "Vector layers converted to H3 in parallel. 0 converts them one at a time. "
                + _AUTOMATIC, kind="int", minimum=0, maximum=1024, optional=True),
        Setting("LOAD_WORKERS", "Database load workers",
                "Variables loaded into the database in parallel. " + _AUTOMATIC,
                kind="int", minimum=1, maximum=1024, optional=True),
    )),
    Section("Postgres", "On the next processing run, which recreates the database's "
            "container (its data is kept). A value Postgres rejects stops it from starting; "
            "the database's Docker log says which.", (
        Setting("PG_SHARED_BUFFERS", "Shared buffers",
                "Postgres's own cache. No more than 40% of the database's memory.",
                kind="pgSize"),
        Setting("PG_WORK_MEM", "Work memory", "Memory for each sort or hash in a query.",
                kind="pgSize"),
        Setting("PG_MAINTENANCE_WORK_MEM", "Maintenance memory",
                "Memory for building indexes and VACUUM.", kind="pgSize"),
        Setting("PG_EFFECTIVE_CACHE_SIZE", "Effective cache size",
                "What the planner assumes the system caches for it.", kind="pgSize"),
        Setting("PG_MAX_PARALLEL_WORKERS_PER_GATHER", "Parallel workers per query",
                "Processes one query step may use.", kind="int", minimum=0, maximum=1024),
        Setting("PG_MAX_PARALLEL_WORKERS", "Parallel workers", "Parallel processes in all.",
                kind="int", minimum=0, maximum=1024),
        Setting("PG_MAX_WORKER_PROCESSES", "Worker processes", "Background processes in all.",
                kind="int", minimum=0, maximum=1024),
        Setting("PG_CHECKPOINT_TIMEOUT", "Checkpoint interval", "Time between checkpoints.",
                kind="pgDuration"),
        Setting("PG_MAX_WAL_SIZE", "Largest WAL",
                "WAL kept between checkpoints: larger means fewer of them during a big load.",
                kind="pgSize"),
        Setting("PG_SYNCHRONOUS_COMMIT", "Synchronous commit",
                "Off loads faster; a crash loses the last transactions (the database can be "
                "rebuilt from the data folder).", kind="choice",
                choices=("off", "on", "local", "remote_write", "remote_apply")),
        Setting("PG_WAL_LEVEL", "WAL level",
                "Minimal writes the least during loads, with no replication. Minimal needs "
                "WAL senders at 0.", kind="choice", choices=("minimal", "replica", "logical")),
        Setting("PG_MAX_WAL_SENDERS", "WAL senders",
                "Replication connections. 0 with the minimal WAL level.", kind="int",
                minimum=0, maximum=1024),
        Setting("PG_WAL_COMPRESSION", "WAL compression", "How the WAL is compressed.",
                kind="choice", choices=("lz4", "pglz", "zstd", "off", "on")),
        Setting("PG_EFFECTIVE_IO_CONCURRENCY", "I/O concurrency",
                "Disk reads Postgres may have going at once: about 200 on an SSD, 2 on a "
                "spinning disk.", kind="int", minimum=0, maximum=1000),
        Setting("PG_RANDOM_PAGE_COST", "Random page cost",
                "How much the planner charges a random read: 1.1 on an SSD, 4 on a spinning "
                "disk.", kind="float", minimum=0, maximum=100),
    )),
    Section("Image and start-up", "On the next run.", (
        Setting("SKIP_BUILD", "Skip rebuilding the engine image",
                "On: runs start faster. Turn it off once after the engine's dependencies "
                "change.", kind="flag"),
    )),
    Section("Measuring a run", "When the engine's image is rebuilt, or the database's "
            "container recreated.", (
        Setting("INSTALL_PROFILERS", "Install the profilers",
                "Puts the profilers in the engine's image, so a run can be measured.",
                kind="flag", optional=True),
        Setting("PG_SHARED_PRELOAD_LIBRARIES", "Postgres preload libraries",
                "pg_stat_statements gives per-query statistics.", optional=True),
        Setting("PG_TRACK_IO_TIMING", "Time Postgres's disk reads", "On or off.",
                kind="choice", choices=("on", "off"), optional=True),
    )),
    Section("Resolutions", "Before each run of a project.", (
        Setting("H3_RES", "Processing resolution", "The size of the hexagons values are "
                "computed at.", kind="int", readOnly=_PER_PROJECT, optional=True),
        Setting("RENDER_H3_RES", "Map resolution", "The size of the hexagons the maps are "
                "drawn at.", kind="int", readOnly=_PER_PROJECT, optional=True),
    )),
)

OTHER_SECTION = "Other settings"

_BY_KEY = {s.key: s for section in CATALOGUE for s in section.settings}


# ── the engine's defaults ─────────────────────────────────────────────────

_EXAMPLE_LINE = re.compile(
    r"^\s*(?P<off>#\s*)?(?:export\s+)?(?P<name>[A-Z][A-Z0-9_]*)="
    r"(?P<value>'[^']*'|\"[^\"]*\"|[^#\s]*)(?P<rest>.*)$"
)


def engine_defaults() -> dict[str, str | None]:
    """
    Every setting of the engine's `.env.example`, with its default: the value
    of an active line, None for one only shown commented out (off unless set).
    """
    path = pipeline.PIPELINE_DIR / ".env.example"
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return {}
    defaults: dict[str, str | None] = {}
    for line in lines:
        match = _EXAMPLE_LINE.match(line)
        if match is None:
            continue
        name = match.group("name")
        value = match.group("value").strip("'\"")
        if match.group("off"):
            # `# INSTALL_PROFILERS=1` documents an optional setting, off by
            # default. A commented example of a command line
            # (`#   FORCE_REPROCESS=1 H3_WORKERS=2 ./run_full.sh`) is not one.
            if re.fullmatch(r"\s*(#.*)?", match.group("rest")) and name not in defaults:
                defaults[name] = None
        else:
            defaults[name] = value
    return defaults


# ── reading ───────────────────────────────────────────────────────────────


def _raw_values() -> dict[str, str]:
    """The `.env` as written (values unquoted, comments dropped), not expanded."""
    path = pipeline.PIPELINE_DIR / ".env"
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return values
    for line in lines:
        match = pipeline._ENV_LINE.match(line)
        if match is not None:
            values[match.group("name")] = match.group("value").strip().strip("'\"")
    return values


def describe() -> dict:
    """Every setting, grouped as the engine groups them, for the screen."""
    defaults = engine_defaults()
    current = _raw_values()

    def entry(setting: Setting) -> dict:
        is_set = setting.key in current
        value = current.get(setting.key, "")
        default = defaults.get(setting.key)
        return {
            "key": setting.key,
            "label": setting.label,
            "description": setting.description,
            "kind": setting.kind,
            "choices": list(setting.choices),
            "minimum": setting.minimum,
            "maximum": setting.maximum,
            "optional": setting.optional,
            "readOnly": setting.readOnly,
            "secret": setting.secret,
            # The password is described, never sent.
            "value": ("" if setting.secret else value),
            "isSet": is_set and value != "",
            "default": "" if setting.secret or default is None else default,
            "isDefault": (not is_set) or value == (default or ""),
        }

    sections = []
    for section in CATALOGUE:
        sections.append({"title": section.title, "applies": section.applies,
                         "settings": [entry(s) for s in section.settings]})

    unknown = sorted(k for k in set(defaults) | set(current) if k not in _BY_KEY)
    if unknown:
        sections.append({
            "title": OTHER_SECTION,
            "applies": "As the engine reads it; see its .env.example.",
            "settings": [entry(Setting(k, k, "Not described here: see the engine's "
                                             ".env.example.", optional=True))
                         for k in unknown],
        })
    return {
        "envFile": str(pipeline.PIPELINE_DIR / ".env"),
        "envExists": (pipeline.PIPELINE_DIR / ".env").is_file(),
        "sections": sections,
    }


# ── checking ──────────────────────────────────────────────────────────────

_DOCKER_SIZE = re.compile(r"^\d+(\.\d+)?[bkmgBKMG]?$")
_PG_SIZE = re.compile(r"^\d+(kB|MB|GB|TB)?$")
_PG_DURATION = re.compile(r"^\d+(us|ms|s|min|h|d)?$")
_SAFE_TEXT = re.compile(r"^[^\s#'\"`$\\]+$")


def _bytes(size: str, unit_base: dict[str, int]) -> int | None:
    match = re.match(r"^(\d+(?:\.\d+)?)([A-Za-z]*)$", size)
    if not match:
        return None
    return int(float(match.group(1)) * unit_base.get(match.group(2), 1))


_DOCKER_UNITS = {"": 1, "b": 1, "k": 1024, "m": 1024 ** 2, "g": 1024 ** 3,
                 "B": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3}
_PG_UNITS = {"": 8192, "kB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3, "TB": 1024 ** 4}


def check_value(setting: Setting, value: str) -> str:
    """The value as it will be written, or ConfigError saying what is wrong."""
    value = value.strip()
    name = setting.label
    if value == "":
        if setting.optional:
            return ""
        raise ConfigError(f"{name}: needs a value.")
    if setting.kind == "int":
        if not re.fullmatch(r"-?\d+", value):
            raise ConfigError(f"{name}: a whole number, not {value!r}.")
        number = float(value)
    elif setting.kind == "float":
        try:
            number = float(value)
        except ValueError:
            raise ConfigError(f"{name}: a number, not {value!r}.") from None
    elif setting.kind == "flag":
        if value not in ("0", "1"):
            raise ConfigError(f"{name}: 1 (on) or 0 (off), not {value!r}.")
        return value
    elif setting.kind == "dockerSize":
        if not _DOCKER_SIZE.match(value):
            raise ConfigError(f"{name}: a size like 8g or 512m, not {value!r}.")
        return value
    elif setting.kind == "pgSize":
        if not _PG_SIZE.match(value):
            raise ConfigError(f"{name}: a size like 512MB or 2GB (kB, MB, GB or TB, "
                              f"case as written), not {value!r}.")
        return value
    elif setting.kind == "pgDuration":
        if not _PG_DURATION.match(value):
            raise ConfigError(f"{name}: a time like 30min, 300s or 1h, not {value!r}.")
        return value
    elif setting.kind == "choice":
        if value not in setting.choices:
            raise ConfigError(f"{name}: one of {', '.join(setting.choices)}, not {value!r}.")
        return value
    else:
        # A path or a word, written into a file bash sources: nothing that
        # would be read as more than one value, a comment or an expansion.
        if not _SAFE_TEXT.match(value):
            raise ConfigError(f"{name}: no spaces, quotes, '#', '$' or backslashes.")
        return value
    if setting.minimum is not None and number < setting.minimum:
        raise ConfigError(f"{name}: at least {setting.minimum:g}.")
    if setting.maximum is not None and number > setting.maximum:
        raise ConfigError(f"{name}: at most {setting.maximum:g}.")
    return value


def _check_together(values: dict[str, str]) -> None:
    """The rules that tie two settings together, which the engine enforces at run time."""
    level = values.get("PG_WAL_LEVEL", "")
    senders = values.get("PG_MAX_WAL_SENDERS", "")
    if level == "minimal" and senders not in ("", "0"):
        raise ConfigError("WAL senders: must be 0 with the minimal WAL level "
                          "(or set the WAL level to replica).")
    buffers = _bytes(values.get("PG_SHARED_BUFFERS", ""), _PG_UNITS)
    memory = _bytes(values.get("DB_MEM_LIMIT", ""), _DOCKER_UNITS)
    if buffers and memory and buffers > 0.4 * memory:
        raise ConfigError("Shared buffers: no more than 40% of the database's memory "
                          f"({values.get('DB_MEM_LIMIT')}).")


# ── writing ───────────────────────────────────────────────────────────────


def save(changes: dict[str, str | None]) -> dict:
    """
    Write these settings into the engine's `.env`. A value of None (or blank,
    for a setting that may be blank) puts the engine's default back: its
    value, or no line at all for one that is off by default.
    """
    if not (pipeline.PIPELINE_DIR / ".env").is_file():
        raise ConfigError("The engine has no .env yet: create it from its .env.example "
                          "first (it holds the database credentials).")
    defaults = engine_defaults()
    known = {**_BY_KEY}
    for key in defaults:
        known.setdefault(key, Setting(key, key, "", optional=True))

    write: dict[str, str] = {}
    remove: list[str] = []
    for key, wanted in changes.items():
        setting = known.get(key)
        if setting is None:
            raise ConfigError(f"{key}: not a setting of the engine.")
        if setting.readOnly:
            raise ConfigError(f"{setting.label}: {setting.readOnly}")
        default = defaults.get(key)
        if wanted is None or (wanted.strip() == "" and setting.optional):
            if default is None or default == "":
                remove.append(key)
            else:
                write[key] = default
            continue
        write[key] = check_value(setting, wanted)

    final = {**_raw_values(), **write}
    for key in remove:
        final.pop(key, None)
    _check_together(final)

    if write:
        pipeline.write_env_values(write, note="Set by Maphex from its engine settings.")
    if remove:
        pipeline.remove_env_values(remove)
    return describe()
