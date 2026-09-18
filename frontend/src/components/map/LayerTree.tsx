/**
 * The layer picker: a file-explorer tree over what the engine rendered.
 *
 * The engine emits a document for the whole model, one per variable, and one
 * per part of a composite variable — so the picker is a tree, and a composite
 * opens to reveal what it is built from, at any depth.
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

export function LayerTree({ title, nodes, selectedId, onSelect, defaultOpen = [] }: LayerTreeProps) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(defaultOpen));

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
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {composite ? (
            <button
              type="button"
              className={`layer-caret${isOpen ? ' is-open' : ''}`}
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.label}`}
              // Stops the caret from also changing what is on the map: opening
              // a composite to look inside is not the same as selecting it.
              onClick={(e) => {
                e.stopPropagation();
                toggle(node.id);
              }}
            >
              <Icon name="chevronRight" size={12} strokeWidth={3} />
            </button>
          ) : (
            <span className="layer-caret is-leaf" aria-hidden="true" />
          )}

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
            <span className="layer-name">{node.label}</span>
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
