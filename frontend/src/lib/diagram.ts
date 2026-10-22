/**
 * Layout for the node diagram beside the YAML editor.
 *
 * Pure geometry: it takes the model and returns absolutely-positioned boxes
 * plus the bezier edges between them. No React, no DOM measurement — the
 * height follows from the number of leaves, so it is known before anything
 * renders.
 *
 * The model is exactly three levels deep, because the engine's config is:
 * criteria, then subgroups, then leaves. So this walks those three rather
 * than recursing over an arbitrary tree, and each level can say what it
 * actually is instead of every box pretending to be the same kind of thing.
 */

import type { ModelCriterion, ModelLeaf, ModelSubgroup } from '../types';
import { leafCount, LEAF_TYPE_LABELS, totalLeaves } from './model';

/**
 * Vertical space reserved per leaf, and the box height used to centre a node
 * on its slot. Read-only boxes are three short lines, so this is tighter than
 * it was when every node held inputs to type into.
 */
const SLOT = 104;
const NODE_HEIGHT = 84;
/** Horizontal distance between levels, and how wide a box is. */
const COLUMN_WIDTH = 218;
const NODE_WIDTH = 196;
/** Where the criteria column starts, leaving room for the root box. */
const FIRST_COLUMN_X = 172;
const ROOT_WIDTH = 142;
const CANVAS_WIDTH = FIRST_COLUMN_X + COLUMN_WIDTH * 2 + NODE_WIDTH + 24;

/** Which level a box sits on. Each is drawn differently. */
export type NodeKind = 'criterion' | 'subgroup' | 'leaf';

export interface DiagramNode {
  id: string;
  kind: NodeKind;
  /** The key, or a leaf's code: what the file calls this. */
  label: string;
  /** The readable name, or a leaf's column. Empty when the file gives none. */
  detail: string;
  /** Formatted weight, or empty when the file does not set one. */
  weight: string;
  /** The scoring type, on a leaf only. */
  type: string;
  /** Short facts worth seeing without opening the file. */
  badges: string[];
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

/**
 * A weight as the file wrote it, near enough.
 *
 * Trimmed of trailing zeros so `0.319` and `1.0` both read as themselves
 * rather than one of them being padded to the other's precision.
 */
const formatWeight = (weight: number | null): string =>
  weight === null ? '' : String(Number(weight.toFixed(4)));

/**
 * Whether a `nombre` is just the key again.
 *
 * A generated file names a criterion after the dimension folder it came from,
 * so the key and the name can be the same word in different cases. Showing it
 * twice reads as a mistake.
 */
const sameName = (key: string, nombre: string): boolean =>
  nombre.trim().toLowerCase() === key.trim().toLowerCase();

function leafBadges(leaf: ModelLeaf): string[] {
  const badges: string[] = [];
  if (leaf.site !== 'both') badges.push(leaf.site);
  if (leaf.steps > 0) badges.push(`${leaf.steps} ${leaf.type === 'map' ? 'values' : 'cuts'}`);
  if (leaf.inverted) badges.push('inverted');
  return badges;
}

function subgroupBadges(subgroup: ModelSubgroup): string[] {
  const badges: string[] = [];
  if (subgroup.worstWins) badges.push('worst of');
  if (subgroup.normalized) badges.push('normalized');
  if (subgroup.absent !== null) badges.push(`absent ${subgroup.absent}`);
  return badges;
}

export function buildDiagram(criteria: ModelCriterion[]): Diagram {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  /** Place one box and return the vertical centre of its slot. */
  const box = (
    node: Omit<DiagramNode, 'left' | 'top' | 'width'>,
    slotTop: number,
    slotHeight: number,
  ): number => {
    const centre = slotTop + slotHeight / 2;
    nodes.push({
      ...node,
      left: FIRST_COLUMN_X + node.depth * COLUMN_WIDTH,
      top: centre - NODE_HEIGHT / 2,
      width: NODE_WIDTH,
    });
    return centre;
  };

  const connect = (from: DiagramNode | undefined, fromY: number, toY: number, id: string) => {
    if (!from) return;
    edges.push({
      id,
      d: curve(from.left + NODE_WIDTH, fromY, from.left + COLUMN_WIDTH, toY),
      kind: 'branch',
    });
  };

  let cursor = 16;
  const criterionCentres: number[] = [];

  criteria.forEach((criterion, criterionIndex) => {
    const criterionTop = cursor;
    const criterionHeight = leafCount(criterion) * SLOT;

    const criterionCentre = box(
      {
        id: `c${criterionIndex}`,
        kind: 'criterion',
        label: criterion.key,
        detail: sameName(criterion.key, criterion.nombre) ? '' : criterion.nombre,
        weight: formatWeight(criterion.weight),
        type: '',
        badges: [],
        depth: 0,
      },
      criterionTop,
      criterionHeight,
    );
    const criterionNode = nodes[nodes.length - 1];
    criterionCentres.push(criterionCentre);

    let subCursor = criterionTop;
    criterion.subgroups.forEach((subgroup, subgroupIndex) => {
      const subgroupTop = subCursor;
      const subgroupHeight = Math.max(1, subgroup.leaves.length) * SLOT;

      const subgroupCentre = box(
        {
          id: `c${criterionIndex}s${subgroupIndex}`,
          kind: 'subgroup',
          label: subgroup.key,
          detail: sameName(subgroup.key, subgroup.nombre) ? '' : subgroup.nombre,
          weight: formatWeight(subgroup.weight),
          type: '',
          badges: subgroupBadges(subgroup),
          depth: 1,
        },
        subgroupTop,
        subgroupHeight,
      );
      const subgroupNode = nodes[nodes.length - 1];
      connect(criterionNode, criterionCentre, subgroupCentre, `c${criterionIndex}>${subgroupIndex}`);

      subgroup.leaves.forEach((leaf, leafIndex) => {
        const leafCentre = box(
          {
            id: `c${criterionIndex}s${subgroupIndex}l${leafIndex}`,
            kind: 'leaf',
            label: leaf.code,
            detail: leaf.column,
            weight: formatWeight(leaf.weight),
            type: LEAF_TYPE_LABELS[leaf.type],
            badges: leafBadges(leaf),
            depth: 2,
          },
          subgroupTop + leafIndex * SLOT,
          SLOT,
        );
        connect(
          subgroupNode,
          subgroupCentre,
          leafCentre,
          `c${criterionIndex}s${subgroupIndex}>${leafIndex}`,
        );
      });

      subCursor += subgroupHeight;
    });

    cursor += criterionHeight;
  });

  const rootY = criterionCentres.length
    ? (criterionCentres[0] + criterionCentres[criterionCentres.length - 1]) / 2
    : 60;

  criterionCentres.forEach((centre, index) => {
    edges.push({
      id: `root>${index}`,
      d: curve(ROOT_WIDTH + 4, rootY, FIRST_COLUMN_X, centre),
      kind: 'root',
    });
  });

  return {
    nodes,
    edges,
    rootTop: rootY - 32,
    height: Math.max(320, totalLeaves(criteria) * SLOT + 40),
    width: CANVAS_WIDTH,
  };
}

export const DIAGRAM_CANVAS_WIDTH = CANVAS_WIDTH;
export const DIAGRAM_ROOT_WIDTH = ROOT_WIDTH;
