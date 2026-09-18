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

import * as mock from './mock';
import type {
  ApplyProgress,
  DataFolder,
  MapMode,
  Mesh,
  ModelConfig,
  ModelExample,
  NewProjectPayload,
  ProcessingProgress,
  Project,
  ProjectSettings,
  ValueScale,
  Variable,
} from '../types';

/* ── projects ──────────────────────────────────────────────────────────── */

/** ENDPOINT: GET /api/projects */
export const listProjects = (): Promise<Project[]> => mock.listProjects();

/** ENDPOINT: GET /api/projects/{id} */
export const getProject = (id: string): Promise<Project> => mock.getProject(id);

/** ENDPOINT: POST /api/projects */
export const createProject = (payload: NewProjectPayload): Promise<Project> =>
  mock.createProject(payload);

/** ENDPOINT: DELETE /api/projects/{id} */
export const deleteProject = (id: string): Promise<void> => mock.deleteProject(id);

/* ── meshes ────────────────────────────────────────────────────────────── */

/** ENDPOINT: GET /api/meshes — the GeoJSON meshes already on disk. */
export const listMeshes = (): Promise<Mesh[]> => mock.listMeshes();

/** ENDPOINT: POST /api/meshes (multipart) — upload a new mesh GeoJSON. */
export const uploadMesh = (file: File): Promise<Mesh> => mock.uploadMesh(file);

/**
 * ENDPOINT: POST /api/fs/pick-folder
 *
 * Opens a native directory picker on the machine running the backend. The
 * browser cannot do this on its own, so it has to be a server call — the UI
 * is local-only by design.
 */
export const pickFolder = (): Promise<string | null> => mock.pickFolder();

/* ── data folders ──────────────────────────────────────────────────────── */

/** ENDPOINT: GET /api/projects/{id}/folders */
export const listFolders = (projectId: string): Promise<DataFolder[]> =>
  mock.listFolders(projectId);

/**
 * ENDPOINT: POST /api/projects/{id}/folders
 *
 * Registers folders dropped onto the dropzone. The browser only hands us
 * relative paths, so the backend resolves them against the project root and
 * reports back the real file counts and sizes.
 */
export const addFolders = (projectId: string, paths: string[]): Promise<DataFolder[]> =>
  mock.addFolders(projectId, paths);

/** ENDPOINT: DELETE /api/projects/{id}/folders/{folderId} */
export const removeFolder = (projectId: string, folderId: string): Promise<void> =>
  mock.removeFolder(projectId, folderId);

/* ── processing ────────────────────────────────────────────────────────── */

/** ENDPOINT: POST /api/projects/{id}/process — kicks off the engine run. */
export const startProcessing = (projectId: string): Promise<void> =>
  mock.startProcessing(projectId);

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

/* ── map data ──────────────────────────────────────────────────────────── */

/**
 * ENDPOINT: GET /api/projects/{id}/variables?mode=raw|model
 *
 * `raw` lists the uploaded variables as-is; `model` lists the outputs the
 * weighting produced.
 */
export const listVariables = (projectId: string, mode: MapMode): Promise<Variable[]> =>
  mock.listVariables(projectId, mode);

/**
 * ENDPOINT: GET /api/projects/{id}/layers/{variableId}?scale=raw|normalized
 *
 * Returns the URL of the engine's pre-rendered layer HTML, which the map
 * screen drops into an iframe.
 *
 * The engine renders these itself, so the UI never receives per-hexagon
 * values and never paints the map. That is the whole point: a full mesh as
 * JSON would be tens of megabytes to serialise, transfer and re-draw, where
 * the generated document is already a finished map the browser can stream.
 *
 * Returning a URL rather than the markup matters — the browser fetches and
 * caches the document natively instead of routing 8 MB of HTML through
 * React state.
 */
export const getLayerUrl = (
  projectId: string,
  variableId: string,
  scale: ValueScale,
): Promise<string> => mock.getLayerUrl(projectId, variableId, scale);

/* ── model ─────────────────────────────────────────────────────────────── */

/**
 * ENDPOINT: GET /api/projects/{id}/model
 *
 * Reads the YAML with ruamel.yaml, so comments and key order survive a
 * round-trip through the editor.
 */
export const getModel = (projectId: string): Promise<ModelConfig> => mock.getModel(projectId);

/** ENDPOINT: PUT /api/projects/{id}/model — validates with Pydantic, then writes. */
export const saveModel = (projectId: string, model: ModelConfig): Promise<void> =>
  mock.saveModel(projectId, model);

/**
 * ENDPOINT: POST /api/projects/{id}/model/apply
 *
 * Saves, then re-runs the weighting so the model outputs on the map reflect
 * the new weights. Resolves once the run has been accepted, not once it has
 * finished — follow it with `watchModelApply` for progress.
 */
export const applyModel = (projectId: string, model: ModelConfig): Promise<void> =>
  mock.applyModel(projectId, model);

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

/**
 * ENDPOINT: POST /api/model/validate
 *
 * Server-side validation. The UI validates locally too, but the engine's
 * rules are the ones that decide, so this is what gates Apply once the
 * backend exists.
 */
export const validateModel = (model: ModelConfig): Promise<{ valid: boolean; errors: string[] }> =>
  mock.validateModel(model);

/** ENDPOINT: GET /api/model/examples — the starter structures in the dialog. */
export const listExamples = (): Promise<ModelExample[]> => mock.listExamples();

/* ── settings ──────────────────────────────────────────────────────────── */

/** ENDPOINT: GET /api/projects/{id}/settings */
export const getSettings = (projectId: string): Promise<ProjectSettings> =>
  mock.getSettings(projectId);

/** ENDPOINT: PUT /api/projects/{id}/settings */
export const saveSettings = (projectId: string, settings: ProjectSettings): Promise<void> =>
  mock.saveSettings(projectId, settings);
