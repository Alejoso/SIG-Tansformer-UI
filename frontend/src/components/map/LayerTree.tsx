/**
 * The layer picker: a file-explorer tree over what the engine rendered.
 *
 * Used for both sides of the map sidebar. The model is hierarchical — a
 * variable can be built from other variables — so its rows open to reveal
 * their parts, at any depth. The input variables are one uploaded folder each
 * and arrive flat, so the same component draws them as a plain list: when
 * nothing in a section is composite, the disclosure column is dropped
 * altogether rather than left as empty space.
 *
 * Structure comes straight from the backend (`api.getLayerTree`); this
 * component only draws it and tracks which rows are open.
 */

import { useState } from 'react';
import type { LayerNode } from '../../types';
import { Icon } from '../ui/Icon';

interface LayerTreeProps {
  /** Section heading, e.g. "Model HTML". */
  title: string;
  nodes: LayerNode[];
  selectedId: string | null;
  onSelect: (node: LayerNode) => void;
  /** Ids to show opened on first render. */
  defaultOpen?: string[];
}

/** True when anything in the section has children, at any depth. */
function hasComposite(nodes: LayerNode[]): boolean {
  return nodes.some((node) => (node.children?.length ?? 0) > 0 || hasComposite(node.children ?? []));
}

export function LayerTree({ title, nodes, selectedId, onSelect, defaultOpen = [] }: LayerTreeProps) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(defaultOpen));
  // A flat section needs no disclosure column; a nested one needs it on every
  // row, including the leaves, or the labels would not line up.
  const showCarets = hasComposite(nodes);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (node: LayerNode, depth: number) => {
    const children = node.children ?? [];
    const composite = children.length > 0;
    const isOpen = open.has(node.id);
    const selected = node.id === selectedId;

    return (
      <li key={node.id} role="none">
        <div
          role="treeitem"
          aria-selected={selected}
          aria-expanded={composite ? isOpen : undefined}
          className={`layer-row${selected ? ' is-selected' : ''}${
            node.hasDocument ? '' : ' is-empty'
          }`}
          // Depth is drawn with padding rather than nested boxes, so the rows
          // keep one flat hit area and one alignment column.
          style={{ paddingLeft: (showCarets ? 8 : 12) + depth * 14 }}
        >
          {showCarets &&
            (composite ? (
              <button
                type="button"
                className={`layer-caret${isOpen ? ' is-open' : ''}`}
                aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.label}`}
                // Stops the caret from also changing what is on the map:
                // opening a composite to look inside is not selecting it.
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(node.id);
                }}
              >
                <Icon name="chevronRight" size={12} strokeWidth={3} />
              </button>
            ) : (
              <span className="layer-caret is-leaf" aria-hidden="true" />
            ))}

          <button
            type="button"
            className="layer-label"
            disabled={!node.hasDocument}
            onClick={() => {
              if (!node.hasDocument) return;
              onSelect(node);
              // Selecting a composite also opens it — never closes it, so a
              // row cannot vanish under the click that selected it.
              if (composite && !isOpen) toggle(node.id);
            }}
          >
            {/* A variable goes by its code and nothing else. The label is
                built from whatever the processed file was called, which in
                real data comes out as `A` or `At` — no use for telling two
                variables apart, which is all this list is for. It stays on
                the hover title, where it costs nothing.

                Model layers have no code, and their labels are the criterion
                names from the config, so those show as they are. */}
            {node.code ? (
              <span className="layer-name mono" title={node.label}>
                {node.code}
              </span>
            ) : (
              <span className="layer-name">{node.label}</span>
            )}
            {composite && <span className="layer-count">{children.length}</span>}
          </button>
        </div>

        {composite && isOpen && (
          <ul role="group" className="layer-children">
            {children.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <section className="layer-section">
      <h2 className="layer-section-title">{title}</h2>
      <ul role="tree" aria-label={title} className="layer-list">
        {nodes.map((node) => renderNode(node, 0))}
      </ul>
    </section>
  );
}
