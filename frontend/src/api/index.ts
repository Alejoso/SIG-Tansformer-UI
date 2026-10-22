/**
 * The backend surface.
 *
 * Every call the UI makes to the server goes through this module — nothing
 * else imports `client.ts`, and no component fetches on its own. Most of it
 * is live now: projects, folders, meshes, the layer tree, the model file and
 * processing all talk to FastAPI. What still forwards to the mock adapter in
 * `./mock` is marked MOCK, and the `ENDPOINT` comment on each function is the
 * route it hits — or is expected to, for the ones still pretending.
 */

import { API_BASE, request } from './client';
import * as mock from './mock';
import type {
  ImportPlan,
  InputVariable,
  Removal,
  LayerTree,
  Mesh,
  ModelExample,
  ModelFile,
  NewProjectPayload,
  PipelineReadiness,
  PipelineRun,
  PickedFolder,
  Project,
  ProjectSettings,
  Resolutions,
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

/* ── the data the engine will read ─────────────────────────────────────── */

/* LIVE: the engine's own input tree, read and written on disk. */

/**
 * ENDPOINT: GET /api/projects/{id}/inputs
 *
 * The variables the pipeline will process, read from its input tree rather
 * than from any record of ours — including anything put there by hand.
 */
export const listInputs = (projectId: string): Promise<InputVariable[]> =>
  request(`/projects/${projectId}/inputs`);

/** ENDPOINT: GET /api/projects/{id}/inputs/dimensions — the ones already in use. */
export const listDimensions = (projectId: string): Promise<string[]> =>
  request(`/projects/${projectId}/inputs/dimensions`);

/**
 * ENDPOINT: POST /api/projects/{id}/inputs/plan
 *
 * A dry run of adding a folder: which dataset was found, which companion
 * files travel with it, and where it would land. Nothing is written.
 */
export const planImport = (
  projectId: string,
  path: string,
  dimension: string,
): Promise<ImportPlan> =>
  request(`/projects/${projectId}/inputs/plan`, {
    method: 'POST',
    body: JSON.stringify({ path, dimension }),
  });

/**
 * ENDPOINT: POST /api/projects/{id}/inputs
 *
 * Copies the folder's dataset into the project as one variable. The server
 * does the copying; the browser never touches the files.
 */
export const addInput = (
  projectId: string,
  path: string,
  dimension: string,
  code: string,
): Promise<InputVariable> =>
  request(`/projects/${projectId}/inputs`, {
    method: 'POST',
    body: JSON.stringify({ path, dimension, code }),
  });

/**
 * ENDPOINT: DELETE /api/projects/{id}/inputs/{dimension}/{code}
 *
 * Removes the project's copy *and* what the pipeline made from it. Both,
 * because the engine rebuilds its database from `out/` — a variable whose
 * output survived would be loaded straight back on the next run. The folder
 * it was copied from is untouched.
 */
export const removeInput = (
  projectId: string,
  dimension: string,
  code: string,
): Promise<Removal> =>
  request(`/projects/${projectId}/inputs/${dimension}/${code}`, { method: 'DELETE' });

/* ── processing ────────────────────────────────────────────────────────── */

/* LIVE: drives the SIG-Transformer pipeline in Docker. */

/**
 * ENDPOINT: GET /api/pipeline
 *
 * Whether the engine could be driven right now. Asked before offering to
 * process: a refusal here names something the user can fix, where a failure
 * mid-run would not.
 */
export const getPipelineReadiness = (): Promise<PipelineReadiness> => request('/pipeline');

/** ENDPOINT: POST /api/pipeline/up — starts Postgres and the engine container. */
export const startPipelineContainers = (): Promise<PipelineReadiness> =>
  request('/pipeline/up', { method: 'POST' });

/** ENDPOINT: POST /api/projects/{id}/process — kicks off a full pipeline pass. */
export const startProcessing = (projectId: string): Promise<PipelineRun> =>
  request(`/projects/${projectId}/process`, { method: 'POST' });

/**
 * ENDPOINT: GET /api/projects/{id}/process
 *
 * The run's current state, or null when the project has never been
 * processed. Null rather than a 404: never having been processed is the
 * normal state for a new project, and a 404 shows up in the browser console
 * as a failed request however carefully it is handled.
 *
 * A run the backend did not start is reconstructed from the engine's logs,
 * so a restart mid-run reports what became of it rather than nothing.
 */
export const getProcessing = (projectId: string): Promise<PipelineRun | null> =>
  request<PipelineRun | null>(`/projects/${projectId}/process`);

/**
 * ENDPOINT: POST /api/projects/{id}/process/abort
 *
 * Stops a run that is going — the real thing, not just the progress view:
 * the backend signals the pipeline script and kills the Python inside the
 * container, which `docker compose exec` does not do on its own.
 *
 * Whatever the engine had already written stays written. It commits variable
 * by variable, so a stopped run leaves partial output rather than rolling
 * back, and processing again carries on from there.
 */
export const abortProcessing = (projectId: string): Promise<{ detail: string }> =>
  request(`/projects/${projectId}/process/abort`, { method: 'POST' });

/** How often to ask for progress while a run is going. */
const POLL_MS = 1000;

/**
 * Follow a run until it ends. Returns an unsubscribe function.
 *
 * Polling, not SSE. A run takes around a quarter of an hour, which is exactly
 * the case a stream is meant for — but this is a local server over loopback,
 * where a request per second costs nothing measurable, and a poll has no
 * reconnect logic to get wrong. `client.ts` still has `subscribe` for when
 * the backend grows a stream; the payload here is already the shape one would
 * push, so that swap would touch neither side's logic.
 */
export const watchProcessing = (
  projectId: string,
  onRun: (run: PipelineRun) => void,
  onError?: (error: Error) => void,
): (() => void) => {
  let stopped = false;
  let timer: number | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const run = await getProcessing(projectId);
      if (stopped) return;
      // Nothing to follow: the backend has no run for this project and could
      // not reconstruct one. Stop rather than poll an empty answer forever.
      if (!run) return;
      onRun(run);
      // Stop on our own once the run is over, so a caller that forgets to
      // unsubscribe does not leave a request-per-second running forever.
      if (run.status !== 'starting' && run.status !== 'running') return;
    } catch (error) {
      if (stopped) return;
      onError?.(error instanceof Error ? error : new Error(String(error)));
      return; // a failing poll will keep failing; let the caller decide
    }
    timer = window.setTimeout(tick, POLL_MS);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
  };
};

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
 * Writes the file. Running the model from it is `startModelRun`, which the
 * Model screen calls straight after this.
 */
