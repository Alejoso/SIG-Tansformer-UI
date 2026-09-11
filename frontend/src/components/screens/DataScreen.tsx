import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import { MAX_FOLDERS } from '../../api/mock';
import { useApp } from '../../state/app-context';
import type { DataFolder, ProcessingPhase } from '../../types';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

/** `412 MB`, `1.2 GB` — matched to how the design writes sizes. */
function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

/**
 * Pull the top-level folder names out of a directory selection. The browser
 * gives every file a path relative to the chosen folder, so the first segment
 * is the folder itself.
 */
function folderNames(files: FileList | null): string[] {
  if (!files) return [];
  const names = new Set<string>();
  for (const file of Array.from(files)) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (relative) names.add(relative.split('/')[0]);
  }
  return [...names];
}

export function DataScreen() {
  const { project, goTo, showHints } = useApp();
  const projectId = project?.id ?? '';

  const [folders, setFolders] = useState<DataFolder[]>([]);
  const [phase, setPhase] = useState<ProcessingPhase>('empty');
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [hexagonCount, setHexagonCount] = useState(0);
  const [showComplete, setShowComplete] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const browseInput = useRef<HTMLInputElement>(null);
  const unwatch = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api.listFolders(projectId).then((list) => {
      if (!live) return;
      setFolders(list);
      // A project that arrives with everything converted is already done.
      if (list.length > 0 && list.every((f) => f.state === 'ready')) setPhase('done');
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  // Never leave the progress stream open behind us.
  useEffect(() => () => unwatch.current?.(), []);

  const locked = phase !== 'empty';
  const full = folders.length >= MAX_FOLDERS;

  const addFolders = useCallback(
    async (paths: string[]) => {
      if (locked || !projectId || paths.length === 0) return;
      setFolders(await api.addFolders(projectId, paths));
    },
    [locked, projectId],
  );

  const removeFolder = async (folderId: string) => {
    await api.removeFolder(projectId, folderId);
    setFolders((current) => current.filter((f) => f.id !== folderId));
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
      setFolders((current) => current.map((f) => ({ ...f, state: 'ready' as const })));
      unwatch.current?.();
      unwatch.current = null;
    });
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (locked) return;

    // Directory entries carry the folder name; loose files fall back to theirs.
    const names = Array.from(e.dataTransfer.items)
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => Boolean(entry?.isDirectory))
      .map((entry) => entry.name);

    void addFolders(names.length > 0 ? names : Array.from(e.dataTransfer.files).map((f) => f.name));
  };

  const processHint =
    folders.length === 0
      ? 'Add at least one folder to continue.'
      : phase === 'empty'
        ? 'This converts every location into a hexagon. You can keep working after it starts.'
        : 'Your data is being converted.';

  return (
    <div className="screen data-screen">
      <div className="screen-body">
        <h1 className="data-title">Add your data</h1>
        <p className="data-lede muted">
          Drop in one folder per variable — up to ten. Each folder becomes a layer you can look at
          on the map.
        </p>

        <button
          type="button"
          className={`dropzone${locked || full ? ' is-locked' : ''}${dragOver ? ' is-over' : ''}`}
          disabled={locked || full}
          onClick={() => browseInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            if (!locked && !full) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <Icon name="upload" size={30} color="var(--color-accent)" />
          <div className="dropzone-title">
            {locked
              ? 'Folders locked while processing'
              : full
                ? `That is all ${MAX_FOLDERS} folders`
                : 'Drop your data folders here'}
          </div>
          <div className="muted-55" style={{ fontSize: 13 }}>
            {locked
              ? 'You can add more once this run finishes'
              : full
                ? 'Remove one to make room for another'
                : `Or click to browse — up to ${MAX_FOLDERS} folders, one per variable`}
          </div>
        </button>

        <input
          ref={browseInput}
          type="file"
          hidden
          multiple
          // Non-standard but supported everywhere this app runs; it is what
          // turns the file picker into a folder picker.
          {...{ webkitdirectory: '', directory: '' }}
          onChange={(e) => {
            void addFolders(folderNames(e.target.files));
            e.target.value = '';
          }}
        />

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
                <div key={folder.id} className={`folder-row${locked ? ' is-locked' : ''}`}>
                  <Icon name="folder" size={19} color="var(--color-accent-600)" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="folder-name">{folder.name}</div>
                    <div className="folder-meta muted-50">
                      {folder.fileCount} files · {formatSize(folder.sizeBytes)}
                    </div>
                  </div>

                  {folder.state === 'ready' && (
                    <span className="tag tag-accent-2" style={{ gap: 5 }}>
                      <Icon name="check" size={12} strokeWidth={3} />
                      Ready
                    </span>
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
            disabled={folders.length === 0 || locked}
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
            {folders.length} folders converted into {hexagonCount.toLocaleString()} hexagons at H3
            resolution 8. Every variable is ready to explore on the map.
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
