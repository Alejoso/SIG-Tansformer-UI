import { useEffect, useState } from 'react';
import * as api from '../api';
import * as modelRun from '../lib/model-run';
import type { ModelChangedColumn, ModelStatus } from '../types';
import { Icon } from './ui/Icon';

interface ModelStatusNoticeProps {
  projectId: string;
  /**
   * Apply the model again. The Model screen passes its own Apply (it writes
   * what is in the editor first); elsewhere the saved file is run as it is.
   */
  onApply?: () => void;
  /** Changed by the caller to ask again, after a save for instance. */
  refreshKey?: unknown;
  /** Narrow, for the map's sidebar. */
  compact?: boolean;
}

function describeChanged(changed: ModelChangedColumn[], roles: string[]): string {
  const columns = changed.filter((item) => roles.includes(item.role)).map((item) => item.column);
  if (!columns.length) return '';
  const shown = columns.slice(0, 4).join(', ');
  return columns.length > 4 ? `${shown} and ${columns.length - 4} more` : shown;
}

/**
 * Whether the map still shows the data, said where the map and the model are.
 *
 * The engine checks after every processing run which columns of the master
 * table changed and what each is to the model, and writes it down
 * (`out/model_status.json`); the server adds whether the model file changed
 * since the last Apply. How loudly this speaks follows how much it matters:
 *
 * - `rerun`: a scored column changed, or the model file did. The scores on
 *   the map are not the scores of this data, so it says so plainly, with
 *   the button that fixes it.
 * - `remask` and `alerts_only`: only exclusions or alerts moved. Every score
 *   is still right; some hexagons are ruled out or flagged differently. A
 *   quiet line.
 * - `informative_only`: only leaves weighted zero changed, which moves no
 *   score. A note, nothing more.
 * - `up_to_date`, `never_run`, `unknown`: nothing to say.
 */
export function ModelStatusNotice({
  projectId,
  onApply,
  refreshKey,
  compact = false,
}: ModelStatusNoticeProps) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const applying = modelRun.useModelRun();
  const runStatus = applying?.projectId === projectId ? applying.run.status : undefined;
  const running = runStatus === 'starting' || runStatus === 'running';

  useEffect(() => {
    // Asked again when a run ends: it has just changed the answer.
    if (!projectId || running) return;
    let live = true;
    api
      .getModelStatus(projectId)
      .then((found) => {
        if (live) setStatus(found);
      })
      .catch(() => {
        if (live) setStatus(null);
      });
    return () => {
      live = false;
    };
  }, [projectId, running, runStatus, refreshKey]);

  if (!status || running) return null;

  const apply =
    onApply ??
    (async () => {
      setStarting(true);
      try {
        modelRun.started(projectId, await api.startModelRun(projectId, { useProjectModel: true }));
      } catch {
        // The server's refusal (another run going, nothing processed) is
        // what the Model screen shows; here the notice simply stays.
      } finally {
        setStarting(false);
      }
    });

  const className = `model-status${compact ? ' is-compact' : ''}`;

  if (status.status === 'rerun') {
    const scored = describeChanged(status.changed, ['score']);
    return (
      <div className={`${className} is-strong`} role="alert" data-status={status.status}>
        <Icon name="close" size={14} strokeWidth={3} />
        <div className="model-status-body">
          <div className="model-status-title">The model map is out of date</div>
          <div className="model-status-text">
            {status.configChanged
              ? 'The model file has changed since it was last applied.'
              : scored
                ? `Data the model scores has changed: ${scored}.`
                : status.reason || 'The data has changed since the model was last applied.'}{' '}
            {onApply
              ? 'Apply the model (the button above) to bring the map up to date.'
              : 'Apply the model again to bring the map up to date.'}
          </div>
        </div>
        {/* On the Model screen its own Apply is right above: a second button
            doing the same thing would only make one wonder which to press. */}
        {!onApply && (
          <button
            type="button"
            className="btn btn-primary model-status-apply"
            onClick={apply}
            disabled={starting}
          >
            {starting ? 'Starting…' : 'Apply'}
          </button>
        )}
      </div>
    );
  }

  if (status.status === 'remask' || status.status === 'alerts_only') {
    const which = status.status === 'remask' ? ['exclusion'] : ['alert'];
    const columns = describeChanged(status.changed, which);
    return (
      <div className={`${className} is-soft`} role="status" data-status={status.status}>
        <Icon name="hexagon" size={14} />
        <div className="model-status-text">
          {status.status === 'remask'
            ? 'Only exclusions changed since the model was last applied'
            : 'Only alerts changed since the model was last applied'}
          {columns ? ` (${columns})` : ''}. The scores still hold; applying again updates which
          hexagons are {status.status === 'remask' ? 'ruled out' : 'flagged'}.
        </div>
      </div>
    );
  }

  if (status.status === 'informative_only') {
    return (
      <div className={`${className} is-note muted-55`} data-status={status.status}>
        Only variables weighted zero changed since the last run, so no score moved.
      </div>
    );
  }

  return null;
}
