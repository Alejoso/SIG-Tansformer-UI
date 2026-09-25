/**
 * Mock implementations of the backend surface.
 *
 * State lives in module-level variables, so it survives navigation within a
 * session and resets on reload. Every function returns a promise with a small
 * delay, so the UI exercises its loading paths the same way it will against
 * a real server.
 */

import type {
  ApplyProgress,
  LayerTree,
  Mesh,
  ModelConfig,
  ModelExample,
  ProcessingProgress,
  ProjectSettings,
  ValueScale,
} from '../../types';
import {
  DEFAULT_MODEL,
  DEFAULT_SETTINGS,
  EXAMPLES,
  LAYER_TREE,
} from './fixtures';

const delay = <T>(value: T, ms = 180): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The dropzone caps at ten folders — one per variable. */
export const MAX_FOLDERS = 10;

/**
 * Meshes, projects and data folders now come from the backend; what is left
 * here is only the parts the engine has not been wired up for yet.
 */

export async function uploadMesh(file: File): Promise<Mesh> {
  // Mesh upload has no server route yet, so this still only pretends.
  const label = file.name.replace(/\.geojson$/i, '');
  return delay({ id: file.name, label, continent: '', iso: '', search: label }, 500);
}

/* ── processing ────────────────────────────────────────────────────────── */

const PROCESS_STEPS: [number, string][] = [
  [0, 'Reading your mesh'],
  [22, 'Turning locations into H3 hexagons'],
  [52, 'Attaching data values to each hexagon'],
  [78, 'Building color scales'],
];

const processingTimers = new Map<string, ReturnType<typeof setInterval>>();

export async function startProcessing(projectId: string): Promise<void> {
  await delay(null, 60);
  void projectId;
}

/**
 * Stop a run in progress.
 *
 * The real one signals the engine to stop — the equivalent of Ctrl-C on the
 * pipeline process — and that part is not built yet. Here it only stops the
 * progress ticks, which is enough for the UI to be exercised.
 */
export async function abortProcessing(projectId: string): Promise<void> {
  const timer = processingTimers.get(projectId);
  if (timer) {
    clearInterval(timer);
    processingTimers.delete(projectId);
  }
  await delay(null, 120);
}

/**
 * Stands in for the SSE stream. Ticks every 55 ms to 100%, marks every folder
 * ready, then reports `done` — the same sequence `watchfiles` will produce.
 */
export function watchProcessing(
  projectId: string,
  onProgress: (p: ProcessingProgress) => void,
): () => void {
  let progress = 0;
  let statusText = PROCESS_STEPS[0][1];

  const timer = setInterval(() => {
    progress = Math.min(100, progress + 2);
    for (const [at, label] of PROCESS_STEPS) {
      if (progress >= at) statusText = label;
    }

    if (progress >= 100) {
      clearInterval(timer);
      processingTimers.delete(projectId);
      onProgress({ phase: 'done', progress: 100, statusText: 'Finishing up', hexagonCount: 4812 });
      return;
    }

    onProgress({ phase: 'processing', progress, statusText });
  }, 55);

  processingTimers.set(projectId, timer);
  return () => {
    clearInterval(timer);
    processingTimers.delete(projectId);
  };
}

/* ── the layer tree ────────────────────────────────────────────────────── */

/**
 * The structure of what the engine rendered.
 *
 * Returned whole: the tree is small (labels and ids, no data), and the sidebar
 * needs all of it to draw. Only the documents behind it are large.
 */
export async function getLayerTree(projectId: string): Promise<LayerTree> {
  void projectId;
  return delay(clone(LAYER_TREE), 140);
}

/**
 * The one sample layer the engine has produced so far.
 *
 * Served by the dev middleware in `vite.config.ts` from the repo's `HTML/`
 * folder. Every variable resolves to this same file for now; once the engine
 * emits one per variable, only this function changes.
 */
const SAMPLE_LAYER = 'soe_001_SOE-001_h3.html';

