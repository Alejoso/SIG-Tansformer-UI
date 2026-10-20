"""
One pipeline run, watched while it happens.

`run_full.sh` takes about thirteen minutes on the Colombia dataset and prints
as it goes. This module starts it, follows its output, and keeps a picture of
where it has got to that the UI can poll, so a request never waits on the
pipeline. If this process goes away mid-run the run goes with it — its stdout
is our pipe — and `adopt` is what finds the remains afterwards and reports
them as stopped rather than as success.

Four sources say what is happening, and they are used for different things:

* the script's stdout says which stage has *started*, and which were skipped —
  the only place skips are visible at all;
* the run manifest (`logs/<id>/run_manifest.jsonl`) says which stages
  *finished*, with each one's status and its own metrics. It is the authority,
  because it carries the canonical script name rather than a log string;
* the process exit code says whether the run as a whole succeeded;
* and for a run started by some earlier process, whether a pipeline is alive
  at all, plus the summary file its last stage writes.

Progress is weighted by how long each stage usually takes rather than counting
stages, because they differ by two orders of magnitude: counting would hold
the bar at 70% through the five minutes of `load_h3_values` and then jump.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import engine_state, pipeline, store

#: How many lines of the script's output to keep for the UI. Enough to show
#: what a failure said without holding a thirteen-minute transcript in memory.
LOG_TAIL = 400


#: Colour codes in the script's output. It writes `[ok]` and `[error]` in
#: green and red, which is right for a terminal and noise in a web page.
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _readable(line: str) -> str:
    """
    One line of the engine's output, as a person would want to read it.

    The stages log structured JSON — one object per line, with the message
    under `msg` and a dozen bookkeeping fields around it. Shown raw, a failure
    panel is a wall of `log_schema_version` and `execution_id` repeated forty
    times, with the sentence that explains the problem buried in the middle.
    So JSON lines are reduced to their message, and the shell's own lines are
    stripped of colour codes.
    """
    line = _ANSI.sub("", line).rstrip()
    stripped = line.lstrip()
    if not stripped.startswith("{"):
        return line
    try:
        entry = json.loads(stripped)
    except json.JSONDecodeError:
        return line
    message = entry.get("msg")
    if not isinstance(message, str) or message == "metrics":
        # A metrics or summary object. Its numbers reach the UI through the
        # run manifest, per stage, where they belong — here they would be a
        # bare word with the figures left in the fields we just dropped.
        return ""
    level = str(entry.get("level", "")).upper()
    return f"{level}: {message}" if level in ("ERROR", "WARNING") else message


@dataclass
class StageState:
    """Where one stage of a run has got to."""

    number: float
    key: str
    label: str
    #: pending | running | ok | skipped | failed | aborted
    status: str = "pending"
    #: The stage's own numbers once it reports — rows loaded, files rendered.
    #: Shown as-is: these are the engine's words for its own work.
    detail: str = ""
    durationSeconds: float | None = None


@dataclass
class RunState:
    """A run, as the UI sees it."""

    projectId: str
    #: starting | running | done | failed | aborted
    status: str
    #: The engine's id for this run, e.g. `2026-10-15_20-31_rf_003`. Empty
    #: until the script announces it, which is after `docker compose up`.
    executionId: str = ""
    percent: int = 0
    statusText: str = ""
    stages: list[StageState] = field(default_factory=list)
    startedAt: float = 0.0
    finishedAt: float | None = None
    error: str = ""
    #: Hexagons in the master table, from the stage that built it.
    hexagonCount: int | None = None
    #: Files the engine skipped or failed on while carrying on regardless.
    #: A run can exit 0 with variables missing, and these are what say so.
    skippedFiles: int = 0
    erroredFiles: int = 0
    #: True when this run clears the engine's per-project tables first, with
    #: the reason. Shown because "this one is slower" otherwise looks like
    #: the app being arbitrary.
    reset: bool = True
    resetReason: str = ""
    #: True when the H3 master itself is being rebuilt — minutes, not seconds.
    rebuildEverything: bool = False
    logTail: list[str] = field(default_factory=list)


class Run:
    """A running pipeline, and the thread following it."""

    def __init__(
        self,
        project: store.ProjectRow,
        data_dir: Path | None = None,
        *,
        reset: bool = True,
        reset_reason: str = "",
        rebuild_everything: bool = False,
    ) -> None:
        self.project_id = project.id
        #: The folder this run processes. Passed as DATA_DIR when the script
        #: honours one; None means the engine's own default.
        self.data_dir = data_dir
        #: Whether the engine's per-project tables are cleared first, and why.
        #: See `engine_state.plan_reload` — one database serves every project.
        self.reset = reset
        self.reset_reason = reset_reason
        self.rebuild_everything = rebuild_everything
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._abort_requested = False
        self._log_path: Path | None = None
        #: True for a run reconstructed from disk rather than started here.
        #: Such a run has no stdout to follow, so every read of it re-reads
        #: the manifest — see `snapshot`.
        self._adopted = False

        self._state = RunState(
            projectId=project.id,
            reset=reset,
            resetReason=reset_reason,
            rebuildEverything=rebuild_everything,
            status="starting",
            statusText="Starting the pipeline",
            startedAt=time.time(),
            stages=[
                StageState(number=stage.number, key=stage.key, label=stage.label)
                for stage in pipeline.STAGES
            ],
        )
        self._by_key = {stage.key: stage for stage in self._state.stages}
        self._weights = {stage.key: stage.weight for stage in pipeline.STAGES}

        self._thread = threading.Thread(target=self._run, name=f"pipeline-{project.id}", daemon=True)

    # ── what the UI reads ─────────────────────────────────────────────────

    def snapshot(self) -> RunState:
        """
        The current state, copied.

        Copied rather than shared because the worker thread mutates it while
        FastAPI serialises it, and a list that grows mid-serialisation is a
        race that shows up as a garbled response once a week.

        An adopted run has no thread behind it, so reading it is what advances
        it: the manifest is re-read here, and the pipeline's own liveness is
        what ends it.
        """
        if self._adopted and self._state.status == "running":
            self._refresh_adopted()

        with self._lock:
            state = self._state
            return RunState(
                projectId=state.projectId,
                status=state.status,
                executionId=state.executionId,
                percent=state.percent,
                statusText=state.statusText,
                stages=[StageState(**vars(stage)) for stage in state.stages],
                startedAt=state.startedAt,
                finishedAt=state.finishedAt,
                error=state.error,
                hexagonCount=state.hexagonCount,
                skippedFiles=state.skippedFiles,
                erroredFiles=state.erroredFiles,
                reset=state.reset,
                resetReason=state.resetReason,
                rebuildEverything=state.rebuildEverything,
                logTail=list(state.logTail),
            )

    @property
    def active(self) -> bool:
        with self._lock:
            return self._state.status in ("starting", "running")

    def start(self) -> None:
        self._thread.start()

    # ── stopping ──────────────────────────────────────────────────────────

    def abort(self) -> str:
        """
        Stop the run, and say what was stopped.

        Two kills, because the pipeline runs in two places. SIGINT to the
        script's process group is the Ctrl-C it would get from a terminal —
        the whole group, since the script spawns `docker compose` children
        that would otherwise outlive it. But `docker compose exec` does not
        forward signals to the process it started, so the Python inside the
        container would carry on writing to the database after the UI said
        the run had stopped. That one is killed through the container.

        Whatever the engine had already written stays written. A run stopped
        halfway leaves half its output behind, which is why this is worded as
        stopping rather than cancelling.
        """
        with self._lock:
            if self._state.status not in ("starting", "running"):
                return "The run had already finished."
            self._abort_requested = True
            process = self._process

        notes = []
        if process is not None and process.poll() is None:
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGINT)
                notes.append("asked the pipeline script to stop")
            except (ProcessLookupError, PermissionError, OSError) as error:
                notes.append(f"could not signal the script ({error})")

        notes.append(pipeline.kill_in_container())
        return "; ".join(note for note in notes if note)

    # ── the worker ────────────────────────────────────────────────────────

    def _set(self, **fields: object) -> None:
        with self._lock:
            for name, value in fields.items():
                setattr(self._state, name, value)

    def _append_log(self, line: str) -> None:
        with self._lock:
            tail = self._state.logTail
            tail.append(line)
            if len(tail) > LOG_TAIL:
                del tail[: len(tail) - LOG_TAIL]

    def _mark(self, key: str, status: str, *, detail: str | None = None) -> None:
        """Set one stage's status, and close out the ones it has passed."""
        with self._lock:
            stage = self._by_key.get(key)
            if stage is None:
                return
            if status == "running":
                # Anything still pending above this one was skipped silently:
                # the script logs a skip for some stages and nothing at all
                # for others, so reaching stage N is the only evidence that
                # N-1 is over.
                for earlier in self._state.stages:
                    if earlier.key == key:
                        break
                    if earlier.status == "pending":
                        earlier.status = "skipped"
                    elif earlier.status == "running":
                        earlier.status = "ok"
            stage.status = status
            if detail is not None:
                stage.detail = detail
            self._state.statusText = stage.label if status == "running" else self._state.statusText
        self._recompute()

    def _recompute(self) -> None:
        """Progress, weighted by how long each stage takes."""
        with self._lock:
            total = sum(self._weights.values())
            done = sum(
                self._weights.get(stage.key, 0.0)
                for stage in self._state.stages
                if stage.status in ("ok", "skipped", "failed")
            )
            running = sum(
                self._weights.get(stage.key, 0.0) * 0.5
                for stage in self._state.stages
                if stage.status == "running"
            )
            if self._state.status in ("done",):
                percent = 100
            else:
                # Never 100 while anything is still going: the user reads a
                # full bar as "finished", and the last stage is the longest
                # place to be wrong about that.
                percent = min(99, round((done + running) / max(1.0, total) * 100))
            self._state.percent = percent

    def _absorb_manifest(self) -> None:
        """
        Fold the run manifest into the stage list.

        The manifest is the authority on how a stage *ended*: it names the
        script, carries the status, and brings the stage's own counts. Read in
        full each time rather than tailed — ten lines for a whole run, and
        re-reading means a line that was half-written when we last looked is
        picked up on the next pass.
        """
        execution_id = self._state.executionId
        if not execution_id:
            return
        path = pipeline.manifest_path(execution_id)
        if not path.exists():
            return

        by_script = {stage.script.rsplit("/", 1)[-1].removesuffix(".py"): stage.key
                     for stage in pipeline.STAGES}

        skipped_files = errored_files = 0
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue  # a line still being written
            if entry.get("event") != "script_summary":
                continue

            key = by_script.get(str(entry.get("script", "")))
            skipped_files += int(entry.get("skip") or 0)
            errored_files += int(entry.get("error") or 0) + int(entry.get("fallidos") or 0)

            cells = entry.get("h3_cells_processed")
            if cells:
                self._set(hexagonCount=int(cells))

            if key is None:
                continue
            ok = entry.get("status") in ("ok", None) and entry.get("exit_code") in (0, None)
            with self._lock:
                stage = self._by_key.get(key)
                if stage is None:
                    continue
                if stage.status in ("running", "pending"):
                    stage.status = "ok" if ok else "failed"
                stage.durationSeconds = entry.get("duration_seconds")
                stage.detail = _describe(entry)

        self._set(skippedFiles=skipped_files, erroredFiles=errored_files)
        self._recompute()

    def _refresh_adopted(self) -> None:
        """
        Advance a run we are only watching from the outside.

        Two questions: what has the manifest gained, and is the pipeline
        still alive. Liveness is asked second, so a stage that finished in
        the moment between the two reads is not lost — the manifest is read
        before we conclude the run is over.
        """
        self._absorb_manifest()
        if _pipeline_is_running():
            return

        folder = pipeline.manifest_path(self._state.executionId).parent
        complete = (folder / SUMMARY_FILE).is_file()

        with self._lock:
            failed = any(stage.status == "failed" for stage in self._state.stages)
            # "skipped" counts towards progress — the engine decided the stage
            # was unnecessary. A stage that never got the chance is "aborted",
            # which does not, so the bar stops where the run stopped.
            unfinished = "skipped" if (failed or complete) else "aborted"
            for stage in self._state.stages:
                if stage.status in ("pending", "running"):
                    stage.status = unfinished

            if failed:
                self._state.status = "failed"
                self._state.statusText = "The pipeline stopped with an error"
                self._state.error = self._state.error or _not_ours(folder)
            elif complete:
                self._state.status = "done"
                self._state.statusText = "Finished"
            else:
                self._state.status = "aborted"
                self._state.statusText = "Stopped before finishing"
                self._state.error = (
                    "The pipeline stopped without finishing. Whatever it had already "
                    "written is on disk; process again to carry on. " + _not_ours(folder)
                )
            self._state.finishedAt = time.time()
        self._recompute()

    def _run(self) -> None:
        # Only set when the script will actually use it: passing it to a
        # version that assigns over it would run against one folder while the
        # UI reads another, silently. `honours_data_dir` is what decides, and
        # the route refuses the mismatch rather than letting it happen.
        extra = pipeline.reload_env(
            reset=self.reset, rebuild_everything=self.rebuild_everything
        )
        if self.data_dir:
            extra["DATA_DIR"] = str(self.data_dir)
        env = pipeline.run_full_env(extra=extra)
        try:
            process = subprocess.Popen(
                pipeline.run_full_command(),
                cwd=pipeline.PIPELINE_DIR,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                # Its own process group, so abort can signal the script and
                # every `docker compose` child it spawned in one go.
                #
                # Its own group, but not its own life: stdout is this pipe, so
                # if the server goes the script dies on its next write. That is
                # the better default — a run nobody is watching still holds the
                # engine's one database — but it does mean a dev-server reload
                # kills a run in progress, and `adopt` is what finds the
                # wreckage afterwards and says so rather than claiming success.
                start_new_session=True,
            )
        except (OSError, FileNotFoundError) as error:
            self._set(status="failed", error=f"Could not start the pipeline: {error}",
                      finishedAt=time.time())
            return

        with self._lock:
            self._process = process
            self._state.status = "running"

        assert process.stdout is not None
        last_manifest_read = 0.0
        for raw in process.stdout:
            line = _readable(raw)
            if not line:
                continue  # a metrics object with nothing to say
            self._append_log(line)
            self._write_log_line(line)

            execution_id = pipeline.match_execution_id(line)
            if execution_id and not self._state.executionId:
                self._set(executionId=execution_id)
                self._open_log(execution_id)

            matched = pipeline.match_stage_line(line)
            if matched is not None:
                key, status = matched
                self._mark(key, status, detail="" if status == "running" else "Already up to date")

            # The manifest only changes when a stage ends, so there is no
            # point reading it on every line of a chatty stage.
            now = time.time()
            if now - last_manifest_read > 2.0:
                last_manifest_read = now
                self._absorb_manifest()

        code = process.wait()
        self._absorb_manifest()
        self._finish(code)

    def _finish(self, code: int) -> None:
        with self._lock:
            aborted = self._abort_requested
            # A stage still pending at the end means one of two things. After
            # a clean run it was genuinely skipped — the script decided it was
            # unnecessary and never said so, which is normal for the optional
            # ones. After a failure or a stop it simply never got the chance,
            # and calling that "skipped" counts it as progress: the real
            # failure sat at 99%, four stages from the end, reading like a
            # near-success.
            unreached = "skipped" if (code == 0 and not aborted) else "aborted"
            for stage in self._state.stages:
                if stage.status == "running":
                    stage.status = "aborted" if aborted else "failed"
                elif stage.status == "pending":
                    stage.status = unreached

            if aborted:
                self._state.status = "aborted"
                self._state.statusText = "Stopped"
                self._state.error = "The run was stopped. Anything already written is still there."
            elif code == 0:
                self._state.status = "done"
                self._state.statusText = "Finished"
            else:
                self._state.status = "failed"
                self._state.statusText = "The pipeline stopped with an error"
                # Lead with what the engine called an error. The last few
                # lines are usually the metrics and "finished in 0.01s" that
                # follow a failure, so a plain tail buries the cause.
                lines = [line for line in self._state.logTail if line.strip()]
                flagged = [line for line in lines if line.startswith("ERROR:")]
                self._state.error = "\n".join(
                    [f"The pipeline exited with code {code}."] + (flagged[-6:] or lines[-8:])
                )
            self._state.finishedAt = time.time()
            finished_ok = self._state.status == "done"
            execution = self._state.executionId
        self._recompute()

        # The engine's database now holds this project's variables — or, if
        # the run did not finish, something we cannot vouch for. Either way
        # the next run needs to know. The results it was loaded from are
        # recorded too, so one disappearing from disk is noticed: an
        # incremental load adds what it finds and never deletes.
        project = store.find_project(self.project_id)
        engine_state.record_run(
            self.project_id,
            execution,
            finished_ok,
            engine_state.output_set(project) if project else [],
        )

    # ── the full transcript on disk ───────────────────────────────────────

    def _open_log(self, execution_id: str) -> None:
        """
        Keep the whole transcript next to the engine's own logs for this run.

        The UI only holds the tail; a thirteen-minute run that went wrong is
        worth reading in full, and its own log folder is where someone would
        look for it.
        """
        folder = pipeline.manifest_path(execution_id).parent
        try:
            folder.mkdir(parents=True, exist_ok=True)
            self._log_path = folder / "ui_console.log"
            with self._log_path.open("a", encoding="utf-8") as handle:
                for line in self._state.logTail:
                    handle.write(line + "\n")
        except OSError:
            self._log_path = None  # not worth failing a run over

    def _write_log_line(self, line: str) -> None:
        if self._log_path is None:
            return
        try:
            with self._log_path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            self._log_path = None


