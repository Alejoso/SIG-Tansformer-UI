/**
 * Feedback while the model runs, and when it finishes.
 *
 * Both are driven by the run itself — the same shape processing reports, from
 * the same watcher — because applying the model *is* a run: `MCDA/run_mcda.sh`
 * measures distances, works out coverage, builds the exclusion masks and then
 * scores every hexagon.
 */

import type { PipelineRun } from '../../types';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

interface ApplyProgressDialogProps {
  run: PipelineRun;
  onStop: () => void;
  stopping: boolean;
  /** Put it away. The run carries on; the Apply button brings it back. */
  onHide: () => void;
}

/**
 * The loading dialog.
 *
 * Names the step rather than showing a bare spinner: scoring a country's
 * worth of hexagons takes long enough that "what is it doing?" is the first
 * thing anyone asks. It has a Stop now — the run is a real process and can
 * genuinely be stopped, which was not true when this only pretended.
 */
export function ApplyProgressDialog({
  run,
  onStop,
  stopping,
  onHide,
}: ApplyProgressDialogProps) {
  const current = run.stages.find((stage) => stage.status === 'running');
  const done = run.stages.filter((stage) => stage.status === 'ok').length;

  return (
    <Dialog
      onClose={onHide}
      width="min(460px, 100%)"
      style={{ alignItems: 'stretch' }}
      labelledBy="apply-progress-title"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Icon name="spinner" size={22} color="var(--color-accent)" className="spin" />
        <div className="dialog-title" id="apply-progress-title" style={{ margin: 0, flex: 1 }}>
          Applying the model
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onStop}
          disabled={stopping}
          style={{ height: 28, paddingInline: 12, fontSize: 12.5, flex: 'none' }}
        >
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
        {/* Not the same as Stop, and the difference matters: this leaves the
            run alone and gets out of the way. */}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onHide}
          style={{ height: 28, paddingInline: 12, fontSize: 12.5, flex: 'none' }}
        >
          Hide
        </button>
      </div>

      <div className="apply-variable" aria-live="polite">
        <span className="apply-variable-label muted-55">Step</span>
        <span className="apply-variable-name">{current?.label ?? run.statusText}</span>
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

      <div className="muted-55" style={{ fontSize: 12 }}>
        {done} of {run.stages.length} steps done. The scoring itself is the long one — it reads
        every hexagon in the master table. You can carry on working; this will say when it is
        finished.
      </div>
    </Dialog>
  );
}

interface ApplyDoneDialogProps {
  run: PipelineRun;
  onStay: () => void;
  onViewMap: () => void;
}

/** The confirmation once the model has scored. */
export function ApplyDoneDialog({ run, onStay, onViewMap }: ApplyDoneDialogProps) {
  const failed = run.status !== 'done';
  // The run has ended by the time this dialog shows, so `finishedAt` is set.
  // Reading the clock during render would make the number change on every
  // re-render, which React rightly complains about.
  const seconds = Math.max(0, Math.round((run.finishedAt ?? run.startedAt) - run.startedAt));

  return (
    <Dialog
      onClose={onStay}
      width="min(460px, 100%)"
      style={{ alignItems: 'flex-start' }}
      labelledBy="apply-done-title"
    >
      <div className="complete-icon">
        <Icon
          name={failed ? 'close' : 'check'}
          size={26}
          color={failed ? 'var(--color-accent-700)' : 'var(--color-accent-2-800)'}
          strokeWidth={3}
        />
      </div>
      <div className="dialog-title" id="apply-done-title">
        {failed ? 'The model did not finish' : 'Model applied'}
      </div>

      {failed ? (
        <>
          <p className="dialog-body" style={{ margin: 0 }}>
            It stopped at{' '}
            {run.stages.find((stage) => stage.status === 'failed')?.label ?? 'one of the steps'}.
          </p>
          {run.error && <pre className="process-error">{run.error}</pre>}
        </>
      ) : (
        <p className="dialog-body" style={{ margin: 0 }}>
          Scored in {seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`}. The map's
          Model side now shows this run — the whole model, each criterion, and the subcriteria
          beneath them.
        </p>
      )}

      <div className="dialog-actions" style={{ alignSelf: 'stretch' }}>
        <button type="button" className="btn btn-secondary" onClick={onStay}>
          Stay here
        </button>
        {!failed && (
          <button type="button" className="btn btn-primary" onClick={onViewMap}>
            View Map
          </button>
        )}
      </div>
    </Dialog>
  );
}
