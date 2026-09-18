/**
 * Layout for the node diagram beside the YAML editor.
 *
 * Pure geometry: it takes the variable tree and returns absolutely-positioned
 * boxes plus the bezier edges between them. No React, no DOM measurement —
 * the diagram's height is derived from the number of leaves, so it is known
 * before anything renders.
 */

import type { ModelPath, ModelVariable } from '../types';
import { intervalsOf, isInformative, leafCount, totalLeaves } from './model';

/**
 * Vertical space reserved per leaf, and the box height used to centre a node
 * on its slot. Sized for the tallest node — label, weight row, transform
 * select and the chips beneath — with enough gap that adjacent siblings do
 * not touch.
 */
const SLOT = 152;
const NODE_HEIGHT = 132;
/** Horizontal distance between depth levels. */
const COLUMN_WIDTH = 214;
const NODE_WIDTH = 190;
/** Where depth 0 starts, leaving room for the root box on the left. */
const FIRST_COLUMN_X = 178;
const ROOT_WIDTH = 152;
const CANVAS_WIDTH = 840;

export interface DiagramNode {
  id: string;
  path: ModelPath;
  label: string;
  weight: string;
  normalization: ModelVariable['normalization'];
  exclusive: boolean;
  /** Weight is zero: carried for reference, not counted in the score. */
  informative: boolean;
  /**
   * How many ranges the interval transform has, or 0 when it uses another
   * transform. The node is too small to edit a table, so it reports the count
   * and the editor pane owns the rows.
   */
  intervalCount: number;
  depth: number;
  left: number;
  top: number;
  width: number;
}

export interface DiagramEdge {
  id: string;
  /** SVG path data. */
  d: string;
  /** `root` edges are terracotta, the rest sage — matching the node tints. */
  kind: 'root' | 'branch';
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Centre of the root box, so the caller can place it. */
  rootTop: number;
  height: number;
  width: number;
}

const curve = (x1: number, y1: number, x2: number, y2: number) =>
  `M ${x1} ${y1} C ${x1 + 26} ${y1}, ${x2 - 26} ${y2}, ${x2} ${y2}`;

export function buildDiagram(variables: ModelVariable[]): Diagram {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  /** Lay out one level and return the vertical centre of each box placed. */
  const place = (list: ModelVariable[], path: ModelPath, depth: number, startY: number): number[] => {
    let cursor = startY;
    const centres: number[] = [];

    list.forEach((variable, index) => {
      const here = [...path, index];
      const slotHeight = leafCount(variable) * SLOT;
      const centre = cursor + slotHeight / 2;
      const left = FIRST_COLUMN_X + depth * COLUMN_WIDTH;

      nodes.push({
        id: here.join('-'),
        path: here,
        label: variable.key.replace(/_/g, ' '),
        weight: variable.weight,
        normalization: variable.normalization,
        exclusive: variable.exclusive,
        informative: isInformative(variable),
        intervalCount: variable.normalization === 'intervals' ? intervalsOf(variable).length : 0,
        depth,
        left,
        top: centre - NODE_HEIGHT / 2,
        width: NODE_WIDTH,
      });

      if (variable.sub?.length) {
        const childCentres = place(variable.sub, here, depth + 1, cursor);
        const fromX = left + NODE_WIDTH;
        const toX = left + COLUMN_WIDTH;
        childCentres.forEach((childY, childIndex) => {
          edges.push({
            id: `${here.join('-')}>${childIndex}`,
            d: curve(fromX, centre, toX, childY),
            kind: 'branch',
          });
        });
      }

      centres.push(centre);
      cursor += slotHeight;
    });

    return centres;
  };

  const rootCentres = place(variables, [], 0, 16);
  const rootY = rootCentres.length
    ? (rootCentres[0] + rootCentres[rootCentres.length - 1]) / 2
    : 60;

  rootCentres.forEach((centre, index) => {
    edges.push({ id: `root>${index}`, d: curve(ROOT_WIDTH + 4, rootY, FIRST_COLUMN_X, centre), kind: 'root' });
  });

  return {
    nodes,
    edges,
    rootTop: rootY - 32,
    height: Math.max(320, totalLeaves(variables) * SLOT + 40),
    width: CANVAS_WIDTH,
  };
}

export const DIAGRAM_CANVAS_WIDTH = CANVAS_WIDTH;
export const DIAGRAM_ROOT_WIDTH = ROOT_WIDTH;
