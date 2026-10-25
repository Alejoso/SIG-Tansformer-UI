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
/** One variable a folder of variables would add. */
export interface ImportCandidate {
  /** The folder to copy from. Several datasets in one folder share it. */
  source: string;
  /** What to call it in the list: the folder it came from, or the file. */
  label: string;
  filename: string;
  format: string;
  sizeBytes: number;
  files: string[];
  /** Suggested, and editable before anything is copied. */
  code: string;
  /** Why this one cannot be added. The others still can. */
  problem: string;
}

/** What adding a folder of variables did. */
export interface ImportOutcome {
  added: InputVariable[];
  failed: { source: string; code: string; problem: string }[];
}

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
  /**
   * Set when the folder holds several variables rather than one — subfolders
   * with a dataset each, or several datasets side by side. The single fields
   * above stay empty then, and these are what to show.
   */
  variables: ImportCandidate[];
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
 * One entry in what the engine rendered.
 *
 * A flat list on both sides: one document per input variable, and on the
 * model side the whole model plus one per criterion. The engine also renders
 * each subcriterion, which the sidebar does not show.
 */
/**
 * A variable the engine could not finish.
 *
 * The run only ever reported a count — "4 files could not be processed" —
 * which named nothing and was gone by the next run. The engine writes the
 * reason into the folder where the output should have been, so this is read
 * from there and survives a reload.
 */
export interface VariableProblem {
  /** `<dimension>/<CODE>`, the same id the Data screen uses. */
  id: string;
  dimension: string;
  code: string;
  /** `error` when the engine said so, `unfinished` when it just stopped. */
  status: 'error' | 'unfinished';
  /** The stage it stopped at, in the engine's own word for it. */
  stage: string;
  /** And in English. */
  stageLabel: string;
  /**
   * The engine's own reason, as it wrote it. Spanish, because that is what
   * it says — translating it would be inventing detail.
   */
  reason: string;
  /** The file it was reading. */
  source: string;
  executionId: string;
}