export const applyModel = (projectId: string, text: string): Promise<ModelFile> =>
  request(`/projects/${projectId}/model/apply`, { method: 'POST', body: JSON.stringify({ text }) });

/* ── running the model ─────────────────────────────────────────────────── */

/* LIVE: drives MCDA/run_mcda.sh, watched exactly like processing. */

/**
 * ENDPOINT: POST /api/projects/{id}/model/run
 *
 * Scores the model over the project's hexagons. Returns the run's starting
 * state; the work takes minutes, so the UI polls.
 */
export const startModelRun = (
  projectId: string,
  options: { site?: string; useProjectModel?: boolean; skipPreprocesses?: boolean } = {},
): Promise<PipelineRun> =>
  request(`/projects/${projectId}/model/run`, {
    method: 'POST',
    body: JSON.stringify({ site: 'both', ...options }),
  });

/** ENDPOINT: GET /api/projects/{id}/model/run — null when never run. */
export const getModelRun = (projectId: string): Promise<PipelineRun | null> =>
  request(`/projects/${projectId}/model/run`);

/** ENDPOINT: POST /api/projects/{id}/model/run/abort — stops it for real. */
export const abortModelRun = (projectId: string): Promise<{ detail: string }> =>
  request(`/projects/${projectId}/model/run/abort`, { method: 'POST' });

/**
 * Follow a model run to its end. Same polling as processing, and the same
 * shape — applying the model is a run like any other.
 */
export const watchModelRun = (
  projectId: string,
  onRun: (run: PipelineRun) => void,
  onError?: (error: Error) => void,
): (() => void) => {
  let stopped = false;
  let timer: number | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const run = await getModelRun(projectId);
      if (stopped) return;
      if (!run) return;
      onRun(run);
      if (run.status !== 'starting' && run.status !== 'running') return;
    } catch (error) {
      if (stopped) return;
      onError?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    timer = window.setTimeout(tick, POLL_MS);
  };

  void tick();
  return () => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
  };
};

export const listExamples = (): Promise<ModelExample[]> => mock.listExamples();

/* ── settings ──────────────────────────────────────────────────────────── */

/**
 * LIVE: GET /api/settings
 *
 * What the engine is configured with, with no project to ask about — the
 * New project screen needs them before there is anything to attach them to.
 */
export const getEngineSettings = (): Promise<ProjectSettings> => request('/settings');

/**
 * LIVE: GET /api/projects/{id}/settings
 *
 * What this project will run at. A project that has never set them follows
 * the engine's own `.env`, and says so with `followingEngine`.
 */
export const getSettings = (projectId: string): Promise<ProjectSettings> =>
  request(`/projects/${projectId}/settings`);

/**
 * LIVE: PUT /api/projects/{id}/settings
 *
 * Stores them. They reach the engine when a run starts — applying them means
 * writing the engine's `.env` and recreating its container, which is not
 * something closing a dialog should do to a run someone has going.
 */
export const saveSettings = (
  projectId: string,
  settings: Resolutions,
): Promise<ProjectSettings> =>
  request(`/projects/${projectId}/settings`, {
    method: 'PUT',
    body: JSON.stringify({
      processingResolution: settings.processingResolution,
      mapResolution: settings.mapResolution,
    }),
  });

/**
 * LIVE: DELETE /api/projects/{id}/settings
 *
 * Back to the engine's own configuration — "Default values" in the dialog.
 * Not the same as saving the numbers it currently reports: one tracks the
 * engine, the other pins a value that would stay put when the engine moves.
 */
export const clearSettings = (projectId: string): Promise<ProjectSettings> =>
  request(`/projects/${projectId}/settings`, { method: 'DELETE' });
