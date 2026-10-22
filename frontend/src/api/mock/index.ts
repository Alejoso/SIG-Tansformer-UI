/**
 * Mock implementations of the backend surface.
 *
 * State lives in module-level variables, so it survives navigation within a
 * session and resets on reload. Every function returns a promise with a small
 * delay, so the UI exercises its loading paths the same way it will against
 * a real server.
 */

import type {
  Mesh,
  ModelExample,
} from '../../types';
import { EXAMPLES } from './fixtures';

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

export const listExamples = (): Promise<ModelExample[]> => delay(clone(EXAMPLES));