#: Manifest keys that are bookkeeping rather than results.
_NOT_RESULTS = {
    "script", "run_id", "execution_id", "event", "status", "log_schema_version",
    "duration_seconds", "started_at", "ended_at",
}


def _describe(entry: dict[str, object]) -> str:
    """
    A stage's own numbers, as one line.

    Every stage reports different keys — `h3_cells_processed` here,
    `generados`/`fallidos` there — so rather than curate a mapping that would
    go stale the moment upstream adds a counter, this shows what the stage
    chose to report.
    """
    parts = [
        f"{name.replace('_', ' ')} {value}"
        for name, value in entry.items()
        if name not in _NOT_RESULTS and isinstance(value, (int, float, bool, str))
    ]
    return ", ".join(parts)


# ── a run the backend did not start ───────────────────────────────────────
#
# The pipeline outlives us. It is started in its own process group, so it
# carries on through a backend restart — and in development uvicorn's reloader
# restarts on every save, which is how this came up: a run went on building
# the master table for ten minutes while the UI, asking a fresh process,
# was told there was no run at all.
#
# So when nothing is held in memory for a project, disk is asked instead. The
# engine leaves enough behind to answer: a folder per run under `logs/`, a
# manifest naming each stage that finished, and — for a run this UI started —
# the console transcript this module writes. What cannot be recovered is the
# live stage label, because that came from following stdout; an adopted run
# shows the last stage that *reported* instead, which lags by one stage but
# never claims something false.


