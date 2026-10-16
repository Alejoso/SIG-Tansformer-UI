import { useEffect, useMemo, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import type { LayerNode, LayerTree as LayerTreeData, MapMode, ValueScale } from '../../types';
import { LayerFrame } from '../map/LayerFrame';
import { LayerTree } from '../map/LayerTree';
import { Icon } from '../ui/Icon';
import { SettingsDialog } from './SettingsDialog';

const MODE_HINTS: Record<MapMode, string> = {
  input: 'The variables exactly as you uploaded them — one document per folder.',
  model: 'What the model produced. Variables built from others open to show their parts.',
};

const SCALE_HINTS: Record<ValueScale, string> = {
  raw: 'Values in their own units — metres per second, kilometres, percent.',
  normalized: 'The same values on a common 0 to 1 scale, so layers can be compared.',
};

/** Alphabetical by label, so a specific variable is easy to find. */
const byLabel = (nodes: LayerNode[]) =>
  [...nodes].sort((a, b) => a.label.localeCompare(b.label));

/** Depth-first walk, so a node can be found by id wherever it sits. */
function findNode(nodes: LayerNode[], id: string): LayerNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = node.children ? findNode(node.children, id) : null;
    if (found) return found;
  }
  return null;
}

export function MapScreen() {
  const { project, goTo, showHints, mapView, setMapView } = useApp();
  const projectId = project?.id ?? '';
  const { mode, scale, nodeId } = mapView;

  /**
   * Raw vs normalized only means something for input variables — model output
   * is already weighted and on its own scale. So the toggle is hidden in model
   * mode, and the value is pinned rather than merely ignored: a leftover
   * `normalized` would otherwise go on quietly asking for a different
   * document than the one the sidebar says is showing.
   */
  const showScale = mode === 'input';
  const effectiveScale: ValueScale = showScale ? scale : 'raw';

  const [tree, setTree] = useState<LayerTreeData | null>(null);
  /**
   * The document URL, tagged with the node it belongs to. Compared during
   * render so switching layers shows the loading state immediately instead of
   * the previous layer's document for a frame.
   */
  const [fetched, setFetched] = useState<{ nodeId: string; url: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Bumped when settings are saved, to force the document to refetch. */
  const [settingsVersion, setSettingsVersion] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api.getLayerTree(projectId).then((loaded) => {
      if (live) setTree(loaded);
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  /** Everything selectable in the current mode, and what to fall back to. */
  const { nodes, fallback } = useMemo(() => {
    if (!tree) return { nodes: [] as LayerNode[], fallback: null as LayerNode | null };
    return mode === 'model'
      ? { nodes: [tree.model.combined, ...tree.model.variables], fallback: tree.model.combined }
      : { nodes: tree.inputs, fallback: tree.inputs[0] ?? null };
  }, [tree, mode]);

  /**
   * The selected node. A node id from the other mode will not be found here,
   * so switching modes falls back rather than blanking the map.
   */
  const active = useMemo(
    () => (nodeId ? findNode(nodes, nodeId) : null) ?? fallback,
    [nodes, nodeId, fallback],
  );

  useEffect(() => {
    // A node the engine produced nothing for has no document to fetch, and
    // asking for one would 404 where an explanation belongs.
    if (!projectId || !active || active.hasDocument === false) return;
    let live = true;
    api.getLayerUrl(projectId, active.id, effectiveScale).then((url) => {
      if (live) setFetched({ nodeId: active.id, url });
    });
    return () => {
      live = false;
    };
    // The resolutions are render settings for the engine, so saving them can
    // point at a freshly generated document.
  }, [projectId, active, effectiveScale, settingsVersion]);

  const layerUrl = fetched && active && fetched.nodeId === active.id ? fetched.url : null;

  const select = (node: LayerNode) => setMapView({ ...mapView, nodeId: node.id });

  return (
    <div className="map-screen">
      <aside className="map-sidebar">
        <div className="seg mode-switch" role="group" aria-label="Layer source">
          <label className="seg-opt">
            <input
              type="radio"
              name="map-mode"
              checked={mode === 'input'}
              onChange={() => setMapView({ ...mapView, mode: 'input', nodeId: null })}
            />
            Input variables
          </label>
          <label className="seg-opt">
            <input
              type="radio"
              name="map-mode"
              checked={mode === 'model'}
              onChange={() => setMapView({ ...mapView, mode: 'model', nodeId: null })}
            />
            Model
          </label>
        </div>

        {showScale && (
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
        )}

        {showHints && (
          <p className="mode-hint muted-55">
            {MODE_HINTS[mode]}
            {showScale && ` ${SCALE_HINTS[scale]}`}
          </p>
        )}

        <div className="layer-tree-scroll">
          {tree ? (
            mode === 'model' ? (
              <>
                {/* One row, always: this document already holds everything. */}
                <LayerTree
                  title="Model HTML"
                  nodes={[tree.model.combined]}
                  selectedId={active?.id ?? null}
                  onSelect={select}
                />
                <LayerTree
                  title="Variables"
                  nodes={tree.model.variables}
                  selectedId={active?.id ?? null}
                  onSelect={select}
                />
              </>
            ) : (
              /* Sorted here rather than trusting the backend's order, so the
                 list stays findable whatever arrives. */
              <LayerTree
                title="Variables"
                nodes={byLabel(tree.inputs)}
                selectedId={active?.id ?? null}
                onSelect={select}
              />
            )
          ) : (
            <div className="screen-loading" style={{ padding: 24 }}>
              <Icon name="spinner" size={20} color="var(--color-accent)" className="spin" />
            </div>
          )}
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

      {active && active.hasDocument === false ? (
        <div className="map-canvas">
          <div className="layer-frame-overlay">
            <Icon name="hexagon" size={34} color="var(--color-accent-400)" />
            <div className="layer-frame-overlay-text">{active.label}</div>
            <div className="muted-55" style={{ fontSize: 12.5, maxWidth: 380, textAlign: 'center' }}>
              {active.description || 'The pipeline has not produced this layer yet.'}
            </div>
          </div>
        </div>
      ) : active && layerUrl ? (
        <LayerFrame
          url={layerUrl}
          filename={active.filename}
          title={active.label}
          subtitle={
            effectiveScale === 'normalized' && active.description
              ? `${active.description} · normalized`
              : active.description
          }
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
