/**
 * Domain types shared by the UI and — eventually — the FastAPI backend.
 *
 * Everything here is what the server is expected to send or accept. Keep this
 * file as the single source of truth: when the backend lands, its Pydantic
 * models should mirror these shapes one-for-one.
 */

/* ── projects ──────────────────────────────────────────────────────────── */

export type ProjectStatus = 'draft' | 'processed';

export interface Project {
  id: string;
  name: string;
  /** Mesh file name, e.g. `ireland_5km_mesh.geojson`. */
  meshId: string;
  /** Human label for the mesh, e.g. `Ireland — 5 km mesh`. */
  meshLabel: string;
  status: ProjectStatus;
  description: string;
  /** Absolute path the engine writes processed files into. */
  outFolder: string;
  variableCount: number;
  hexagonCount: number;
  /** ISO-8601. Rendered as "2 days ago". */
  updatedAt: string;
}

export interface NewProjectPayload {
  name: string;
  meshId: string;
  outFolder: string;
  description: string;
}

export interface Mesh {
  id: string;
  label: string;
}

/* ── data folders + processing ─────────────────────────────────────────── */

export interface DataFolder {
  id: string;
  /** Folder name as it appears on disk. */
  name: string;
  path: string;
  fileCount: number;
  /** Total size in bytes; the UI formats it. */
  sizeBytes: number;
  /** `ready` once the engine has converted it into H3. */
  state: 'pending' | 'ready' | 'failed';
}

export type ProcessingPhase = 'empty' | 'processing' | 'done';

/**
 * One tick of the processing run. The backend pushes these over SSE as
 * `watchfiles` sees the engine drop results into the project folder.
 */
export interface ProcessingProgress {
  phase: ProcessingPhase;
  /** 0–100. */
  progress: number;
  /** Current step, e.g. `Turning locations into H3 hexagons`. */
  statusText: string;
  hexagonCount?: number;
  error?: string;
}

/* ── map variables ─────────────────────────────────────────────────────── */

export type MapMode = 'raw' | 'model';

export interface Variable {
  id: string;
  name: string;
  /** Unit line under the name, e.g. `metres per second at 100 m`. */
  unit: string;
  /** One-line plain-language explanation shown over the map. */
  hint: string;
  min: number;
  max: number;
  /** Decimal places used when formatting a value. */
  decimals: number;
  /** Appended to a formatted value, e.g. ` m/s`. */
  suffix: string;
}

/** One hexagon's value for one variable. */
export interface HexCell {
  /** H3 index, e.g. `881f1d4881fffff`. */
  h3: string;
  value: number;
}

export interface HexLayerData {
  variableId: string;
  resolution: number;
  cells: HexCell[];
}

/* ── model (the tunable YAML) ──────────────────────────────────────────── */

export type Normalisation = 'minmax' | 'zscore' | 'log' | 'ninguna';

/**
 * A node in the weighting tree. The engine's real config is richer and is
 * expected to change a lot, so this stays deliberately small: a name, a
 * weight, an exclusion flag, a normalisation, and children.
 */
export interface ModelVariable {
  key: string;
  /** Weight, kept as a string so a half-typed `0.` survives editing. */
  peso: string;
  /** When true the variable rules a cell out instead of weighting it. */
  excluyente: boolean;
  normalizacion: Normalisation;
  sub?: ModelVariable[];
}

export interface ModelConfig {
  project: string;
  model: string;
  objective: string;
  /** H3 resolution, as a string for the same reason as `peso`. */
  resolution: string;
  variables: ModelVariable[];
}

export interface ModelExample {
  id: string;
  title: string;
  blurb: string;
  /** Rendered verbatim in the examples dialog. */
  yaml: string;
  variables: ModelVariable[];
}

/* ── advanced settings ─────────────────────────────────────────────────── */

export interface ProjectSettings {
  pipelineVersion: string;
  /** Fixed by the engine; shown read-only. */
  h3Resolution: number;
  coordinateSystem: string;
}

/** Path into the variable tree: child indices from the root down. */
export type ModelPath = number[];