def _not_ours(folder: Path) -> str:
    """Why there is no transcript for a run this server did not start."""
    return (
        "This run was not started by the server now reporting on it, so its output was "
        f"not captured — the engine's own logs for it are in {folder}."
    )


def _pipeline_is_running() -> bool:
    """
    Whether a pipeline script is going anywhere on this machine.

    /proc is read directly rather than shelling out to `pgrep -f`, which
    matches any process whose whole command line *contains* the pattern. That
    is every shell running a check for it, every `grep run_full.sh`, and the
    editor with the file open — and a false positive here refuses a
    legitimate run with "one at a time". It caught itself the first time it
    ran. Comparing argv is both exact and cheaper than a subprocess.
    """
    own_pid = str(os.getpid())
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or entry.name == own_pid:
            continue
        try:
            raw = (entry / "cmdline").read_bytes()
        except OSError:
            continue  # the process ended between listing and reading
        argv = [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]
        if not argv:
            continue
        # Either `run_full.sh` directly, or a shell invoked with it — which is
        # how this module starts it, and how `bash run_full.sh` appears.
        if Path(argv[0]).name.endswith(pipeline.RUN_SCRIPT):
            return True
        if len(argv) > 1 and Path(argv[0]).name in ("bash", "sh", "dash", "zsh"):
            if Path(argv[1]).name == pipeline.RUN_SCRIPT:
                return True
    return False


