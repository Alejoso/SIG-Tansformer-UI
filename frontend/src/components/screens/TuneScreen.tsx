import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import { modelFromParsed, weightSum } from '../../lib/model';
import { lintYaml, parseYaml } from '../../lib/yaml-lint';
import type { ModelExample, ModelFile, ModelIssue, PipelineRun } from '../../types';
import { ApplyDoneDialog, ApplyProgressDialog } from '../tune/ApplyDialogs';
import { ExamplesDialog } from '../tune/ExamplesDialog';
import { ModelDiagram } from '../tune/ModelDiagram';
import { YamlCodeEditor } from '../tune/YamlCodeEditor';
import { Icon } from '../ui/Icon';

export function TuneScreen() {
  const { project, goTo, showHints, showToast, setMapView } = useApp();
  const projectId = project?.id ?? '';

  const [file, setFile] = useState<ModelFile | null>(null);
  const [text, setText] = useState('');
  /** What is on disk, so "unsaved" is a fact rather than a guess. */
  const [savedText, setSavedText] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  /** The model run in flight, polled like a processing run. */
  const [applyRun, setApplyRun] = useState<PipelineRun | null>(null);
  const [stopping, setStopping] = useState(false);
  const unwatchApply = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api
      .getModel(projectId)
      .then((loaded) => {
        if (!live) return;
        setFile(loaded);
        setText(loaded.text);
        setSavedText(loaded.text);
      })
      .catch((error: unknown) => {
        if (live) setLoadError(error instanceof Error ? error.message : 'Could not open the model file');
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  useEffect(() => () => unwatchApply.current?.(), []);

  /** Syntax problems, found here on every keystroke rather than on save. */
  const syntaxProblems = useMemo(() => lintYaml(text), [text]);

  /**
   * Structural problems from the last round trip.
   *
   * Cleared as soon as the text changes: they describe what was sent, and
   * leaving them up while someone fixes the file would be misleading.
   */
  const structureProblems: ModelIssue[] =
    file && text === file.text ? file.structureErrors : [];

  const parsed = useMemo(() => (syntaxProblems.length ? null : parseYaml(text)), [text, syntaxProblems]);
  const diagramModel = useMemo(() => (parsed ? modelFromParsed(parsed) : null), [parsed]);

  const dirty = text !== savedText;

  const record = useCallback((saved: ModelFile) => {
    setFile(saved);
    setSavedText(saved.text);
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      record(await api.saveModel(projectId, text));
      showToast('Saved');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save the model file');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Apply writes the file, then walks the variables.
   *
   * Only the write is real; running the model from the file comes next. The
   * walk is driven by the variables actually in the document, so it names what
   * is really there rather than a fixed list.
   */
  const apply = async () => {
    setBusy(true);
    let saved: ModelFile;
    try {
      saved = await api.applyModel(projectId, text);
      record(saved);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not write the model file');
      setBusy(false);
      return;
    }

    // Not gated on the diagram. The diagram is drawn from the shape this app
    // invented before we knew what the engine reads; the engine reads
    // criteria/subgroups/leaves. A file it understands may well draw nothing
    // here, and refusing to run it because of that would be this app
    // overruling the thing doing the work. If the engine dislikes the file it
    // says so, and that message is worth more than ours.

    // The file is written; now run it. The model is a run like processing —
    // four steps in the engine's container — so it is watched the same way.
    try {
      const started = await api.startModelRun(projectId, { useProjectModel: true });
      setApplyRun(started);
    } catch (error) {
      setBusy(false);
      showToast(error instanceof Error ? error.message : 'Could not start the model');
      return;
    }

    unwatchApply.current = api.watchModelRun(
      projectId,
      (tick) => {
        setApplyRun(tick);
        if (tick.status === 'starting' || tick.status === 'running') return;
        setBusy(false);
        unwatchApply.current = null;
      },
      (error) => {
        setBusy(false);
        showToast(error.message);
      },
    );
  };

  /** Stop a model run. It is a real process, so this really stops it. */
  const stopApply = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      const { detail } = await api.abortModelRun(projectId);
      unwatchApply.current?.();
      unwatchApply.current = null;
      setApplyRun(null);
      setBusy(false);
      showToast(detail ? `Stopped — ${detail}` : 'Stopped');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not stop it');
    } finally {
      setStopping(false);
    }
  };

  const viewMap = () => {
    setMapView({ mode: 'model', scale: 'raw', nodeId: 'model' });
    goTo('map');
  };

  /** Paste an example in at the end, rather than replacing the file. */
  const insertExample = (example: ModelExample) => {
    setText((current) => `${current.trimEnd()}\n\n${example.yaml.trim()}\n`);
    setShowExamples(false);
    showToast(`${example.title} added to the editor`);
  };

  if (loadError) {
    return (
      <div className="screen-loading" style={{ flexDirection: 'column', gap: 10 }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18 }}>
          Cannot open the model file
        </div>
        <div className="muted-55" style={{ fontSize: 12.5, maxWidth: 440, textAlign: 'center' }}>
          {loadError}
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="screen-loading">
        <Icon name="spinner" size={22} color="var(--color-accent)" className="spin" />
      </div>
    );
  }

  const problems = [
    ...syntaxProblems.map((p) => ({
      message: p.message,
      line: p.line,
      kind: 'syntax' as const,
    })),
    ...structureProblems.map((p) => ({
      message: p.message,
      line: p.line,
      kind: 'structure' as const,
    })),
  ];

  const statusLabel = syntaxProblems.length
    ? `${syntaxProblems.length} syntax ${syntaxProblems.length === 1 ? 'error' : 'errors'}`
    : structureProblems.length
      ? `${structureProblems.length} ${structureProblems.length === 1 ? 'problem' : 'problems'}`
      : dirty
        ? 'Valid · unsaved'
        : 'Saved';

  const statusClass = problems.length ? 'is-invalid' : dirty ? '' : 'is-clean';

  return (
    <div className="tune-screen">
      <div className="tune-head">
        <div>
          <h1>Tune the model</h1>
          {showHints && (
            <p className="muted">
              This is the model file itself — edit it however you like, comments and all. Syntax is
              checked as you type; the structure is checked when you save.
            </p>
          )}
        </div>

        <div className="tune-actions">
          <span className={`status-chip ${statusClass}`}>
            <Icon name={problems.length ? 'close' : 'check'} size={13} strokeWidth={3} />
            {statusLabel}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setShowExamples(true)}
            style={{ height: 42, paddingInline: 16, fontSize: 14, gap: 8, whiteSpace: 'nowrap' }}
          >
            <Icon name="book" />
            Examples
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={save}
            disabled={busy || !dirty}
            style={{ height: 42, paddingInline: 20, fontSize: 14.5, whiteSpace: 'nowrap' }}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={apply}
            disabled={busy || syntaxProblems.length > 0}
            style={{ height: 42, paddingInline: 22, fontSize: 14.5, whiteSpace: 'nowrap' }}
          >
            Apply
          </button>
        </div>
      </div>

      <div className="tune-panes">
        <section className="yaml-pane" aria-label="Model file">
          <header className="yaml-head">
            <Icon name="file" size={15} color="var(--color-accent-600)" />
            {/* The real path, so it is clear which file is being written. */}
            <span className="yaml-filename mono" title={file.path}>
              {file.path.split('/').slice(-3).join('/')}
            </span>
            <span className="yaml-kind muted-50">{dirty ? 'unsaved' : 'saved'}</span>
          </header>

          <div className="yaml-body-editor">
            <YamlCodeEditor value={text} onChange={setText} readOnly={busy} />
          </div>

          {problems.length > 0 && (
            <div className="yaml-problems" role="alert">
              {problems.slice(0, 8).map((problem, index) => (
                <div key={`${problem.kind}-${index}`} className="yaml-problem">
                  <span className={`yaml-problem-kind is-${problem.kind}`}>
                    {problem.kind === 'syntax' ? 'syntax' : 'model'}
                  </span>
                  {problem.line !== null && (
                    <span className="yaml-problem-line mono">line {problem.line}</span>
                  )}
                  <span className="yaml-problem-text">{problem.message}</span>
                </div>
              ))}
              {problems.length > 8 && (
                <div className="yaml-problem muted-55">
                  …and {problems.length - 8} more
                </div>
              )}
            </div>
          )}
        </section>

        {diagramModel ? (
          <ModelDiagram model={diagramModel} weightSum={weightSum(diagramModel)} />
        ) : (
          <div className="diagram-pane diagram-empty">
            <Icon name="hexagon" size={34} color="var(--color-accent-400)" />
            <div className="diagram-empty-title">
              {syntaxProblems.length ? 'Waiting for the file to parse' : 'Nothing to draw yet'}
            </div>
            <p className="muted-55">
              {syntaxProblems.length
                ? 'The diagram follows the text, so it comes back as soon as the YAML is valid.'
                : 'Add a `variables:` mapping and the structure will appear here.'}
            </p>
          </div>
        )}
      </div>

      {showExamples && (
        <ExamplesDialog onClose={() => setShowExamples(false)} onInsert={insertExample} />
      )}

      {applyRun && (applyRun.status === 'starting' || applyRun.status === 'running') && (
        <ApplyProgressDialog run={applyRun} onStop={stopApply} stopping={stopping} />
      )}

      {applyRun && applyRun.status !== 'starting' && applyRun.status !== 'running' && (
        <ApplyDoneDialog run={applyRun} onStay={() => setApplyRun(null)} onViewMap={viewMap} />
      )}
    </div>
  );
}
