import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import type { DataFolder, PathInspection, ProcessingPhase } from '../../types';
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

export function DataScreen() {
  const { project, goTo, showHints, showToast, openProject } = useApp();
  const projectId = project?.id ?? '';

  const [folders, setFolders] = useState<DataFolder[]>([]);
  const [phase, setPhase] = useState<ProcessingPhase>('empty');
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [hexagonCount, setHexagonCount] = useState(0);
  const [showComplete, setShowComplete] = useState(false);
  const [aborting, setAborting] = useState(false);

  /** The path being typed, and what the server makes of it. */
  const [draftPath, setDraftPath] = useState('');
  const [inspected, setInspected] = useState<{ path: string; result: PathInspection } | null>(null);
  const [adding, setAdding] = useState(false);

  /** The folder whose location is being corrected, if any. */
  const [relocating, setRelocating] = useState<DataFolder | null>(null);

  const unwatch = useRef<(() => void) | null>(null);

  /** Bumped to refetch the folder list after something changes it. */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api.listFolders(projectId).then((list) => {
      if (live) setFolders(list);
    });
    return () => {
      live = false;
    };
  }, [projectId, reloadToken]);

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

  const locked = phase !== 'empty';
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
    const picked = await api.pickFolder();
    if (picked.path) setDraftPath(picked.path);
    else if (picked.unavailable) showToast(picked.unavailable);
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

  const startProcessing = async () => {
    if (locked || folders.length === 0) return;
    setPhase('processing');
    setProgress(0);
    setStatusText('Reading your mesh');
    await api.startProcessing(projectId);

    unwatch.current = api.watchProcessing(projectId, (tick) => {
      setProgress(tick.progress);
      setStatusText(tick.statusText);
      if (tick.phase !== 'done') return;

      setPhase('done');
      setHexagonCount(tick.hexagonCount ?? 0);
      setShowComplete(true);
      unwatch.current?.();
      unwatch.current = null;
    });
  };

  /**
   * Stop a run that is already going.
   *
   * Returns to the pre-run state rather than a distinct "aborted" one: the
   * folders are still there and Process is the obvious next move.
   */
  const abort = async () => {
    if (phase !== 'processing' || aborting) return;
    setAborting(true);
    try {
      await api.abortProcessing(projectId);
      unwatch.current?.();
      unwatch.current = null;
      setPhase('empty');
      setProgress(0);
      setStatusText('');
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
              disabled={locked || full}
              style={{ gap: 7, flex: 'none' }}
            >
              <Icon name="folder" size={15} />
              Browse
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
            {!locked && !full && !checking && !inspection && showHints && (
              <span className="muted-55">
                Paste an absolute path. The local server reads it, so <span className="mono">~</span>{' '}
                and environment variables work.
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

        {phase === 'processing' && (
          <div className="card elev-sm process-card">
            <div className="process-head">
              <Icon name="spinner" size={20} color="var(--color-accent)" className="spin" />
              <div className="process-status">{statusText}</div>
              <div className="muted-55" style={{ fontSize: 13 }}>
                {progress}%
              </div>
              <button
                type="button"
                className="btn btn-secondary process-abort"
                onClick={abort}
                disabled={aborting}
              >
                <Icon name="close" size={13} />
                {aborting ? 'Stopping…' : 'Abort'}
              </button>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="progress-bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="muted-55" style={{ fontSize: 12 }}>
              Folders are locked while we convert them. This usually takes a couple of minutes.
            </div>
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
            {phase === 'done' ? 'Processed' : phase === 'processing' ? 'Processing…' : 'Process'}
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
          <p className="dialog-body" style={{ margin: 0 }}>
            {folders.length} folders converted into {hexagonCount.toLocaleString()} hexagons. Every
            variable is ready to explore on the map.
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