#: Written by the pipeline's last step, so its presence is what distinguishes
#: a run that finished from one that stopped partway. Nothing else does: the
#: manifest grows a line per stage either way, and a killed run leaves a
#: folder that looks like a successful short one.
SUMMARY_FILE = "run_summary.txt"


def _latest_run_folder() -> Path | None:
    """The most recently started run, by the timestamp in its folder name."""
    log_dir = pipeline.manifest_path("x").parent.parent
    if not log_dir.is_dir():
        return None
    folders = [
        folder for folder in log_dir.iterdir()
        if folder.is_dir() and (folder / "run.json").is_file()
    ]
    if not folders:
        return None
    return max(folders, key=lambda folder: folder.stat().st_mtime)


def adopt(project: store.ProjectRow) -> Run | None:
    """
    Rebuild a run's state from disk, for a run this process did not start.

    Deliberately conservative about ownership: the engine's logs do not record
    which project asked for a run, because the engine has no idea projects
    exist. So this only adopts a run whose folder we can see, and reports it
    as the project's own — correct as long as one machine runs one pipeline,
    which is already enforced when starting one.
    """
    folder = _latest_run_folder()
    if folder is None:
        return None

    run = Run(project)
    run._adopted = True
    alive = _pipeline_is_running()
    run._state.executionId = folder.name
    run._state.startedAt = (folder / "run.json").stat().st_mtime
    run._absorb_manifest()

    with run._lock:
        reported = [stage for stage in run._state.stages if stage.status in ("ok", "failed")]
        failed = any(stage.status == "failed" for stage in run._state.stages)

        complete = (folder / SUMMARY_FILE).is_file()

        if alive:
            run._state.status = "running"
            # Everything before the last stage that reported is over, one way
            # or another; what comes after is still unknown.
            run._state.statusText = (
                f'Continuing after "{reported[-1].label}"' if reported
                else "The pipeline is running"
            )
        elif not reported:
            return None  # nothing on disk worth reporting
        elif failed:
            run._state.status = "failed"
            run._state.statusText = "The pipeline stopped with an error"
            run._state.error = _not_ours(folder)
            run._state.finishedAt = folder.stat().st_mtime
        elif complete:
            run._state.status = "done"
            run._state.statusText = "Finished"
            run._state.finishedAt = folder.stat().st_mtime
        else:
            # Stages reported, none failed, and yet the pipeline is gone and
            # left no summary: it was killed rather than finishing. Saying
            # "done" here would be the worst kind of wrong — the engine stops
            # partway through loading variables, so the output is real but
            # incomplete, and nothing downstream would question it.
            run._state.status = "aborted"
            run._state.statusText = "Stopped before finishing"
            run._state.error = (
                f'This run stopped after "{reported[-1].label}" without finishing. '
                "Whatever it had already written is on disk; process again to carry on. "
                + _not_ours(folder)
            )
            run._state.finishedAt = folder.stat().st_mtime

        if not alive:
            unfinished = "skipped" if (complete or failed) else "aborted"
            for stage in run._state.stages:
                if stage.status == "pending":
                    stage.status = unfinished

    run._recompute()
    return run


