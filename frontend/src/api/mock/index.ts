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
  Mesh,
  ModelConfig,
  ModelExample,
  ProjectSettings,
} from '../../types';
import { DEFAULT_SETTINGS, EXAMPLES } from './fixtures';

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

/* ── model ─────────────────────────────────────────────────────────────── */

const settingsByProject = new Map<string, ProjectSettings>();

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
