/**
 * What the dialog at the end of a run says about it: `lib/run-outcome.ts`.
 *
 * Plain logic, so a unit test rather than a browser suite: no server needed.
 *
 *     node --test tests/unit/
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOutcome } from '../../src/lib/run-outcome.ts';

const RUN = '2026-11-24_18-29_rf_002';
const EARLIER = '2026-11-23_10-02_rf_001';

const problem = (code, status, executionId, cause = '') => ({
  id: `amb/${code}`, dimension: 'amb', code, status, stage: '', stageLabel: '', reason: '',
  source: '', executionId, cause,
});

test('a problems list that could not be read is not "All done"', () => {
  const outcome = runOutcome({ executionId: RUN, erroredFiles: 3 }, null, true);
  assert.equal(outcome.state, 'unknown');
  assert.equal(outcome.someFailed, true);
  assert.notEqual(outcome.title, 'All done');
});

test('nor is it when the run counted no failed files', () => {
  const outcome = runOutcome({ executionId: RUN, erroredFiles: 0 }, null, true);
  assert.equal(outcome.state, 'unknown');
  assert.notEqual(outcome.title, 'All done');
});

test('until the problems are from after the run, it is checking', () => {
  // The list from before the run: it would say "All done" and then flip.
  const outcome = runOutcome({ executionId: RUN, erroredFiles: 0 }, [], false);
  assert.equal(outcome.state, 'checking');
  assert.equal(outcome.title, 'Checking…');
  assert.equal(outcome.someFailed, false);
});

test('only what this run left out counts, not what an earlier one did', () => {
  const outcome = runOutcome({ executionId: RUN, erroredFiles: 2 }, [
    problem('AMB_001', 'error', EARLIER),
    problem('AMB_002', 'unfinished', EARLIER, 'memory'),
    problem('AMB_003', 'missing', RUN, 'memory'),
    problem('AMB_004', 'notBuilt', RUN),
  ], true);
  assert.equal(outcome.state, 'known');
  assert.equal(outcome.failed, 2);
  assert.equal(outcome.memory, 1);
  assert.equal(outcome.title, 'Done, with some left out');
});

test('a run that left nothing out is all done, whatever older runs left', () => {
  const outcome = runOutcome({ executionId: RUN, erroredFiles: 0 },
    [problem('AMB_001', 'error', EARLIER)], true);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.title, 'All done');
});

test('a run without an id counts every problem', () => {
  const outcome = runOutcome({ executionId: '', erroredFiles: 0 },
    [problem('AMB_001', 'error', EARLIER)], true);
  assert.equal(outcome.failed, 1);
});
