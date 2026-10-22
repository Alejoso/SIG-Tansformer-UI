/**
 * Reading the model file into something the diagram can draw.
 *
 * The file's schema is the engine's: `MCDA/engine/mcda_score.py` reads
 *
 *     criteria -> subgroups -> leaves
 *
 * and a leaf names a column of the master table with a `type` saying how its
 * values become a score from 1 to 5. Nothing here is a second opinion on that
 * shape — the file is the engine's input, and this only reads it.
 *
 * One rule throughout: what the text says is what comes back. A leaf with no
 * weight keeps a null one rather than the 1 the engine would assume, because
 * a diagram showing a number nobody wrote is worse than one showing a gap.
 */

import type {
  LeafType,
  ModelConfig,
  ModelCriterion,
  ModelLeaf,
  ModelSubgroup,
  Site,
} from '../types';

const LEAF_TYPES: LeafType[] = ['range', 'map', 'direct', 'minmax', 'zscore'];
const SITES: Site[] = ['both', 'onshore', 'offshore'];

/** What each scoring type is called in the interface. */
export const LEAF_TYPE_LABELS: Record<LeafType, string> = {
  range: 'Cuts',
  map: 'Categories',
  direct: 'Already 1-5',
  minmax: 'Min-max',
  zscore: 'Z-score',
};

/** The longer form, for a tooltip where there is room to explain. */
export const LEAF_TYPE_HINTS: Record<LeafType, string> = {
  range: 'Your own cuts: each band of values scores a number',
  map: 'An exact value maps to a score',
  direct: 'The value already is a score from 1 to 5',
  minmax: 'The range present in the data, stretched onto 1 to 5',
  zscore: 'Around the mean: a z of -2 to 2 becomes 1 to 5',
};

const asString = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

/** A number, or null when the file does not give one. Never a default. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** How many steps a leaf's transform has: cuts for `range`, keys for `map`. */
function stepsOf(record: Record<string, unknown>, type: LeafType): number {
  if (type === 'range') return Array.isArray(record.bins) ? record.bins.length : 0;
  if (type === 'map') return isRecord(record.map) ? Object.keys(record.map).length : 0;
  return 0;
}

function toLeaf(body: unknown, index: number): ModelLeaf | null {
  if (!isRecord(body)) return null;

  const rawType = asString(body.type);
  // An unrecognised type is drawn as what it is written as rather than
  // guessed at. The problems list below the editor says the engine will not
  // score it; the diagram does not need to say so twice.
  const type = (LEAF_TYPES as string[]).includes(rawType) ? (rawType as LeafType) : 'direct';

  const rawSite = asString(body.site) || 'both';
  const site = (SITES as string[]).includes(rawSite) ? (rawSite as Site) : 'both';

  return {
    code: asString(body.code) || asString(body.column) || `leaf ${index + 1}`,
    column: asString(body.column),
    site,
    type,
    weight: asNumber(body.weight),
    steps: stepsOf(body, type),
    inverted: asString(body.direction) === 'cost',
  };
}

function toSubgroup(body: unknown, index: number): ModelSubgroup | null {
  if (!isRecord(body)) return null;

  const leaves = Array.isArray(body.leaves)
    ? body.leaves
        .map((leaf, position) => toLeaf(leaf, position))
        .filter((leaf): leaf is ModelLeaf => leaf !== null)
    : [];

  return {
    key: asString(body.key) || `subgroup ${index + 1}`,
    nombre: asString(body.nombre),
    weight: asNumber(body.weight),
    worstWins: asString(body.combine) === 'min',
    absent: asNumber(body.absent),
    normalized: body.normalize !== undefined && body.normalize !== null,
    leaves,
  };
}

function toCriterion(body: unknown, index: number): ModelCriterion | null {
  if (!isRecord(body)) return null;

  const subgroups = Array.isArray(body.subgroups)
    ? body.subgroups
        .map((subgroup, position) => toSubgroup(subgroup, position))
        .filter((subgroup): subgroup is ModelSubgroup => subgroup !== null)
    : [];

  return {
    key: asString(body.key) || `criterion ${index + 1}`,
    nombre: asString(body.nombre),
    weight: asNumber(body.weight),
    subgroups,
  };
}

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/**
 * Build the diagram's view of the model from parsed YAML.
 *
 * Returns null when the document holds no criteria at all, so the pane can
 * say there is nothing to draw rather than drawing an empty frame. A document
 * with criteria is drawn however incomplete it is — half a model being typed
 * is exactly when seeing its shape helps.
 */
export function modelFromParsed(document: unknown): ModelConfig | null {
  if (!isRecord(document)) return null;
  if (!Array.isArray(document.criteria)) return null;

  const criteria = document.criteria
    .map((criterion, index) => toCriterion(criterion, index))
    .filter((criterion): criterion is ModelCriterion => criterion !== null);

  if (criteria.length === 0) return null;

  return {
    criteria,
    excludedColumns: countOf(document.exclude_columns),
    excludedThresholds: countOf(document.exclude_thresholds),
    prioritized: countOf(document.prioritized),
  };
}


/* ── reading the tree ──────────────────────────────────────────────────── */

/** How many leaves a criterion holds — drives the diagram's spacing. */
export function leafCount(criterion: ModelCriterion): number {
  const total = criterion.subgroups.reduce(
    (sum, subgroup) => sum + Math.max(1, subgroup.leaves.length),
    0,
  );
  return Math.max(1, total);
}

export function totalLeaves(criteria: ModelCriterion[]): number {
  return criteria.reduce((total, criterion) => total + leafCount(criterion), 0);
}

/**
 * What the criteria's weights add to — the figure the caption shows.
 *
 * The engine divides by this total, so the model still runs when it is not 1;
 * the numbers just stop reading as shares of the whole. A criterion with no
 * weight counts as nothing, which is what the engine does with it.
 */
export function weightSum(model: ModelConfig): number {
  return model.criteria.reduce((total, criterion) => total + (criterion.weight ?? 0), 0);
}

/** Every column the model scores, in order, without repeats. */
export function scoredColumns(model: ModelConfig): string[] {
  const seen = new Set<string>();
  for (const criterion of model.criteria) {
    for (const subgroup of criterion.subgroups) {
      for (const leaf of subgroup.leaves) {
        if (leaf.column) seen.add(leaf.column);
      }
    }
  }
  return [...seen];
}
