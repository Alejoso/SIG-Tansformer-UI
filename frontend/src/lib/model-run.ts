/**
 * The model run, watched from above the screens.
 *
 * It used to be state inside the Model screen, which meant the progress
 * dialog could not be closed and leaving the screen lost track of a run that
 * was still going — the engine carried on, the app simply stopped looking.
 *
 * So the watch lives here instead. Three things read it: the Model screen,
 * for its Apply button; the header, so there is something to come back to;
 * and the app shell, which renders both dialogs — which is what lets a run
 * that finishes while you are on the Map still say so.
 *
 * A subscribable module rather than context, for the same reason the draft
 * is one: this ticks once a second, and in context every screen would
 * re-render with it. `useSyncExternalStore` means only the three that ask
 * for it do.
 */

import { useSyncExternalStore } from 'react';
import * as api from '../api';
import type { PipelineRun } from '../types';

export interface ModelRunState {
  /** The project it belongs to. A run is only ever shown for its own. */
  projectId: string;
  run: PipelineRun;
  /** Whether the progress dialog is up. Closing it does not stop anything. */
  showing: boolean;
  /**
   * Set once the finished run has been acknowledged.
   *
   * Without it the "it finished" dialog would come back on every re-render
   * for the rest of the session.
   */
  acknowledged: boolean;
}

let state: ModelRunState | null = null;
let stopWatching: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(next: ModelRunState | null) {
  state = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const snapshot = () => state;

/** The run in flight, or the last one that has not been acknowledged yet. */
export function useModelRun(): ModelRunState | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const isLive = (run: PipelineRun) => run.status === 'starting' || run.status === 'running';

function follow(projectId: string) {
  stopWatching?.();
  stopWatching = api.watchModelRun(
    projectId,
    (run) => {
      // Keep whatever the dialog is doing; only the run itself has moved.
      emit({
        projectId,
        run,
        showing: state?.showing ?? false,
        acknowledged: state?.acknowledged ?? false,
      });
      if (!isLive(run)) {
        stopWatching?.();
        stopWatching = null;
      }
    },
    () => {
      // The backend went away mid-run. Stop claiming to know what is
      // happening rather than leaving a progress bar frozen at 40%.
      stopWatching?.();
      stopWatching = null;
      emit(null);
    },
  );
}

/** Called when Apply has started one. The dialog opens with it. */
export function started(projectId: string, run: PipelineRun): void {
  emit({ projectId, run, showing: true, acknowledged: false });
  follow(projectId);
}

/**
 * Pick up a run that was already going — after a reload, or on opening a
 * project whose model is still being scored.
 *
 * Only a live one: a finished run from an hour ago is not news, and
 * announcing it on every project open would be.
 */
export async function resume(projectId: string): Promise<void> {
  if (state?.projectId === projectId) return;
  try {
    const run = await api.getModelRun(projectId);
    if (!run || !isLive(run)) return;
    emit({ projectId, run, showing: false, acknowledged: false });
    follow(projectId);
  } catch {
    // Nothing to resume is the normal case.
  }
}

/** Open or close the progress dialog. Neither starts nor stops the run. */
export function setShowing(showing: boolean): void {
  if (state) emit({ ...state, showing });
}

/** The finished run has been seen; stop announcing it. */
export function acknowledge(): void {
  if (state) emit({ ...state, acknowledged: true });
}

/** Forget it entirely — used when a run is stopped on purpose. */
export function clear(): void {
  stopWatching?.();
  stopWatching = null;
  emit(null);
}
