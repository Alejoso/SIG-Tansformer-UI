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

/* ── the layer tree ────────────────────────────────────────────────────── */

/**
 * Whether the map draws each cell's value in the variable's own units or
 * after normalization.
 *
 * `raw` is the value as stored — metres per second, kilometres, percent.
 * `normalized` is that value put on a common 0-1 scale, which is what makes
 * two variables comparable to the eye.
 */
export type ValueScale = 'raw' | 'normalized';

/**
 * One entry in the structure the engine renders.
 *
 * The engine emits a document for the whole model, one for each variable, and
 * one for each subvariable a composite variable is built from — so what comes
 * back is a tree, not a list. The sidebar mirrors it the way a file explorer
 * mirrors folders: composites open to reveal what they are made of.
 *
 * Nesting is arbitrary depth. A subvariable can itself be composite.
 */
export interface LayerNode {
  /** Unique across the whole tree; this is the selection key and the URL key. */
  id: string;
  label: string;
  /** One line of plain-language context, shown over the map. */
  description?: string;
  /**
   * Present when this node is built from others. An empty array and an absent
   * one mean the same thing — a leaf — so the UI checks for length.
   */
  children?: LayerNode[];
  /**
   * False when the engine produced no document for this node, e.g. a grouping
   * that exists only to hold children. Such a row still opens, but selecting
   * it shows nothing.
   */
  hasDocument: boolean;
}

/** Which side of the project the map sidebar is showing. */
export type MapMode = 'input' | 'model';

/**
 * Everything the engine rendered for a project.
 *
 * Kept as one response because the engine generates it in a single pass, and
 * because the UI needs all of it to decide what to show first.
 *
 * The two sides are shaped differently on purpose. The model is hierarchical —
 * a variable can be built from other variables — so it arrives as a tree. The
 * inputs are one uploaded folder per variable, so they are flat and stay flat.
 */
export interface LayerTree {
  model: {
    /**
     * The single document holding the whole model. There is only ever one:
     * it already contains everything in one place.
     */
    combined: LayerNode;
    /** The model's variables, nested wherever one is composed of others. */
    variables: LayerNode[];
  };
  /** The uploaded variables, one per folder. Never nested. */
  inputs: LayerNode[];
}

/* ── model (the tunable YAML) ──────────────────────────────────────────── */

/**
 * How a variable's raw values are turned into a comparable score.
 *
 * - `minmax` — rescale onto 0-1 using the observed range. No configuration.
 * - `standard` — subtract the mean, divide by the standard deviation. No
 *   configuration.
 * - `intervals` — hand-written ranges, each mapping to a number. This is also
 *   how a categorical result is expressed, since a category is just a number
 *   with a meaning attached.
 */
export type Normalization = 'minmax' | 'standard' | 'intervals';

/**
 * One row of an interval transform: every value in the range becomes `value`.
 *
 * Bounds are `(from, to]` — exclusive lower, inclusive upper — matching the
 * engine's `range` bins, so the UI does not teach a different convention from
 * the one that actually runs.
 *
 * All three are strings so a half-typed `-` or `0.` survives editing, the same
 * reason `weight` is a string.
 */
export interface Interval {
  /** Lower bound, exclusive. Empty means unbounded below. */
  from: string;
  /** Upper bound, inclusive. Empty means unbounded above. */
  to: string;
  /** What values in this range become. Always a number. */
  value: string;
}

/**
 * A node in the weighting tree. The engine's real config is richer and is
 * expected to change a lot, so this stays deliberately small: a name, a
 * weight, an exclusion flag, a normalization, and children.
 */
export interface ModelVariable {
  key: string;
  /** Weight, kept as a string so a half-typed `0.` survives editing. */
  weight: string;
  /** When true the variable rules a cell out instead of weighting it. */
  exclusion_variable: boolean;
  normalization: Normalization;
  /**
   * The ranges, in order. Only meaningful when `normalization` is
   * `intervals`; kept on the variable rather than in a side table so one node
   * carries everything about itself.
   */
  intervals?: Interval[];
  sub?: ModelVariable[];
}

export interface ModelConfig {
  project: string;
  model: string;
  objective: string;
  /** H3 resolution, as a string for the same reason as `weight`. */
  resolution: string;
  variables: ModelVariable[];
}

/**
 * One tick while the model is being applied. The engine re-normalises and
 * re-weights one variable at a time, so the UI can name what it is working on
 * instead of showing an opaque spinner.
 */
export interface ApplyProgress {
  phase: 'running' | 'done' | 'failed';
  /** The variable being processed right now, e.g. `wind_speed`. */
  variable: string;
  /** 1-based position of `variable` in the run. */
  index: number;
  total: number;
  error?: string;
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
  /**
   * H3 resolution the engine converts the source data at. This is the
   * resolution the values are actually computed and stored at, so changing it
   * means reprocessing.
   */
  processingResolution: number;
  /**
   * H3 resolution the map draws at. Kept separate from the processing
   * resolution so a heavy mesh can be explored at a coarser, faster grid
   * without touching the stored data.
   *
   * When this is coarser than `processingResolution` the backend has to
   * aggregate cells up; when it is finer there is no more detail to show.
   */
  mapResolution: number;
  coordinateSystem: string;
}

/** H3 defines resolutions 0 (coarsest) through 15 (finest). */
export const MIN_H3_RESOLUTION = 0;
export const MAX_H3_RESOLUTION = 15;

/** Path into the variable tree: child indices from the root down. */
export type ModelPath = number[];
