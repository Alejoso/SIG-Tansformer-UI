/**
 * Operations on the weighting tree.
 *
 * The YAML editor and the node diagram are two views of this one structure,
 * so every edit from either side goes through `setField` / `bumpWeight` here
 * and both views re-render from the result.
 */

import type { ModelConfig, ModelPath, ModelVariable, Normalisation } from '../types';

export const NORMALISATIONS: Normalisation[] = ['minmax', 'zscore', 'log', 'ninguna'];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Walk to the node at `path`; the root stands in as a virtual parent. */
export function nodeAt(variables: ModelVariable[], path: ModelPath): ModelVariable {
  let current: ModelVariable = { key: '', peso: '0', excluyente: false, normalizacion: 'ninguna', sub: variables };
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
      return v.sub?.length ? ok(v.sub) : true;
    });
  return ok(model.variables) && /^\d+$/.test(model.resolution);
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
  | { kind: 'normalizacion'; path: ModelPath };

export interface ModelLine {
  n: number;
  indent: number;
  key: string;
  /** `section` lines are a key with no value, e.g. `variables:`. */
  kind: 'section' | 'plain' | 'text' | 'bool' | 'enum';
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
      if (v.sub?.length) {
        out.push(`${pad}  subvariables:`);
        emit(v.sub, `${pad}    `);
      }
    }
  };

  emit(model.variables, '  ');
  return out.join('\n');
}
