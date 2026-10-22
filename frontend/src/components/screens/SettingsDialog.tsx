import { useEffect, useState } from 'react';
import * as api from '../../api';
import { MAX_H3_RESOLUTION, MIN_H3_RESOLUTION, type ProjectSettings } from '../../types';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

interface SettingsDialogProps {
  projectId: string;
  onClose: () => void;
}

const inRange = (value: number) =>
  Number.isInteger(value) && value >= MIN_H3_RESOLUTION && value <= MAX_H3_RESOLUTION;

/**
 * The two resolutions the engine actually reads.
 *
 * They are deliberately separate, and the difference is worth stating on the
 * screen rather than only here: the processing resolution is the size of the
 * hexagons the values are computed and stored at, so moving it rebuilds the
 * master table and reprocesses everything. The map resolution is only how the
 * engine draws, so moving it redraws and leaves the data alone.
 *
 * They are stored per project, but the engine has one database and one
 * `.env`, so what they mean is "set the engine to this before running this
 * project". Two projects that disagree about the processing resolution cost
 * a master rebuild each time you switch — the engine notices and does it
 * itself. Said out loud below, because otherwise it reads as the app being
 * slow at random.
 */
export function SettingsDialog({ projectId, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  /** What the engine is set to now, so a change can say what it will cost. */
  const [saved, setSaved] = useState<ProjectSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getSettings(projectId)
      .then((loaded) => {
        if (!live) return;
        setSettings(loaded);
        setSaved(loaded);
      })
      .catch((loadError: unknown) => {
        if (live) {
          setError(loadError instanceof Error ? loadError.message : 'Could not read the settings');
        }
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  const processingValid = settings ? inRange(settings.processingResolution) : false;
  const mapValid = settings ? inRange(settings.mapResolution) : false;
  // A map finer than the processing grid cannot show detail that was never
  // computed, so warn rather than silently drawing an illusion of precision.
  const mapTooFine =
    !!settings && processingValid && mapValid &&
    settings.mapResolution > settings.processingResolution;
  const reprocesses =
    !!settings && !!saved && processingValid &&
    settings.processingResolution !== saved.processingResolution;
  const canSave = !!settings && processingValid && mapValid && !saving;

  const save = async () => {
    if (!canSave || !settings) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveSettings(projectId, settings);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the settings');
    } finally {
      setSaving(false);
    }
  };

  /** Drop this project's own numbers and track the engine's again. */
  const follow = async () => {
    setSaving(true);
    setError(null);
    try {
      const cleared = await api.clearSettings(projectId);
      setSettings(cleared);
      setSaved(cleared);
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Could not clear the settings');
    } finally {
      setSaving(false);
    }
  };

  /** Keeps a half-typed field usable by storing NaN rather than snapping. */
  const setResolution = (field: 'processingResolution' | 'mapResolution', raw: string) =>
    setSettings((current) =>
      current ? { ...current, [field]: raw === '' ? Number.NaN : Number(raw) } : current,
    );

  const show = (value: number) => (Number.isNaN(value) ? '' : String(value));

  return (
    <Dialog onClose={onClose} width="min(480px, 100%)" labelledBy="settings-title">
      <div className="dialog-title" id="settings-title">
        Advanced settings
      </div>

      {!settings ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
          {error ? (
            <p className="settings-note is-error" style={{ margin: 0 }}>
              {error}
            </p>
          ) : (
            <Icon name="spinner" size={20} color="var(--color-accent)" className="spin" />
          )}
        </div>
      ) : (
        <>
          <p className="dialog-body" style={{ margin: 0 }}>
            {settings.followingEngine
              ? 'Most projects never need these. Nothing has been set here, so this project ' +
                'runs at whatever the engine is configured with — shown below.'
              : 'Most projects never need these. They are applied to the engine when a run ' +
                'starts.'}
          </p>

          <div className="settings-grid">
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
                <p className="field-hint muted-55">
                  The size of the hexagons your values are stored in.
                </p>
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
                <p className="field-hint muted-55">
                  What the hexagons on the map are drawn at. Only redraws.
                </p>
              </div>
            </div>

            {(!processingValid || !mapValid) && (
              <p className="settings-note is-error">
                H3 resolutions run from {MIN_H3_RESOLUTION} to {MAX_H3_RESOLUTION}.
              </p>
            )}
            {/* The expensive one. Every stored value is keyed by a hexagon of
                the old size, so none of them survive the change. */}
            {reprocesses && (
              <p className="settings-note">
                Changing the processing resolution rebuilds the hexagon master table and
                reprocesses every variable on the next run — minutes, not seconds.
              </p>
            )}
            {mapTooFine && (
              <p className="settings-note">
                The map is finer than the processing grid, so it cannot show more detail than was
                computed at resolution {settings.processingResolution}.
              </p>
            )}
            {error && <p className="settings-note is-error">{error}</p>}

            <div className="field">
              <label htmlFor="crs">Coordinate system</label>
              <input id="crs" className="input" value={settings.coordinateSystem} readOnly />
              <p className="field-hint muted-55">
                The engine works in WGS 84 throughout, so there is nothing to choose.
              </p>
            </div>
          </div>
        </>
      )}

      <div className="dialog-actions">
        {/* The way back. Saving the numbers the engine currently reports is
            not the same thing: that pins them, and they would stay put when
            the engine moves. */}
        {settings && !settings.followingEngine && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={follow}
            disabled={saving}
            style={{ marginRight: 'auto' }}
          >
            Follow the engine
          </button>
        )}
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
