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
    #: Whether the stage writes a `script_summary` line. One does not, so it
    #: can never be counted — see `reporting_stages`.
    reports: bool = True


#: Taken from the table in the pipeline's own docs/pipeline.md, which carries a
#: "condición" column saying exactly when each stage runs. Stages 0-2 are
#: validation, `docker compose up` and the SQL schema; this module does the
#: first two itself and the third is handled by Postgres on first start.
STAGES: tuple[Stage, ...] = (
    Stage(3, "normalize_dane", "Normalise administrative boundaries",
          "/app/app/pipeline/normalize_dane_mgn.py", conditional=True),
    Stage(4, "fill_h3", "Build the H3 master table",
          "/app/app/pipeline/fill_h3_from_geojson.py", conditional=True, needs_db=True),
    Stage(5, "h3_grid", "Export the H3 grid",
          "/app/app/pipeline/generate_h3_grid.py", conditional=True, needs_db=True),
    Stage(6, "h3_tiles", "Generate PMTiles",
          "/app/app/pipeline/generate_h3_tiles.py", conditional=True, needs_db=True),
    Stage(7, "lint_filenames", "Clean up file names",
          "/app/app/tools/lint_filenames.py"),
    Stage(8, "ingest", "Ingest vectors to GeoParquet",
          "/app/app/pipeline/ingest_to_geoparquet.py"),
    Stage(9, "raster_to_h3", "Sample rasters onto H3 cells",
          "/app/app/pipeline/raster_to_h3.py"),
    Stage(10, "parquet_to_h3", "Convert vectors to H3",
          "/app/app/pipeline/parquet_to_h3.py"),
    # Runs on every pass but writes no manifest entry, so it is invisible to
    # anything counting summaries.
    Stage(10.5, "variable_fixes", "Apply per-variable corrections",
          "/app/app/pipeline/apply_variable_fixes.py", reports=False),
    Stage(10.6, "prune_stale", "Archive superseded outputs",
          "/app/app/pipeline/prune_stale_outputs.py", conditional=True),
    Stage(11, "load_values", "Load H3 values into the database",
          "/app/app/pipeline/load_h3_values.py", needs_db=True),
    Stage(12, "render_html", "Render the interactive maps",
          "/app/app/tools/render_html.py"),
    Stage(12.5, "collect_html", "Collect the verification renders",
          "/app/app/tools/collect_verification_html.py", conditional=True),
    Stage(13, "export_master", "Export the master table",
          "/app/app/pipeline/export_hexagonos_csv.py", args=("--limit", "0"), needs_db=True),
)

#: The denominator for progress. The docs say to count `script_summary` lines
#: against fourteen stages, but that is not what lands in the manifest:
#: stages 0-2 write none, and `apply_variable_fixes` writes none either. Only
#: these can ever appear.
def reporting_stages() -> tuple[Stage, ...]:
    return tuple(stage for stage in STAGES if stage.reports)


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


def compose_up() -> subprocess.CompletedProcess[str] | None:
    """Bring up Postgres and the idle app container."""
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


# ── reading a run's progress ──────────────────────────────────────────────

def manifest_path(execution_id: str) -> Path:
    """Host-side path to a run's manifest, via the bind-mounted logs folder."""
    log_dir = Path(os.environ.get("MAPHEX_PIPELINE_LOG_DIR", PIPELINE_DIR / "logs"))
    return log_dir / execution_id / "run_manifest.jsonl"


#: The last stage that writes a summary. `pipeline_summary` runs after it but
#: logs nothing, so this is what marks a run as finished.
TERMINAL_STAGE = "export_hexagonos_csv"


@dataclass
class RunProgress:
    executionId: str
    #: Stages that have reported a summary, in order.
    completed: list[str]
    #: Stages that reported a summary with a non-ok status.
    failed: list[str]
    total: int
    percent: int
    #: True once the pipeline's own progress line exists, which the pipeline
    #: team plan to add. Until then the percentage is an estimate.
    exact: bool
    #: The terminal stage has reported, so the run is over.
    finished: bool = False
    #: Per-stage counts of files the pipeline skipped or failed on.
    #:
    #: The pipeline deliberately carries on past a damaged file rather than
    #: losing a two-hour run, so it can exit 0 with variables missing. These
    #: are what say whether a "successful" run actually loaded everything.
    skippedFiles: int = 0
    erroredFiles: int = 0


def read_progress(execution_id: str) -> RunProgress:
    """
    How far a run has got, from its manifest.

    Counts `script_summary` lines, which is what the pipeline team suggest.
    The count is an estimate, not a measurement: five of the fourteen stages
    are skipped when their output already exists, so a complete run can log
    fewer summaries than there are stages. A `pipeline_progress` line is
    planned upstream and is preferred here as soon as one appears.
    """
    path = manifest_path(execution_id)
    completed: list[str] = []
    failed: list[str] = []
    percent, exact = 0, False
    skipped_files = errored_files = 0

    if not path.exists():
        return RunProgress(execution_id, completed, failed, len(reporting_stages()), 0, False)

    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue  # a partially written line while the run is going

        event = entry.get("event")
        if event == "script_summary":
            name = str(entry.get("script", "?"))
            completed.append(name)
            if entry.get("status") not in ("ok", None) or entry.get("exit_code") not in (0, None):
                failed.append(name)
            skipped_files += int(entry.get("skip") or 0)
            errored_files += int(entry.get("error") or 0) + int(entry.get("fallidos") or 0)
        elif event == "pipeline_progress":
            # Upstream's own figure, once it exists, beats counting.
            percent, exact = int(entry.get("percent", percent)), True

    finished = TERMINAL_STAGE in completed

    if not exact:
        # Counting cannot reach 100: the conditional stages are skipped once
        # their output exists, so a finished run logs fewer summaries than
        # there are stages. The terminal stage is what says it is over.
        total = len(reporting_stages())
        percent = 100 if finished else min(95, round(len(completed) / max(1, total) * 100))

    return RunProgress(
        execution_id, completed, failed, len(reporting_stages()), percent, exact,
        finished=finished, skippedFiles=skipped_files, erroredFiles=errored_files,
    )
