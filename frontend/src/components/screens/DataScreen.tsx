import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import { useApp } from '../../state/app-context';
import type { ImportPlan, InputVariable, PipelineRun, PipelineStage } from '../../types';
import { Dialog } from '../ui/Dialog';
import { formatSize } from '../../lib/format';
import { Icon } from '../ui/Icon';
import { SettingsDialog } from './SettingsDialog';

/* The mockup said "up to ten", and that was right when the list was a record
   of folders someone had pointed at. It is now the engine's input tree, which
   already holds twelve here and has no limit of its own — so a cap would do
   nothing but refuse real data. The count is shown; nothing is blocked. */

/** Chosen in the dimension list to type a new one instead of picking. */
const NEW_DIMENSION = '\u0000new';

/*
 * What the server will make of a typed dimension and code.
 *
 * Cosmetic only — `inputs.py` normalises for real, and is the authority. This
 * exists so the "Copied to…" line shows the path that will actually be
 * created rather than the keystrokes: files are named `SOE-001.gpkg` and
 * folders `10-Socioeconomico`, while the engine reads `SOE_001` under
 * `10_socioeconomico`, and silently landing somewhere other than what was
 * previewed is worse than not previewing at all.
 */
const canonicalDimension = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

const canonicalCode = (raw: string): string => {
  const cleaned = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  const match = /^([A-Za-z]{3})_?([0-9]{1,3})$/.exec(cleaned);
  return match ? `${match[1]}_${match[2].padStart(3, '0')}` : cleaned;
};

/**
 * What this run is doing differently, if anything.
 *
 * Most runs reuse the H3 master and only load what changed, which takes
 * under a minute. The ones that clear the database first, or rebuild the
 * master, take considerably longer — and without a word about it that reads
 * as the app being slow at random rather than doing more work.
 */
function runNote(run: PipelineRun): string {
  if (run.rebuildEverything) {
    return 'Rebuilding the H3 master as well as your data — this takes several minutes.';
  }
  if (run.reset && run.resetReason) {
    return `Reloading everything for this project, because ${run.resetReason}.`;
  }
  return 'Loading what changed. Data is locked until it finishes.';
}

