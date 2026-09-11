/**
 * Mock implementations of the backend surface.
 *
 * State lives in module-level variables, so it survives navigation within a
 * session and resets on reload. Every function returns a promise with a small
 * delay, so the UI exercises its loading paths the same way it will against
 * a real server.
 */

import type {
  DataFolder,
  HexLayerData,
  MapMode,
  Mesh,
  ModelConfig,
  ModelExample,
  NewProjectPayload,
  ProcessingProgress,
  Project,
  ProjectSettings,
  Variable,
} from '../../types';
import { mockGrid, mockValues, originCell } from '../../lib/h3mock';
import {
  AVAILABLE_FOLDERS,
  DEFAULT_MODEL,
  DEFAULT_SETTINGS,
  EXAMPLES,
  MESHES,
  MESH_CENTRES,
  MODEL_VARIABLES,
  PROJECTS,
  RAW_VARIABLES,
} from './fixtures';

const delay = <T>(value: T, ms = 180): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The dropzone caps at ten folders — one per variable. */
export const MAX_FOLDERS = 10;

/* ── in-memory store ───────────────────────────────────────────────────── */

let projects: Project[] = clone(PROJECTS);
const foldersByProject = new Map<string, DataFolder[]>();
const modelByProject = new Map<string, ModelConfig>();
const settingsByProject = new Map<string, ProjectSettings>();

/** Projects that arrive already processed start with their folders filled in. */
function seedFolders(project: Project): DataFolder[] {
  if (project.status === 'draft') {
    return clone(AVAILABLE_FOLDERS.slice(0, 3));
  }
  return clone(AVAILABLE_FOLDERS.slice(0, 6)).map((f) => ({ ...f, state: 'ready' as const }));
}

/* ── projects ──────────────────────────────────────────────────────────── */

export const listProjects = () => delay(clone(projects));

export async function getProject(id: string): Promise<Project> {
  const found = projects.find((p) => p.id === id);
  if (!found) throw new Error(`No project ${id}`);
  return delay(clone(found));
}

export async function createProject(payload: NewProjectPayload): Promise<Project> {
  const mesh = MESHES.find((m) => m.id === payload.meshId);
  const project: Project = {
    id: `p-${Date.now()}`,
    name: payload.name.trim() || 'Untitled project',
    meshId: payload.meshId,
    meshLabel: mesh?.label ?? payload.meshId,
    status: 'draft',
    description: payload.description,
    outFolder: payload.outFolder,
    variableCount: 0,
    hexagonCount: 0,
    updatedAt: 'just now',
  };
  projects = [project, ...projects];
  foldersByProject.set(project.id, []);
  return delay(clone(project));
}

export async function deleteProject(id: string): Promise<void> {
  projects = projects.filter((p) => p.id !== id);
  foldersByProject.delete(id);
  await delay(null);
}

/* ── meshes ────────────────────────────────────────────────────────────── */

export const listMeshes = (): Promise<Mesh[]> => delay(clone(MESHES));

export async function uploadMesh(file: File): Promise<Mesh> {
  const mesh: Mesh = { id: file.name, label: file.name.replace(/\.geojson$/i, '') };
  return delay(mesh, 500);
}

export async function pickFolder(): Promise<string | null> {
  // The real one opens a native dialog on the machine running the backend.
  return delay('/Projects/Ridgeline/results', 250);
}

/* ── data folders ──────────────────────────────────────────────────────── */

function foldersOf(projectId: string): DataFolder[] {
  if (!foldersByProject.has(projectId)) {
    const project = projects.find((p) => p.id === projectId);
    foldersByProject.set(projectId, project ? seedFolders(project) : []);
  }
  return foldersByProject.get(projectId)!;
}

export const listFolders = (projectId: string) => delay(clone(foldersOf(projectId)));

/**
 * The mock ignores the paths and pulls the next unused folders from the pool,
 * which is what lets the dropzone work without a file system behind it.
 */
export async function addFolders(projectId: string, paths: string[]): Promise<DataFolder[]> {
  const current = foldersOf(projectId);
  const taken = new Set(current.map((f) => f.id));
  let remaining = Math.max(1, paths.length);

  for (const candidate of AVAILABLE_FOLDERS) {
    if (remaining === 0 || current.length >= MAX_FOLDERS) break;
    if (taken.has(candidate.id)) continue;
    current.push(clone(candidate));
    taken.add(candidate.id);
    remaining -= 1;
  }

  foldersByProject.set(projectId, current);
  return delay(clone(current));
}

export async function removeFolder(projectId: string, folderId: string): Promise<void> {
  foldersByProject.set(
    projectId,
    foldersOf(projectId).filter((f) => f.id !== folderId),
  );
  await delay(null, 80);
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
      foldersByProject.set(
        projectId,
        foldersOf(projectId).map((f) => ({ ...f, state: 'ready' as const })),
      );
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

/* ── map data ──────────────────────────────────────────────────────────── */

const variablesFor = (mode: MapMode) => (mode === 'raw' ? RAW_VARIABLES : MODEL_VARIABLES);

export async function listVariables(projectId: string, mode: MapMode): Promise<Variable[]> {
  void projectId;
  // `seed` only drives the mock field; it is not part of the wire contract.
  return delay(variablesFor(mode).map(({ seed: _seed, ...variable }) => variable));
}

/** Cache the generated grid per project so switching variables stays instant. */
const gridCache = new Map<string, { cells: string[]; origin: string; resolution: number }>();

function gridFor(projectId: string) {
  const cached = gridCache.get(projectId);
  if (cached) return cached;

  const project = projects.find((p) => p.id === projectId);
  const centre = MESH_CENTRES[project?.meshId ?? ''] ?? [53.35, -8.0];
  const resolution = settingsByProject.get(projectId)?.h3Resolution ?? DEFAULT_SETTINGS.h3Resolution;
  const grid = {
    cells: mockGrid({ centre, resolution }),
    origin: originCell(centre, resolution),
    resolution,
  };
  gridCache.set(projectId, grid);
  return grid;
}

export async function getHexLayer(projectId: string, variableId: string): Promise<HexLayerData> {
  const definition =
    [...RAW_VARIABLES, ...MODEL_VARIABLES].find((v) => v.id === variableId) ?? RAW_VARIABLES[0];
  const { cells, origin, resolution } = gridFor(projectId);

  return delay(
    {
      variableId: definition.id,
      resolution,
      cells: mockValues(cells, origin, definition.seed, definition.min, definition.max),
    },
    120,
  );
}

/* ── model ─────────────────────────────────────────────────────────────── */

export async function getModel(projectId: string): Promise<ModelConfig> {
  if (!modelByProject.has(projectId)) {
    const project = projects.find((p) => p.id === projectId);
    modelByProject.set(projectId, {
      ...clone(DEFAULT_MODEL),
      project: (project?.name ?? 'project').toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    });
  }
  return delay(clone(modelByProject.get(projectId)!));
}

export async function saveModel(projectId: string, model: ModelConfig): Promise<void> {
  modelByProject.set(projectId, clone(model));
  await delay(null, 220);
}

export async function applyModel(projectId: string, model: ModelConfig): Promise<void> {
  modelByProject.set(projectId, clone(model));
  await delay(null, 320);
}

export async function validateModel(
  model: ModelConfig,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  const walk = (list: ModelConfig['variables'], trail: string) => {
    for (const v of list) {
      const weight = Number.parseFloat(v.peso);
      if (Number.isNaN(weight) || weight < 0 || weight > 1) {
        errors.push(`${trail}${v.key}: peso must be between 0 and 1`);
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
  gridCache.delete(projectId);
  await delay(null, 120);
}
