import { useEffect, useState } from 'react';
import * as api from '../../api';
import { DEFAULT_SETTINGS, PIPELINE_VERSIONS } from '../../api/mock/fixtures';
import { MAX_H3_RESOLUTION, MIN_H3_RESOLUTION, type ProjectSettings } from '../../types';
import { Dialog } from '../ui/Dialog';

interface SettingsDialogProps {
  /** `null` before a project exists — the dialog then edits the defaults. */
  projectId: string | null;
  onClose: () => void;
}

const inRange = (value: number) =>
  Number.isInteger(value) && value >= MIN_H3_RESOLUTION && value <= MAX_H3_RESOLUTION;

/**
 * Advanced settings.
 *
 * The two H3 resolutions are deliberately separate: `processingResolution` is
 * what the engine computes and stores at, `mapResolution` is only what gets
 * drawn. Splitting them lets a heavy mesh be explored at a coarser grid
 * without reprocessing anything.
 */
export function SettingsDialog({ projectId, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api.getSettings(projectId).then((loaded) => {
      if (live) setSettings(loaded);
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  const processingValid = inRange(settings.processingResolution);
  const mapValid = inRange(settings.mapResolution);
  // A map finer than the processing grid cannot show detail that was never
  // computed, so warn rather than silently drawing an illusion of precision.
  const mapTooFine = processingValid && mapValid && settings.mapResolution > settings.processingResolution;
  const canSave = processingValid && mapValid && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (projectId) await api.saveSettings(projectId, settings);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  /** Keeps a half-typed field usable by storing NaN rather than snapping. */
  const setResolution = (field: 'processingResolution' | 'mapResolution', raw: string) =>
    setSettings((current) => ({ ...current, [field]: raw === '' ? Number.NaN : Number(raw) }));

  const show = (value: number) => (Number.isNaN(value) ? '' : String(value));

  return (
    <Dialog onClose={onClose} width="min(480px, 100%)" labelledBy="settings-title">
      <div className="dialog-title" id="settings-title">
        Advanced settings
      </div>
      <p className="dialog-body" style={{ margin: 0 }}>
        Most projects never need to touch these. The defaults follow your last project.
      </p>

      <div className="settings-grid">
        <div className="field">
          <label htmlFor="pipeline-version">Pipeline version</label>
          <select
            id="pipeline-version"
            className="input"
            value={settings.pipelineVersion}
            onChange={(e) => setSettings({ ...settings, pipelineVersion: e.target.value })}
          >
            {PIPELINE_VERSIONS.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="processing-res">Processing resolution</label>
            <input
              id="processing-res"
              className={`input${processingValid ? '' : ' is-invalid'}`}
              type="number"
              inputMode="numeric"
              min={MIN_H3_RESOLUTION}
              max={MAX_H3_RESOLUTION}
              value={show(settings.processingResolution)}
              aria-invalid={!processingValid}
              onChange={(e) => setResolution('processingResolution', e.target.value)}
            />
            <p className="field-hint muted-55">What the engine converts your data at.</p>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="map-res">Visualization resolution</label>
            <input
              id="map-res"
              className={`input${mapValid ? '' : ' is-invalid'}`}
              type="number"
              inputMode="numeric"
              min={MIN_H3_RESOLUTION}
              max={MAX_H3_RESOLUTION}
              value={show(settings.mapResolution)}
              aria-invalid={!mapValid}
              onChange={(e) => setResolution('mapResolution', e.target.value)}
            />
            <p className="field-hint muted-55">What the hexagons on the map are drawn at.</p>
          </div>
        </div>

        {(!processingValid || !mapValid) && (
          <p className="settings-note is-error">
            H3 resolutions run from {MIN_H3_RESOLUTION} to {MAX_H3_RESOLUTION}.
          </p>
        )}
        {mapTooFine && (
          <p className="settings-note">
            The map is finer than the processing grid, so it cannot show more detail than was
            computed at resolution {settings.processingResolution}.
          </p>
        )}

        <div className="field">
          <label htmlFor="crs">Coordinate system</label>
          <input id="crs" className="input" value={settings.coordinateSystem} readOnly />
        </div>
      </div>

      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={!canSave}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </Dialog>
  );
}