/** `1m 04s`, `12s` — how long a run took, from its own timestamps. */
function formatDuration(run: { startedAt: number; finishedAt: number | null }): string {
  const seconds = Math.max(0, Math.round((run.finishedAt ?? Date.now() / 1000) - run.startedAt));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * One step of the engine's pipeline.
 *
 * Both the numbers and the skips are shown rather than tidied away. A step
 * that says "skipped — already up to date" is the engine explaining why a
 * fifteen-minute job finished in two, and without it the run looks like it
 * silently did nothing.
 */
function StageRow({ stage }: { stage: PipelineStage }) {
  const mark =
    stage.status === 'running' ? (
      <Icon name="spinner" size={13} color="var(--color-accent)" className="spin" />
    ) : stage.status === 'ok' ? (
      <Icon name="check" size={13} color="var(--color-accent-2-800)" strokeWidth={3} />
    ) : stage.status === 'failed' ? (
      <Icon name="close" size={13} color="var(--color-accent-700)" strokeWidth={3} />
    ) : (
      <span className="stage-dot" />
    );

  return (
    <li className={`stage-row is-${stage.status}`}>
      <span className="stage-mark">{mark}</span>
      <span className="stage-label">{stage.label}</span>
      <span className="stage-detail muted-55">
        {stage.status === 'skipped' && (stage.detail || 'Skipped')}
        {stage.status === 'aborted' && 'Not run'}
        {(stage.status === 'ok' || stage.status === 'failed') && stage.detail}
      </span>
      {stage.durationSeconds != null && (
        <span className="stage-time muted-55">{Math.round(stage.durationSeconds)}s</span>
      )}
    </li>
  );
}

export function DataScreen() {
  const { project, goTo, showHints, showToast } = useApp();
  const [showSettings, setShowSettings] = useState(false);
  const projectId = project?.id ?? '';

  /** What the engine will actually read, straight from its input tree. */
  const [variables, setVariables] = useState<InputVariable[]>([]);
  const [dimensions, setDimensions] = useState<string[]>([]);
  /** The engine run, straight from the backend. Null until one is started. */
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [showComplete, setShowComplete] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [starting, setStarting] = useState(false);
  /** Why the engine cannot be driven, when it cannot. */
  const [blocked, setBlocked] = useState<string[]>([]);
  /** Expanded by default while running: the stage list is the interesting part. */
  const [showStages, setShowStages] = useState(true);

  /** The folder being added, and what the server would do with it. */
  const [draftPath, setDraftPath] = useState('');
  const [planned, setPlanned] = useState<{ path: string; result: ImportPlan } | null>(null);
  const [adding, setAdding] = useState(false);
  /** The folder dialog blocks this request for as long as it is open. */
  const [browsing, setBrowsing] = useState(false);

  /** Where the new variable will go. Both are editable before adding. */
  const [dimension, setDimension] = useState('');
  const [newDimension, setNewDimension] = useState('');
  const [code, setCode] = useState('');
  const [addError, setAddError] = useState('');
  /**
   * Whether the dimension on screen is the user's choice rather than ours.
   *
   * Without this the server's suggestion wins forever: choosing "New
   * dimension…" leaves the name empty, an empty name is indistinguishable
   * from "nothing chosen yet", and the next plan — which arrives 350ms
   * later, about as long as it takes to move the mouse to the field —
   * suggests the dimension the project already has and puts it back. The
   * field vanished under the cursor.
   */
  const [dimensionTouched, setDimensionTouched] = useState(false);
  /**
   * The variable being removed, if any.
   *
   * Removal is not instant any more: results written by the pipeline belong
   * to root, so deleting them starts a container, which takes a few seconds.
   * Without this the row just sits there and the obvious thing to do is
   * click again.
   */
  const [removing, setRemoving] = useState<string | null>(null);

  /**
   * The dimension the new variable will go under.
   *
   * Declared here, above the effects, because the import plan depends on it:
   * the suggested code is the next free one *within a dimension*, so changing
   * the dimension has to re-ask.
   */
  const chosenDimension = dimension === NEW_DIMENSION ? newDimension.trim() : dimension;

  const unwatch = useRef<(() => void) | null>(null);

  /** Bumped to reread the input tree after something changes it. */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    Promise.all([api.listInputs(projectId), api.listDimensions(projectId)])
      .then(([list, dims]) => {
        if (!live) return;
        setVariables(list);
        setDimensions(dims);
        // Default to the dimension already in use, so the common case —
        // another variable alongside the others — needs no choice at all.
        // Not `|| ''`: a select whose value matches no option still *shows*
        // its first option, and changing nothing fires no event — so state
        // stayed empty, the new-dimension box never appeared and Add was
        // disabled with nothing saying why. With no dimensions yet, the only
        // option is "New dimension…", so that is what state must say.
        setDimension((current) => current || dims[0] || NEW_DIMENSION);
      })
      .catch((error: unknown) => {
        if (live) {
          showToast(error instanceof Error ? error.message : 'Could not read this project’s data');
        }
      });
    return () => {
      live = false;
    };
  }, [projectId, reloadToken, showToast]);

  // Never leave the progress stream open behind us.
  useEffect(() => () => unwatch.current?.(), []);

  /**
   * Ask the server what adding this folder would do, a beat after typing stops.
   *
   * A dry run rather than a plain existence check: copying into the engine's
   * tree is the one thing this screen does to a directory, so what will be
   * copied and where is shown before the button is pressed. The browser
   * cannot read an absolute path out of a file picker either way, so what is
   * in the box is just text until the server has looked at it.
   */
  useEffect(() => {
    const path = draftPath.trim();
    if (!path) return;

    let live = true;
    const timer = setTimeout(async () => {
      try {
        const result = await api.planImport(projectId, path, chosenDimension);
        if (!live) return;
        setPlanned({ path, result });
        // The server suggests the next free code for that dimension; keep
        // whatever the user has typed over it.
        setCode((current) => current || result.code);

        // A suggested dimension is only ever offered into an untouched
        // control. Once the choice is the user's it is theirs, including
        // the choice to be in the middle of typing a new one.
        if (dimensionTouched) return;
        if (!result.dimension) {
          setDimension(NEW_DIMENSION);
        } else if (dimensions.includes(result.dimension)) {
          setDimension(result.dimension);
        } else {
          // Not one of the existing ones, so it has to show as "New
          // dimension…" or the select and the state would disagree.
          setNewDimension((typed) => typed || result.dimension);
          setDimension(NEW_DIMENSION);
        }
      } catch {
        if (live) setPlanned(null);
      }
    }, 350);

    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftPath, projectId, dimension, dimensions, dimensionTouched]);

  /**
   * What the server said about the folder currently in the box.
   *
   * Tagged with the path it describes and compared during render, so a
   * cleared or edited box shows "checking" immediately rather than briefly
   * showing a verdict about the previous path.
   */
  const plan = planned?.path === draftPath.trim() ? planned.result : null;
  const checking = draftPath.trim().length > 0 && plan === null;

  /**
   * The screen's three states, derived from the run rather than tracked
   * alongside it — one source of truth means the buttons cannot disagree
   * with the progress bar.
   */
  const running = run?.status === 'starting' || run?.status === 'running';
  const phase = running ? 'processing' : run?.status === 'done' ? 'done' : 'empty';
  const locked = running;
  /** Variables whose folder is not one readable dataset — the engine will skip them. */
  const unreadable = variables.filter((v) => v.problem && !v.processedOnly);
  /** Results with no input: the engine still loads them, so they are worth seeing. */
  const orphaned = variables.filter((v) => v.processedOnly);
  const canAdd =
    !locked && plan !== null && !plan.problem && Boolean(chosenDimension) && Boolean(code);

  /**
   * Copy the chosen folder into the project as a variable.
   *
   * The server does the copying — the browser never sees the files — and
   * refuses anything it cannot place, so its message is shown as-is rather
   * than reduced to "could not add".
   */
  const addVariable = async () => {
    if (!canAdd) return;
    setAdding(true);
    setAddError('');
    try {
      const added = await api.addInput(projectId, draftPath, chosenDimension, code);
      setDraftPath('');
      setPlanned(null);
      setCode('');
      setNewDimension('');
      setDimension(added.dimension);
      setDimensionTouched(false);
      reload();
      showToast(`${added.filename} added as ${added.id}`);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'Could not add that folder');
    } finally {
      setAdding(false);
    }
  };

  const browse = async () => {
    setBrowsing(true);
    try {
      const picked = await api.pickFolder(draftPath);
      if (picked.path) setDraftPath(picked.path);
      else if (picked.unavailable) showToast(picked.unavailable);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not open a folder chooser');
    } finally {
      setBrowsing(false);
    }
  };

  /**
   * Take a variable out of the project, input and results together.
   *
   * The confirmation says so in those words. The results have to go — the
   * engine rebuilds its database from `out/`, so a variable whose output
   * survived would come back on the next run — but deleting someone's
   * processed data on a button called "remove" is not something to do
   * quietly.
   */
  const removeVariable = async (variable: InputVariable) => {
    const sure = window.confirm(
      `Remove ${variable.id} from this project?\n\n` +
        `This deletes the project's copy of ${variable.filename} and anything the ` +
        'engine made from it — its hexagons and its map. It leaves the master table ' +
        'and the model on the next run.\n\n' +
        `${variable.source ? 'The folder it was copied from is not touched.' : ''}`,
    );
    if (!sure) return;
    setRemoving(variable.id);
    try {
      const gone = await api.removeInput(projectId, variable.dimension, variable.code);
      reload();
      showToast(
        gone.outputFiles > 0
          ? `${gone.id} removed, with ${gone.outputFiles} processed file${gone.outputFiles === 1 ? '' : 's'}`
          : `${gone.id} removed`,
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not remove it');
    } finally {
      setRemoving(null);
    }
  };

  /**
   * Follow a run to its end, and react when it gets there.
   *
   * Used both for a run this screen started and for one it found already
   * going, so the two paths cannot drift apart.
   */
  const follow = useCallback(
    (initial: PipelineRun) => {
      setRun(initial);
      unwatch.current?.();
      unwatch.current = api.watchProcessing(
        projectId,
        (tick) => {
          setRun(tick);
          if (tick.status === 'starting' || tick.status === 'running') return;

          unwatch.current = null;
          if (tick.status === 'done') {
            setShowComplete(true);
            // The engine has just written new layers; the folder list shows
            // what it made of each one.
            reload();
          }
        },
        (error) => showToast(error.message),
      );
    },
    [projectId, reload, showToast],
  );

  /**
   * Pick a run back up after a reload.
   *
   * The engine takes about a quarter of an hour, which is long enough that
   * the user will navigate away, reload, or come back tomorrow. The backend
   * holds the run, so asking once on mount is the difference between that
   * being fine and the screen claiming nothing is happening while the engine
   * is halfway through.
   */
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api
      .getProcessing(projectId)
      .then((existing) => {
        if (!live || !existing) return;
        if (existing.status === 'starting' || existing.status === 'running') follow(existing);
        else setRun(existing);
      })
      .catch(() => {
        // Nothing to resume is the normal case, and a backend that cannot be
        // reached is already reported by the folder list.
      });
    return () => {
      live = false;
    };
  }, [projectId, follow]);

  const startProcessing = async () => {
    if (locked || starting || variables.length === 0) return;
    setStarting(true);
    setBlocked([]);
    try {
      follow(await api.startProcessing(projectId));
    } catch (error) {
      // The backend refuses with the reason — Docker not running, the folder
      // gone, another project already processing — and each one is something
      // the user can act on, so it is shown rather than reduced to a toast.
      const message = error instanceof Error ? error.message : 'Could not start the engine';
      setBlocked([message]);
    } finally {
      setStarting(false);
    }
  };

  /**
   * Stop a run that is already going.
   *
   * Goes back to the pre-run state: the folders are still there and Process
   * is the obvious next move. What the engine already wrote stays on disk —
   * it commits variable by variable — so this is a stop, not an undo, and the
   * backend says in as many words what it managed to stop.
   */
  const abort = async () => {
    if (!running || aborting) return;
    setAborting(true);
    try {
      const { detail } = await api.abortProcessing(projectId);
      unwatch.current?.();
      unwatch.current = null;
      setRun(null);
      showToast(detail ? `Stopped — ${detail}` : 'Stopped');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not stop the run');
    } finally {
      setAborting(false);
    }
  };

  const processHint =
    variables.length === 0
      ? 'Add at least one folder to continue.'
      : unreadable.length > 0
        ? `${unreadable.length} of these will be skipped — the engine reads one dataset per variable.`
        : phase === 'empty'
          ? 'This converts every location into a hexagon. You can keep working after it starts.'
          : 'Your data is being converted.';

  /** Put the path on the clipboard, for a terminal or a file manager. */
  const copyFolder = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      showToast('Path copied');
    } catch {
      // Clipboard access can be refused outright; saying so beats a button
      // that looks like it worked.
      showToast('Could not copy — select the path and copy it by hand');
    }
  };

  return (
    <div className="screen data-screen">
      <div className="screen-body">
        <h1 className="data-title">Add your data</h1>
        <p className="data-lede muted">
          One folder per variable. Each one is copied into the project and becomes a layer you
          can look at on the map.
        </p>

        {/* Where "the project" actually is. Everything the engine reads and
            writes for this project lives under here — `in/` for what you add,
            `out/` for what it makes, `model/model.yaml`, `MCDA/runs/` — and
            until it is on screen the only way to find it is the projects
            list. The full path is in the title too, since a long one is
            clipped. */}
        {project?.outFolder && (
          <div className="project-folder">
            <Icon name="folder" size={14} color="var(--color-accent-600)" />
            <span className="project-folder-label muted-55">Project folder</span>
            <span className="project-folder-path mono" title={project.outFolder}>
              {project.outFolder}
            </span>
            <button
              type="button"
              className="project-folder-copy"
              onClick={() => copyFolder(project.outFolder)}
            >
              <Icon name="copy" size={13} />
              Copy
            </button>
          </div>
        )}

        {orphaned.length > 0 && (
          <div className="folder-alert">
            <div className="folder-alert-body">
              <strong>
                {orphaned.length === 1
                  ? 'One variable has results but no input'
                  : `${orphaned.length} variables have results but no input`}
              </strong>
              <span className="muted-55">
                The engine loads every result it finds, so {orphaned.length === 1 ? 'it is' : 'they are'}{' '}
                still in the master table and the model. Remove{' '}
                {orphaned.length === 1 ? 'it' : 'them'} below, or add the data back under the same
                code.
              </span>
            </div>
          </div>
        )}

        {unreadable.length > 0 && (
          <div className="folder-alert">
            <div className="folder-alert-body">
              <strong>
                {unreadable.length === 1
                  ? 'One variable has nothing the engine can read'
                  : `${unreadable.length} variables have nothing the engine can read`}
              </strong>
              <span className="muted-55">
                The engine takes one dataset per variable and names the variable after it. These
                will be skipped: {unreadable.map((v) => v.id).join(', ')}.
              </span>
            </div>
          </div>
        )}

        {/* Paths are typed or browsed for, never dropped: a browser will not
            reveal a real path from a file picker, and the server is the one
            that has to find the folder in order to copy it. */}
        <div className={`path-add${locked ? ' is-locked' : ''}`}>
          <label className="path-add-label" htmlFor="folder-path">
            Folder holding one variable
          </label>
          <div className="field-row">
            <input
              id="folder-path"
              className="input"
              value={draftPath}
              disabled={locked}
              placeholder="/home/you/data/wind_atlas_2024"
              onChange={(e) => {
                setDraftPath(e.target.value);
                setAddError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canAdd) void addVariable();
              }}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={browse}
              disabled={locked || browsing}
              style={{ gap: 7, flex: 'none' }}
            >
              {browsing ? (
                <Icon name="spinner" size={15} className="spin" />
              ) : (
                <Icon name="folder" size={15} />
              )}
              {browsing ? 'Choosing…' : 'Browse'}
            </button>
          </div>

          {/* What the copy would do, before it does it. */}
          {plan && !plan.problem && (
            <div className="import-plan">
              <div className="import-plan-file">
                <Icon name="file" size={15} color="var(--color-accent-600)" />
                <span className="mono">{plan.filename}</span>
                <span className="tag tag-accent-2">{plan.format}</span>
                <span className="muted-55">{formatSize(plan.sizeBytes)}</span>
                {plan.files.length > 1 && (
                  <span
                    className="muted-55"
                    title={plan.files.join(', ')}
                  >
                    + {plan.files.length - 1} companion{plan.files.length === 2 ? '' : 's'}
                  </span>
                )}
              </div>

              <div className="import-plan-where">
                <label htmlFor="variable-dimension">Dimension</label>
                <select
                  id="variable-dimension"
                  className="input"
                  /* Belt and braces for the bug above: anything not in the
                     list is the "new dimension" case, so the shown option
                     and the state always agree. */
                  value={dimensions.includes(dimension) ? dimension : NEW_DIMENSION}
                  onChange={(e) => {
                    setDimension(e.target.value);
                    setDimensionTouched(true);
                    // The code is the next free one *within* a dimension, so
                    // it has to be re-asked for rather than carried over.
                    setCode('');
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {dimensions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  <option value={NEW_DIMENSION}>New dimension…</option>
                </select>

                {dimension === NEW_DIMENSION && (
                  <input
                    className="input"
                    value={newDimension}
                    placeholder="11_ambiental"
                    aria-label="New dimension name"
                    onChange={(e) => {
                      setNewDimension(e.target.value);
                      setDimensionTouched(true);
                    }}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                )}

                <label htmlFor="variable-code">Code</label>
                <input
                  id="variable-code"
                  className="input mono"
                  value={code}
                  placeholder="REG_007"
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  // Not normalised while typing: deleting the hyphen out
                  // of "SOE-" as it is typed fights the user. The line
                  // below shows where it will land.
                  style={{ width: 110, flex: 'none' }}
                />

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={addVariable}
                  disabled={!canAdd || adding}
                  style={{ flex: 'none' }}
                >
                  {adding ? 'Copying…' : 'Add'}
                </button>
              </div>

              {/* A disabled button with no reason is the worst case here:
                  everything looks filled in and nothing happens. */}
              {!chosenDimension || !code ? (
                <div className="muted-55" style={{ fontSize: 11.5 }}>
                  {!chosenDimension
                    ? 'Name the dimension this variable belongs to — the engine reads it from the folder path.'
                    : 'Give it a code: three letters and three digits, like SOE_001.'}
                </div>
              ) : (
                <div className="muted-55" style={{ fontSize: 11.5 }}>
                  Copied to{' '}
                  <span className="mono">
                    in/{canonicalDimension(chosenDimension)}/{canonicalCode(code)}/
                  </span>{' '}
                  — the engine reads a variable's dimension and code from that path.
                </div>
              )}
            </div>
          )}

          <div className="path-add-status">
            {locked && <span className="muted-55">Data is locked while a run is going.</span>}
            {!locked && checking && <span className="muted-55">Checking…</span>}
            {!locked && !checking && plan?.problem && (
              <span className="path-add-problem">{plan.problem}</span>
            )}
            {/* Its own block, not a span: the server's refusals can carry a
                command to run, and a command folded into a paragraph is one
                nobody can copy. */}
            {addError && <div className="path-add-error">{addError}</div>}
            {browsing && <span className="muted-55">Waiting for the folder chooser…</span>}
            {!browsing && !locked && !checking && !plan && !addError && showHints && (
              <span className="muted-55">
                Browse for a folder, or paste a path — <span className="mono">~</span> and
                environment variables work.
              </span>
            )}
          </div>
        </div>

        {variables.length > 0 && (
          <div className="folders">
            <div className="folders-head">
              <h4>In this project</h4>
              <span className="muted-55" style={{ fontSize: 12 }}>
                {variables.length} variable{variables.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="folders-list">
              {variables.map((variable) => (
                <div
                  key={variable.id}
                  className={`folder-row${locked ? ' is-locked' : ''}${
                    variable.problem ? ' is-unreadable' : ''
                  }${variable.processedOnly ? ' is-unreadable' : ''}${
                    removing === variable.id ? ' is-going' : ''
                  }`}
                >
                  <Icon
                    name="file"
                    size={18}
                    color={
                      variable.problem ? 'var(--color-accent)' : 'var(--color-accent-600)'
                    }
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="folder-name">
                      <span className="mono variable-code">{variable.code}</span>
                      {variable.filename || 'nothing readable'}
                    </div>
                    <div className="folder-meta muted-50">
                      <span className="mono">{variable.dimension}</span>
                      {variable.processedOnly && ' · results only'}
                      {variable.source && (
                        <>
                          {' · from '}
                          <span className="mono" title={variable.source}>
                            {variable.source.split('/').pop()}
                          </span>
                          {/* The copy is what gets processed, so a moved
                              source is worth noting and nothing more. */}
                          {variable.sourceMissing && ' (moved since)'}
                        </>
                      )}
                    </div>
                  </div>

                  {removing === variable.id ? (
                    <span className="muted-55" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                      Removing variable…
                    </span>
                  ) : variable.processedOnly ? (
                    <span className="tag folder-missing-tag" title={variable.problem}>
                      No input
                    </span>
                  ) : variable.problem ? (
                    <span className="tag folder-missing-tag" title={variable.problem}>
                      Will be skipped
                    </span>
                  ) : (
                    <span className="muted-55" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                      {variable.format} · {formatSize(variable.sizeBytes)}
                    </span>
                  )}

                  {/* One at a time: each removal starts its own container, and
                      two at once would have them racing over the same tree. */}
                  {!locked && (
                    <button
                      type="button"
                      className="btn btn-icon btn-secondary"
                      aria-label={
                        removing === variable.id
                          ? `Removing ${variable.id}`
                          : `Remove ${variable.id}`
                      }
                      onClick={() => removeVariable(variable)}
                      disabled={removing !== null}
                      style={{ width: 30, height: 30, borderColor: 'transparent' }}
                    >
                      {removing === variable.id ? (
                        <Icon name="spinner" size={15} className="spin" />
                      ) : (
                        <Icon name="close" size={15} />
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {blocked.length > 0 && (
          <div className="folder-alert">
            <div className="folder-alert-body">
              <strong>The engine could not be started</strong>
              {blocked.map((problem) => (
                <span key={problem} className="muted-55">
                  {problem}
                </span>
              ))}
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setBlocked([])}>
              Dismiss
            </button>
          </div>
        )}

        {run && (
          <div className="card elev-sm process-card">
            <div className="process-head">
              {running ? (
                <Icon name="spinner" size={20} color="var(--color-accent)" className="spin" />
              ) : (
                <Icon
                  name={run.status === 'done' ? 'check' : 'close'}
                  size={18}
                  color={
                    run.status === 'done'
                      ? 'var(--color-accent-2-800)'
                      : 'var(--color-accent-700)'
                  }
                  strokeWidth={3}
                />
              )}
              <div className="process-status">{run.statusText}</div>
              <div className="muted-55" style={{ fontSize: 13 }}>
                {run.percent}%
              </div>
              {running ? (
                <button
                  type="button"
                  className="btn btn-secondary process-abort"
                  onClick={abort}
                  disabled={aborting}
                >
                  <Icon name="close" size={13} />
                  {aborting ? 'Stopping…' : 'Abort'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary process-abort"
                  onClick={() => setRun(null)}
                >
                  Dismiss
                </button>
              )}
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-valuenow={run.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="progress-bar" style={{ width: `${run.percent}%` }} />
            </div>

            <div className="process-meta">
              <span className="muted-55">
                {running
                  ? runNote(run)
                  : `Finished in ${formatDuration(run)}.`}
              </span>
              {run.executionId && (
                <span className="muted-55 mono" title="The engine's own id for this run">
                  {run.executionId}
                </span>
              )}
            </div>

            {/* The engine does not stop for one damaged file — it logs it and
                carries on, so a run can succeed with variables missing. That
                has to be said out loud or the "all done" dialog is a lie. */}
            {(run.erroredFiles > 0 || run.skippedFiles > 0) && (
              <div className={run.erroredFiles > 0 ? 'process-warn' : 'muted-55'}>
                {run.erroredFiles > 0 && (
                  <>
                    {run.erroredFiles} {run.erroredFiles === 1 ? 'file' : 'files'} could not be
                    processed — the engine carried on without{' '}
                    {run.erroredFiles === 1 ? 'it' : 'them'}.{' '}
                  </>
                )}
                {run.skippedFiles > 0 && (
                  <>
                    {run.skippedFiles} already up to date, so{' '}
                    {run.skippedFiles === 1 ? 'it was' : 'they were'} left alone.
                  </>
                )}
              </div>
            )}

            {run.error && <pre className="process-error">{run.error}</pre>}

            <button
              type="button"
              className={`process-stages-toggle${showStages ? ' is-open' : ''}`}
              onClick={() => setShowStages((open) => !open)}
            >
              <Icon name="chevronRight" size={13} strokeWidth={3} />
              {showStages ? 'Hide steps' : `Show all ${run.stages.length} steps`}
            </button>

            {showStages && (
              <ol className="process-stages">
                {run.stages.map((stage) => (
                  <StageRow key={stage.key} stage={stage} />
                ))}
              </ol>
            )}
          </div>
        )}

        <div className="process-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={variables.length === 0 || locked}
            onClick={startProcessing}
            style={{ height: 44, paddingInline: 26, fontSize: 15 }}
          >
            {starting ? 'Starting…' : phase === 'done' ? 'Process again' : running ? 'Processing…' : 'Process'}
          </button>
          {/* Beside the button that starts the run, because the resolution
              is a property of the run and this is the last moment it can be
              chosen without reprocessing everything. */}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowSettings(true)}
            disabled={locked}
            style={{ height: 44, paddingInline: 18, gap: 8, flex: 'none' }}
          >
            <Icon name="sliders" />
            Resolution
          </button>
          {showHints && (
            <span className="muted-55" style={{ fontSize: 12.5 }}>
              {processHint}
            </span>
          )}
        </div>
      </div>

      {showComplete && (
        <Dialog
          onClose={() => setShowComplete(false)}
          width="min(430px, 100%)"
          style={{ alignItems: 'flex-start' }}
          labelledBy="complete-title"
        >
          <div className="complete-icon">
            <Icon name="check" size={26} color="var(--color-accent-2-800)" strokeWidth={3} />
          </div>
          <div className="dialog-title" id="complete-title">
            All done
          </div>
          {/* Deliberately not "N folders converted": the folder count is our
              own record, not what the engine did with it — one folder can
              hold a dozen variables, and the engine reads its whole input
              tree regardless of what we listed. The hexagon count comes from
              the stage that built the table, so it is the engine's own. */}
          <p className="dialog-body" style={{ margin: 0 }}>
            {run?.hexagonCount
              ? `Your data is on ${run.hexagonCount.toLocaleString()} hexagons. `
              : 'Your data has been converted. '}
            {run && run.erroredFiles > 0
              ? `${run.erroredFiles} ${run.erroredFiles === 1 ? 'file' : 'files'} could not be processed — the rest is ready to explore on the map.`
              : 'Every variable is ready to explore on the map.'}
          </p>
          <div className="dialog-actions" style={{ alignSelf: 'stretch' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setShowComplete(false)}>
              Stay here
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setShowComplete(false);
                goTo('map');
              }}
            >
              View Map
            </button>
          </div>
        </Dialog>
      )}

      {showSettings && project && (
        <SettingsDialog projectId={project.id} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
