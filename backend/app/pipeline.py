"""
Driving the SIG-Transformer pipeline.

The pipeline is not a monolith: `run_full.sh` orchestrates fourteen scripts
that each run on their own inside a long-lived container, which exists only to
be exec'd into (`command: sleep infinity` in its compose file). So this module
calls the stages directly rather than the shell script, and SIG-Transformer
needs no changes to support it.

Two of its directories are bind-mounted to the host, which is what keeps this
simple: `./logs` holds the run manifests, and `${DATA_DIR}` holds the outputs.
Both are ordinary files to us — progress and results need no Docker API, only
the filesystem.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

#: Where SIG-Transformer is checked out. A sibling of this repo by default.
PIPELINE_DIR = Path(
    os.environ.get("MAPHEX_PIPELINE_DIR", Path(__file__).resolve().parents[3] / "SIG-Transformer")
)

#: The compose service that holds the Python environment.
APP_SERVICE = "app"


@dataclass(frozen=True)
class Stage:
    """One step of the pipeline, as `run_full.sh` invokes it."""

    #: As numbered in run_full.sh and docs/pipeline.md. Some are fractional —
    #: 10.5 and 12.5 were inserted between existing steps.
    number: float
    key: str
    label: str
    #: Path inside the container.
    script: str
    #: Extra arguments `run_full.sh` passes.
    args: tuple[str, ...] = ()
    #: `run_full.sh` skips these when their output already exists, or unless a
    #: flag turns them on. That is why a finished run logs fewer summaries than
    #: there are stages.
    conditional: bool = False
    #: Needs Postgres, not just the app container.
    needs_db: bool = False
    #: Whether the stage writes a `script_summary` line to the run manifest.
    #: `apply_variable_fixes` does not, so its row in the UI is filled in by
    #: the next stage starting rather than by a summary of its own.
    reports: bool = True
    #: Roughly how long this stage takes, in seconds. Measured from one real
    #: run of the Colombia dataset at H3_RES=8, so these are the right order
    #: of magnitude and nothing more. They exist only to weight the progress
    #: bar: the stages differ by two orders of magnitude, so counting them
    #: equally would park the bar for five minutes on `load_h3_values` alone
    #: (324s of a 765s run) and then jump. A stage that has never been
    #: observed carries a guess, which is still better than treating it as
    #: equal to a one-second rename.
    weight: float = 10.0


#: Taken from the table in the pipeline's own docs/pipeline.md, which carries a
#: "condición" column saying exactly when each stage runs. Stages 0-2 are
#: validation, `docker compose up` and the SQL schema; this module does the
#: first two itself and the third is handled by Postgres on first start.
STAGES: tuple[Stage, ...] = (
    Stage(3, "normalize_dane", "Normalise administrative boundaries",
          "/app/app/pipeline/normalize_dane_mgn.py", conditional=True, weight=60),
    Stage(4, "fill_h3", "Build the H3 master table",
          "/app/app/pipeline/fill_h3_from_geojson.py", conditional=True, needs_db=True, weight=119),
    Stage(5, "h3_grid", "Export the H3 grid",
          "/app/app/pipeline/generate_h3_grid.py", conditional=True, needs_db=True, weight=72),
    Stage(6, "h3_tiles", "Generate PMTiles",
          "/app/app/pipeline/generate_h3_tiles.py", conditional=True, needs_db=True, weight=133),
    Stage(7, "lint_filenames", "Clean up file names",
          "/app/app/tools/lint_filenames.py", weight=1),
    Stage(8, "ingest", "Ingest vectors to GeoParquet",
          "/app/app/pipeline/ingest_to_geoparquet.py", weight=13),
    Stage(9, "raster_to_h3", "Sample rasters onto H3 cells",
          "/app/app/pipeline/raster_to_h3.py", weight=4),
    Stage(10, "parquet_to_h3", "Convert vectors to H3",
          "/app/app/pipeline/parquet_to_h3.py", weight=61),
    # Runs on every pass but writes no manifest entry, so it is invisible to
    # anything counting summaries.
    Stage(10.5, "variable_fixes", "Apply per-variable corrections",
          "/app/app/pipeline/apply_variable_fixes.py", reports=False, weight=5),
    Stage(10.6, "prune_stale", "Archive superseded outputs",
          "/app/app/pipeline/prune_stale_outputs.py", conditional=True, weight=5),
    Stage(11, "load_values", "Load H3 values into the database",
          "/app/app/pipeline/load_h3_values.py", needs_db=True, weight=324),
    Stage(12, "render_html", "Render the interactive maps",
          "/app/app/tools/render_html.py", weight=8),
    Stage(12.5, "collect_html", "Collect the verification renders",
          "/app/app/tools/collect_verification_html.py", conditional=True, weight=5),
    Stage(13, "export_master", "Export the master table",
          "/app/app/pipeline/export_hexagonos_csv.py", args=("--limit", "0"), needs_db=True, weight=33),
)

STAGES_BY_KEY = {stage.key: stage for stage in STAGES}

#: The model, which is separate from ingestion and the one re-run most often
#: while tuning weights.
MCDA_SCRIPT = "/app/MCDA/engine/mcda_score.py"


@dataclass
class PipelineStatus:
    """Whether the pipeline can be driven at all, and what is missing."""

    pipelineDir: str
    pipelineFound: bool
    dockerAvailable: bool
    composeAvailable: bool
    appRunning: bool
    dbRunning: bool
    problems: list[str] = field(default_factory=list)

    @property
    def ready(self) -> bool:
        return not self.problems


def _run(command: list[str], cwd: Path | None = None, timeout: int = 30):
    try:
        return subprocess.run(
            command, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None


def _running_services() -> set[str]:
    """Which compose services are up, by name."""
    result = _run(["docker", "compose", "ps", "--services", "--filter", "status=running"],
                  cwd=PIPELINE_DIR)
    if result is None or result.returncode != 0:
        return set()
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def _explain_blocked(blocked: list[Path]) -> str:
    """
    Why the pipeline cannot write to its own folders, and how to fix it.

    Ownership is checked rather than assumed. Docker-made-it-as-root is the
    usual cause and the fix is a `chown`, but a folder that is already ours
    and merely read-only needs `chmod` — and being sent to the wrong one of
    those is an afternoon gone.
    """
    names = ", ".join(str(path) for path in blocked)
    try:
        theirs = [path for path in blocked if path.stat().st_uid != os.getuid()]
    except OSError:
        theirs = blocked

    if not theirs:
        return (
            f"The pipeline cannot write to {names}. They are yours, so it is their "
            f"permissions rather than their owner — `chmod u+w` on them, or check "
            f"whether they are on a read-only mount."
        )

    owners = sorted({path.owner() for path in theirs if path.exists()})
    whose = f" (owned by {', '.join(owners)})" if owners else ""
    return (
        f"The pipeline cannot write to {names}{whose}. `run_full.sh` creates a folder "
        f"there from the host before any container starts, so a run fails on its first "
        f"line. These are not in the engine's repository, so Docker creates them when "
        f"it starts before anything else has — as root, because the daemon runs as "
        f"root. Fix with: sudo chown -R $(id -un):$(id -gn) {PIPELINE_DIR}"
    )


def status() -> PipelineStatus:
    """
    What is in place and what is not.

    Reported as a list of problems rather than a single boolean so the UI can
    say which thing to fix — "Docker is not running" and "the pipeline is not
    where I expected" need different answers from the user.
    """
    problems: list[str] = []

    found = (PIPELINE_DIR / "docker-compose.yml").is_file()
    if not found:
        problems.append(
            f"No pipeline at {PIPELINE_DIR}. Set MAPHEX_PIPELINE_DIR to where "
            f"SIG-Transformer is checked out."
        )

    docker = shutil.which("docker") is not None
    if not docker:
        problems.append("Docker is not on the PATH. On WSL, enable integration for this distro.")

    compose = False
    if docker:
        result = _run(["docker", "compose", "version"])
        compose = result is not None and result.returncode == 0
        if not compose:
            problems.append("`docker compose` is not available.")

    if found:
        blocked = unwritable_host_folders()
        if blocked:
            problems.append(_explain_blocked(blocked))

    services = _running_services() if (found and compose) else set()
    app_up, db_up = APP_SERVICE in services, "db" in services
    if found and compose and not app_up:
        problems.append("The pipeline containers are not up. Start them before running a stage.")

    return PipelineStatus(
        pipelineDir=str(PIPELINE_DIR),
        pipelineFound=found,
        dockerAvailable=docker,
        composeAvailable=compose,
        appRunning=app_up,
        dbRunning=db_up,
        problems=problems,
    )


#: Folders the pipeline needs on the host, and who makes them.
#:
#: None are in the engine's repository — they are all gitignored — so on a
#: fresh checkout they do not exist. Whatever runs first creates them, and if
#: that is `docker compose up`, Docker creates them as **root**, because the
#: daemon runs as root. After that `run_full.sh` fails on its own first line:
#: it does `mkdir -p logs/<execution_id>` from the host, as the user, before
#: any container is involved.
#:
#: `admin` is listed because the script does `mkdir -p admin/in admin/out`
#: the same way.
HOST_FOLDERS = ("logs", "admin", "toytest")

#: The subset whose ownership actually stops a run, which is not the same
#: list. `toytest` is only touched when TOYTEST=1, and `data` is written from
#: inside the container, where the engine runs as root and permissions do not
#: apply — refusing to process over either would be a refusal with nothing
#: behind it. (A root-owned `data` does stop *adding* data, and `inputs.py`
#: says so at the point where it matters.)
RUN_FOLDERS = ("logs", "admin")


def _host_paths() -> list[Path]:
    return [PIPELINE_DIR / name for name in HOST_FOLDERS] + [engine_data_dir()]


def prepare_host_folders() -> None:
    """
    Create what the pipeline needs, as us, before Docker can do it as root.

    Best effort and cheap. Called before `docker compose up`, which is the
    step that would otherwise create these — once they exist, Docker mounts
    them rather than making them.
    """
    for path in _host_paths():
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass  # reported properly by `unwritable_host_folders`


def unwritable_host_folders() -> list[Path]:
    """
    Which of them we cannot write to — the ones that will fail a run.

    Checked before starting rather than discovered during: the script's very
    first action is a host-side mkdir, so this is the difference between a
    clear message and `mkdir: Permission denied` with no context.

    Only the folders a run genuinely needs — see `RUN_FOLDERS`.
    """
    blocked = []
    for path in (PIPELINE_DIR / name for name in RUN_FOLDERS):
        target = path if path.is_dir() else path.parent
        if target.is_dir() and not os.access(target, os.W_OK | os.X_OK):
            blocked.append(path)
    return blocked


def compose_up() -> subprocess.CompletedProcess[str] | None:
    """
    Bring up Postgres and the idle app container.

    The folders are made first: this is the call that would otherwise have
    Docker create them as root. See `prepare_host_folders`.
    """
    prepare_host_folders()
    return _run(["docker", "compose", "up", "-d"], cwd=PIPELINE_DIR, timeout=600)


def read_env_file() -> dict[str, str]:
    """
    The pipeline's own `.env`, parsed.

    Compose loads this for the container, but values we need to *compute* —
    DATABASE_URL in particular — are not in it.
    """
    values: dict[str, str] = {}
    env_path = PIPELINE_DIR / ".env"
    if not env_path.exists():
        return values
    for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        values[name.strip()] = value.strip()
    return values


def database_url() -> str:
    """
    The connection string the DB stages expect.

    `run_full.sh` builds this when it is not already set, and the container
    does not get it from compose — so driving stages directly means building
    it here too, by the same rule, or anything touching Postgres fails with
    "DATABASE_URL no configurada".
    """
    env = read_env_file()
    if env.get("DATABASE_URL"):
        return env["DATABASE_URL"]

    user = env.get("POSTGRES_USER", "")
    password = env.get("POSTGRES_PASSWORD", "")
    database = env.get("POSTGRES_DB", "")
    # Inside the compose network the host is the service name, not localhost.
    host = env.get("DB_HOST", "db")
    port = env.get("DB_PORT", "5432")
    return f"postgresql://{user}:{password}@{host}:{port}/{database}"


def stage_command(stage: Stage, execution_id: str, settings: dict[str, str] | None = None) -> list[str]:
    """
    The exact command for one stage.

    Built rather than run so it can be shown, logged and tested without
    starting anything — the pipeline takes hours, and a wrong command is
    cheaper to catch here.
    """
    command = ["docker", "compose", "exec", "-T", "-e", f"EXECUTION_ID={execution_id}"]
    if stage.needs_db:
        command += ["-e", f"DATABASE_URL={database_url()}"]
    for name, value in (settings or {}).items():
        command += ["-e", f"{name}={value}"]
    command += [APP_SERVICE, "python", stage.script, *stage.args]
    return command


def mcda_command(config: str, site: str, master: str, execution_id: str) -> list[str]:
    """
    The model run.

    `--master` is required: when more than one master table exists the engine
    refuses to choose, and lists the options in its error.
    """
    return [
        "docker", "compose", "exec", "-T", "-e", f"EXECUTION_ID={execution_id}",
        APP_SERVICE, "python", MCDA_SCRIPT,
        "--config", config, "--site", site, "--master", master,
    ]


# ── where a run reports from ──────────────────────────────────────────────


def manifest_path(execution_id: str) -> Path:
    """Host-side path to a run's manifest, via the bind-mounted logs folder."""
    log_dir = Path(os.environ.get("MAPHEX_PIPELINE_LOG_DIR", PIPELINE_DIR / "logs"))
    return log_dir / execution_id / "run_manifest.jsonl"


