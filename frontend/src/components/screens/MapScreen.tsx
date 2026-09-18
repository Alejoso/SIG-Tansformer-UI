import { useEffect, useMemo, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import type { LayerNode, LayerTree as LayerTreeData, ValueScale } from '../../types';
import { LayerFrame } from '../map/LayerFrame';
import { LayerTree } from '../map/LayerTree';
import { Icon } from '../ui/Icon';
import { SettingsDialog } from './SettingsDialog';

const SCALE_HINTS: Record<ValueScale, string> = {
  raw: 'Values in their own units — metres per second, kilometres, percent.',
  normalized: 'The same values on a common 0 to 1 scale, so layers can be compared.',
};

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
  const { scale, nodeId } = mapView;

  const [tree, setTree] = useState<LayerTreeData | null>(null);
  /** URL of the engine's pre-rendered document for the selected node. */
  const [layerUrl, setLayerUrl] = useState<string | null>(null);
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

  /** The selected node, defaulting to the whole model. */
  const active = useMemo(() => {
    if (!tree) return null;
    const all = [tree.model, ...tree.variables];
    return (nodeId && findNode(all, nodeId)) || tree.model;
  }, [tree, nodeId]);

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

  const select = (node: LayerNode) => setMapView({ ...mapView, nodeId: node.id });

  return (
    <div className="map-screen">
      <aside className="map-sidebar">
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

        {showHints && <p className="mode-hint muted-55">{SCALE_HINTS[scale]}</p>}

        <div className="layer-tree-scroll">
          {tree ? (
            <>
              <LayerTree
                title="Model HTML"
                nodes={[tree.model]}
                selectedId={active?.id ?? null}
                onSelect={select}
                // Opened by default so the tree's behaviour is visible without
                // hunting for something to click.
                defaultOpen={['model']}
              />
              <LayerTree
                title="Input variables"
                nodes={tree.variables}
                selectedId={active?.id ?? null}
                onSelect={select}
              />
            </>
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

      {active && layerUrl ? (
        <LayerFrame
          url={layerUrl}
          title={active.label}
          subtitle={
            scale === 'normalized' && active.description
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
