import { useEffect, useMemo, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import { rampFor, rampSwatch } from '../../lib/ramp';
import type { MapMode, Variable, ValueScale } from '../../types';
import { LayerFrame } from '../map/LayerFrame';
import { Icon } from '../ui/Icon';
import { SettingsDialog } from './SettingsDialog';

const MODE_HINTS: Record<MapMode, string> = {
  input: 'These are the variables exactly as you uploaded them, hexagon by hexagon.',
  model: 'These are the same variables after the model applies your weights.',
};

const SCALE_HINTS: Record<ValueScale, string> = {
  raw: 'Values in their own units — metres per second, kilometres, percent.',
  normalized: 'The same values put on a common 0 to 1 scale, so variables can be compared.',
};

export function MapScreen() {
  const { project, goTo, showHints, mapView, setMapView } = useApp();
  const projectId = project?.id ?? '';
  const { mode, scale } = mapView;

  const [variables, setVariables] = useState<Variable[]>([]);
  /** URL of the engine's pre-rendered document for the selected layer. */
  const [layerUrl, setLayerUrl] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Bumped when settings are saved, to force the layer to refetch. */
  const [settingsVersion, setSettingsVersion] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api.listVariables(projectId, mode).then((list) => {
      if (!live) return;
      setVariables(list);
      // Keep the requested variable if it exists in this mode, else fall back.
      setMapView({
        ...mapView,
        mode,
        variableId: list.some((v) => v.id === mapView.variableId)
          ? mapView.variableId
          : (list[0]?.id ?? null),
      });
    });
    return () => {
      live = false;
    };
    // `mapView` is read but must not re-trigger the fetch; only the mode does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, mode]);

  const active = useMemo(
    () => variables.find((v) => v.id === mapView.variableId) ?? variables[0] ?? null,
    [variables, mapView.variableId],
  );

  useEffect(() => {
    if (!projectId || !active) return;
    let live = true;
    api.getLayerUrl(projectId, active.id, scale).then((url) => {
      if (live) setLayerUrl(url);
    });
    return () => {
      live = false;
    };
    // The resolutions are render settings for the engine, so saving them can
    // point at a freshly generated document.
  }, [projectId, active, scale, settingsVersion]);

  const ramp = rampFor(mode);

  return (
    <div className="map-screen">
      <aside className="map-sidebar">
        <div className="seg mode-switch" role="group" aria-label="Layer source">
          <label className="seg-opt">
            <input
              type="radio"
              name="map-mode"
              checked={mode === 'input'}
              onChange={() => setMapView({ ...mapView, mode: 'input', variableId: null })}
            />
            Input variables
          </label>
          <label className="seg-opt">
            <input
              type="radio"
              name="map-mode"
              checked={mode === 'model'}
              onChange={() => setMapView({ ...mapView, mode: 'model', variableId: null })}
            />
            Model output
          </label>
        </div>

        <div className="seg mode-switch" role="group" aria-label="Value scale">
          <label className="seg-opt">
            <input
              type="radio"
              name="value-scale"
              checked={scale === 'raw'}
              onChange={() => setMapView({ ...mapView, scale: 'raw' })}
            />
            Raw data
          </label>
          <label className="seg-opt">
            <input
              type="radio"
              name="value-scale"
              checked={scale === 'normalized'}
              onChange={() => setMapView({ ...mapView, scale: 'normalized' })}
            />
            Normalized
          </label>
        </div>

        {showHints && (
          <p className="mode-hint muted-55">
            {MODE_HINTS[mode]} {SCALE_HINTS[scale]}
          </p>
        )}

        <div className="variable-list">
          {variables.map((variable, index) => {
            const selected = variable.id === active?.id;
            return (
              <button
                key={variable.id}
                type="button"
                className="variable-row"
                aria-pressed={selected}
                onClick={() => setMapView({ ...mapView, variableId: variable.id })}
              >
                <div className="variable-swatch" style={{ background: rampSwatch(ramp, index) }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="variable-name">{variable.name}</div>
                  <div className="variable-unit muted-52">
                    {scale === 'normalized' ? 'normalized, 0 to 1' : variable.unit}
                  </div>
                </div>
                {selected && <Icon name="check" size={15} color="var(--color-accent-700)" strokeWidth={3} />}
              </button>
            );
          })}
        </div>

        <div className="map-sidebar-actions">
          <button
            type="button"
            className="btn btn-secondary btn-block"
            onClick={() => goTo('tune')}
            style={{ margin: 0, gap: 8, height: 40 }}
          >
            <Icon name="sliders" />
            Tune the model
          </button>
          {/* Map resolution is a setting you want to change while looking at
              the map, so Config is reachable from here too. */}
          <button
            type="button"
            className="btn btn-secondary btn-block"
            onClick={() => setShowSettings(true)}
            style={{ margin: 0, gap: 8, height: 40 }}
          >
            <Icon name="fit" />
            Resolution &amp; config
          </button>
        </div>
      </aside>

      {active && layerUrl ? (
        <LayerFrame
          url={layerUrl}
          title={active.name}
          subtitle={scale === 'normalized' ? `${active.hint} · normalized` : active.hint}
        />
      ) : (
        <div className="map-canvas">
          <div className="screen-loading" style={{ height: '100%' }}>
            <Icon name="spinner" size={22} color="var(--color-accent)" className="spin" />
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsDialog
          projectId={projectId}
          onClose={() => {
            setShowSettings(false);
            setSettingsVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