# ── running the whole pipeline ────────────────────────────────────────────
#
# The stage list above exists to *name* the steps and to re-run one on its
# own. A full pass goes through `run_full.sh` instead, and deliberately so:
# the script is not a thin loop over the stages, it is where the decisions
# live. Whether to rebuild the H3 master is a comparison between the H3
# resolution, the bbox flag and the mtime of the normalised boundaries
# against what the `pipeline_state` table recorded last time; when that says
# rebuild, the script truncates seven tables and turns on three force flags
# that the stages then read. Reimplementing it here would mean keeping a copy
# of someone else's rules in step with theirs, and a copy that drifted would
# not fail loudly — it would quietly skip the master rebuild, or truncate
# when it should not have. So the script stays in charge and this module
# watches it work.

RUN_SCRIPT = "run_full.sh"

#: What the script prints as it reaches each stage, as (substring, stage key,
#: status) — matched case-insensitively against its stdout.
#:
#: This is screen-scraping another team's log lines, so it is written to fail
#: softly. Progress and per-stage results come from the run manifest, which
#: records the canonical script name; these markers only supply the live
#: "what is happening now" label and the skip notices, which the manifest has
#: no entry for. If upstream rewords a line, that label goes quiet and
#: everything else still works.
STAGE_LOG_MARKERS: tuple[tuple[str, str, str], ...] = (
    ("normalizando shapefiles dane", "normalize_dane", "running"),
    ("geojson normalizados ya existen", "normalize_dane", "skipped"),
    ("llenando h3", "fill_h3", "running"),
    ("tabla maestro ya tiene", "fill_h3", "skipped"),
    ("generando malla h3", "h3_grid", "running"),
    ("malla h3 ya existe", "h3_grid", "skipped"),
    ("generando pmtiles", "h3_tiles", "running"),
    ("pmtiles ya existe", "h3_tiles", "skipped"),
    ("limpiando nombres de archivos", "lint_filenames", "running"),
    ("ingesta vectorial", "ingest", "running"),
    ("procesando rasters a h3", "raster_to_h3", "running"),
    ("convirtiendo parquets vectoriales", "parquet_to_h3", "running"),
    ("aplicando correcciones de variables", "variable_fixes", "running"),
    ("archivando salidas obsoletas", "prune_stale", "running"),
    ("sincronizando valores h3", "load_values", "running"),
    ("generando renders html", "render_html", "running"),
    ("recopilando renders html", "collect_html", "running"),
    ("exportando tabla maestra", "export_master", "running"),
)


