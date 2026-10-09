/**
 * Operations on the weighting tree.
 *
 * The YAML editor and the node diagram are two views of this one structure,
 * so every edit from either side goes through `setField` / `bumpWeight` here
 * and both views re-render from the result.
 */

import type { Interval, ModelConfig, ModelPath, ModelVariable, Normalization } from '../types';

export const NORMALIZATIONS: Normalization[] = ['minmax', 'standard', 'intervals'];

/** What each transform is called in the interface. */
export const NORMALIZATION_LABELS: Record<Normalization, string> = {
  minmax: 'Min-max',
  standard: 'Standard scaler',
  intervals: 'Intervals',
};

/**
 * How many rows a new interval transform starts with.
 *
 * Five, with numbers already in them, because the engine's own bins score 1-5
 * and an empty table would read as broken rather than as waiting for input.
 * The bounds are placeholders to edit, not a recommendation.
 */
export const DEFAULT_INTERVAL_COUNT = 5;

/**
 * A starting set of intervals: unbounded at both ends so every value is
 * covered, and ascending so the shape of the transform is obvious at a glance.
 */
export function defaultIntervals(): Interval[] {
  return [
    { from: '', to: '20', value: '1' },
    { from: '20', to: '40', value: '2' },
    { from: '40', to: '60', value: '3' },
    { from: '60', to: '80', value: '4' },
    { from: '80', to: '', value: '5' },
  ];
}

/** The intervals of a variable, or an empty list if it has none. */
export const intervalsOf = (variable: ModelVariable): Interval[] => variable.intervals ?? [];

/** Walk to the node at `path`; the root stands in as a virtual parent. */
export function nodeAt(variables: ModelVariable[], path: ModelPath): ModelVariable {
  let current: ModelVariable = { key: '', weight: '0', exclusion_variable: false, normalization: 'minmax', sub: variables };
  for (const index of path) {
    const children = current.sub;
    if (!children?.[index]) throw new Error(`No model node at path ${path.join('.')}`);
    current = children[index];
  }
  return current;
}

/** A bound is valid when it is blank (unbounded) or a number. */
const boundOk = (bound: string) => bound.trim() === '' || Number.isFinite(Number(bound));

/**
 * What is wrong with one interval, or null when it is fine. Returned as a
 * message so the editor can say why rather than only going red.
 *
 * `rowCount` is needed for one rule: a range open at both ends covers every
 * value, which is fine on its own but silently swallows every other range
 * beside it. That is the failure worth catching, and it is cheap — full
 * gap-and-overlap analysis across the table is not attempted here.
 */
export function intervalError(interval: Interval, rowCount = 1): string | null {
  if (!boundOk(interval.from)) return 'Lower bound must be a number, or blank for unbounded';
  if (!boundOk(interval.to)) return 'Upper bound must be a number, or blank for unbounded';
  if (!Number.isFinite(Number(interval.value)) || interval.value.trim() === '') {
    return 'Result must be a number';
  }

  const from = interval.from.trim();
  const to = interval.to.trim();
  if (from !== '' && to !== '' && Number(from) >= Number(to)) {
    return 'Lower bound must be below the upper bound';
  }
  if (rowCount > 1 && from === '' && to === '') {
    return 'Open at both ends, so it would cover every other range — set a bound';
  }
  return null;
}

/** True when every interval on the variable is well-formed. */
export function intervalsValid(variable: ModelVariable): boolean {
  if (variable.normalization !== 'intervals') return true;
  const intervals = intervalsOf(variable);
  return intervals.length > 0 && intervals.every((i) => intervalError(i, intervals.length) === null);
}

/**
 * Top-level weights only — the figure the "weights add to" chip shows.
 *
 * Exclusion variable variables are left out: they rule a record out rather than
 * contributing a share of the score, so counting them would make the total
 * look wrong whenever one exists.
 */
export function weightSum(model: ModelConfig): number {
  return model.variables
    .filter((v) => !v.exclusion_variable)
    .reduce((total, v) => total + (Number.parseFloat(v.weight) || 0), 0);
}

/**
 * A weight of zero means the variable does not influence the score at all —
 * it is carried along to be looked at on the map, not to be counted. The UI
 * calls these *informative* and tints them differently, so a zero weight
 * reads as a deliberate choice rather than an unfinished edit.
 */
export function isInformative(variable: ModelVariable): boolean {
  // An exclusion variable has no weight at all, so "weight of zero" says
  // nothing about it.
  if (variable.exclusion_variable) return false;
  return Number.parseFloat(variable.weight) === 0;
}

