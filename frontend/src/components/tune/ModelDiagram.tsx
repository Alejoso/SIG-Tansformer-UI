/**
 * The right half of the tune screen: the same config as a node graph.
 *
 * Boxes are absolutely positioned from `buildDiagram`, with the bezier edges
 * drawn on an SVG underneath. Editing a weight here goes through the same
 * handlers as the YAML pane, so both views stay in step.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildDiagram,
  DIAGRAM_CANVAS_WIDTH,
  DIAGRAM_ROOT_WIDTH,
} from '../../lib/diagram';
import { NORMALIZATIONS, NORMALIZATION_LABELS } from '../../lib/model';
import type { ModelConfig, ModelPath, Normalization } from '../../types';
import { Icon } from '../ui/Icon';
import { ExclusiveTip } from '../ui/InfoTip';

/** Padding subtracted when fitting the diagram to the pane. */
const FIT_PADDING = 40;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.6;
/** Never shrink below this when auto-fitting; smaller is unreadable. */
const MIN_FIT_ZOOM = 0.62;

interface ModelDiagramProps {
  model: ModelConfig;
  weightSum: number;
  onWeight: (path: ModelPath, value: string) => void;
  onBump: (path: ModelPath, delta: number) => void;
  onExclusive: (path: ModelPath, value: boolean) => void;
  onNormalization: (path: ModelPath, value: Normalization) => void;
}

export function ModelDiagram({
  model,
  weightSum,
  onWeight,
  onBump,
  onExclusive,
  onNormalization,
}: ModelDiagramProps) {
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
            }${node.exclusive ? ' is-exclusive' : ''}`}
            style={{ left: node.left, top: node.top, width: node.width }}
          >
            <div className="node-label">
              {/* The name truncates, the badge does not — it was being
                  clipped by the label's ellipsis. */}
              <span className="node-label-name">{node.label}</span>
              {node.informative && <span className="node-badge">informative</span>}
            </div>

            {node.exclusive ? (
              /* An exclusive variable is a yes-or-no rule, not a weighted
                 input: there is no weight and no transform to set, so only
                 the flag and its explanation are shown. */
              <div className="node-meta node-meta-exclusive">
                <button
                  type="button"
                  className="node-excl is-on"
                  aria-pressed
                  onClick={() => onExclusive(node.path, false)}
                >
                  excludes
                </button>
                <ExclusiveTip />
              </div>
            ) : (
              <>
                <div className="node-weight">
                  <button
                    type="button"
                    className="btn btn-icon btn-secondary node-step"
                    aria-label={`Decrease ${node.label} weight`}
                    onClick={() => onBump(node.path, -0.02)}
                  >
                    <Icon name="minus" size={12} strokeWidth={3} />
                  </button>
                  <input
                    className={`node-input${
                      Number.isNaN(Number.parseFloat(node.weight)) ? ' is-invalid' : ''
                    }`}
                    value={node.weight}
                    aria-label={`${node.label} weight`}
                    onChange={(e) => onWeight(node.path, e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-icon btn-secondary node-step"
                    aria-label={`Increase ${node.label} weight`}
                    onClick={() => onBump(node.path, 0.02)}
                  >
                    <Icon name="plus" size={12} strokeWidth={3} />
                  </button>
                </div>

                {/* Stacked rather than side by side: "Standard scaler" does
                    not fit beside a chip in a 190px node. */}
                <select
                  className="node-norm"
                  value={node.normalization}
                  aria-label={`${node.label} normalization`}
                  onChange={(e) => onNormalization(node.path, e.target.value as Normalization)}
                >
                  {NORMALIZATIONS.map((option) => (
                    <option key={option} value={option}>
                      {NORMALIZATION_LABELS[option]}
                    </option>
                  ))}
                </select>

                <div className="node-meta">
                  {/* The table itself lives in the editor pane — a 190px box
                      is no place for it — but the count keeps the two views
                      honest about each other. */}
                  {node.intervalCount > 0 && (
                    <span className="node-intervals" title="Ranges, edited in the YAML pane">
                      {node.intervalCount}
                    </span>
                  )}
                  <button
                    type="button"
                    className="node-excl"
                    aria-pressed={false}
                    onClick={() => onExclusive(node.path, true)}
                  >
                    weighted
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="diagram-caption">
        <span className="diagram-caption-label muted-55">Same config, as a diagram</span>
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
