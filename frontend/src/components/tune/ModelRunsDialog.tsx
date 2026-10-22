/**
 * What past model runs are costing, and getting rid of them.
 *
 * Every Apply writes a whole set of rendered maps — the model, each
 * criterion, each subcriterion — into its own folder, and nothing removes
 * them. Only the newest is ever drawn: the map takes `runs[0]` and nothing
 * in the app asks for another. So after a few rounds of tuning most of a
 * project's disk is in folders that cannot be opened from anywhere, and
 * there was no way to find that out, let alone act on it.
 *
 * Deleting is offered rather than done. These are results; which of them is
 * worth keeping is not a judgement to make on someone's behalf quietly.
 */

import { useState } from 'react';
import * as api from '../../api';
import { formatSize, formatWhen } from '../../lib/format';
import type { ModelRun } from '../../types';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

interface ModelRunsDialogProps {
  projectId: string;
  runs: ModelRun[];
  /** Called with the new list after anything is removed. */
  onChanged: (runs: ModelRun[]) => void;
  onClose: () => void;
}

export function ModelRunsDialog({ projectId, runs, onChanged, onClose }: ModelRunsDialogProps) {
  const [busy, setBusy] = useState(false);
  /** Which run the delete button is waiting for a second click on. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freed, setFreed] = useState<number | null>(null);

  const older = runs.filter((run) => !run.current);
  const reclaimable = older.reduce((total, run) => total + run.sizeBytes, 0);

  const after = async (removal: { freedBytes: number }) => {
    setFreed(removal.freedBytes);
    onChanged(await api.listModelRuns(projectId));
  };

  const removeOne = async (run: ModelRun) => {
    if (confirming !== run.id) {
      setConfirming(run.id);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await after(await api.removeModelRun(projectId, run.id));
      setConfirming(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Could not remove it');
    } finally {
      setBusy(false);
    }
  };

  const keepNewest = async () => {
    setBusy(true);
    setError(null);
    try {
      await after(await api.pruneModelRuns(projectId, 1));
    } catch (pruneError) {
      setError(pruneError instanceof Error ? pruneError.message : 'Could not clean up');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} width="min(560px, 100%)" labelledBy="runs-title">
      <div className="dialog-title" id="runs-title">
        Model runs
      </div>
      <p className="dialog-body" style={{ margin: 0 }}>
        Every Apply writes a new set of maps. The map only ever shows the newest, so the rest
        are taking up room without being reachable.
      </p>

      <div className="run-list">
        {runs.map((run) => (
          <div key={run.id} className={`run-row${run.current ? ' is-current' : ''}`}>
            <div className="run-row-main">
              <span className="run-id mono">{run.id}</span>
              <span className="run-meta muted-55">
                {formatWhen(run.modifiedAt)} · {run.documentCount} maps
              </span>
            </div>
            {run.current && <span className="run-badge">on the map</span>}
            <span className="run-size mono">{formatSize(run.sizeBytes)}</span>
            <button
              type="button"
              className={`run-remove${confirming === run.id ? ' is-confirming' : ''}`}
              onClick={() => removeOne(run)}
              onBlur={() => setConfirming((id) => (id === run.id ? null : id))}
              disabled={busy}
              aria-label={`Remove run ${run.id}`}
            >
              {confirming === run.id ? 'Sure?' : <Icon name="close" size={13} strokeWidth={3} />}
            </button>
          </div>
        ))}
        {runs.length === 0 && (
          <p className="muted-55" style={{ fontSize: 12.5, margin: 0 }}>
            No model runs yet. Apply the model and one appears here.
          </p>
        )}
      </div>

      {freed !== null && (
        <p className="settings-note">
          {freed > 0 ? `Freed ${formatSize(freed)}.` : 'Nothing to free.'}
        </p>
      )}
      {error && <p className="settings-note is-error">{error}</p>}

      <div className="dialog-actions">
        {older.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={keepNewest}
            disabled={busy}
            style={{ marginRight: 'auto' }}
          >
            {busy ? 'Removing…' : `Keep only the newest — frees ${formatSize(reclaimable)}`}
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
