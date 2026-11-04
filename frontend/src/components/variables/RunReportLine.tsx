/**
 * The engine's own report of a finished run, in one line: its verdict, how
 * many errors and warnings it counted, and a link to the whole file
 * (`run_report.yaml`: stage times, results, every error and warning, and the
 * parameters the run had).
 *
 * The verdict matters on its own: `with_errors` is a run that exited cleanly
 * but whose results the engine flags, which nothing else on screen would say.
 */

import * as api from '../../api';
import type { PipelineRun } from '../../types';

const VERDICT: Record<string, string> = {
  ok: 'no errors',
  with_errors: 'finished, with errors in the results',
  failed: 'failed',
};

export function RunReportLine({ run }: { run: PipelineRun }) {
  const report = run.report;
  if (!report || !run.executionId) return null;

  const counts = [
    report.errorCount ? `${report.errorCount} error${report.errorCount === 1 ? '' : 's'}` : '',
    report.warningCount
      ? `${report.warningCount} warning${report.warningCount === 1 ? '' : 's'}`
      : '',
  ].filter(Boolean);
  // The run's own error text already lists these for a run with errors in
  // its results; for a failed one it is the log tail, so they go here.
  const listed = report.status === 'failed' ? report.errors : [];

  return (
    <div className={report.status === 'ok' ? 'muted-55' : 'process-warn'}>
      Engine report: {VERDICT[report.status] ?? report.status}
      {counts.length > 0 && ` · ${counts.join(', ')}`}
      {report.duration && ` · ${report.duration}`} ·{' '}
      <a href={api.runReportUrl(run.executionId)} target="_blank" rel="noreferrer">
        open run_report.yaml
      </a>
      {listed.length > 0 && (
        <ul className="run-report-errors">
          {listed.map((line) => (
            <li key={line} className="mono">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
