/**
 * The layer picker: what the engine rendered, as a list.
 *
 * The model side is flat — the whole model, then one map per criterion. The
 * input side is one level deep: a folder per dimension holding the variables
 * in it. A real project has sixty variables across three dimensions, and
 * sixty rows in one list is a list nobody reads.
 *
 * A folder is not a layer. It has no document of its own, so clicking it
 * opens it rather than putting anything on the map — the disabled look that
 * goes with `hasDocument: false` elsewhere would be wrong here, because the
 * row does do something.
 *
 * Structure comes straight from the backend (`api.getLayerTree`); this only
 * draws it and remembers which folders are open.
 */

import { useState } from 'react';
import type { LayerNode } from '../../types';
import { Icon } from '../ui/Icon';

interface LayerTreeProps {
  /** Section heading, e.g. "Variables". */
  title: string;
  nodes: LayerNode[];
  selectedId: string | null;
  onSelect: (node: LayerNode) => void;
}

const childrenOf = (node: LayerNode) => node.children ?? [];

export function LayerTree({ title, nodes, selectedId, onSelect }: LayerTreeProps) {
  /**
   * Folders the user has opened or closed by hand. Anything not in here
   * follows the selection.
   */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  /**
   * Open when it has been opened by hand, and otherwise only if it is the
   * only folder there is.
   *
   * Opening the one holding the selection was the first instinct, and it
   * made the first screen worse: the map falls back to a variable, its
   * dimension has twenty-three of them, and the other two dimensions were
   * pushed off the bottom — so a sidebar built to show three folders opened
   * showing none of them. Closed, all three are there, and the heading over
   * the map says which one the layer came from.
   *
   * Derived rather than kept, so the first render settles itself. A hand
   * closing one still wins: an explicit `false` outranks the default.
   */
  const onlyFolder = nodes.filter((node) => childrenOf(node).length > 0).length === 1;
  const isOpen = (node: LayerNode) => toggled[node.id] ?? onlyFolder;

  const toggle = (node: LayerNode) =>
    setToggled((current) => ({ ...current, [node.id]: !isOpen(node) }));

  const row = (node: LayerNode, isChild: boolean) => {
    const selected = node.id === selectedId;
    // A folder is one that holds something. A node with no document and no
    // children is neither a layer nor a folder — the "no model run yet"
    // placeholder is the one — and stays the disabled row it has always been.
    const folder = childrenOf(node).length > 0;
    return (
      <div
        className={`layer-row${selected ? ' is-selected' : ''}${folder ? ' is-folder' : ''}${
          !folder && !node.hasDocument ? ' is-empty' : ''
        }${isChild ? ' is-child' : ''}`}
      >
        <button
          type="button"
          className="layer-label"
          disabled={!folder && !node.hasDocument}
          onClick={() => (folder ? toggle(node) : onSelect(node))}
          aria-expanded={folder ? isOpen(node) : undefined}
        >
          {folder && (
            <span className={`layer-caret${isOpen(node) ? ' is-open' : ''}`}>
              <Icon name="chevronRight" size={12} strokeWidth={3} />
            </span>
          )}
          {/* A variable goes by its code and nothing else. The label is built
              from whatever the processed file was called, which in real data
              comes out as `A` or `At` — no use for telling two variables
              apart, which is all this list is for. It stays on the hover
              title, where it costs nothing.

              Folders and model layers have no code: a dimension's name and a
              criterion's are names somebody chose. */}
          {node.code ? (
            <span className="layer-name mono" title={node.label}>
              {node.code}
            </span>
          ) : (
            <span className="layer-name">{node.label}</span>
          )}
          {folder && <span className="layer-count">{childrenOf(node).length}</span>}
        </button>
      </div>
    );
  };

  return (
    <section className="layer-section">
      <h2 className="layer-section-title">{title}</h2>
      <ul role="tree" aria-label={title} className="layer-list">
        {nodes.map((node) => (
          <li key={node.id} role="none">
            {row(node, false)}
            {childrenOf(node).length > 0 && isOpen(node) && (
              <ul role="group" className="layer-children">
                {childrenOf(node).map((child) => (
                  <li key={child.id} role="none">
                    {row(child, true)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
