/**
 * What the dialog at the end of a processing run says about it.
 *
 * Apart from the Data screen so it can be tested without a browser
 * (`tests/unit/run-outcome.test.mjs`), and because each of its rules is a
 * way the dialog once said the wrong thing.
 */

import type { PipelineRun, VariableProblem } from '../types';

export interface RunOutcome {
  /**
   * `checking` while the problems list is still the one from before the run,
   * `unknown` when it could not be read, `known` once it is this run's.
   */
  state: 'checking' | 'unknown' | 'known';
  title: string;
  /** Whether the run left something out, as far as can be told. */
  someFailed: boolean;
  /** Variables this run left out, when known; 0 otherwise. */
  failed: number;
  /** Of those, the ones the engine running out of memory cost. */
  memory: number;
}

/**
 * The outcome of a finished run.
 *
 * `problems` is null when the request for them failed, and `current` says
 * whether they were read after this run ended. Neither case is "All done":
 * before the list is back it is "Checking…" (deciding from the run's own
 * count of files and then flipping when the list arrives reads as the run
 * changing its mind), and a list that could not be read is said to be so,
 * falling back to that count.
 *
 * Only this run's problems count. The list is everything on disk, and a
 * variable an earlier run left out, which this one did not touch again,
 * would otherwise make every later run "Done, with some left out". A problem
 * carries the run its log is from; the variables left with nothing at all
 * (`missing`) carry the last run's id, so they count too. A run without an
 * id (the engine never named it) counts them all, as before.
 */
export function runOutcome(
  run: Pick<PipelineRun, 'executionId' | 'erroredFiles'> | null,
  problems: VariableProblem[] | null,
  current: boolean,
): RunOutcome {
  if (!current) {
    return { state: 'checking', title: 'Checking…', someFailed: false, failed: 0, memory: 0 };
  }
  if (problems === null) {
    const someFailed = (run?.erroredFiles ?? 0) > 0;
    return {
      state: 'unknown',
      title: someFailed ? 'Done, with some left out' : 'Done',
      someFailed,
      failed: 0,
      memory: 0,
    };
  }
  const executionId = run?.executionId ?? '';
  const mine = executionId ? problems.filter((p) => p.executionId === executionId) : problems;
  const failed = mine.length;
  return {
    state: 'known',
    title: failed > 0 ? 'Done, with some left out' : 'All done',
    someFailed: failed > 0,
    failed,
    memory: mine.filter((p) => p.cause === 'memory').length,
  };
}
