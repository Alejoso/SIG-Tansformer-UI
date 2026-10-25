import { useEffect, useMemo, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import type { LayerNode, LayerTree as LayerTreeData, MapMode } from '../../types';
import { LayerFrame } from '../map/LayerFrame';
import { LayerTree } from '../map/LayerTree';
import { Icon } from '../ui/Icon';
import { SettingsDialog } from './SettingsDialog';

const MODE_HINTS: Record<MapMode, string> = {
  input: 'The variables exactly as you uploaded them — one document per folder.',
  model: 'What the model produced: the whole thing, and one map per criterion.',
};

/** One level down as well, since a dimension's variables live under it. */
function findNode(nodes: LayerNode[], id: string): LayerNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = (node.children ?? []).find((one) => one.id === id);
    if (child) return child;
  }
  return null;
}

/** The first thing that can actually go on the map, folders skipped. */
function firstLayer(nodes: LayerNode[]): LayerNode | null {
  for (const node of nodes) {
    if (node.hasDocument) return node;
    const child = (node.children ?? []).find((one) => one.hasDocument);
    if (child) return child;
  }
  return null;
}

export function MapScreen() {
  const { project, goTo, showHints, mapView, setMapView } = useApp();
  const projectId = project?.id ?? '';
  const { mode, nodeId } = mapView;

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
      : { nodes: tree.inputs, fallback: firstLayer(tree.inputs) };
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
    api.getLayerUrl(projectId, active.id).then((url) => {
      if (live) setFetched({ nodeId: active.id, url });
    });
    return () => {
      live = false;
    };
    // The resolutions are render settings for the engine, so saving them can
    // point at a freshly generated document.
  }, [projectId, active, settingsVersion]);

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

        {showHints && (
          <p className="mode-hint muted-55">{MODE_HINTS[mode]}</p>
        )}

        <div className="layer-tree-scroll">
          {tree ? (
            mode === 'model' ? (
              /* The whole model first, then one map per criterion. One list:
                 they are the same kind of thing at different scopes, and two
                 headings for two and one rows was more structure than there
                 is. */
              <LayerTree
                title="Model"
                nodes={[tree.model.combined, ...tree.model.variables]}
                selectedId={active?.id ?? null}
                onSelect={select}
              />
            ) : (
              /* Already grouped and sorted by the server: dimensions
                 alphabetically, and the variables inside each in the order
                 `scan_variables` found them. */
              <LayerTree
                title="Variables"
                nodes={tree.inputs}
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
          /* The code when the layer has one: it is what the model file and
             the master table call this, while the label is taken from
             whatever the processed file was named — which can come out as
             "A" or "At". The readable name moves to the line below. */
          title={active.code || active.label}
          subtitle={active.description}
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
