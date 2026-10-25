/**
 * The layer picker: a list of what the engine rendered.
 *
 * A plain list on both sides. The input variables are one uploaded folder
 * each; the model side is the whole model and one map per criterion. It used
 * to be a tree, with rows that opened to show the subcriteria beneath a
 * criterion — the engine still renders those, and they are still on disk, but
 * the sidebar does not offer them.
 *
 * Structure comes straight from the backend (`api.getLayerTree`); this
 * component only draws it.
 */

import type { LayerNode } from '../../types';

interface LayerTreeProps {
  /** Section heading, e.g. "Model". */
  title: string;
  nodes: LayerNode[];
  selectedId: string | null;
  onSelect: (node: LayerNode) => void;
}

export function LayerTree({ title, nodes, selectedId, onSelect }: LayerTreeProps) {
  return (
    <section className="layer-section">
      <h2 className="layer-section-title">{title}</h2>
      <ul role="listbox" aria-label={title} className="layer-list">
        {nodes.map((node) => {
          const selected = node.id === selectedId;
          return (
            <li key={node.id} role="none">
              <div
                role="option"
                aria-selected={selected}
                className={`layer-row${selected ? ' is-selected' : ''}${
                  node.hasDocument ? '' : ' is-empty'
                }`}
              >
                <button
                  type="button"
                  className="layer-label"
                  disabled={!node.hasDocument}
                  onClick={() => node.hasDocument && onSelect(node)}
                >
                  {/* A variable goes by its code and nothing else. The label
                      is built from whatever the processed file was called,
                      which in real data comes out as `A` or `At` — no use for
                      telling two variables apart, which is all this list is
                      for. It stays on the hover title, where it costs
                      nothing.

                      Model layers have no code, and their labels are the
                      criterion names from the config, so those show as they
                      are. */}
                  {node.code ? (
                    <span className="layer-name mono" title={node.label}>
                      {node.code}
                    </span>
                  ) : (
                    <span className="layer-name">{node.label}</span>
                  )}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
