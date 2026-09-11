import { useEffect, useMemo, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import { rampFor, rampSwatch } from '../../lib/ramp';
import type { HexLayerData, MapMode, Variable } from '../../types';
import { HexMap } from '../map/HexMap';
import { Icon } from '../ui/Icon';

const MODE_HINTS: Record<MapMode, string> = {
  raw: 'These are the variables exactly as you uploaded them, hexagon by hexagon.',
  model: 'These are the same variables after the model applies your weights.',
};

export function MapScreen() {
  const { project, goTo, showHints, mapView, setMapView } = useApp();
  const projectId = project?.id ?? '';
  const { mode } = mapView;

  const [variables, setVariables] = useState<Variable[]>([]);
  const [layer, setLayer] = useState<HexLayerData | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api.listVariables(projectId, mode).then((list) => {
      if (!live) return;
      setVariables(list);
      // Keep the requested variable if it exists in this mode, else fall back.
      setMapView({
        mode,
        variableId: list.some((v) => v.id === mapView.variableId)
          ? mapView.variableId
          : (list[0]?.id ?? null),
      });
    });
    return () => {
      live = false;
    };
    // `mapView.variableId` is read but must not re-trigger the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, mode]);

  const active = useMemo(
    () => variables.find((v) => v.id === mapView.variableId) ?? variables[0] ?? null,
    [variables, mapView.variableId],
  );

  useEffect(() => {
    if (!projectId || !active) return;
    let live = true;
    api.getHexLayer(projectId, active.id).then((data) => {
      if (live) setLayer(data);
    });
    return () => {
      live = false;
    };
  }, [projectId, active]);

  const ramp = rampFor(mode);
  const format = useMemo(() => {
    if (!active) return (value: number) => String(value);
    return (value: number) => `${value.toFixed(active.decimals)}${active.suffix}`;
  }, [active]);

  return (
    <div className="map-screen">
      <aside className="map-sidebar">
        <div className="seg mode-switch" role="group" aria-label="Layer source">
          <label className="seg-opt">
            <input
              type="radio"
              name="map-mode"
              checked={mode === 'raw'}
              onChange={() => setMapView({ mode: 'raw', variableId: null })}
            />
            Raw variables
          </label>
          <label className="seg-opt">
            <input
              type="radio"
              name="map-mode"
              checked={mode === 'model'}
              onChange={() => setMapView({ mode: 'model', variableId: null })}
            />
            Model output
          </label>
        </div>

        {showHints && <p className="mode-hint muted-55">{MODE_HINTS[mode]}</p>}

        <div className="variable-list">
          {variables.map((variable, index) => {
            const selected = variable.id === active?.id;
            return (
              <button
                key={variable.id}
                type="button"
                className="variable-row"
                aria-pressed={selected}
                onClick={() => setMapView({ mode, variableId: variable.id })}
              >
                <div className="variable-swatch" style={{ background: rampSwatch(ramp, index) }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="variable-name">{variable.name}</div>
                  <div className="variable-unit muted-52">{variable.unit}</div>
                </div>
                {selected && <Icon name="check" size={15} color="var(--color-accent-700)" strokeWidth={3} />}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={() => goTo('tune')}
          style={{ marginTop: 14, gap: 8, height: 40 }}
        >
          <Icon name="sliders" />
          Tune the model
        </button>
      </aside>

      {active && layer ? (
        <HexMap
          cells={layer.cells}
          variable={active}
          ramp={ramp}
          resolution={layer.resolution}
          format={format}
        />
      ) : (
        <div className="map-canvas">
          <div className="screen-loading" style={{ height: '100%' }}>
            <Icon name="spinner" size={22} color="var(--color-accent)" className="spin" />
          </div>
        </div>
      )}
    </div>
  );
}
