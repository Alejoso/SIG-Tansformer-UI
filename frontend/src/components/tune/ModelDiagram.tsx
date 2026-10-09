/**
 * The right half of the tune screen: the model as a node graph.
 *
 * Read-only, and deliberately so. The editor beside it is a text editor now,
 * and writing a change back into someone's YAML means rewriting their file —
 * their comments, their ordering, their formatting. A picture of what the
 * text currently says is worth more than a second way to edit it that would
 * damage the first.
 *
 * It is drawn from whatever the text parses to, so it follows along as the
 * file is typed, and disappears when the file stops making sense.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildDiagram,
  DIAGRAM_CANVAS_WIDTH,
  DIAGRAM_ROOT_WIDTH,
} from '../../lib/diagram';
import { NORMALIZATION_LABELS } from '../../lib/model';
import type { ModelConfig } from '../../types';
import { Icon } from '../ui/Icon';

/** Padding subtracted when fitting the diagram to the pane. */
const FIT_PADDING = 40;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.6;
/** Never shrink below this when auto-fitting; smaller is unreadable. */
const MIN_FIT_ZOOM = 0.62;

interface ModelDiagramProps {
  model: ModelConfig;
  weightSum: number;
}

export function ModelDiagram({ model, weightSum }: ModelDiagramProps) {
  const pane = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.86);

  const diagram = buildDiagram(model.variables);

  const fit = useCallback(() => {
    const element = pane.current;
    if (!element) return;
    const scale = Math.min(1, (element.clientWidth - FIT_PADDING) / (DIAGRAM_CANVAS_WIDTH + 20));
    element.scrollTo(0, 0);
    setZoom(Math.max(MIN_FIT_ZOOM, scale));
  }, []);

  // Fit once on mount, and again whenever the pane is resized.
  useEffect(() => {
    fit();
    const element = pane.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);

  return (
    <div className="diagram-pane" ref={pane}>
      <div
        className="diagram-canvas"
        style={{
          width: diagram.width,
          height: diagram.height,
          transform: `scale(${zoom})`,
        }}
      >
        <svg
          width={diagram.width}
          height={diagram.height}
          style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
          aria-hidden="true"
        >
          {diagram.edges.map((edge) => (
            <path
              key={edge.id}
              d={edge.d}
              fill="none"
              strokeWidth={2}
              stroke={edge.kind === 'root' ? 'var(--color-accent-300)' : 'var(--color-accent-2-400)'}
            />
          ))}
        </svg>

        <div className="node-root" style={{ top: diagram.rootTop, width: DIAGRAM_ROOT_WIDTH }}>
          <div className="node-root-label">variables</div>
          <div className="node-root-value">{model.model}</div>
        </div>

        {diagram.nodes.map((node) => (
          <div
            key={node.id}
            className={`node${node.depth > 0 ? ' depth-deep' : ''}${
              node.informative ? ' is-informative' : ''
            }${node.exclusion_variable ? ' is-exclusive' : ''}`}
            style={{ left: node.left, top: node.top, width: node.width }}
          >
            <div className="node-label">
              <span className="node-label-name">{node.label}</span>
              {node.informative && <span className="node-badge">informative</span>}
            </div>

            {node.exclusion_variable ? (
              <div className="node-meta node-meta-exclusive">
                <span className="node-excl is-on">excludes</span>
              </div>
            ) : (
              <>
                <div className="node-readout">
                  <span className="node-readout-label">weight</span>
                  <span className="node-readout-value">{node.weight}</span>
                </div>
                <div className="node-meta">
                  <span className="node-norm-readout">
                    {NORMALIZATION_LABELS[node.normalization]}
                  </span>
                  {node.intervalCount > 0 && (
                    <span className="node-intervals">{node.intervalCount}</span>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="diagram-caption">
        <span className="diagram-caption-label muted-55">The file, as a diagram</span>
        <span className="tag tag-accent-2" style={{ gap: 5 }}>
          <span>weights add to</span>
          <span>{weightSum.toFixed(2)}</span>
        </span>
      </div>

      <div className="map-controls is-horizontal">
        <button
          type="button"
          className="btn btn-icon map-btn"
          aria-label="Zoom diagram in"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.1))}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="btn btn-icon map-btn"
          aria-label="Zoom diagram out"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.1))}
        >
          <Icon name="minus" />
        </button>
        <button type="button" className="btn btn-icon map-btn" aria-label="Fit diagram" onClick={fit}>
          <Icon name="fit" />
        </button>
      </div>
    </div>
  );
}