export interface LayerNode {
  /** Unique across the whole tree; this is the selection key and the URL key. */
  id: string;
  label: string;
  /**
   * The variable's code, on the rows that have one.
   *
   * The label comes from the file the engine processed, which is whatever it
   * happened to be called. The code is what the model file and the master
   * table know it by, so it is the one to find a variable with.
   */
  code?: string;
  /** One line of plain-language context, shown over the map. */
  description?: string;
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

/* ── the model file's own shape ─────────────────────────────────────────── */

/**
 * How a leaf's values become a score from 1 to 5.
 *
 * These are the engine's, from the `leaf_score` dispatch in
 * `MCDA/engine/mcda_score.py` — not a set this app invented:
 *
 * - `range` — your own cuts, `bins` of `[from, to, score]`, read as
 *   `(from, to]`. `null` is unbounded.
 * - `map` — an exact value to a score, for categories.
 * - `direct` — the value already is a 1-5 score.
 * - `minmax` — the range present in the data, stretched onto 1-5.
 * - `zscore` — the same, around the mean: z of -2..2 becomes 1..5.
 */
export type LeafType = 'range' | 'map' | 'direct' | 'minmax' | 'zscore';

/** Which half of the country a leaf covers. The sea and the land score apart. */
export type Site = 'both' | 'onshore' | 'offshore';

/**
 * One variable being scored.
 *
 * Read out of the file for the diagram to draw, so every field is what the
 * text says rather than what it should say — a missing weight stays null
 * instead of becoming a default, because the diagram's job is to show what
 * is written.
 */
export interface ModelLeaf {
  /** The engine's label for it, hyphenated: `SOE-001`. */
  code: string;
  /** The master-table column holding the values. This is what gets scored. */
  column: string;
  site: Site;
  type: LeafType;
  /** Its share of the subgroup, or null when the file does not say. */
  weight: number | null;
  /** Cuts on a `range` leaf, entries on a `map` one. Zero for the rest. */
  steps: number;
  /** `direction: cost` — a high value scores low. */
  inverted: boolean;
}

/** A group of leaves that answer the same question. */
export interface ModelSubgroup {
  key: string;
  /** The readable name, when the file gives one. */
  nombre: string;
  weight: number | null;
  /** `combine: min` — the worst leaf decides, rather than the average. */
  worstWins: boolean;
  /** What a hexagon the variable does not cover scores, when it sets that. */
  absent: number | null;
  /** It normalizes its own spread instead of averaging weighted leaves. */
  normalized: boolean;
  leaves: ModelLeaf[];
}

export interface ModelCriterion {
  key: string;
  nombre: string;
  weight: number | null;
  subgroups: ModelSubgroup[];
}

/**
 * The whole model, as the diagram reads it.
 *
 * Zoning is counted rather than detailed: it does not score anything, it
 * rules hexagons out, so it belongs in the caption and not in the tree.
 */
export interface ModelConfig {
  criteria: ModelCriterion[];
  /** Columns whose mere presence excludes a hexagon. */
  excludedColumns: number;
  /** Rules excluding by a threshold on a continuous variable. */
  excludedThresholds: number;
  /** Codes kept whatever else is dropped. */
  prioritized: number;
}


/**
 * One past run of the model.
 *
 * Every Apply writes another whole set of rendered maps — the model, each
 * criterion, each subcriterion — and nothing removes them, while only the
 * newest is ever drawn.
 */
export interface ModelRun {
  id: string;
  sizeBytes: number;
  /** Seconds since the epoch, from the folder itself. */
  modifiedAt: number;
  /** The one the map draws. Every other run is unreachable from the app. */
  current: boolean;
  documentCount: number;
}

/** What a clean-up took away. */
export interface ModelRunsRemoval {
  removed: string[];
  freedBytes: number;
  /** Asked for but not there. Not an error — the outcome is the one wanted. */
  missing: string[];
}

/** One thing wrong with the model file. */
export interface ModelIssue {
  message: string;
  /** 1-based, when the parser gives a position. */
  line: number | null;
  column: number | null;
  /**
   * `error` when the engine would crash on this or quietly drop the leaf;
   * `warning` when it runs anyway but probably not as meant. The engine only
   * warns about its own config, so neither kind blocks Apply — only YAML that
   * does not parse does.
   */
  severity: 'error' | 'warning';
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
  /**
   * Where the snippet belongs. A `criterion` block is a list item and goes at
   * the end of `criteria:`; a `top` block is its own key and goes at the end
   * of the file. Pasting either in the other's place would not parse, which
   * is why this is carried rather than guessed from the text.
   */
  scope: 'criterion' | 'top';
  /** Shown in the dialog, and inserted into the editor verbatim. */
  yaml: string;
}

/* ── advanced settings ─────────────────────────────────────────────────── */

/**
 * The engine knobs a project carries.
 *
 * Two of them. There used to be a `pipelineVersion` as well, offering a
 * choice between three invented version strings for a thing the engine does
 * not have.
 */
/** The pair a person actually chooses. The rest of the settings are readouts. */
export type Resolutions = Pick<ProjectSettings, 'processingResolution' | 'mapResolution'>;

export interface ProjectSettings {
  /**
   * H3 resolution the engine converts the source data at. This is the
   * resolution the values are actually computed and stored at, so changing it
   * rebuilds the whole master table and reprocesses everything.
   */
  processingResolution: number;
  /**
   * H3 resolution the engine draws its maps at. Kept separate from the
   * processing resolution so a heavy mesh can be drawn at a coarser, faster
   * grid without recomputing anything — changing it only redraws.
   *
   * Finer than `processingResolution` shows no more detail, because none was
   * computed.
   */
  mapResolution: number;
  /** Shown, not offered: the engine works in WGS 84 throughout. */
  coordinateSystem: string;
  /**
   * True while this project has never set them, and is following whatever
   * the engine's own `.env` is configured with. Worth saying on screen: the
   * numbers are real either way, but nobody here chose them.
   */
  followingEngine: boolean;
  /**
   * Whether anything has been processed yet.
   *
   * Changing a resolution only matters if there are results sitting at the
   * old one. On an empty project it is just a choice.
   */
  hasResults: boolean;
}

/** H3 defines resolutions 0 (coarsest) through 15 (finest). */
export const MIN_H3_RESOLUTION = 0;
export const MAX_H3_RESOLUTION = 15;

/** Path into the variable tree: child indices from the root down. */
export type ModelPath = number[];