/** How many leaves sit under a node — drives the diagram's vertical spacing. */
export function leafCount(variable: ModelVariable): number {
  if (!variable.sub?.length) return 1;
  return variable.sub.reduce((total, child) => total + leafCount(child), 0);
}

export function totalLeaves(variables: ModelVariable[]): number {
  return variables.reduce((total, v) => total + leafCount(v), 0);
}

/**
 * Local validity check, mirroring what the backend's Pydantic models will
 * enforce. Kept client-side so the Apply button can react as you type.
 */
export function isValid(model: ModelConfig): boolean {
  const ok = (list: ModelVariable[]): boolean =>
    list.every((v) => {
      // An exclusion variable has neither a weight nor a transform, so there
      // is nothing on it to be invalid.
      if (!v.exclusion_variable) {
        const weight = Number.parseFloat(v.weight);
        if (Number.isNaN(weight) || weight < 0 || weight > 1) return false;
        if (!intervalsValid(v)) return false;
      }
      return v.sub?.length ? ok(v.sub) : true;
    });
  return ok(model.variables) && /^\d+$/.test(model.resolution);
}

/**
 * Why the model is not valid, or null when it is.
 *
 * Distinguishes weights from intervals because the status chip used to say
 * "check the flagged weights" for a bad interval, sending people to look at
 * the wrong thing.
 */
export function invalidReason(model: ModelConfig): 'weights' | 'intervals' | 'resolution' | null {
  let badWeight = false;
  let badInterval = false;

  const walk = (list: ModelVariable[]) => {
    for (const v of list) {
      if (!v.exclusion_variable) {
        const weight = Number.parseFloat(v.weight);
        if (Number.isNaN(weight) || weight < 0 || weight > 1) badWeight = true;
        if (!intervalsValid(v)) badInterval = true;
      }
      if (v.sub?.length) walk(v.sub);
    }
  };
  walk(model.variables);

  if (badWeight) return 'weights';
  if (badInterval) return 'intervals';
  if (!/^\d+$/.test(model.resolution)) return 'resolution';
  return null;
}


/* ── reading a model out of YAML ───────────────────────────────────────── */

const asString = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

/** One `variables:` entry, or null when it is not shaped like one. */
function toVariable(key: string, body: unknown): ModelVariable | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  const intervals = Array.isArray(record.intervals)
    ? record.intervals
        .filter((row): row is unknown[] => Array.isArray(row) && row.length === 3)
        .map((row) => ({
          from: asString(row[0] ?? ''),
          to: asString(row[1] ?? ''),
          value: asString(row[2]),
        }))
    : undefined;

  const children =
    typeof record.subvariables === 'object' && record.subvariables !== null
      ? Object.entries(record.subvariables as Record<string, unknown>)
          .map(([childKey, childBody]) => toVariable(childKey, childBody))
          .filter((child): child is ModelVariable => child !== null)
      : undefined;

  const normalization = asString(record.normalization);
  return {
    key,
    weight: asString(record.weight ?? '0'),
    exclusion_variable: Boolean(record.exclusion_variable),
    normalization: (NORMALIZATIONS as string[]).includes(normalization)
      ? (normalization as ModelVariable['normalization'])
      : 'minmax',
    ...(intervals?.length ? { intervals } : {}),
    ...(children?.length ? { sub: children } : {}),
  };
}

/**
 * Build the diagram's view of a model from parsed YAML.
 *
 * Returns null when the document is not shaped like a model at all, so the
 * diagram can say it cannot draw this rather than drawing something wrong.
 * Anything it does not recognise inside a variable is ignored rather than
 * rejected — the file is the user's, and the diagram is only one reading of it.
 */
export function modelFromParsed(document: unknown): ModelConfig | null {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return null;
  const record = document as Record<string, unknown>;

  const rawVariables = record.variables;
  if (typeof rawVariables !== 'object' || rawVariables === null || Array.isArray(rawVariables)) {
    return null;
  }

  const variables = Object.entries(rawVariables as Record<string, unknown>)
    .map(([key, body]) => toVariable(key, body))
    .filter((variable): variable is ModelVariable => variable !== null);

  if (variables.length === 0) return null;

  return {
    project: asString(record.project),
    model: asString(record.model) || 'model',
    objective: asString(record.objective),
    resolution: asString(record.resolution ?? ''),
    variables,
  };
}