def match_stage_line(line: str) -> tuple[str, str] | None:
    """Which stage a line of the script's output is about, if any."""
    lowered = line.lower()
    for marker, key, status in STAGE_LOG_MARKERS:
        if marker in lowered:
            return key, status
    return None


#: The script announces the id it generated. We cannot choose it: the script
#: sets EXECUTION_ID unconditionally at startup, so we read it back rather
#: than passing one in.
EXECUTION_ID_MARKER = "Execution ID:"


def match_execution_id(line: str) -> str | None:
    if EXECUTION_ID_MARKER not in line:
        return None
    return line.split(EXECUTION_ID_MARKER, 1)[1].strip() or None


def run_full_command() -> list[str]:
    """
    How to invoke a full pass.

    Called through bash explicitly rather than relying on the execute bit,
    which does not survive every way this repo gets onto a machine.
    """
    return ["bash", RUN_SCRIPT]


def engine_data_dir() -> Path:
    """
    The folder the engine will actually process. Not the project's.

    `run_full.sh` lists `DATA_DIR` among the variables it accepts from the
    environment, and then, twenty lines later, assigns over it:

        if [[ "${TOYTEST}" == "1" ]]; then
          DATA_DIR="${ROOT_DIR}/toytest/data"
        else
          DATA_DIR="${ROOT_DIR}/data"
        fi

    So the override is declared but discarded, and a run always works on the
    folder inside the pipeline's own checkout. That is worth knowing rather
    than working around: passing `DATA_DIR` and believing it took effect is
    how a run silently processes one folder while the UI reads another.

    A one-line change upstream — `DATA_DIR="${DATA_DIR:-${ROOT_DIR}/data}"` —
    would make the declared override real, and is what per-project data
    folders need.
    """
    env = read_env_file()
    if env.get("TOYTEST") == "1":
        return PIPELINE_DIR / "toytest" / "data"
    return PIPELINE_DIR / "data"


