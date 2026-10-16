import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import type { DataFolder, PathInspection, PipelineRun, PipelineStage } from '../../types';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

/** One folder per variable, as the design has it. A soft cap, not a rule. */
const MAX_FOLDERS = 10;

/** `412 MB`, `1.2 GB` — matched to how the design writes sizes. */
function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/** `1m 04s`, `12s` — how long a run took, from its own timestamps. */
function formatDuration(run: { startedAt: number; finishedAt: number | null }): string {
  const seconds = Math.max(0, Math.round((run.finishedAt ?? Date.now() / 1000) - run.startedAt));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * One step of the engine's pipeline.
 *
 * Both the numbers and the skips are shown rather than tidied away. A step
 * that says "skipped — already up to date" is the engine explaining why a
 * fifteen-minute job finished in two, and without it the run looks like it
 * silently did nothing.
 */
function StageRow({ stage }: { stage: PipelineStage }) {
  const mark =
    stage.status === 'running' ? (
      <Icon name="spinner" size={13} color="var(--color-accent)" className="spin" />
    ) : stage.status === 'ok' ? (
      <Icon name="check" size={13} color="var(--color-accent-2-800)" strokeWidth={3} />
    ) : stage.status === 'failed' ? (
      <Icon name="close" size={13} color="var(--color-accent-700)" strokeWidth={3} />
    ) : (
      <span className="stage-dot" />
    );

  return (
    <li className={`stage-row is-${stage.status}`}>
      <span className="stage-mark">{mark}</span>
      <span className="stage-label">{stage.label}</span>
      <span className="stage-detail muted-55">
        {stage.status === 'skipped' && (stage.detail || 'Skipped')}
        {stage.status === 'aborted' && 'Not run'}
        {(stage.status === 'ok' || stage.status === 'failed') && stage.detail}
      </span>
      {stage.durationSeconds != null && (
        <span className="stage-time muted-55">{Math.round(stage.durationSeconds)}s</span>
      )}
    </li>
  );
}

export function DataScreen() {
  const { project, goTo, showHints, showToast, openProject } = useApp();
  const projectId = project?.id ?? '';

  const [folders, setFolders] = useState<DataFolder[]>([]);
  /** The engine run, straight from the backend. Null until one is started. */
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [showComplete, setShowComplete] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [starting, setStarting] = useState(false);
  /** Why the engine cannot be driven, when it cannot. */
  const [blocked, setBlocked] = useState<string[]>([]);
  /** Expanded by default while running: the stage list is the interesting part. */
  const [showStages, setShowStages] = useState(true);

  /** The path being typed, and what the server makes of it. */
  const [draftPath, setDraftPath] = useState('');
  const [inspected, setInspected] = useState<{ path: string; result: PathInspection } | null>(null);
  const [adding, setAdding] = useState(false);
  /** The folder dialog blocks this request for as long as it is open. */
  const [browsing, setBrowsing] = useState(false);

  /** The folder whose location is being corrected, if any. */
  const [relocating, setRelocating] = useState<DataFolder | null>(null);

  const unwatch = useRef<(() => void) | null>(null);

  /** Bumped to refetch the folder list after something changes it. */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api
      .listFolders(projectId)
      .then((list) => {
        if (live) setFolders(list);
      })
      .catch((error: unknown) => {
        if (live) {
          showToast(error instanceof Error ? error.message : 'Could not load this project’s folders');
        }
      });
    return () => {
      live = false;
    };
  }, [projectId, reloadToken, showToast]);

  // Never leave the progress stream open behind us.
  useEffect(() => () => unwatch.current?.(), []);

  /**
   * Check the typed path against the server, a beat after typing stops.
   *
   * The browser cannot read an absolute path out of a file picker, so what is
   * in the box is just text until the server has looked at it.
   */
  useEffect(() => {
    const path = draftPath.trim();
    if (!path) return;

    let live = true;
    const timer = setTimeout(async () => {
      const result = await api.inspectPath(path);
      if (live) setInspected({ path, result });
    }, 350);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draftPath]);

  /**
   * What the server said about the path currently in the box.
   *
   * Tagged with the path it describes and compared during render, so a
   * cleared or edited box shows "checking" immediately rather than briefly
   * showing a verdict about the previous path.
   */
  const inspection = inspected?.path === draftPath.trim() ? inspected.result : null;
  const checking = draftPath.trim().length > 0 && inspection === null;

  /**
   * The screen's three states, derived from the run rather than tracked
   * alongside it — one source of truth means the buttons cannot disagree
   * with the progress bar.
   */
  const running = run?.status === 'starting' || run?.status === 'running';
  const phase = running ? 'processing' : run?.status === 'done' ? 'done' : 'empty';
  const locked = running;
  const full = folders.length >= MAX_FOLDERS;
  const missing = folders.filter((f) => !f.exists);
  const canAdd = !locked && !full && inspection?.problem == null && inspection !== null;

  const addFolder = async () => {
    if (!canAdd) return;
    setAdding(true);
    try {
      setFolders(await api.addFolders(projectId, [draftPath]));
      setDraftPath('');
      setInspected(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not add that folder');
    } finally {
      setAdding(false);
    }
  };

  const browse = async () => {
    setBrowsing(true);
    try {
      const picked = await api.pickFolder(draftPath);
      if (picked.path) setDraftPath(picked.path);
      else if (picked.unavailable) showToast(picked.unavailable);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not open a folder chooser');
    } finally {
      setBrowsing(false);
    }
  };

  const removeFolder = async (folderId: string) => {
    await api.removeFolder(projectId, folderId);
    reload();
  };

  /**
   * Forget the project because a folder it needs has gone.
   *
   * Only the record goes — nothing on disk is touched, which is the whole
   * point of offering this rather than trying to clean up after the user.
   */
  const forgetProject = async () => {
    await api.deleteProject(projectId);
    showToast(`${project?.name ?? 'Project'} removed from the list`);
    goTo('projects');
  };

  /**
   * Follow a run to its end, and react when it gets there.
   *
   * Used both for a run this screen started and for one it found already
   * going, so the two paths cannot drift apart.
   */
  const follow = useCallback(
    (initial: PipelineRun) => {
      setRun(initial);
      unwatch.current?.();
      unwatch.current = api.watchProcessing(
        projectId,
        (tick) => {
          setRun(tick);
          if (tick.status === 'starting' || tick.status === 'running') return;

          unwatch.current = null;
          if (tick.status === 'done') {
            setShowComplete(true);
            // The engine has just written new layers; the folder list shows
            // what it made of each one.
            reload();
          }
        },
        (error) => showToast(error.message),
      );
    },
    [projectId, reload, showToast],
  );

  /**
   * Pick a run back up after a reload.
   *
   * The engine takes about a quarter of an hour, which is long enough that
   * the user will navigate away, reload, or come back tomorrow. The backend
   * holds the run, so asking once on mount is the difference between that
   * being fine and the screen claiming nothing is happening while the engine
   * is halfway through.
   */
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api
      .getProcessing(projectId)
      .then((existing) => {
        if (!live || !existing) return;
        if (existing.status === 'starting' || existing.status === 'running') follow(existing);
        else setRun(existing);
      })
      .catch(() => {
        // Nothing to resume is the normal case, and a backend that cannot be
        // reached is already reported by the folder list.
      });
    return () => {
      live = false;
    };
  }, [projectId, follow]);

  const startProcessing = async () => {
    if (locked || starting || folders.length === 0) return;
    setStarting(true);
    setBlocked([]);
    try {
      follow(await api.startProcessing(projectId));
    } catch (error) {
      // The backend refuses with the reason — Docker not running, the folder
      // gone, another project already processing — and each one is something
      // the user can act on, so it is shown rather than reduced to a toast.
      const message = error instanceof Error ? error.message : 'Could not start the engine';
      setBlocked([message]);
    } finally {
      setStarting(false);
    }
  };

  /**
   * Stop a run that is already going.
   *
   * Goes back to the pre-run state: the folders are still there and Process
   * is the obvious next move. What the engine already wrote stays on disk —
   * it commits variable by variable — so this is a stop, not an undo, and the
   * backend says in as many words what it managed to stop.
   */
  const abort = async () => {
    if (!running || aborting) return;
    setAborting(true);
    try {
      const { detail } = await api.abortProcessing(projectId);
      unwatch.current?.();
      unwatch.current = null;
      setRun(null);
      showToast(detail ? `Stopped — ${detail}` : 'Stopped');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not stop the run');
    } finally {
      setAborting(false);
    }
  };

  const processHint =
    folders.length === 0
      ? 'Add at least one folder to continue.'
      : missing.length > 0
        ? 'Some folders are missing — fix them before processing.'
        : phase === 'empty'
          ? 'This converts every location into a hexagon. You can keep working after it starts.'
          : 'Your data is being converted.';

  return (
    <div className="screen data-screen">
      <div className="screen-body">
        <h1 className="data-title">Add your data</h1>
        <p className="data-lede muted">
          One folder per variable — up to ten. Each folder becomes a layer you can look at on the
          map.
        </p>

        {missing.length > 0 && (
          <div className="folder-alert">
            <div className="folder-alert-body">
              <strong>
                {missing.length === 1
                  ? 'A folder is no longer where it was'
                  : `${missing.length} folders are no longer where they were`}
              </strong>
              <span className="muted-55">
                Point each one at its new location, or remove this project from the list. Removing
                it only forgets the record — nothing on disk is touched.
              </span>
            </div>
            <button type="button" className="btn btn-secondary" onClick={forgetProject}>
              Remove project
            </button>
          </div>
        )}

        {/* Paths are typed rather than dropped: a browser will not reveal a
            real path from a file picker, and the record has to be a real
            path for the folder to be found again. */}
        <div className={`path-add${locked || full ? ' is-locked' : ''}`}>
          <label className="path-add-label" htmlFor="folder-path">
            Folder path on this machine
          </label>
          <div className="field-row">
            <input
              id="folder-path"
              className="input"
              value={draftPath}
              disabled={locked || full}
              placeholder="/home/you/data/wind_atlas_2024"
              onChange={(e) => setDraftPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addFolder();
              }}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={browse}
              disabled={locked || full || browsing}
              style={{ gap: 7, flex: 'none' }}
            >
              {browsing ? (
                <Icon name="spinner" size={15} className="spin" />
              ) : (
                <Icon name="folder" size={15} />
              )}
              {browsing ? 'Choosing…' : 'Browse'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={addFolder}
              disabled={!canAdd || adding}
              style={{ flex: 'none' }}
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
          </div>

          <div className="path-add-status">
            {locked && <span className="muted-55">Folders are locked while a run is going.</span>}
            {!locked && full && (
              <span className="muted-55">
                That is all {MAX_FOLDERS} folders — remove one to make room.
              </span>
            )}
            {!locked && !full && checking && <span className="muted-55">Checking…</span>}
            {!locked && !full && !checking && inspection?.problem && (
              <span className="path-add-problem">{inspection.problem}</span>
            )}
            {!locked && !full && !checking && inspection && !inspection.problem && (
              <span className="path-add-ok">
                <Icon name="check" size={12} strokeWidth={3} />
                {inspection.fileCount} files · {formatSize(inspection.sizeBytes)} ·{' '}
                <span className="mono">{inspection.path}</span>
              </span>
            )}
            {browsing && <span className="muted-55">Waiting for the folder chooser…</span>}
            {!browsing && !locked && !full && !checking && !inspection && showHints && (
              <span className="muted-55">
                Browse for a folder, or paste a path — <span className="mono">~</span> and
                environment variables work.
              </span>
            )}
          </div>
        </div>

        {folders.length > 0 && (
          <div className="folders">
            <div className="folders-head">
              <h4>Added folders</h4>
              <span className="muted-55" style={{ fontSize: 12 }}>
                {folders.length} of {MAX_FOLDERS}
              </span>
            </div>
            <div className="folders-list">
              {folders.map((folder) => (
                <div
                  key={folder.id}
                  className={`folder-row${locked ? ' is-locked' : ''}${
                    folder.exists ? '' : ' is-missing'
                  }`}
                >
                  <Icon
                    name="folder"
                    size={19}
                    color={folder.exists ? 'var(--color-accent-600)' : 'var(--color-accent)'}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="folder-name">{folder.name}</div>
                    <div className="folder-meta muted-50 mono">{folder.path}</div>
                  </div>

                  {folder.exists ? (
                    <span className="muted-55" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                      {folder.fileCount} files · {formatSize(folder.sizeBytes)}
                    </span>
                  ) : (
                    <>
                      <span className="tag folder-missing-tag">Not found</span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setRelocating(folder)}
                        style={{ flex: 'none', height: 30, fontSize: 12.5 }}
                      >
                        Locate…
                      </button>
                    </>
                  )}

                  {phase === 'empty' && (
                    <button
                      type="button"
                      className="btn btn-icon btn-secondary"
                      aria-label={`Remove ${folder.name}`}
                      onClick={() => removeFolder(folder.id)}
                      style={{ width: 30, height: 30, borderColor: 'transparent' }}
                    >
                      <Icon name="close" size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {blocked.length > 0 && (
          <div className="folder-alert">
            <div className="folder-alert-body">
              <strong>The engine could not be started</strong>
              {blocked.map((problem) => (
                <span key={problem} className="muted-55">
                  {problem}
                </span>
              ))}
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setBlocked([])}>
              Dismiss
            </button>
          </div>
        )}

        {run && (
          <div className="card elev-sm process-card">
            <div className="process-head">
              {running ? (
                <Icon name="spinner" size={20} color="var(--color-accent)" className="spin" />
              ) : (
                <Icon
                  name={run.status === 'done' ? 'check' : 'close'}
                  size={18}
                  color={
                    run.status === 'done'
                      ? 'var(--color-accent-2-800)'
                      : 'var(--color-accent-700)'
                  }
                  strokeWidth={3}
                />
              )}
              <div className="process-status">{run.statusText}</div>
              <div className="muted-55" style={{ fontSize: 13 }}>
                {run.percent}%
              </div>
              {running ? (
                <button
                  type="button"
                  className="btn btn-secondary process-abort"
                  onClick={abort}
                  disabled={aborting}
                >
                  <Icon name="close" size={13} />
                  {aborting ? 'Stopping…' : 'Abort'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary process-abort"
                  onClick={() => setRun(null)}
                >
                  Dismiss
                </button>
              )}
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-valuenow={run.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="progress-bar" style={{ width: `${run.percent}%` }} />
            </div>

            <div className="process-meta">
              <span className="muted-55">
                {running
                  ? 'Folders are locked while we convert them. This usually takes about a quarter of an hour.'
                  : `Finished in ${formatDuration(run)}.`}
              </span>
              {run.executionId && (
                <span className="muted-55 mono" title="The engine's own id for this run">
                  {run.executionId}
                </span>
              )}
            </div>

            {/* The engine does not stop for one damaged file — it logs it and
                carries on, so a run can succeed with variables missing. That
                has to be said out loud or the "all done" dialog is a lie. */}
            {(run.erroredFiles > 0 || run.skippedFiles > 0) && (
              <div className={run.erroredFiles > 0 ? 'process-warn' : 'muted-55'}>
                {run.erroredFiles > 0 && (
                  <>
                    {run.erroredFiles} {run.erroredFiles === 1 ? 'file' : 'files'} could not be
                    processed — the engine carried on without{' '}
                    {run.erroredFiles === 1 ? 'it' : 'them'}.{' '}
                  </>
                )}
                {run.skippedFiles > 0 && (
                  <>
                    {run.skippedFiles} already up to date, so{' '}
                    {run.skippedFiles === 1 ? 'it was' : 'they were'} left alone.
                  </>
                )}
              </div>
            )}

            {run.error && <pre className="process-error">{run.error}</pre>}

            <button
              type="button"
              className={`process-stages-toggle${showStages ? ' is-open' : ''}`}
              onClick={() => setShowStages((open) => !open)}
            >
              <Icon name="chevronRight" size={13} strokeWidth={3} />
              {showStages ? 'Hide steps' : `Show all ${run.stages.length} steps`}
            </button>

            {showStages && (
              <ol className="process-stages">
                {run.stages.map((stage) => (
                  <StageRow key={stage.key} stage={stage} />
                ))}
              </ol>
            )}
          </div>
        )}

        <div className="process-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={folders.length === 0 || locked || missing.length > 0}
            onClick={startProcessing}
            style={{ height: 44, paddingInline: 26, fontSize: 15 }}
          >
            {starting ? 'Starting…' : phase === 'done' ? 'Process again' : running ? 'Processing…' : 'Process'}
          </button>
          {showHints && (
            <span className="muted-55" style={{ fontSize: 12.5 }}>
              {processHint}
            </span>
          )}
        </div>
      </div>

      {relocating && (
        <RelocateDialog
          projectId={projectId}
          folder={relocating}
          onClose={() => setRelocating(null)}
          onDone={async () => {
            setRelocating(null);
            reload();
            // The project card counts missing folders, so refresh it too.
            if (project) openProject(await api.getProject(projectId), 'data');
          }}
        />
      )}

      {showComplete && (
        <Dialog
          onClose={() => setShowComplete(false)}
          width="min(430px, 100%)"
          style={{ alignItems: 'flex-start' }}
          labelledBy="complete-title"
        >
          <div className="complete-icon">
            <Icon name="check" size={26} color="var(--color-accent-2-800)" strokeWidth={3} />
          </div>
          <div className="dialog-title" id="complete-title">
            All done
          </div>
          {/* Deliberately not "N folders converted": the folder count is our
              own record, not what the engine did with it — one folder can
              hold a dozen variables, and the engine reads its whole input
              tree regardless of what we listed. The hexagon count comes from
              the stage that built the table, so it is the engine's own. */}
          <p className="dialog-body" style={{ margin: 0 }}>
            {run?.hexagonCount
              ? `Your data is on ${run.hexagonCount.toLocaleString()} hexagons. `
              : 'Your data has been converted. '}
            {run && run.erroredFiles > 0
              ? `${run.erroredFiles} ${run.erroredFiles === 1 ? 'file' : 'files'} could not be processed — the rest is ready to explore on the map.`
              : 'Every variable is ready to explore on the map.'}
          </p>
          <div className="dialog-actions" style={{ alignSelf: 'stretch' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setShowComplete(false)}>
              Stay here
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setShowComplete(false);
                goTo('map');
              }}
            >
              View Map
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

interface RelocateDialogProps {
  projectId: string;
  folder: DataFolder;
  onClose: () => void;
  onDone: () => void;
}

/** Point a folder that has gone missing at wherever it lives now. */
function RelocateDialog({ projectId, folder, onClose, onDone }: RelocateDialogProps) {
  const [path, setPath] = useState(folder.path);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.relocateFolder(projectId, folder.id, path);
      onDone();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not use that path');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog onClose={onClose} width="min(520px, 100%)" labelledBy="relocate-title">
      <div className="dialog-title" id="relocate-title">
        Where is {folder.name}?
      </div>
      <p className="dialog-body" style={{ margin: 0 }}>
        It was recorded at <span className="mono">{folder.path}</span>, and there is nothing there
        now. Point it at its new home, or close this and remove the project instead.
      </p>

      <div className="field">
        <label htmlFor="relocate-path">New folder path</label>
        <input
          id="relocate-path"
          className={`input${error ? ' is-invalid' : ''}`}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
        {error && <p className="field-hint path-add-problem">{error}</p>}
      </div>

      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Checking…' : 'Use this folder'}
        </button>
      </div>
    </Dialog>
  );
}
