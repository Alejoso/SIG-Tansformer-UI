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
  /**
   * How many of the project's folders are no longer on disk. Counted by the
   * server on every read, because the whole point of storing a path is that
   * what it points at can move.
   */
  /** Variables the engine will skip because their folder holds no dataset. */
  unreadableVariables: number;
}

export interface NewProjectPayload {
  name: string;
  meshId: string;
  outFolder: string;
  description: string;
}

/**
 * A study area a project can be built on. Today that is a country, read from
 * Natural Earth through GeoPandas on the server.
 */
export interface Mesh {
  id: string;
  label: string;
  continent: string;
  /** ISO 3166-1 alpha-3, where the dataset has one. Norway and France do not. */
  iso: string;
  /** Every name and code this row answers to, joined — what the filter matches. */
  search: string;
}

/* ── project data + processing ─────────────────────────────────────────── */

/** The result of asking the server to open a native folder dialog. */
export interface PickedFolder {
  path: string | null;
  /** Set when no dialog could be opened, so the UI can say why. */
  unavailable: string | null;
}

/**
 * One variable in the engine's input tree.
 *
 * The pipeline does not take a list of folders: it walks `<DATA_DIR>/in` and
 * reads each variable's dimension and code out of the path
 * (`in/09_regulatorio/REG_001/file.csv`). So this is not a record of what
 * someone added — it is what is actually there, and what will actually run.
 */
export interface InputVariable {
  /** `<dimension>/<CODE>`, which is both its identity and where it lives. */
  id: string;
  dimension: string;
  code: string;
  filename: string;
  /** GPKG, CSV, SHP… as the engine labels formats. */
  format: string;
  sizeBytes: number;
  fileCount: number;
  /** Where it was copied from. Empty for data put there by hand. */
  source: string;
  /** The source folder has moved. The copy still works, so this is a note. */
  sourceMissing: boolean;
  /** Set when the folder is not one readable dataset — the engine will skip it. */
  problem: string;
  /**
   * Results with no input behind them.
   *
   * The pipeline loads every `.h3.parquet` under `out/`, so one of these is
   * still a column in the master table and a leaf the model can score. They
   * come from an input deleted outside this app.
   */
  processedOnly: boolean;
}

/** What removing a variable took away. */
export interface Removal {
  id: string;
  inputFiles: number;
  /**
   * Files deleted from `out/`. Non-zero means processed results went too —
   * which is the point: the engine rebuilds its database from `out/`, so a
   * variable whose output survived would come back on the next run.
   */
  outputFiles: number;
}

/** What adding a folder would copy, and where, worked out before it happens. */
export interface ImportPlan {
  source: string;
  filename: string;
  format: string;
  sizeBytes: number;
  /** The dataset, then any companion files that must travel with it. */
  files: string[];
  dimension: string;
  code: string;
  problem: string;
}

export type ProcessingPhase = 'empty' | 'processing' | 'done';

/** How one stage of the pipeline ended, or that it has not run. */
export type StageStatus = 'pending' | 'running' | 'ok' | 'skipped' | 'failed' | 'aborted';

/**
 * One step of the engine's pipeline.
 *
 * `number` is the step's number in the engine's own documentation, fractional
 * included — 10.5 and 12.5 were inserted between existing steps and keeping
 * their real numbers means a question about "step 11" has one answer in the
 * UI and in the engine's docs.
 */
export interface PipelineStage {
  number: number;
  key: string;
  label: string;
  status: StageStatus;
  /** The stage's own counts, in its own words. Empty until it reports. */
  detail: string;
  durationSeconds: number | null;
}

/** A run of the engine, as the backend sees it. */
export interface PipelineRun {
  projectId: string;
  status: 'starting' | 'running' | 'done' | 'failed' | 'aborted';
  /** The engine's id for the run, e.g. `2026-10-15_20-31_rf_001`. */
  executionId: string;
  /** 0–100, weighted by how long each stage takes rather than counting them. */
  percent: number;
  statusText: string;
  stages: PipelineStage[];
  startedAt: number;
  finishedAt: number | null;
  error: string;
  hexagonCount: number | null;
  /**
   * Input files the engine skipped or failed on and carried on past.
   *
   * These matter more than they look: the engine deliberately does not abort
   * a run over one damaged file, so it can finish successfully with variables
   * missing. A run that says "done" with a non-zero count here did not do
   * everything it was asked to.
   */
  skippedFiles: number;
  erroredFiles: number;
  /**
   * Whether this run clears the engine's per-project tables first, and why.
   *
   * The pipeline has one database and nothing in it is scoped to a project,
   * so switching projects — or removing a variable — means the previous
   * rows have to go before new ones are loaded.
   */
  reset: boolean;
  resetReason: string;
  /** The H3 master is being rebuilt too: minutes rather than seconds. */
  rebuildEverything: boolean;
  /** The tail of the engine's output, for when something goes wrong. */
  logTail: string[];
}

/**
 * Whether the engine can be driven at all.
 *
 * Every reason it cannot be is something only the user can fix — Docker not
 * running, WSL integration switched off, the pipeline checked out somewhere
 * else — so the problems come back as sentences to show rather than a flag.
 */
export interface PipelineReadiness {
  ready: boolean;
  pipelineDir: string;
  /** The folder the engine processes when a project does not choose one. */
  dataDir: string;
  /**
   * Whether each project can keep its data in its own folder.
   *
   * False on a pipeline checkout whose `run_full.sh` assigns over the
   * `DATA_DIR` it is given — there, a project has to point at `dataDir`.
   */
  perProjectData: boolean;
  pipelineFound: boolean;
  dockerAvailable: boolean;
  composeAvailable: boolean;
  appRunning: boolean;
  dbRunning: boolean;
  problems: string[];
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
  /** The file behind this layer, so the frame can name what is on screen. */
  filename?: string;
  /**
   * False when the pipeline logged a problem for this layer.
   *
   * A rendered layer can still have failed: the pipeline deliberately carries
   * on past a bad file rather than losing a long run, so its presence is not
   * proof it is sound.
   */
  ok?: boolean;
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

/** One thing wrong with the model file. */
export interface ModelIssue {
  message: string;
  /** 1-based, when the parser gives a position. Structural problems have none. */
  line: number | null;
  column: number | null;
}

/**
 * The model file as it sits on disk.
 *
 * The text is what was typed — comments, spacing and key order intact. It is
 * never round-tripped through a parser on the way to or from the editor,
 * because that would quietly rewrite someone's file.
 */
export interface ModelFile {
  /** Absolute path on the machine running the server. */
  path: string;
  text: string;
  /** True when the file did not exist and was seeded with the default. */
  created: boolean;
  /** The document does not parse. */
  syntaxErrors: ModelIssue[];
  /** It parses, but does not describe a model the engine could run. */
  structureErrors: ModelIssue[];
}

export interface ModelExample {
  id: string;
  title: string;
  blurb: string;
  /** Shown in the dialog, and inserted into the editor verbatim. */
  yaml: string;
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