def run_full_env(*, skip_build: bool = True, extra: dict[str, str] | None = None) -> dict[str, str]:
    """
    The environment for a full pass.

    `SKIP_BUILD=1` by default: left off, the script runs `docker compose up
    --build` on every pass, so clicking Process would rebuild the image. The
    image is ours to manage — `compose_up` and the setup path do that — and a
    rebuild in the middle of what the user thinks is a data run would just
    look like a hang.

    `DATA_DIR` is deliberately *not* set here; see `engine_data_dir` for why
    setting it would not work.
    """
    env = dict(os.environ)
    if skip_build:
        env["SKIP_BUILD"] = "1"
    # Unbuffered, or the script's children trickle out in 4 KB blocks and the
    # progress label lags minutes behind the work.
    env["PYTHONUNBUFFERED"] = "1"
    env.update(extra or {})
    return env


#: Kills whatever the pipeline is running inside the container.
#:
#: `docker compose exec` does not forward signals to the process it started,
#: so stopping the client leaves the Python running — it would keep writing to
#: the database after the UI said the run had stopped. The image has no pkill,
#: so this walks /proc. The pattern is matched against the full command line,
#: which for every stage contains `/app/app/`.
KILL_SNIPPET = r"""
killed=0
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  [ "$pid" = "$$" ] && continue
  cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
  case "$cmd" in
    *"/app/app/"*|*"/app/MCDA/"*)
      kill -TERM "$pid" 2>/dev/null && killed=$((killed+1)) ;;
  esac
done
echo "killed=$killed"
"""


def kill_in_container() -> str:
    """
    Stop the pipeline inside the container. Returns what happened, for the log.

    Best-effort by nature: if the container is already gone there is nothing
    to kill, which is the same outcome by a different route.
    """
    result = _run(
        ["docker", "compose", "exec", "-T", APP_SERVICE, "sh", "-c", KILL_SNIPPET],
        cwd=PIPELINE_DIR,
        timeout=30,
    )
    if result is None:
        return "could not reach the container to stop the pipeline"
    if result.returncode != 0:
        return (result.stderr or result.stdout or "").strip()[:200]
    return (result.stdout or "").strip()
