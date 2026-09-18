/**
 * Operations on the weighting tree.
 *
 * The YAML editor and the node diagram are two views of this one structure,
 * so every edit from either side goes through `setField` / `bumpWeight` here
 * and both views re-render from the result.
 */

import type { Interval, ModelConfig, ModelPath, ModelVariable, Normalisation } from '../types';

export const NORMALISATIONS: Normalisation[] = ['minmax', 'standard', 'intervals'];

/** What each transform is called in the interface. */
export const NORMALISATION_LABELS: Record<Normalisation, string> = {
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

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Walk to the node at `path`; the root stands in as a virtual parent. */
export function nodeAt(variables: ModelVariable[], path: ModelPath): ModelVariable {
  let current: ModelVariable = { key: '', peso: '0', excluyente: false, normalizacion: 'minmax', sub: variables };
  for (const index of path) {
    const children = current.sub;
    if (!children?.[index]) throw new Error(`No model node at path ${path.join('.')}`);
    current = children[index];
  }
  return current;
}

/** Return a new config with one field on one node changed. */
export function setField<K extends keyof ModelVariable>(
  model: ModelConfig,
  path: ModelPath,
  field: K,
  value: ModelVariable[K],
): ModelConfig {
  const next = clone(model);
  nodeAt(next.variables, path)[field] = value;
  return next;
}

/** Nudge a weight by `delta`, clamped to [0, 1] and kept at two decimals. */
export function bumpWeight(model: ModelConfig, path: ModelPath, delta: number): ModelConfig {
  const current = Number.parseFloat(nodeAt(model.variables, path).peso);
  const base = Number.isNaN(current) ? 0 : current;
  const next = Math.max(0, Math.min(1, base + delta)).toFixed(2);
  return setField(model, path, 'peso', next);
}

/**
 * Switch a variable's transform.
 *
 * Moving to `intervals` seeds a default table when there is none, so the
 * editor never shows an empty transform. Moving away keeps whatever table was
 * there — switching back should not lose work someone typed.
 */
export function setNormalisation(
  model: ModelConfig,
  path: ModelPath,
  normalizacion: Normalisation,
): ModelConfig {
  const next = clone(model);
  const node = nodeAt(next.variables, path);
  node.normalizacion = normalizacion;
  if (normalizacion === 'intervals' && !node.intervals?.length) {
    node.intervals = defaultIntervals();
  }
  return next;
}

/** Edit one field of one interval. */
export function setInterval(
  model: ModelConfig,
  path: ModelPath,
  index: number,
  field: keyof Interval,
  value: string,
): ModelConfig {
  const next = clone(model);
  const node = nodeAt(next.variables, path);
  const intervals = node.intervals ?? [];
  if (!intervals[index]) return model;
  intervals[index] = { ...intervals[index], [field]: value };
  node.intervals = intervals;
  return next;
}

/**
 * Add a row after `index`, or at the end when no index is given.
 *
 * The new row starts where the one above it ended and continues its numbering,
 * so the table stays contiguous and the user usually only types one bound.
 * Seeding the result matters: a row that arrives already flagged reads as
 * broken rather than as waiting for input.
 */
export function addInterval(model: ModelConfig, path: ModelPath, index?: number): ModelConfig {
  const next = clone(model);
  const node = nodeAt(next.variables, path);
  const intervals = node.intervals ?? [];
  const at = index === undefined ? intervals.length : index + 1;
  const previous = intervals[at - 1];

  const previousValue = Number(previous?.value);
  const value = Number.isFinite(previousValue) && previous?.value.trim() !== ''
    ? String(previousValue + 1)
    : '';

  intervals.splice(at, 0, { from: previous?.to ?? '', to: '', value });
  node.intervals = intervals;
  return next;
}

/** Remove one row. The last row cannot be removed — a transform needs one. */
export function removeInterval(model: ModelConfig, path: ModelPath, index: number): ModelConfig {
  const next = clone(model);
  const node = nodeAt(next.variables, path);
  const intervals = node.intervals ?? [];
  if (intervals.length <= 1) return model;
  intervals.splice(index, 1);
  node.intervals = intervals;
  return next;
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
  if (variable.normalizacion !== 'intervals') return true;
  const intervals = intervalsOf(variable);
  return intervals.length > 0 && intervals.every((i) => intervalError(i, intervals.length) === null);
}

/** Top-level weights only — the figure the "weights add to" chip shows. */
export function weightSum(model: ModelConfig): number {
  return model.variables.reduce((total, v) => total + (Number.parseFloat(v.peso) || 0), 0);
}

/**
 * A weight of zero means the variable does not influence the score at all —
 * it is carried along to be looked at on the map, not to be counted. The UI
 * calls these *informative* and tints them differently, so a zero weight
 * reads as a deliberate choice rather than an unfinished edit.
 */
export function isInformative(variable: ModelVariable): boolean {
  return Number.parseFloat(variable.peso) === 0;
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
      const weight = Number.parseFloat(v.peso);
      if (Number.isNaN(weight) || weight < 0 || weight > 1) return false;
      if (!intervalsValid(v)) return false;
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
      const weight = Number.parseFloat(v.peso);
      if (Number.isNaN(weight) || weight < 0 || weight > 1) badWeight = true;
      if (!intervalsValid(v)) badInterval = true;
      if (v.sub?.length) walk(v.sub);
    }
  };
  walk(model.variables);

  if (badWeight) return 'weights';
  if (badInterval) return 'intervals';
  if (!/^\d+$/.test(model.resolution)) return 'resolution';
  return null;
}

/** Every key already in use, so an inserted example can be de-duplicated. */
function usedKeys(variables: ModelVariable[], into = new Set<string>()): Set<string> {
  for (const v of variables) {
    into.add(v.key);
    if (v.sub?.length) usedKeys(v.sub, into);
  }
  return into;
}

