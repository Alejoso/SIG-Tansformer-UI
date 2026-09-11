import { useEffect, useState } from 'react';
import * as api from '../../api';
import { PIPELINE_VERSIONS } from '../../api/mock/fixtures';
import { DEFAULT_SETTINGS } from '../../api/mock/fixtures';
import type { ProjectSettings } from '../../types';
import { Dialog } from '../ui/Dialog';

interface SettingsDialogProps {
  /** `null` before a project exists — the dialog then edits the defaults. */
  projectId: string | null;
  onClose: () => void;
}

/**
 * Advanced settings. H3 resolution and the coordinate system are fixed by the
 * engine, so they are shown read-only rather than hidden — the value matters
 * even though it is not yours to change.
 */
export function SettingsDialog({ projectId, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);

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

  const save = async () => {
    if (projectId) await api.saveSettings(projectId, settings);
    onClose();
  };

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
            <label htmlFor="h3-res">H3 resolution</label>
            <input id="h3-res" className="input" value={settings.h3Resolution} readOnly />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="crs">Coordinate system</label>
            <input id="crs" className="input" value={settings.coordinateSystem} readOnly />
          </div>
        </div>
      </div>

      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={save}>
          Save settings
        </button>
      </div>
    </Dialog>
  );
}
