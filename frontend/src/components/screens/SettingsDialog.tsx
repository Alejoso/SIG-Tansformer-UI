import { useEffect, useState } from 'react';
import * as api from '../../api';
import {
  MAX_H3_RESOLUTION,
  MIN_H3_RESOLUTION,
  type ProjectSettings,
  type Resolutions,
} from '../../types';
import { useApp } from '../../state/app-context';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

interface SettingsDialogProps {
  /** The project these belong to, or null before it has been created. */
  projectId: string | null;
  /**
   * Without a project: what has been chosen so far, or null for the engine's
   * own. The project does not exist yet, so the choice is handed back to the
   * screen and written once it does — the resolution has to be settled
   * before the first run, and after it is the only other place to put this.
   */
  chosen?: Resolutions | null;
  onChoose?: (chosen: Resolutions | null) => void;
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
export function SettingsDialog({ projectId, chosen, onChoose, onClose }: SettingsDialogProps) {
  const { goTo } = useApp();
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  /**
   * What was saved, once it was — the dialog stays open to say what has to
   * happen next.
   *
   * Nothing on screen changes when a resolution is saved: the values keep
   * the hexagon size they were computed at, and the maps keep the one they
   * were drawn at. Closing on save would make that look like it had taken
   * effect.
   */
  const [justSaved, setJustSaved] = useState<{ processing: boolean; map: boolean } | null>(null);
  /** What is stored now, so a change can say what it will cost. */
  const [saved, setSaved] = useState<ProjectSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = projectId ? api.getSettings(projectId) : api.getEngineSettings();
    load
      .then((loaded) => {
        if (!live) return;
        // Before the project exists, a choice already made outranks the
        // engine's numbers — reopening the dialog should show what you set.
        const start =
          !projectId && chosen ? { ...loaded, ...chosen, followingEngine: false } : loaded;
        setSettings(start);
        setSaved(start);
      })
      .catch((loadError: unknown) => {
        if (live) {
          setError(loadError instanceof Error ? loadError.message : 'Could not read the settings');
        }
      });
    return () => {
      live = false;
    };
    // `chosen` is the starting value, not something to follow: re-reading it
    // mid-edit would overwrite what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const redraws =
    !!settings && !!saved && mapValid && settings.mapResolution !== saved.mapResolution;
  /** Only worth warning about when there is something at the old resolution. */
  const affectsResults = (reprocesses || redraws) && !!settings?.hasResults;
  const canSave = !!settings && processingValid && mapValid && !saving;

  const save = async () => {
    if (!canSave || !settings) return;
    const pair: Resolutions = {
      processingResolution: settings.processingResolution,
      mapResolution: settings.mapResolution,
    };

    if (!projectId) {
      onChoose?.(pair);
      onClose();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api.saveSettings(projectId, pair);
      if (affectsResults) {
        // Stay open and say what is still to do. The numbers are stored;
        // nothing that has already been computed has moved.
        setJustSaved({ processing: reprocesses, map: redraws });
        setSaved({ ...settings, ...pair, followingEngine: false });
        setSaving(false);
        return;
      }
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the settings');
    } finally {
      setSaving(false);
    }
  };

  /** "Default values": drop this project's own numbers and track the engine's. */
  const follow = async () => {
    setSaving(true);
    setError(null);
    try {
      const cleared = projectId ? await api.clearSettings(projectId) : await api.getEngineSettings();
      if (!projectId) onChoose?.(null);
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
    <Dialog onClose={onClose} width="min(500px, 100%)" labelledBy="settings-title">
      <div className="settings-head">
        <div className="dialog-title" id="settings-title">
          Resolution &amp; config
        </div>
        {/* Which of the two states this is in, always — otherwise the
            "Default values" button is simply absent with no way to tell why,
            which is exactly how it reads when nobody has set anything. */}
        {settings && (
          <span className={`settings-source${settings.followingEngine ? ' is-engine' : ''}`}>
            {settings.followingEngine ? 'Default values' : 'Set for this project'}
          </span>
        )}
      </div>

      {justSaved ? (
        <>
          <p className="dialog-body" style={{ margin: 0 }}>
            Saved. <strong>Nothing has changed yet</strong> — what is on the map was computed
            and drawn at the old resolution, and stays that way until the data is processed
            again.
          </p>
          <ul className="settings-next">
            {justSaved.processing && (
              <li>
                The hexagons are a different size now, so every value has to be computed
                again. The engine rebuilds its master table and reprocesses each variable —
                minutes, not seconds.
              </li>
            )}
            {justSaved.map && (
              <li>
                The maps are redrawn as part of that. On its own a re-run will not touch
                them: the engine skips a map that is newer than the data behind it.
              </li>
            )}
          </ul>
        </>
      ) : !settings ? (
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
              ? 'Most projects never need these. The numbers below are the defaults the ' +
                'engine is configured with, and leaving them alone keeps this project on ' +
                'them — including if the engine is set up differently later.'
              : 'These are applied to the engine when a run starts. Default values puts this ' +
                'project back on the engine\u2019s own numbers.'}
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
                {!projectId
                  ? 'Worth settling now: changing it after the first run rebuilds the hexagon ' +
                    'master table and reprocesses every variable.'
                  : settings.hasResults
                    ? 'Nothing already processed changes until you process again — the values ' +
                      'keep the hexagon size they were computed at. Then the master table is ' +
                      'rebuilt and every variable reprocessed: minutes, not seconds.'
                    : 'Nothing has been processed yet, so this costs nothing — it is simply ' +
                      'the size the first run will use.'}
              </p>
            )}
            {/* The engine skips a map that is newer than the data behind it,
                so this one does not take effect on a bare re-run either. */}
            {redraws && settings.hasResults && (
              <p className="settings-note">
                The maps already drawn keep their current resolution. They are redrawn when
                the variables are processed again, not on a re-run on its own.
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
        {justSaved ? (
          <>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Later
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                onClose();
                goTo('data');
              }}
            >
              Go and process
            </button>
          </>
        ) : (
          <>
        {/* The way back, offered only when there is something to go back
            from. Typing the numbers the engine currently reports is not the
            same thing: that pins them, and they would stay put when the
            engine moves. */}
        {settings && !settings.followingEngine && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={follow}
            disabled={saving}
            style={{ marginRight: 'auto' }}
          >
            Default values
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={!canSave}>
          {saving ? 'Saving…' : projectId ? 'Save settings' : 'Use these'}
        </button>
          </>
        )}
      </div>
    </Dialog>
  );
}