export async function getLayerUrl(
  projectId: string,
  nodeId: string,
  scale: ValueScale,
): Promise<string> {
  void projectId;
  void nodeId;
  void scale;
  return delay(`/layers/${SAMPLE_LAYER}`, 80);
}

/* ── model ─────────────────────────────────────────────────────────────── */

const modelByProject = new Map<string, ModelConfig>();
const settingsByProject = new Map<string, ProjectSettings>();

export async function getModel(projectId: string): Promise<ModelConfig> {
  if (!modelByProject.has(projectId)) {
    modelByProject.set(projectId, clone(DEFAULT_MODEL));
  }
  return delay(clone(modelByProject.get(projectId)!));
}

export async function saveModel(projectId: string, model: ModelConfig): Promise<void> {
  modelByProject.set(projectId, clone(model));
  await delay(null, 220);
}

export async function applyModel(projectId: string, model: ModelConfig): Promise<void> {
  modelByProject.set(projectId, clone(model));
  await delay(null, 120);
}

/** Every variable in the tree, parents before children — the order the engine works in. */
function flattenKeys(variables: ModelConfig['variables'], into: string[] = []): string[] {
  for (const variable of variables) {
    into.push(variable.key);
    if (variable.sub?.length) flattenKeys(variable.sub, into);
  }
  return into;
}

/** How long the mock spends "processing" each variable. */
const APPLY_STEP_MS = 420;

/**
 * Stands in for the apply stream. Walks the variable tree one key at a time so
 * the dialog can name what is being processed, then reports `done`.
 */
export function watchModelApply(
  projectId: string,
  model: ModelConfig,
  onProgress: (p: ApplyProgress) => void,
): () => void {
  const keys = flattenKeys(model.variables);
  const total = keys.length;
  let index = 0;
  let cancelled = false;

  if (total === 0) {
    // Nothing to process; report done on the next tick so callers can still
    // unsubscribe from a real handle.
    const idle = setTimeout(
      () => onProgress({ phase: 'done', variable: '', index: 0, total: 0 }),
      APPLY_STEP_MS,
    );
    return () => clearTimeout(idle);
  }

  const timer = setInterval(() => {
    if (cancelled) return;

    if (index >= total) {
      clearInterval(timer);
      onProgress({ phase: 'done', variable: keys[total - 1], index: total, total });
      return;
    }

    index += 1;
    onProgress({ phase: 'running', variable: keys[index - 1], index, total });
  }, APPLY_STEP_MS);

  void projectId;
  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}

export async function validateModel(
  model: ModelConfig,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  const walk = (list: ModelConfig['variables'], trail: string) => {
    for (const v of list) {
      const weight = Number.parseFloat(v.weight);
      if (Number.isNaN(weight) || weight < 0 || weight > 1) {
        errors.push(`${trail}${v.key}: weight must be between 0 and 1`);
      }
      if (v.sub?.length) walk(v.sub, `${trail}${v.key}.`);
    }
  };
  walk(model.variables, '');

  if (!/^\d+$/.test(model.resolution)) errors.push('resolution must be a whole number');

  return delay({ valid: errors.length === 0, errors }, 80);
}

export const listExamples = (): Promise<ModelExample[]> => delay(clone(EXAMPLES));

/* ── settings ──────────────────────────────────────────────────────────── */

export async function getSettings(projectId: string): Promise<ProjectSettings> {
  if (!settingsByProject.has(projectId)) {
    settingsByProject.set(projectId, clone(DEFAULT_SETTINGS));
  }
  return delay(clone(settingsByProject.get(projectId)!));
}

export async function saveSettings(projectId: string, settings: ProjectSettings): Promise<void> {
  settingsByProject.set(projectId, clone(settings));
  // The resolutions now tell the engine what to render, rather than changing
  // anything the UI draws itself, so there is no client-side cache to clear.
  await delay(null, 120);
}
