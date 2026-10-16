/**
 * The backend surface.
 *
 * Every call the UI makes to the server goes through this module — nothing
 * else imports `client.ts`, and no component fetches on its own. Today each
 * function forwards to the mock adapter in `./mock`; wiring the real FastAPI
 * server means replacing the bodies with `request(...)` calls and deleting
 * nothing else.
 *
 * The `ENDPOINT` comment on each function is the route it is expected to hit.
 */

import { API_BASE, request } from './client';
import * as mock from './mock';
import type {
  ApplyProgress,
  DataFolder,
  LayerTree,
  Mesh,
  ModelConfig,
  ModelExample,
  ModelFile,
  NewProjectPayload,
  ProcessingProgress,
  PathInspection,
  PickedFolder,
  Project,
  ProjectSettings,
  ValueScale,
} from '../types';

/* ── projects ──────────────────────────────────────────────────────────── */

/* LIVE: served by the FastAPI backend, stored in data/projects.csv. */

export const listProjects = (): Promise<Project[]> => request('/projects');

export const getProject = (id: string): Promise<Project> => request(`/projects/${id}`);

export const createProject = (payload: NewProjectPayload): Promise<Project> =>
  request('/projects', { method: 'POST', body: JSON.stringify(payload) });

/**
 * Forget a project. Removes its rows from the CSVs and nothing else — the
 * folders it pointed at are the user's data and are left where they are.
 */
export const deleteProject = (id: string): Promise<void> =>
  request(`/projects/${id}`, { method: 'DELETE' });

/* ── meshes ────────────────────────────────────────────────────────────── */

/** LIVE: GET /api/meshes — still a fixed list server-side. */
export const listMeshes = (): Promise<Mesh[]> => request('/meshes');

/** ENDPOINT: POST /api/meshes (multipart) — upload a new mesh GeoJSON. */
export const uploadMesh = (file: File): Promise<Mesh> => mock.uploadMesh(file);

/**
 * LIVE: POST /api/fs/pick-folder
 *
 * Opens a folder chooser on the machine running the backend — a Linux dialog
 * if one is installed, otherwise the Windows one under WSL.
 *
 * This request blocks for as long as the dialog is open, so call it from a
 * control that can show it is waiting. When nothing can be opened the result
 * says so rather than failing silently, and pasting a path still works.
 */
export const pickFolder = (startAt?: string): Promise<PickedFolder> =>
  request('/fs/pick-folder', {
    method: 'POST',
    body: JSON.stringify({ startAt: startAt?.trim() || null }),
  });

/**
 * LIVE: POST /api/fs/inspect
 *
 * Checks a typed path before it is committed. The browser deliberately cannot
 * read an absolute path out of a file picker, so every path is text the user
 * typed — this is what stands between a typo and a confusing empty folder.
 */
export const inspectPath = (path: string): Promise<PathInspection> =>
  request('/fs/inspect', { method: 'POST', body: JSON.stringify({ path }) });

/* ── data folders ──────────────────────────────────────────────────────── */

/* LIVE: stored in data/folders.csv, existence re-checked on every read. */

export const listFolders = (projectId: string): Promise<DataFolder[]> =>
  request(`/projects/${projectId}/folders`);

/** Absolute paths. The server validates each one and rejects the batch if any fails. */
export const addFolders = (projectId: string, paths: string[]): Promise<DataFolder[]> =>
  request(`/projects/${projectId}/folders`, { method: 'POST', body: JSON.stringify({ paths }) });

export const removeFolder = (projectId: string, folderId: string): Promise<void> =>
  request(`/projects/${projectId}/folders/${folderId}`, { method: 'DELETE' });

/** Point a folder at a new location, for when the one on record has moved. */
export const relocateFolder = (
  projectId: string,
  folderId: string,
  path: string,
): Promise<DataFolder> =>
  request(`/projects/${projectId}/folders/${folderId}/path`, {
    method: 'PUT',
    body: JSON.stringify({ path }),
  });

/* ── processing ────────────────────────────────────────────────────────── */

/** ENDPOINT: POST /api/projects/{id}/process — kicks off the engine run. */
export const startProcessing = (projectId: string): Promise<void> =>
  mock.startProcessing(projectId);

