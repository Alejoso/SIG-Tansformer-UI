/**
 * Feedback while the model is applied, and when it finishes.
 *
 * Both are driven by `ApplyProgress` ticks, which the mock generates today and
 * the backend will stream over SSE — the components do not know the
 * difference.
 */

import type { ApplyProgress } from '../../types';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

/** Turns `distance_to_substation` into `distance to substation`. */
const readable = (key: string) => key.replace(/_/g, ' ');

/**
 * The loading dialog. Names the variable being processed rather than showing a
 * bare spinner, because on a real mesh this run is long enough that "which one
 * is it on?" is the first thing anyone asks.
 *
 * It has no close button on purpose: the run is already in flight, and
 * dismissing the dialog would not stop it.
 */
export function ApplyProgressDialog({ progress }: { progress: ApplyProgress }) {
  const percent = progress.total > 0 ? Math.round((progress.index / progress.total) * 100) : 0;

  return (
    <Dialog
      onClose={() => {}}
      width="min(440px, 100%)"
      style={{ alignItems: 'stretch' }}
      labelledBy="apply-progress-title"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Icon name="spinner" size={22} color="var(--color-accent)" className="spin" />
        <div className="dialog-title" id="apply-progress-title" style={{ margin: 0 }}>
          Applying the model
        </div>
      </div>

      <div className="apply-variable" aria-live="polite">
        <span className="apply-variable-label muted-55">Processing</span>
        <span className="apply-variable-name">{readable(progress.variable)}</span>
      </div>

      <div
        className="progress-track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="progress-bar" style={{ width: `${percent}%` }} />
      </div>

      <div className="muted-55" style={{ fontSize: 12 }}>
        Variable {progress.index} of {progress.total} — each one is normalised and re-weighted.
      </div>
    </Dialog>
  );
}

interface ApplyDoneDialogProps {
  variableCount: number;
  onStay: () => void;
  onViewMap: () => void;
}

/** The confirmation once every variable has been through. */
export function ApplyDoneDialog({ variableCount, onStay, onViewMap }: ApplyDoneDialogProps) {
  return (
    <Dialog
      onClose={onStay}
      width="min(430px, 100%)"
      style={{ alignItems: 'flex-start' }}
      labelledBy="apply-done-title"
    >
      <div className="complete-icon">
        <Icon name="check" size={26} color="var(--color-accent-2-800)" strokeWidth={3} />
      </div>
      <div className="dialog-title" id="apply-done-title">
        Model applied
      </div>
      <p className="dialog-body" style={{ margin: 0 }}>
        {variableCount} {variableCount === 1 ? 'variable was' : 'variables were'} normalised and
        re-weighted. The model output on the map now reflects your weights.
      </p>
      <div className="dialog-actions" style={{ alignSelf: 'stretch' }}>
        <button type="button" className="btn btn-secondary" onClick={onStay}>
          Stay here
        </button>
        <button type="button" className="btn btn-primary" onClick={onViewMap}>
          View Map
        </button>
      </div>
    </Dialog>
  );
}
