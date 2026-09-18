import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import {
  appendVariables,
  bumpWeight,
  isValid,
  setField,
  toLines,
  weightSum,
} from '../../lib/model';
import type { ApplyProgress, ModelConfig, ModelExample, ModelPath, Normalisation } from '../../types';
import { ApplyDoneDialog, ApplyProgressDialog } from '../tune/ApplyDialogs';
import { ExamplesDialog } from '../tune/ExamplesDialog';
import { ModelDiagram } from '../tune/ModelDiagram';
import { YamlEditor } from '../tune/YamlEditor';
import { Icon } from '../ui/Icon';

export function TuneScreen() {
  const { project, goTo, showHints, showToast, setMapView } = useApp();
  const projectId = project?.id ?? '';

  const [model, setModel] = useState<ModelConfig | null>(null);
  const [saved, setSaved] = useState(true);
  const [applied, setApplied] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  /** Non-null while the apply run is in flight; drives the loading dialog. */
  const [applyProgress, setApplyProgress] = useState<ApplyProgress | null>(null);
  const [applyDone, setApplyDone] = useState<number | null>(null);
  const unwatchApply = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api.getModel(projectId).then((loaded) => {
      if (!live) return;
      setModel(loaded);
      setSaved(true);
      setApplied(true);
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  // Never leave the apply stream open behind us.
  useEffect(() => () => unwatchApply.current?.(), []);

  /**
   * Every edit goes through here: it replaces the model and marks it dirty.
   * `transform` runs against the current model, so it stays correct even if
   * two edits land in the same batch.
   */
  const edit = useCallback((transform: (current: ModelConfig) => ModelConfig) => {
    setModel((current) => (current ? transform(current) : current));
    setSaved(false);
    setApplied(false);
  }, []);

  const onWeight = useCallback(
    (path: ModelPath, value: string) => edit((m) => setField(m, path, 'peso', value)),
    [edit],
  );
  const onBump = useCallback(
    (path: ModelPath, delta: number) => edit((m) => bumpWeight(m, path, delta)),
    [edit],
  );
  const onExcluyente = useCallback(
    (path: ModelPath, value: boolean) => edit((m) => setField(m, path, 'excluyente', value)),
    [edit],
  );
  const onNormalisation = useCallback(
    (path: ModelPath, value: Normalisation) => edit((m) => setField(m, path, 'normalizacion', value)),
    [edit],
  );
  const onResolution = useCallback(
    (value: string) => edit((m) => ({ ...m, resolution: value })),
    [edit],
  );

  const valid = model ? isValid(model) : false;
  const lines = useMemo(() => (model ? toLines(model) : []), [model]);
  const sum = model ? weightSum(model) : 0;

  const insertExample = (example: ModelExample) => {
    edit((m) => appendVariables(m, example.variables));
    setShowExamples(false);
    showToast(`${example.title} added to the editor`);
  };

  const save = async () => {
    if (!model) return;
    setBusy(true);
    try {
      await api.saveModel(projectId, model);
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Apply runs the model. It opens a loading dialog naming each variable as
   * the engine works through it, then a confirmation — rather than jumping
   * straight to the map, which gave no sign anything had happened.
   */
  const apply = async () => {
    if (!model || !valid) return;
    setBusy(true);
    await api.applyModel(projectId, model);
    setSaved(true);
    setApplied(true);
    setApplyProgress({ phase: 'running', variable: '', index: 0, total: 0 });

    unwatchApply.current = api.watchModelApply(projectId, model, (tick) => {
      if (tick.phase !== 'done') {
        setApplyProgress(tick);
        return;
      }
      setApplyProgress(null);
      setApplyDone(tick.total);
      setBusy(false);
      unwatchApply.current?.();
      unwatchApply.current = null;
    });
  };

  const viewMap = () => {
    setApplyDone(null);
    // Land on the whole-model document, which is what the new weights
    // just regenerated.
    setMapView({ mode: 'model', scale: 'raw', nodeId: 'model' });
    goTo('map');
  };

  if (!model) {
    return (
      <div className="screen-loading">
        <Icon name="spinner" size={22} color="var(--color-accent)" className="spin" />
      </div>
    );
  }

  const statusLabel = !valid
    ? 'Check the flagged weights'
    : !saved
      ? 'Valid · unsaved'
      : applied
        ? 'Saved and applied'
        : 'Saved · not applied';

  const statusClass = !valid ? 'is-invalid' : saved && applied ? 'is-clean' : '';

  return (
    <div className="tune-screen">
      <div className="tune-head">
        <div>
          <h1>Tune the model</h1>
          {showHints && (
            <p className="muted">
              Edit on either side — the text and the diagram always show the same thing. Each
              variable has a weight, its own normalisation, an optional exclusion rule, and can hold
              nested subvariables. Top-level weights should add up to about 1.
            </p>
          )}
        </div>

        <div className="tune-actions">
          <span className={`status-chip ${statusClass}`}>
            <Icon name="check" size={13} strokeWidth={3} />
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
            disabled={busy || saved}
            style={{ height: 42, paddingInline: 20, fontSize: 14.5, whiteSpace: 'nowrap' }}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={apply}
            disabled={busy || !valid}
            style={{ height: 42, paddingInline: 22, fontSize: 14.5, whiteSpace: 'nowrap' }}
          >
            Apply
          </button>
        </div>
      </div>

      <div className="tune-panes">
        <YamlEditor
          lines={lines}
          onWeight={onWeight}
          onExcluyente={onExcluyente}
          onNormalisation={onNormalisation}
          onResolution={onResolution}
        />
        <ModelDiagram
          model={model}
          weightSum={sum}
          onWeight={onWeight}
          onBump={onBump}
          onExcluyente={onExcluyente}
          onNormalisation={onNormalisation}
        />
      </div>

      {showExamples && (
        <ExamplesDialog onClose={() => setShowExamples(false)} onInsert={insertExample} />
      )}

      {applyProgress && <ApplyProgressDialog progress={applyProgress} />}

      {applyDone !== null && (
        <ApplyDoneDialog
          variableCount={applyDone}
          onStay={() => setApplyDone(null)}
          onViewMap={viewMap}
        />
      )}
    </div>
  );
}