/** Append an example's variables, suffixing any key that would collide. */
export function appendVariables(
  model: ModelConfig,
  incoming: ModelVariable[],
): ModelConfig {
  const taken = usedKeys(model.variables);
  const renamed = clone(incoming).map((v) => (taken.has(v.key) ? { ...v, key: `${v.key}_2` } : v));
  return { ...clone(model), variables: [...clone(model.variables), ...renamed] };
}

/* ── the editor's line model ───────────────────────────────────────────── */

/** What an editable line writes back to. */
export type LineTarget =
  | { kind: 'resolution' }
  | { kind: 'peso'; path: ModelPath }
  | { kind: 'excluyente'; path: ModelPath; current: boolean }
  | { kind: 'normalizacion'; path: ModelPath }
  | {
      kind: 'interval';
      path: ModelPath;
      index: number;
      interval: Interval;
      canRemove: boolean;
      rowCount: number;
    }
  | { kind: 'add-interval'; path: ModelPath };

export interface ModelLine {
  n: number;
  indent: number;
  key: string;
  /** `section` lines are a key with no value, e.g. `variables:`. */
  kind: 'section' | 'plain' | 'text' | 'bool' | 'enum' | 'interval' | 'add-interval';
  value?: string;
  /** Set on a variable's own line and its `peso`: the weight is zero. */
  informative?: boolean;
  target?: LineTarget;
}

/**
 * Flatten the config into the numbered lines the editor draws. Rendering from
 * a derived list — rather than parsing text — is what keeps the editor and
 * the diagram guaranteed to agree.
 */
export function toLines(model: ModelConfig): ModelLine[] {
  const lines: ModelLine[] = [];
  let n = 0;

  const push = (line: Omit<ModelLine, 'n'>) => {
    n += 1;
    lines.push({ ...line, n });
  };

  push({ indent: 0, key: 'project', kind: 'plain', value: model.project });
  push({ indent: 0, key: 'model', kind: 'plain', value: model.model });
  push({ indent: 0, key: 'objective', kind: 'plain', value: model.objective });
  push({ indent: 0, key: 'resolution', kind: 'text', value: model.resolution, target: { kind: 'resolution' } });
  push({ indent: 0, key: 'variables', kind: 'section' });

  const emit = (list: ModelVariable[], path: ModelPath, indent: number) => {
    list.forEach((variable, index) => {
      const here = [...path, index];
      push({ indent, key: variable.key, kind: 'section', informative: isInformative(variable) });
      push({
        indent: indent + 1,
        key: 'peso',
        kind: 'text',
        value: variable.peso,
        informative: isInformative(variable),
        target: { kind: 'peso', path: here },
      });
      push({
        indent: indent + 1,
        key: 'excluyente',
        kind: 'bool',
        value: variable.excluyente ? 'true' : 'false',
        target: { kind: 'excluyente', path: here, current: variable.excluyente },
      });
      push({
        indent: indent + 1,
        key: 'normalizacion',
        kind: 'enum',
        value: variable.normalizacion,
        target: { kind: 'normalizacion', path: here },
      });
      // The ranges belong to the variable, so they are drawn under it as
      // nested lines rather than hidden behind a dialog — this pane is the
      // config as text, and the ranges are part of the config.
      if (variable.normalizacion === 'intervals') {
        const intervals = intervalsOf(variable);
        push({ indent: indent + 1, key: 'intervalos', kind: 'section' });
        intervals.forEach((interval, index) => {
          push({
            indent: indent + 2,
            key: `${index + 1}`,
            kind: 'interval',
            target: {
              kind: 'interval',
              path: here,
              index,
              interval,
              canRemove: intervals.length > 1,
              rowCount: intervals.length,
            },
          });
        });
        push({
          indent: indent + 2,
          key: '',
          kind: 'add-interval',
          target: { kind: 'add-interval', path: here },
        });
      }

      if (variable.sub?.length) {
        push({ indent: indent + 1, key: 'subvariables', kind: 'section' });
        emit(variable.sub, here, indent + 2);
      }
    });
  };

  emit(model.variables, [], 1);
  return lines;
}

/**
 * Serialise the config as YAML text.
 *
 * Only used for copying out today. Once the backend owns the file, ruamel.yaml
 * writes it instead — this deliberately does not try to preserve comments,
 * because it cannot.
 */
export function toYaml(model: ModelConfig): string {
  const out: string[] = [
    `project: ${model.project}`,
    `model: ${model.model}`,
    `objective: ${model.objective}`,
    `resolution: ${model.resolution}`,
    'variables:',
  ];

  const emit = (list: ModelVariable[], pad: string) => {
    for (const v of list) {
      out.push(`${pad}${v.key}:`);
      out.push(`${pad}  peso: ${v.peso}`);
      out.push(`${pad}  excluyente: ${v.excluyente}`);
      out.push(`${pad}  normalizacion: ${v.normalizacion}`);
      if (v.normalizacion === 'intervals') {
        out.push(`${pad}  intervalos:`);
        for (const interval of intervalsOf(v)) {
          // `null` for an open end, which is how the engine writes its bins.
          const from = interval.from.trim() === '' ? 'null' : interval.from.trim();
          const to = interval.to.trim() === '' ? 'null' : interval.to.trim();
          out.push(`${pad}    - [${from}, ${to}, ${interval.value.trim() || 'null'}]`);
        }
      }
      if (v.sub?.length) {
        out.push(`${pad}  subvariables:`);
        emit(v.sub, `${pad}    `);
      }
    }
  };

  emit(model.variables, '  ');
  return out.join('\n');
}