/**
 * ENDPOINT: POST /api/projects/{id}/process/abort
 *
 * Stops a run that is already going. The backend is expected to signal the
 * engine process — the equivalent of Ctrl-C — and that part is NOT built yet:
 * today this only stops the progress stream. Whatever the engine had already
 * written to the results folder stays there, so a partial run leaves partial
 * output behind.
 */
export const abortProcessing = (projectId: string): Promise<void> =>
  mock.abortProcessing(projectId);

/**
 * ENDPOINT: GET /api/projects/{id}/process/stream (SSE)
 *
 * Progress ticks driven by `watchfiles` watching the results folder.
 * Returns an unsubscribe function.
 */
export const watchProcessing = (
  projectId: string,
  onProgress: (p: ProcessingProgress) => void,
): (() => void) => mock.watchProcessing(projectId, onProgress);

/* ── map layers ────────────────────────────────────────────────────────── */

/**
 * ENDPOINT: GET /api/projects/{id}/layers
 *
 * The structure of what the engine rendered: the whole-model document, and
 * the variables nested wherever one is composed of others.
 *
 * LIVE: discovered from the project's folder, which is the pipeline's
 * DATA_DIR. Variables come back flat because the pipeline writes them as a
 * mirror of the input tree; the model nests by criterion and is empty until
 * a model run exists.
 */
export const getLayerTree = (projectId: string): Promise<LayerTree> =>
  request(`/projects/${projectId}/layers`);

/**
 * LIVE: the URL of one layer's rendered document.
 *
 * A URL rather than the markup: these are megabytes of pydeck document, and
 * the browser streams and caches them natively in an iframe. Routing them
 * through React state would not.
 *
 * `scale` is accepted but not yet used — the raw and normalised combined
 * tables come from a newer pipeline run than any on disk, and each variable
 * currently renders one document.
 */
export const getLayerUrl = (
  projectId: string,
  nodeId: string,
  scale: ValueScale,
): Promise<string> => {
  void scale;
  return Promise.resolve(`${API_BASE}/projects/${projectId}/layers/${nodeId}/document`);
};

/* ── model ─────────────────────────────────────────────────────────────── */

/**
 * LIVE: GET /api/projects/{id}/model
 *
 * The model file, created from the default if it does not exist yet. The text
 * arrives exactly as stored — the editor is a text editor, so nothing is
 * reformatted on the way through.
 */
export const getModel = (projectId: string): Promise<ModelFile> =>
  request(`/projects/${projectId}/model`);

/**
 * LIVE: PUT /api/projects/{id}/model
 *
 * Writes the file and returns what is wrong with it. Saving does not require
 * the document to be valid — refusing to store work in progress would mean
 * losing it.
 */
export const saveModel = (projectId: string, text: string): Promise<ModelFile> =>
  request(`/projects/${projectId}/model`, { method: 'PUT', body: JSON.stringify({ text }) });

/**
 * ENDPOINT: POST /api/projects/{id}/model/apply
 *
 * LIVE for the write; the run is not built yet.
 *
 * Today this saves the file. Re-running the weighting from it is the next
 * step — `watchModelApply` still simulates that part.
 */
export const applyModel = (projectId: string, text: string): Promise<ModelFile> =>
  request(`/projects/${projectId}/model/apply`, { method: 'POST', body: JSON.stringify({ text }) });

/**
 * ENDPOINT: GET /api/projects/{id}/model/apply/stream (SSE)
 *
 * Per-variable progress while the model is applied, so the UI can name what is
 * being processed instead of showing an opaque spinner. Returns an
 * unsubscribe function.
 *
 * The `model` argument is only there for the mock, which has no server to ask
 * which variables are in flight; the real call takes the project alone.
 */
export const watchModelApply = (
  projectId: string,
  model: ModelConfig,
  onProgress: (p: ApplyProgress) => void,
): (() => void) => mock.watchModelApply(projectId, model, onProgress);

/** ENDPOINT: GET /api/model/examples — the starter structures in the dialog. */
export const listExamples = (): Promise<ModelExample[]> => mock.listExamples();

/* ── settings ──────────────────────────────────────────────────────────── */

/** ENDPOINT: GET /api/projects/{id}/settings */
export const getSettings = (projectId: string): Promise<ProjectSettings> =>
  mock.getSettings(projectId);

/** ENDPOINT: PUT /api/projects/{id}/settings */
export const saveSettings = (projectId: string, settings: ProjectSettings): Promise<void> =>
  mock.saveSettings(projectId, settings);
