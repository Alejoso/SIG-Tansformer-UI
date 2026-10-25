/**
 * The model run's two dialogs, rendered by the shell rather than by the
 * Model screen.
 *
 * That is the whole point of it being here: a run takes minutes, the engine
 * carries on whatever screen you are looking at, and the thing that says it
 * finished has to be able to appear over any of them. While it runs the
 * dialog is yours to put away — nothing is blocked, and the Apply button on
 * the Model screen brings it back.
 */

import { useState } from 'react';
import * as api from '../api';
import * as modelRun from '../lib/model-run';
import { useApp } from '../state/app-context';
import { ApplyDoneDialog, ApplyProgressDialog } from './tune/ApplyDialogs';

export function ModelRunWatch() {
  const { goTo, setMapView, showToast } = useApp();
  const state = modelRun.useModelRun();
  const [stopping, setStopping] = useState(false);

  if (!state) return null;
  const live = state.run.status === 'starting' || state.run.status === 'running';

  /** Stop it for real — it is a process, not a progress bar. */
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      const { detail } = await api.abortModelRun(state.projectId);
      modelRun.clear();
      showToast(detail ? `Stopped — ${detail}` : 'Stopped');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not stop it');
    } finally {
      setStopping(false);
    }
  };

  if (live) {
    return state.showing ? (
      <ApplyProgressDialog
        run={state.run}
        onStop={stop}
        stopping={stopping}
        onHide={() => modelRun.setShowing(false)}
      />
    ) : null;
  }

  // Finished. Shown once, wherever you happen to be — the run was minutes
  // ago and you may well have moved on, which is exactly when being told
  // matters.
  if (state.acknowledged) return null;
  return (
    <ApplyDoneDialog
      run={state.run}
      onStay={modelRun.acknowledge}
      onViewMap={() => {
        modelRun.acknowledge();
        setMapView({ mode: 'model', nodeId: 'model' });
        goTo('map');
      }}
    />
  );
}