# ── the registry ──────────────────────────────────────────────────────────
#
# One run per project, in memory, because a run normally belongs to the
# process following it. `adopt` covers the case where that process is gone.

_runs: dict[str, Run] = {}
_registry_lock = threading.Lock()


def current(project_id: str) -> Run | None:
    with _registry_lock:
        return _runs.get(project_id)


def current_or_adopted(project: store.ProjectRow) -> Run | None:
    """
    The project's run, from memory or reconstructed from disk.

    What the UI asks on load. An adopted run is cached like any other so the
    reconstruction happens once rather than on every poll — and so that if it
    is still going, the next poll sees the same object growing rather than a
    fresh guess each second.
    """
    with _registry_lock:
        existing = _runs.get(project.id)
        if existing is not None:
            return existing

    adopted = adopt(project)
    if adopted is None:
        return None

    with _registry_lock:
        # Another request may have adopted it while we were reading disk.
        return _runs.setdefault(project.id, adopted)


def start(
    project: store.ProjectRow,
    data_dir: Path | None = None,
    *,
    reset: bool = True,
    reset_reason: str = "",
    rebuild_everything: bool = False,
) -> Run:
    """
    Begin a run for a project, unless one is already going.

    Refuses a second concurrent run *anywhere*, not just for this project:
    the engine has one database and one master table, so two runs would
    interleave their writes into the same rows. The same reason makes a
    pipeline started outside the UI a blocker — `pgrep` catches the case
    where someone ran `run_full.sh` in a terminal, or where a previous
    backend's run is still going.
    """
    if _pipeline_is_running():
        raise RuntimeError(
            "A pipeline run is already going on this machine. The engine has one "
            "database, so one run at a time."
        )

    with _registry_lock:
        existing = _runs.get(project.id)
        if existing is not None and existing.active:
            return existing
        for other_id, other in _runs.items():
            if other_id != project.id and other.active:
                raise RuntimeError(
                    "Another project is already being processed. The engine has one "
                    "database, so one run at a time."
                )
        run = Run(
            project,
            data_dir,
            reset=reset,
            reset_reason=reset_reason,
            rebuild_everything=rebuild_everything,
        )
        _runs[project.id] = run
    run.start()
    return run
