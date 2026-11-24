# Maphex — SIG UI

Local interface for the H3 multicriteria pipeline: add your data, process it,
score a model over it, and look at the result on a map. It drives the engine
in the sibling **SIG-Transformer** checkout — the engine does the work, this
runs it and shows what it did.

```
SIG-UI/
├── design/      the source mockup (Maphex.dc.html + the Organic design system)
├── backend/     FastAPI — projects, data, the engine, the model file
│   ├── app/         one module per concern; see the sections below
│   ├── reference/   vendored Natural Earth 110m countries (820 kB): names fallback, old mesh ids
│   └── tests/       pytest: meshes, uploads, what a mesh without a sea refuses
├── data/        projects.csv + folders.csv (git-ignored, machine-specific)
├── frontend/    React + Vite + TypeScript
│   └── tests/       browser checks against the running app
└── README.md
```

Almost nothing is mocked any more — see
[what is real](#what-is-real-and-what-is-still-mocked).

## The map is rendered by the engine, not by us

The engine emits a finished pydeck HTML document per layer, and the map screen
drops it into an `<iframe>`. The UI never receives per-hexagon values and never
paints a map — a full mesh as JSON would be tens of megabytes to serialise,
transfer and re-draw, where the generated document is already a map the browser
can stream and cache.

The documents are read out of the project's own `out/` folder and served by
`GET …/layers/{nodeId}/document`, so nothing has to be copied anywhere for the
map to find them. (An earlier arrangement served a repo-level `HTML/` folder
through a Vite plugin; both are gone. A leftover `HTML/` directory in a
checkout from back then is dead weight and can be deleted.)

An iframe rather than injected markup, because each document:

- is a complete HTML page that sets `body { margin:0; overflow:hidden }` and
  sizes its canvas with `100vw/100vh`, which would fight this app's layout;
- loads its own deck.gl and mapbox-gl from a CDN, and two deck.gl runtimes in
  one document collide over globals and WebGL contexts;
- is megabytes of inlined data that must not pass through React state.

It runs under `sandbox="allow-scripts"`, so the document cannot read
`window.parent` and storage access throws — pydeck runs fine under that.

Because the document owns its own pan, zoom, tooltip, legend and opacity
control, the app adds no map chrome of its own. Anything drawn on top would
duplicate or contradict what is inside it.

## Everything with one `docker compose up`

With both checkouts side by side (see below) and the engine's `.env` in
place, this folder's `docker-compose.yml` brings up the whole application:

```bash
cd SIG-UI
docker compose up        # add -d to leave it in the background
```

Then open <http://localhost:8765>. Three containers:

| container | what it is |
|-----------|------------|
| `sig_db`  | Postgres/PostGIS, from the engine's compose file |
| `sig_app` | the engine, idle until a run execs into it, from the same file |
| `maphex`  | this UI, built and served by its FastAPI backend |

The engine's `docker-compose.yml` is pulled in with `include:`, unchanged,
and its `.env` still configures Postgres and the engine. The project name is
`sig-transformer`, the one the engine always had, so the existing database
volume (`sig-transformer_pgdata`) is the one used. If the engine's `.env`
sets `COMPOSE_PROJECT_NAME`, put the same line in a `SIG-UI/.env`.

How it works, and what it asks of you:

- **Run it from `SIG-UI/`.** The backend drives the engine with `docker
  compose`, as it does outside Docker, through the host's Docker socket. The
  folders it hands to compose are resolved by the host's daemon, so they must
  have the same path inside the container as on the host: your home is
  mounted at its own path, and `$PWD` tells the container where `SIG-UI` is.
  Project folders and data folders therefore have to be under your home
  (or under `MAPHEX_HOST_ROOT`, if you set it in `SIG-UI/.env`).
- The backend runs as whoever owns `SIG-UI/` on the host, so what it writes
  stays yours.
- The engine somewhere other than `../SIG-Transformer`: set
  `SIG_TRANSFORMER_DIR` in `SIG-UI/.env`. Another port: `MAPHEX_PORT`.
- The folder picker opens a Windows dialog from WSL, which a container
  cannot do; type or paste the path instead.
- After changing the UI's code: `docker compose up --build`.
- The image's `docker compose` is pinned to the host's version
  (`COMPOSE_VERSION` in the `Dockerfile`). When Docker Desktop updates it,
  rebuild with `--build-arg COMPOSE_VERSION=v…`; until then each side
  recreates `sig_app` (harmlessly) after the other has touched it.

The sections below are the setup without Docker for the UI, for development
with Vite's hot reload.

## A clean start

Four things have to be in place, and the order matters — the engine holds the
state, so it goes first.

### 1. The engine, beside this checkout

```
Vento/
├── SIG-Transformer/   the engine
└── SIG-UI/            this
```

Siblings, because that is where the backend looks. Somewhere else is fine if
you say so:

```bash
MAPHEX_PIPELINE_DIR=/path/to/SIG-Transformer ./run.sh   # in backend/
```

**Use the engine's `main`, from 2026-11-18 on.** It carries what this app
needs: the lint leaves the pipeline's own outputs alone, `pyarrow` is held
below 26, `run_full.sh` honours the `DATA_DIR` it is given, step 13.5 fills
each variable's gaps from a `transform.yaml`, and every run writes a
`run_report.yaml` (2026-11-03); the value column of a file with several
(`app/tools/value_columns.py`), the model's status
(`MCDA/engine/model_status.py`) and container sizes fitted to the machine
(`app/tools/machine_resources.py`) (2026-11-05); and the map tooltip with the
hexagon's H3 code, which the legend reads (2026-11-18). An older engine still
runs, but those parts go quiet: no value-column dialog, no status notice, no
fitting, and a legend titled from the data instead of the tooltip. Its outputs
and settings are in English since 2026-11-03 (the model's maps are under
`criteria/`, `RESET_FILES` replaced `RESET_ARCHIVOS`); see
[Working with the current engine](#working-with-the-current-engine). The old
`fix/compatibilidad-maphex` branch is no longer needed, except for its
dependency lock.

Then its configuration and its data:

```bash
cp .env.example .env     # then set POSTGRES_USER / PASSWORD / DB
docker compose up -d     # builds the image the first time; it is not quick
```

The engine's `.env.example` is in sections and says what each value does and
when a change takes effect. Keep its `COMPOSE_PROJECT_NAME` on an existing
install: it names the database volume. The container sizes (`APP_*`, `DB_*`,
`MAX_*`) are lowered to what Docker has on the machine (`FIT_TO_MACHINE=1`,
the default). The engine's runners do it themselves, and so does this app
when it brings the containers up (`pipeline.compose_up` asks the engine's
`app/tools/machine_resources.py`). `FIT_TO_MACHINE=0` in the engine's `.env`
uses the sizes as written.

Meshes other than Colombia need the engine from 2026-11-20 on: it reads the
`MESH_*` variables this app passes (see [Meshes](#meshes-the-area-the-engine-builds-over))
and vendors the Natural Earth 10m countries the picker lists
(`admin/in/natural_earth/ne_10m_admin_0_countries.parquet`). An older engine
ignores them and builds Colombia whatever was picked.

`admin/in/dane_mgn2024/` has to hold the DANE boundary shapefiles. They are
~108 MB and not in git — ask whoever has them. Without them there is nothing
to build the hexagon master table from, and processing stops at the first
step. The maritime polygon beside them *is* in the repository.

### 2. The backend

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./run.sh
```

Python 3.12 or newer: a clean install with 3.14 (what a current Arch ships as
`python3`) works as written. Every version in `requirements.txt` is exact,
including the resolved ones; see the note at the bottom of that file before
changing any.

### 3. The frontend

```bash
cd frontend && npm install && npm run dev
```

Opens on http://localhost:5173; Vite proxies `/api` to uvicorn on **:8765**.
The UI needs the backend — without it the projects list cannot load, and says
so.

Port 8000 is crowded, so the default is 8765. To move it, set `MAPHEX_PORT`
for **both** processes — `backend/run.sh` and `vite.config.ts` read the same
variable:

```bash
MAPHEX_PORT=9000 ./run.sh          # in backend/
MAPHEX_PORT=9000 npm run dev       # in frontend/
```

`npm run build` emits `frontend/dist`, which the backend serves at `/` when it
is present. It is a snapshot: after pulling, build again (or delete `dist/`),
or `:8765/` keeps serving the interface as it was the day it was built. In
development use `:5173`, which is always the current code.

### 4. The first project

In the app: **New project** → name it, pick the area, and choose a folder for
it to live in. That folder is the engine's `DATA_DIR` — everything for the
project goes under it, and the Data screen shows the path.

The resolution is worth settling here rather than later: it decides the size
of every hexagon the first run computes, and changing it afterwards rebuilds
the master table and reprocesses everything. **Resolution** on that screen,
and again beside Process.

Then **Data** → point at a folder holding one variable, or at a folder of
them, and press **Process**. The first run builds the H3 master table and
takes minutes; later ones reuse it.

### What the app writes outside its own checkout

Worth knowing before pointing it at an engine you care about:

- **the engine's `.env`** — `H3_RES` and `RENDER_H3_RES`, set from the
  project's settings before a run, and the app container recreated when they
  change. See [Settings reach the engine](#settings-reach-the-engine-through-its-env).
  Only the value is replaced: the line's comment and an `export` stay, and the
  file is swapped in whole (it holds the engine's credentials) with its
  permissions kept. The engine's own projects are not affected as long as
  they set `h3_resolution` and `map_resolution` in their `project.yaml`
  (Colombia does); one that leaves them out takes whatever Maphex last wrote.
- **the engine's container, left on this project.** Processing and model runs
  recreate it mounted on the project's folder and database, and nothing puts
  it back. Both bring it up with the same configuration for a project (its
  folder and its own `DATABASE_URL`, as `run_full.sh` does), so going from
  processing to a model run and back does not recreate it; a change of
  project does. The engine's `./MCDA/run_mcda.sh` does not start the containers,
  so after a run here it has to check what it finds before scoring.
- **the project's folder**: `in/`, `out/`, `model/model.yaml`,
  `config/transform.yaml`, `MCDA/runs/`, and `mesh/` for a project created on
  an uploaded mesh. All of it the engine's doing except the model file,
  `config/transform.yaml` (rewritten from each variable's fill before every
  run) and the mesh, copied in when the project is created and again before a
  run if it has gone. A file already in `mesh/` under the same name is never
  overwritten when it differs: the run is refused, saying which file.
- **`data/*.csv` here**: the project list, where each variable was copied
  from, each variable's fill when changed from the default
  (`variable_settings.csv`), the value column chosen for a file with
  several (`value_columns.csv`), and the processing runs started for each
  project (`runs.csv`). The engine's logs do not say which project a run was
  for, so after a restart that list is how the Data screen tells its own last
  run from one started in a terminal, a model run, or another project's.
  Uploaded meshes are kept under `data/meshes/<id>/`, one folder each with an
  `upload-record.json` saying what was found in it (a name no upload can
  take; uploads from before it kept theirs in `mesh.json`). A project uses
  its own copy, so an upload no project was created on can be deleted by
  hand, and deleting the last project on an upload deletes the upload.

A project counts as processed (the projects list says *Processed* and opens
on the map) once any of its variables has a map under `out/`, whoever drew
it.

Every pipeline run exports another master table into `out/maestro/`; the
engine's model runner takes the newest one itself, so nothing is moved.

Nothing is written to the folders variables were imported *from*. Those are
read and copied, never moved or changed.

## Checking it still works

The backend has tests of its own, which need nothing running and never touch
the engine (they point it at an empty folder):

```bash
cd backend
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```

The rest are browser checks:

```bash
cd frontend && npm test            # all of them
npm test -- map                    # only the suites whose name matches
```

Both processes have to be up, because nothing in these is stubbed: they drive
a real browser against the real backend against the engine's real output. That
is the point. Almost everything that has gone wrong in this app was not logic
but the seam between the three — a document the engine writes differently than
expected, a control covered by an overlay, a run whose files are owned by root
— and only the running thing shows that.

A fresh checkout needs the browser once:

```bash
npx playwright install chromium
```

The suites are in `frontend/tests/`, one file per area, with `harness.mjs`
shared between them. Each prints a line per check and keeps going after a
failure: when something breaks it is far more useful to see all twelve things
that changed than the first one. A failing suite leaves a screenshot in
`frontend/tests/failures/` — half of what goes wrong here is layout, and
nothing shows that as fast as looking.

They need a project with processed variables, and they find one themselves
rather than naming an id, since those are per machine. With nothing processed
anywhere they say so and skip. Anything a suite writes — it breaks the model
file on purpose, to check the message — it puts back in a `finally`, and says
whether it managed to.

They run one at a time: each drives a whole browser against one backend, and
two of them would be writing the same project's model file.

## What is real and what is still mocked

| Area | State |
|---|---|
| Projects, data folders, meshes, path checking | **Live** — FastAPI, stored in `data/*.csv` |
| Meshes: Colombia (DANE), Natural Earth, geoBoundaries, uploads | **Live**: passed to the engine as `MESH_*` with every run |
| The model file, and running the model | **Live** — a YAML file under the project's folder, run with `MCDA/run_mcda.sh` |
| Processing | **Live** — `run_full.sh`, watched stage by stage |
| The layer tree and the rendered maps | **Live** — discovered from the project's `out/` folder |
| Project settings | **Live** — two resolutions, written into the engine's `.env` before a run |
| The model examples | Mocked in `frontend/src/api/mock/` |

That is all that is left of the mocks: the examples are UI copy with nowhere
else to live yet.

## What is a variable, and what is the engine's own working file

Everything under `out/<dimension>/<CODE>/` looks like a variable, and most of
it is. Some of it is the engine talking to itself: `distancias/` is where the
model run's distance preprocess writes a folder per column, `mascaras/` holds
the exclusion masks, `_impute_cache/` is a cache.

`outputs.ENGINE_FOLDERS` is the list, and `is_variable_folder` the test —
leading `_` and `.` excluded by shape so the next cache does not have to be
found the hard way.

It lives in one place because it used to live in three, and all three had
drifted. None of them knew about `distancias`, so after a model run six of
its intermediates appeared on the Data screen as variables with no input,
and again in the failures panel as variables that had not finished. The real
failures were underneath them.

This has to track what the engine writes. The engine keeps its own version of
the same list — `_SKIP_DIRS` in `MCDA/engine/distance_to_nearest.py` — worth
comparing against when it gains a step.

## Why a variable did not make it through

A run reports a count — "4 files could not be processed" — and that is all it
ever said. Which four, and why, was not in the app anywhere, and the number
was gone as soon as the next run started.

The answer was already on disk. The engine carries on past a file it cannot
read, and leaves the reason where the output should have been:

* `out/<dimension>/<CODE>/<stem>.pipeline.jsonl` — one JSON line per stage,
  with `status` and, when it failed, `details.error`;
* `out/<dimension>/<CODE>/<stem>.error.txt` — ingest's own note, with
  `Motivo:`. Older than the JSONL and still the only record on a project
  processed before it existed, so it is read as a fallback.

`outputs.scan_problems` walks that and reports a variable whose first
failing stage says so. First, not last: a variable that fails at ingest has
nothing to render either, and being told about the render is being told about
the symptom.

It cannot be done with `scan_variables`, which walks rendered documents — a
variable that failed before the render has none, which is exactly the case
worth reporting. Nor is diffing inputs against rendered maps enough: it finds
*which* ones are missing but not *why*, and the why is the part nobody can
guess.

Two outcomes are told apart. An `error` is the engine saying so, with its own
words quoted rather than translated. `unfinished` is a variable whose chain
simply stops — no render, and nothing claiming to have failed — which is what
an interrupted run leaves behind, and wants processing again rather than
investigating.

Read off disk on every visit, so it survives a reload and a project opened a
week later still says what is wrong with it.

It sits below the variables and above the Process button, which is the order
of the thing: what the last run did, then the button that starts the next.
And the "all done" dialog admits when it is not — a different title, the
accent rather than the sage, and the count called out in its own box. A run
that lost four variables dressed exactly like one that lost none is how four
failures go unread, and the engine carrying on past a bad file means this is
the only moment anything says so.

## A variable's code comes from its folder, and is shown

The engine reads a variable's identity out of the folder it sits in:
`in/<dimension>/<CODE>/`, and `format_code` uppercases the leading
`abc_123`. So the folder name is what a suggested code is taken from — the
file inside may be called anything, and often is.

**A code is spelled the way the engine's lint leaves it.** Every run starts
with `lint_filenames`, which renames everything under `in/`: the name in
lower case, accents dropped, `&` and `@` spelled out, anything else that is
not a letter or digit one underscore, and on a folder the leading `abc_123`
back in capitals. So the folder `TEC_001_SV003` becomes `TEC_001_sv003` on
the first run, and a variable recorded under the first name stops matching
itself. `normalise_code` gives that spelling up front (the identity in
capitals, the tail in lower case), and files are copied under the names the
lint would give them (`Zonas.SHP` arrives as `zonas.shp`, its `.dbf` with
it), so nothing in the tree is renamed under the app. `inputs.engine_name` is
a copy of the lint's `sanitize_name`, checked against it; re-read the two
side by side when the engine's changes.

A code may carry a tail. `SOE_001_poblacion` is as good a folder name as
`SOE_001`: the engine reads the identity off the front, keeps the rest, and
makes a column out of the whole thing. `CODE_PATTERN` allows it up to
`MAX_CODE_LENGTH`, which is 32 — nothing in the engine stops a longer one,
since it becomes a Postgres column name and those run to 63, but past that
it stops being readable in the model file, on the map and in a folder
listing, which is most of what a code is for.

The same rule lives in two places and has to stay in step: `normalise_code`
on the server, and `canonicalCode` in the Data screen, which previews where
a variable will land before it is copied.

**The map names a variable by its code and nothing else.** The label is
`_humanise` of the processed file's name, which is not always a name anyone
chose — a real project here has three variables whose labels come out as
`A`, `At` and `At`, two of them identical. That is no use for telling two
rows apart, which is all the list is for, so the code is the row and the
label stays on the hover title. The heading over the map is the code too,
with the dimension under it.

Model layers have no code — their labels are the criterion keys from the
config, which someone did choose — so those show as they are.

## A folder of variables, not just a folder that is one

The engine's input tree is `in/<dimension>/<CODE>/<one dataset>`, so adding a
variable means pointing at a folder with one dataset in it. Pointing at the
folder *above* — the one holding all of them — now works too, and `plan` works
out which it is:

* one dataset at the top level, nothing below → one variable, exactly as before;
* folders with one dataset each, at any depth → a variable per folder;
* several datasets side by side → a variable per dataset. This one used to
  be refused outright, with a message saying to add them one folder at a time.

At any depth because the engine reads at any depth (see
[Nested variables](#nested-variables-read-at-any-depth)). The walk stops six
folders down and after 5000 folders, so a home directory picked by mistake
answers with a message instead of hanging the screen.

Codes are suggested across the whole batch at once, so each misses both what
is already on disk and what the rows above it were given — a rule one
function (`_next_code`) applies for a single variable and a batch alike, so
they cannot drift apart.

A subfolder with nothing readable is left out silently: a folder of variables
usually has a `docs` or a `.git` beside them, and those are not failures. A
subfolder with *several* datasets gives a row per dataset, the same as
several datasets side by side at the top: dropping it quietly is how one goes
missing.

The import is one request, and it does not stop at the first failure. The
others are fine, and re-picking the folder to retry the rest would be worse
than being told which one to look at — so it always answers 201 with what it
did, per variable.

## A model run outlives the screen that started it

Applying takes minutes, and the engine carries on whatever you do next. The
progress dialog used to be a wall — `onClose={() => {}}`, no way past it —
and the watch lived inside the Model screen, so leaving lost track of a run
that was still going. The engine kept working; the app simply stopped
looking.

The watch is in `lib/model-run.ts` now, above the screens. Three things read
it:

- the **Model screen**, whose Apply button becomes `Applying… 40%` and
  reopens the dialog rather than starting a second run;
- the **header**, which carries a chip on every other screen — without it a
  hidden run would be invisible and there would be no way back to it;
- the **app shell**, which renders both dialogs, so a run that finishes while
  you are on the Map still says so there.

A subscribable module rather than context, for the same reason the draft is
one: it ticks once a second, and in context every screen would re-render with
it. `useSyncExternalStore` means only those three do.

Opening a project asks whether a run is already going and picks it back up,
so a reload mid-run does not lose it — the same thing the Data screen has
always done for processing.

Two things follow from the app no longer being held still. The Data screen
counts a model run as the engine being busy, because the server refuses a
second run whatever starts it — one database, one container — so Process
would otherwise look live and answer with an error. And the header chip stays
off the Model screen, where the Apply button is already saying it.

## Model runs pile up, and only the newest is reachable

Every Apply writes a whole set of rendered maps — the model, each criterion,
each subcriterion — into `MCDA/runs/<id>/`, and nothing removes them. Only
the newest is ever drawn: `outputs.scan_model` takes `runs[0]` and nothing in
the app asks for another, so every older run is already invisible.

Measured on the project this was written against: three runs at 191 MB each,
against 31 MB of input and 145 MB of pipeline output. Two thirds of the
project was in folders that could not be opened from anywhere.

The Model screen says so once there is more than one — a single run is just
the result — and the dialog behind it lists them with what each costs, marks
the one the map draws, and removes them one at a time or all but the newest.

Removing is offered, not done. These are results, and which of them is worth
keeping is not a judgement to make quietly on someone's behalf — the same
reason removing a variable asks first. A sweep is clamped to keep at least
one: a clean-up that left nothing to look at would be a strange thing to call
a clean-up.

They belong to root, like everything the engine writes, so removal goes
through a container — and all of them go in *one* container, because
`compose run` takes a few seconds to start and removing six runs one call at
a time would spend most of its time starting containers. The ids are resolved
against what is on disk first (`outputs.model_run_path` only returns folders
it has just listed), which is a stronger guarantee than quoting them into a
shell.

## Settings reach the engine through its `.env`

Two settings do anything: the resolution the data is computed at, and the one
the maps are drawn at. They are stored per project, as `h3_res` and
`render_h3_res` in `projects.csv`, and blank means "whatever the engine is
configured with" — which is what a project that has never been touched
reports, read from the engine's own `.env`.

They are *applied* when a run starts, by writing that `.env` and recreating
the app container. Both parts are necessary:

- **Writing the file.** Every route into the container leads back to it:
  compose interpolates `${H3_RES}` into the app service's `environment:`
  from `.env`, and `env_file: .env` supplies the rest, `RENDER_H3_RES` among
  them. `H3_RES` is the one that bites — `run_full.sh` compares the *host*
  value against what the last master build recorded and rebuilds when they
  differ, but never forwards it to the container; it is not in that script's
  `FORWARD_VARS`. So exporting a different value without writing it to
  `.env` would have the script rebuild the master on every run forever,
  comparing a number the build never sees against the one the build keeps
  writing.
- **Recreating the container.** Both of those are resolved when the
  container is created, so one that is already up keeps the environment it
  started with however many times `up -d` runs. It is recreated only when the
  file actually changed, which is why `write_env_values` returns whether it
  did.

`RENDER_H3_RES` is forwarded by `run_full.sh`, but `MCDA/run_mcda.sh`
forwards nothing but the execution id — so the model run's maps read it from
the container too, and the file is the one mechanism that covers every path.

Because the engine has one `.env`, these are really properties of the engine
as it is configured right now; keeping them per project means "set the engine
to this before running this project". Each project has its own database, so
its master is built at its own resolution and kept between its runs. The engine notices and does it; `settings.save` marks
the project stale so our own record of what the database holds is cleared
with it.

**Five switches go with every run**, stored per project beside the
resolutions (`export_csv`, `mcda_tables_csv`, `keep_awake`, `mcda_stats_csv`,
`map_tooltip_h3` in `projects.csv`) and shown under *With every run* in the
same dialog. None changes a result. Each has its own default: blank in the
store is the default, `1` on and `0` off, so a change of default reaches
every project that never chose. The ones that cost disk or time are off; the
H3 code in the tooltips is on, as the engine has drawn its maps since
2026-11-20.

| Switch | Passed as | What it does |
|---|---|---|
| Master table as CSV | `EXPORT_CSV` | Each processing run writes the master as a CSV beside its parquet. Gigabytes on a real project |
| Model tables as CSV | `MCDA_TABLES_CSV` | Each model run writes its criteria and subcriteria tables as CSV |
| Score statistics | `MCDA_STATS_CSV` | Each model run writes `aggregate/stats.csv`: count, range, mean, deviation and quartiles of the global score, each criterion and subcriterion |
| H3 code in the map tooltips | `MAP_TOOLTIP_H3` | On by default. Every map's tooltip names the hexagon under the cursor by its H3 code; changing it redraws the maps on the next run |
| Keep the computer awake during runs | `KEEP_AWAKE` | The runner holds off sleep (`systemd-inhibit`) while it works |

They are passed in the environment of the run, as `1` or `0`, rather than
written into `.env`: both runners take them from there, and a value given
explicitly wins over the engine's `.env`, so off here means off. Saved on
their own route (`PUT …/settings/options`) so that turning one on does not
pin the resolutions to today's engine numbers; "Default values" puts them
back on their defaults along with unpinning the resolutions.

The coordinate system is shown and not offered: the engine works in WGS 84
throughout. There was also a *pipeline version* offering a choice between
three invented version strings; the engine has no versioning, so it is gone.

**Where the dialog is reachable from matters.** The processing resolution
decides the size of every hexagon the first run computes, and changing it
afterwards rebuilds the master and reprocesses everything — so it has to be
settable *before* that run. It is on New project (chosen there, written to
the project once it is created, since there is nothing to attach it to
before), beside Process on the Data screen, and on the Map. The Map alone
would be too late: you only get there by processing first.

**Changing a resolution does not change anything already processed**, and
the dialog says so rather than closing as if it had. The values keep the
hexagon size they were computed at; the maps keep the size they were drawn
at. Both need the variables processed again — including the visualization
one, because `render_html.py` skips a map that is newer than the parquet
behind it, so a bare re-run will not redraw it. After saving, the dialog
stays open to say what is still to do, with a button that goes to the screen
with Process on it. Only when there is something at the old resolution:
`hasResults` says whether there is, and on an empty project changing a
number costs nothing.

The dialog always says which of its two states it is in — *Default values*
or *Set for this project* — because the "Default values" button only exists
when there is something to go back from, and a button that is simply absent
explains nothing. The field is still `followingEngine` in the API: the label
is what reads best on screen, the field says what it actually means, which is
that the project tracks the engine rather than holding a copy of today's
numbers.

## The engine's own settings

Everything else in the engine's `.env` is the machine's, not a project's: the
size of its containers, Postgres tuning, the workers of each stage. **Engine
settings**, on the project list, shows all of it (`GET /api/engine/config`)
and writes what is changed (`PUT /api/engine/config`, `engine_config.py`).

- **Where the list comes from.** The defaults are the engine's own
  `.env.example`; a setting it shows only commented out is off by default. The
  labels and descriptions are ours, in English. A setting the engine has and
  the list does not know still appears, under *Other settings*.
- **Shown and not offered**, each with its reason: the connection (user,
  password, database, port, URL), because Postgres created the database with
  them; the Docker project name, which names the database's volume; and the
  two resolutions, which each project sets for itself. The password is never
  sent to the browser.
- **Checked before writing**: the form of each value (`8g` for Docker, `512MB`
  for Postgres, `30min`, a number in range, one of the choices, a path with
  nothing bash would expand) and the two rules that tie settings together
  (the minimal WAL level needs 0 WAL senders; shared buffers no more than 40%
  of the database's memory).
- **Written in place**: a line keeps its position and its comment; a new one
  goes at the end under a note saying who wrote it; *Default* writes the
  engine's default back, or removes the line for one that is off or worked
  out by the engine by default (blank workers).
- **Never during a run** (409): the runners read the file as they start, and
  the database settings recreate its container on the next run.

## The model says when its map is out of date

The model scores the master table, and every processing run builds a new
one; a model run made before it is still what the map shows. Two things can
make it stale, and the Map and the Model screen say so
(`ModelStatusNotice`, from `GET /api/projects/{id}/model/status`):

- **The data moved under it.** The engine checks that itself: at the end of
  processing, and after each model run, its `model_status.py` compares the
  columns of the master each model last ran on with the current one, weighs
  each changed column by what it is to the model (a scored leaf, an
  exclusion, an alert, a leaf weighted zero), and writes
  `out/model_status.json`. For this app's projects, which load none of the
  engine's own, every run is told where the model is
  (`MCDA_STATUS_CONFIG=/data/model/model.yaml`) and where its runs are
  (`MCDA_RUNS_DIR=/data/MCDA/runs`); without a model file nothing is passed.
- **The model file moved.** Saved since the last Apply. Checked here, not by
  the engine, because it changes the moment the file is saved: the file
  against the copy the last run kept (`config_used.yaml`), compared parsed,
  so a comment or spacing is not a change.

How loudly it speaks follows how much it matters:

| Status | Meaning | On screen |
|---|---|---|
| `rerun` | a scored column changed, or the model file did | a strong notice with Apply |
| `remask` | only exclusions changed: every score holds | a quiet line |
| `alerts_only` | only alerts changed | a quiet line |
| `informative_only` | only leaves weighted zero changed | a note |
| `up_to_date`, `never_run`, `unknown` | nothing to act on | nothing |

The engine's file is only believed about the run it names: one written
before the newest run, about another, says nothing about it (`unknown`).
Apply on the Map runs the model file as it is saved; on the Model screen it
is the screen's own Apply, which writes what is in the editor first.

## The project store

Two CSV files, because the point is that you can open them, read them, and fix
them by hand:

```
data/projects.csv   id, name, mesh_id, mesh_label, mesh_source, mesh_country, mesh_level,
                    mesh_file, mesh_name_field, mesh_code_field, description, out_folder,
                    h3_res, render_h3_res, export_csv, mcda_tables_csv, keep_awake,
                    created_at, updated_at
data/folders.csv    project_id, folder_id, name, path, added_at
```

Two files rather than one so a project with no folders is still a row, and so
neither file needs a column saying what kind of row it is. Writes are
whole-file rewrites through a temp file and an atomic replace — the data is
tiny and single-user, so a crash cannot leave a half-written store.

Override the location with `MAPHEX_DATA_DIR`.

## A project folder is the pipeline's DATA_DIR

The contract's advice for separating projects is to change `DATA_DIR`, so a
project's folder *is* that directory:

```
<project folder>/in/<dimension>/<CODE>/<file>     what the pipeline reads
<project folder>/in/<dimension>/<GROUP>/<CODE>/<file>     the same, nested
<project folder>/out/<dimension>/<CODE>/<file>.h3.html     what it rendered
                                        <file>.h3.parquet
                                        <file>.pipeline.jsonl
<project folder>/out/model_status.json            the engine's check of the model
<project folder>/model/model.yaml                 the model, edited here
<project folder>/mesh/<file>                      an uploaded mesh, as MESH_PATH=mesh/<file>
```

`GET /api/projects/{id}/layers` scans `out/` and returns what is actually
there. Nothing is mocked and nothing is cached — the pipeline writes files,
and this is the same view a person would get listing the folder.

Two things fall out of that shape:

- **Input variables are a list per dimension** because the pipeline writes
  them as a mirror of the input tree, one folder per code (a nested one sits
  in its group, and is listed by its code like any other). The model nests by
  criterion, which is why that side is a tree.
- **A rendered layer is not proof of success.** The pipeline carries on past a
  bad file rather than losing a long run, so each variable's
  `.pipeline.jsonl` is read for its per-stage status and a layer that logged a
  problem is flagged in the sidebar.

Layers are served by `GET …/layers/{nodeId}/document`, which also answers
`HEAD` — the UI checks a document exists before pointing an iframe at it,
because an iframe loads an error page as readily as a map. `HEAD` is answered
with headers alone: Starlette would otherwise send the whole body for it, and
every layer opened would cost its megabytes twice.

### The opacity slider is added on the way out

The engine's documents end with `const deckInstance = createDeck({...})`, and
`backend/app/document.py` appends a slider to them as they are streamed. The
file on disk is untouched, so layers rendered months ago get the control too
and nobody has to re-run a pipeline for a slider.

It works the deck.gl way: `layer.clone({opacity})` + `deckInstance.setProps`,
which multiplies the alpha already baked into each hexagon's colour without
touching geometry or recomputing anything. Not the canvas's CSS opacity —
there are two canvases in that document, and the other one is the basemap.
Dimming it as well would wash out the whole picture rather than the hexagons
sitting on it. (If a future bundle stops exposing `deckInstance`, the fallback
fades deck's own canvas and leaves the `mapboxgl-` one alone.)

Injected rather than drawn over the frame from our side: the document is
sandboxed in an iframe, so a slider outside it would have nothing to talk to.
Only the last few kilobytes of the file are ever held in memory — the control
goes in before `</html>`, which is the only anchor reliably after pydeck's own
script, since it closes `</body>` before it.

### The legend is read out of the data

The same injection adds a legend, top right. The engine writes no key: it
bakes an RGBA into every cell (`_color`) and names the column the map is of
in the tooltip. pydeck has nothing to turn on here — `@deck.gl/widgets` ships
a distance scale bar, not a colour legend — and a widget could not help
anyway, because the document carries colours per cell rather than the scale
they came from. So the legend is derived from the hexagons themselves, which
means every swatch is a colour that is actually on screen and a layer
rendered months ago gets a legend as well.

The tooltip comes in two forms, and the legend reads both. Layers rendered
before 2026-11-18 have it as text, `global: {global} | alerta: {alert}`.
Since then the engine writes HTML, one item per line, with the code of the
hexagon under the cursor first:
`<b>H3 (res 6):</b> {h3_index}<br/><b>global:</b> {global}<br/><b>alert:</b> {alert}`.
Either way the column is the first `label: {column}` item that is not
`h3_index`, and its label titles the legend.

What it draws follows the shape of the column, which is the engine's own rule
(`render_html` treats an integer column with more than twelve distinct values
as continuous) applied to the data rather than to a dtype we can no longer
see:

- up to twelve distinct values, or any text at all: one swatch per value, in
  the colour that value is painted in. On a classified layer the tooltip
  points at the label column, so the legend reads `3C` rather than `11`;
- more than that: a ramp, with the lowest and highest values printed under
  it. The colours along it are sampled from the cells nearest each stop, so
  the ends are the colours of the cells the numbers name;
- cells the engine took out of the measurement — solid black, alpha 220 —
  get their own `Excluded` swatch and are kept out of the range, so a `-1`
  does not drag the low end of an MCDA score down with it;
- the ring the combined MCDA map draws over a flagged cell gets a row too.
- cells without a value, which the engine paints its no-data grey (light grey,
  half transparent; since 2026-11-24, before which one NaN turned the whole
  map flat green), get a `No data` row in that grey and are kept out of the
  range.

A layer it cannot describe gets no legend rather than a made-up one: a column
that is entirely null reaches the render as NaN cast to int, every channel
`-2^63`, and there is nothing honest to say about that.

Colours carry their own alpha (180 of 255 on a ramp), so every swatch is
drawn over white — the same compositing as over the basemap. On the panel's
own background it would be the wrong colour.

## The model file

The model is a YAML file you edit directly. The editor is a real text editor —
CodeMirror with YAML highlighting — so you can paste, restructure, keep
comments and order keys however you like. Nothing round-trips through a parser
on the way to or from disk, so the file stays exactly as you wrote it.

Where it lives:

```
<project results folder>/model/model.yaml
```

Both parts are constants in `backend/app/model_store.py`, overridable with
`MAPHEX_MODEL_DIRNAME` and `MAPHEX_MODEL_FILENAME`. A project with no results
folder set falls back to `data/projects/<id>/model/model.yaml`, so the screen
works before one is chosen. The file is created from a commented default the
first time it is opened.

**Save** writes the file. **Apply** writes it and then runs it:
`MCDA/run_mcda.sh` in the engine's container, watched exactly like processing,
with a progress dialog naming each step and a Stop that really stops it.

Saving does not require the document to be valid. Refusing to store work in
progress would mean losing it, and the problems come back in the response
either way.

### What goes in it

Checked in two places. **Syntax** is checked in the browser on every keystroke,
and shows as a gutter mark, an underline and a line-numbered message. **Structure**
is checked by the server on save, because the engine's rules are the ones that
decide.

The schema is **the engine's**, read straight out of `MCDA/engine/mcda_score.py`.
Criteria hold subgroups, subgroups hold leaves, and a leaf names one column of
the master table:

```yaml
criteria:
  - key: economy              # its name in the results
    name: Economy             # optional, readable
    weight: 0.5               # criteria add to 1
    subgroups:
      - key: interest_distance
        weight: 1.0           # subgroups of one criterion add to 1
        leaves:
          # The column is the master table's own column name: the variable's
          # folder, uppercased. out/maestro/<run>/*.variables.csv lists them.
          # absent: the 1-5 score of a hexagon still without a value.
          - {code: SOE-002, column: SOE_002, site: both, type: minmax, absent: 1}

  - key: wind_resource
    weight: 0.5
    subgroups:
      - key: wpd_density
        weight: 1.0
        agg: wmean            # wmean | min | max | gmean | sum
        leaves:
          - code: TEC-004
            column: TEC_004_sv003
            site: both        # both | onshore | offshore
            type: range
            absent: 1
            bins:             # [from, to, score]; null is unbounded
              - [null, 300, 1]   # ranges are (from, to]: exclusive lower
              - [300, 400, 2]
              - [400, null, 5]

# Zoning, read from this same file.
exclude_columns: []           # any value in these columns excludes the hexagon (-1)
exclude_thresholds: []        # or a cut on a continuous one
alert_columns: []             # marks the hexagon (-2) without changing its score
prioritized: []               # codes kept whatever else is dropped
```

A leaf's `type` is how its values become a score from 1 to 5:

| `type`   | what it does                                   | needs    |
| -------- | ---------------------------------------------- | -------- |
| `minmax` | the range present in the data, onto 1-5        | nothing  |
| `zscore` | the same, around the mean (z of -2..2 → 1..5)  | nothing  |
| `range`  | your own cuts                                   | `bins`   |
| `map`    | an exact value to a score, for categories       | `map`    |
| `direct` | the value already is a 1-5 score                | nothing  |

`direction: cost` inverts a `minmax` or `zscore` leaf.

The server reports two kinds of finding, because the engine does:

**Errors** — the engine would crash or quietly drop the leaf:

- `criteria` must exist and be a list; each criterion needs a `key`, a
  `weight` and a non-empty `subgroups`; each subgroup a `key`, a `weight` and
  non-empty `leaves`.
- A leaf needs a `column` and a `type` the engine scores. `range` needs
  `bins`, `map` needs `map`. `agg` and `on_missing` take only the values the
  engine knows. `site` must be `both`, `onshore` or `offshore`: anything
  else never applies, so the leaf would be skipped in silence.
- Each bin is `[from, to, score]` with numeric or null bounds, and a bounded
  lower below its upper.

**Warnings** — it runs, but probably not as meant:

- A key the engine does not read, at any level. This is the one worth having:
  a mistyped `binz:` leaves a leaf with no cuts and the run still finishes.
- Weights that do not add to 1, at any level, with the engine's own
  exemptions: a subgroup that normalizes or aggregates with `min` or `max` is
  not counted, and onshore and offshore leaves are summed separately. These
  messages match `validate_weights` in the engine.
- A leaf with no `absent`: a hexagon without a value there gets no score,
  and the engine's run report flags it as an error.
- A key an older engine read and this one does not, said by name: `nombre`
  is `name`, `combine` is `agg`, and `fill`/`impute` moved out of the model
  (see below).
- A fixed score outside 1-5, and a subgroup key repeated under two criteria
  (their outputs would overwrite each other).

Only YAML that does not parse stops Apply. The engine has the final word on
its own config, so neither finding blocks a run.

### The file starts from your own data

A project's model file is written the first time the screen is opened, from
the variables that project actually holds — one criterion per dimension, one
leaf per variable, `type: minmax` throughout, and `absent: 1` on every leaf
(change it here, leaf by leaf). `minmax` because it is the
one type that needs no numbers chosen in advance: it reads the range out of
the column. So the file you open with is a model the engine can score, not an
example about somewhere else.

The columns come from `out/maestro/<run>/*.variables.csv`, which every run
writes beside the master parquet. That file is the authority: the column is
usually the variable's folder with its code uppercased, but the loader
appends the file name when a folder holds more than one dataset, and guessing
would produce a config that parses and then scores nothing. Before anything
has been processed the names are derived from the input tree instead, and the
generated file says so in a comment.



### The diagram is a readout

The pane beside the editor draws whatever the text currently parses to, and
steps aside when it does not parse. It is deliberately **read-only**: writing a
change back would mean rewriting your file — comments, ordering, formatting —
which is the opposite of what a text editor is for.

### Folders are paths, and paths go stale

A browser will not reveal an absolute path from a file picker, so folders are
**typed or pasted**, and the server is what validates them — it resolves `~`
and `$VARS`, checks the path is a readable directory, and reports the real
file count and size before anything is committed.

Because a path is only a path, the server re-checks every folder on **every
read**. When one has gone:

- the project card says how many are missing,
- the data screen offers **Locate…** to point it at its new home,
- or **Remove project**, which deletes the CSV rows, and the app's own copy
  of an uploaded mesh no other project is on, and *nothing else*. The
  folders are the user's data; forgetting a project never touches them.

**Browse** opens a real folder chooser. `POST /api/fs/pick-folder` tries, in
order: `zenity`, `kdialog`, Python's `tkinter`, and then — under WSL — the
Windows dialog via `powershell.exe`, converting the result back with
`wslpath`. That last one matters here: this machine has no Linux dialog
toolkit and no passwordless sudo to install one, but WSL can run Windows
binaries, and a folder picked *inside* WSL comes back as a
`\\wsl.localhost\…` UNC path that `wslpath -u` turns into a normal Linux
path.

The request blocks for as long as the dialog is open, so the button shows it
is waiting. If nothing can be opened, the result says so and pasting a path
still works.

## Meshes: the area the engine builds over

A project's mesh is the area its hexagons cover. The engine builds it; the app
says which one, with the variables both runners forward into the container
(`run_full.sh` for processing, `MCDA/run_mcda.sh` for the model). All six are
passed with every run of both kinds, the unused ones empty, so a value left in
the engine's `.env` by hand cannot leak into a run here (`meshes.env_of`):

| Mesh | Id | Passed to the engine |
|---|---|---|
| Colombia (DANE) | `dane_colombia` | `MESH_SOURCE=dane_colombia` |
| A Natural Earth country | `natural_earth:<ADM0_A3>` | `MESH_SOURCE=natural_earth`, `MESH_COUNTRY=URY` |
| A country at geoBoundaries detail | `geoboundaries:<ISO3>:<ADM0\|ADM1\|ADM2>` | `MESH_SOURCE=geoboundaries`, `MESH_COUNTRY=URY`, `MESH_LEVEL=ADM1` |
| An uploaded file | `file:<upload id>` | `MESH_SOURCE=file`, `MESH_PATH=mesh/<file>`, `MESH_NAME_FIELD`, `MESH_CODE_FIELD` |

`MESH_PATH` is relative to `/data`, which is the project's folder.

**The picker** (`GET /api/meshes`) lists Colombia (DANE) first, the one to
pick for work in Colombia: the DANE municipalities with the sea out to the
exclusive economic zone, which is what every run used before meshes could be
chosen. Then every country in Natural Earth 10m, read from the engine's own
copy (`admin/in/natural_earth/ne_10m_admin_0_countries.parquet`, columns only,
through `pyarrow`), so a country offered is a country the engine can find.
Labels are Natural Earth's long names; the search matches the name, both
codes and the continent. Without the engine's file (an older engine) the
names fall back to the 110m set in `backend/reference/`, and a run on one of
them fails in the engine, which says why.

**Detail.** A Natural Earth country is its outline by default. One with an
ISO code can be built at geoBoundaries detail instead: ADM0 (the country),
ADM1 or ADM2 (its first and second divisions). geoBoundaries is keyed by ISO
code, so the 22 Natural Earth rows without one (France and Norway among them)
offer only the outline. The engine downloads geoBoundaries on the first run
that asks for a country and level, so that run needs internet. Boundaries from
geoBoundaries are CC BY 4.0, attributed as *geoBoundaries
(www.geoboundaries.org)*, which the screen shows wherever it is offered.

**Uploads** (`POST /api/meshes`, multipart, field `file`): a GeoJSON
(`.geojson`, `.json`), a GeoPackage with one layer (`.gpkg`), a GeoParquet
(`.parquet`), or a shapefile zipped with its `.shx`, `.dbf` and `.prj`
(`.zip`). Up to 200 MB (`MAPHEX_MESH_MAX_MB`). Checked on arrival with
GeoPandas: it has to be readable, hold at least one Polygon or MultiPolygon
(other features are left out, and the answer says how many), and have a
coordinate system. One without is accepted only when every coordinate is a
longitude and a latitude: EPSG:4326 is assumed, written into the kept copy
(a `.prj` for a shapefile) so the engine reads the same thing, and the answer
says so. The answer lists the file's columns of text or whole numbers, and
the screen offers them as the name and code columns (`MESH_NAME_FIELD`,
`MESH_CODE_FIELD`), both optional: left empty, the engine finds them. Only a
column with a value for every polygon and no value repeated can be the code
(the engine's own rule, which it would otherwise apply at step 3): only those
are offered and suggested, and picking another is refused, saying which values
are empty or repeated. A column of whole numbers stored as floats is written
back to the kept copy as integers, so a code reads `5001` and not `5001.0`.

Nothing about where an upload is written comes from the upload. The file is
kept under a name built from the last part of what the browser sent, spelled
the way the engine's lint spells names, in a folder named by the app. Out of a
zip only the one shapefile's parts are taken, each written under that name; a
member whose path climbs out of the zip (`../`, an absolute path), or is a
link, refuses the whole upload, and a zip with more than one shapefile is
refused too. A refused upload leaves nothing behind.

**No sea, except on Colombia (DANE).** Every other mesh covers its own
outline and nothing else, so the engine refuses what only means something
with a sea, and the app does not offer it and refuses it on the server first:

- the `sea` fill domain (`land` and everywhere both cover the whole mesh);
- a model leaf with `site: offshore`, or a model run with `--site offshore`
  (`onshore` and `both` cover the whole mesh). The model file shows each such
  leaf as an error, and Apply is refused, naming them;
- a `region` fill by department, and the DIVIPOLA / `codigo_dane` joins, which
  are Colombia's. The app never writes a region level: a bare `region` is the
  department on the Colombia (DANE) mesh and the mesh's own features on any
  other.

Onshore and offshore need two projects: one on Colombia (DANE) for the sea,
or one per mesh. The Data screen says the mesh has no sea beside its name.

**Projects made before meshes reached the engine** stored a slug of the
110m name (`colombia`, `uruguay`) and all ran on the DANE boundaries, whatever
the slug said: the mesh never reached the engine. They are read without
rewriting the store (`meshes.legacy_id`), and every one of them, whatever its
slug (or an empty id, or a name the old mocked upload made up), is
`dane_colombia`, so they keep running exactly as before. Their card now says
*Colombia (DANE)*.

**One database per project.** Every project runs on a database of its own,
`<main>_maphex_<project id>` next to the engine's main one (`sigdb_maphex_...`
with the default `.env`), passed as `POSTGRES_DB` and `DATABASE_URL` to every
processing and model run (`pipeline.project_database`). The engine creates it
on the project's first run. So projects never share a master table: switching
between projects, or between meshes, rebuilds nothing, and a project can
neither merge its variables into another's nor delete them. The engine also
refuses to load a project folder into its main database, which belongs to
its main data folder only, and so refuses a project whose folder is its main
data folder (the `DATA_DIR` of its `.env`, or `./data`): the app says so
first, in creating the project and before processing or a model run,
following symlinks as the engine does. A project's first run after this
change builds its database from scratch, and until a processing run has
finished on it there is no database for the model, so a model run is refused
with "Run Process first". Deleting a project here does not drop its database:
the app has no way into the engine's db container.


### A country with its sea

A country mesh, Natural Earth or geoBoundaries, can take its sea: **Include
its sea** on the New project screen adds `:eez` to the mesh id
(`natural_earth:GRC:eez`, `geoboundaries:GRC:ADM1:eez`), kept as `mesh_sea`
in `projects.csv` and passed as `MESH_SEA=eez`. The engine downloads the
country's exclusive economic zone from Marine Regions on the first run
(CC BY 4.0) and builds the master with it, so the project has a sea: the
`sea` fill domain and the offshore model are offered, as on Colombia (DANE).

### An engine that does not know meshes

An engine checked out from before meshes ignores `MESH_*` and builds
Colombia (DANE) whatever the project says: a Peru project then drew
Colombian data in Colombia, and Greek data on a Greek project read as outside
the mesh. Processing and the model are refused up front on a mesh other than
Colombia (DANE) when the engine has no `app/pipeline/prepare_mesh.py`, and on
a country with its sea when that script cannot add one, saying to update the
engine. Read from the checkout, as `honours_data_dir` is.

### Data of another area

The engine draws only the cells inside the project's mesh. A variable with
none (Colombian data on a Greek mesh) is not loaded or drawn, and the
problems panel says so under *checking it against the mesh*, with the
engine's reason. A variable the engine's per-variable corrections could not
build says so under *applying its corrections*. One it was to build and did not (the run
stopped before that step, or an engine that could not find its source) says
which step that was, instead of "stopped partway, with nothing saying why". An error that a successful
map came after is history: the variable was fixed since.

## Working with the current engine

**Each variable's fill, and each leaf's absent.** The engine splits missing
data in two, and so does the app:

- **Fill, on the Data screen.** While processing, step 13.5 fills each
  master-table column's empty hexagons with a chain of methods (`spatial` the
  neighbours' mean, `region` the municipality's, `nearest` the closest value,
  `idw`, `mean`, `median`, a fixed number, or `none`), inside a domain
  (`all`, `land` = hexagons in a municipality, `sea` = the rest; on a mesh
  other than Colombia (DANE) there is no sea, and `land` and `all` are the
  whole mesh, see [Meshes](#meshes-the-area-the-engine-builds-over)). Every
  variable is asked for its fill when it is added (one row per file in a
  batch) and can change it afterwards from its row. The default depends on
  the kind of file: a raster or a table is a measurement that should exist
  everywhere, so its gaps are filled with `spatial, median`; a vector is
  usually a layer of where something is, and a hexagon outside it is an
  answer rather than a gap, so it is not filled. Only fills changed from the
  default are stored (`data/variable_settings.csv`), and "Default values"
  puts a variable back.
- **Absent, in the model file.** The model scores whatever is still empty
  with each leaf's `absent`, 1 to 5, decided beside the leaf's cuts and
  weight. A generated model starts every leaf at 1, the cautious choice; 5 is
  for variables where no data means no restriction. The editor warns about a
  leaf without one.

Before every run the backend writes the project's `config/transform.yaml` in
the engine's own format and passes it as `PROJECT_TRANSFORM`; what was filled,
and how, is in `out/maestro/<run>/*.fill.yaml`.

**No engine project.** The engine keeps projects of its own in `projects/`,
and its `.env` may name a default one. This app's runs set `PROJECT` empty, so
none of them is loaded: everything comes from `.env` and from what is passed
here, `DATA_DIR` first, and the project's own database (`POSTGRES_DB`,
`DATABASE_URL`). A `POSTGRES_DB` set where the backend runs does not change
the project databases (they are named after the engine's `.env`); it only
sets what a direct call outside a project, like `docker compose up`, uses.

**Reports.** Every run of either kind writes `logs/<id>/run_report.yaml`:
stage times, results, every error and warning, and the parameters it ran
with. Its verdict reaches the run's state as `report` (ok, failed, or
`with_errors` for a run that finished but whose results the engine flags),
the Data screen and the model's result dialog link to the file, and the
model's past runs list every file a run wrote (report, `run.yaml`, the
aggregated table `aggregate/mcda_aggregate.h3.parquet`, the zip, the maps) to
open or download.

### A file with several value columns

The engine makes one value per hexagon, so it reads a file as one geography
and one value. A file with several candidate columns (a shapefile with
`Tipo_Roca`, `cohesion_M`, `A_Friccion`) is rejected at ingest and not
transformed until the project's `transform.yaml` says which column is the
value:

```yaml
value_columns:
  SOC_028_s: Total_Victimas_Caso                 # every file of the variable
  TEC_032_t: {vias.shp: tipo, datos.xlsx: total} # per file, for a folder of several
```

The app never decides this, and never edits the file. Which files need a
choice, and what their candidates are, is the engine's own detection, asked
through its read-only helper (`app/tools/value_columns.py --json
--transform ...`) inside its image: `exec` when the app container is mounted
on the project, otherwise a one-off `compose run` with the project's folder
as `DATA_DIR`, so it never answers for the wrong project. The answer is
cached until the input tree or a choice changes. When the engine cannot be
asked, the screen says nothing and processing goes ahead; the engine still
reports what it left out.

- **Before every run.** Process asks the engine first. If some files need a
  column, a dialog lists each one with a dropdown of its columns, each shown
  with its first value (`Total_Victimas_Caso: 9 (number)`), and "Leave for
  later". Choose and continue, or continue without choosing: a file left
  without a column is not transformed until a value column is chosen, and
  the other variables are processed as usual.
- **On the Data screen.** A variable that needs a choice says so on its row,
  with a button to the same dropdown in its settings (where its fill is).
  A chosen column is shown on the row and can be changed or cleared there.
  When the engine has already rejected the file, its entry in the problems
  panel offers the same fix.
- **Stored** in `data/value_columns.csv`, a row per variable (per file for a
  folder of several), checked against the engine's candidates, and written
  into `config/transform.yaml` as `value_columns:` before every run. Left
  out of the file when nothing is chosen. A choice that changes makes the
  engine reprocess that file. Removing a variable or a project drops its
  choices.
- **Handled by the engine.** A source the engine builds itself in its own
  step, with a column chosen there (`fixed_by` in the helper's answer), needs
  nothing here, and its settings say so.

### Nested variables, read at any depth

The engine's own data groups a variable's versions as
`tec/TEC_001_t/TEC_001_sv003/x.tif`, and the engine reads its input tree at
any depth: ingest and the raster step `rglob` all of `in/`, every dataset is
processed into the mirror of its folder under `out/`, the dimension is the
first folder, and the loader names the master-table column after the folder
holding the file (`leaf_var_name`): `TEC_001_sv003`. `TEC_001_t` is only a
group. So everything here reads the tree the same way:

- **The list** (`inputs.scan`) has a variable per folder holding a dataset,
  wherever it sits. Its id is its path under `in/`
  (`tec/TEC_001_t/TEC_001_sv003`), its code is that folder (the column), and
  the folders between are its `group`, shown before the code on the Data
  screen. `TEC_001_t` is not listed: a folder that only holds folders is not
  a variable, and nothing is reported about it. A code folder straight under
  a dimension with nothing readable anywhere inside it still is, with that
  problem. A folder holding several datasets is not a problem either: the
  engine makes a column of each (`<CODE>_<file>`), and the row says so.
- **Results, problems, results with no input, what the database was loaded
  from** (`outputs.result_folders`) are read at any depth too, skipping the
  engine's own folders at every level. A result is a folder holding what the
  engine writes per variable (`.h3.parquet`, the stage log, ingest's
  `.error.txt`, the map), and "loaded" means an `.h3.parquet`, which is what
  the loader picks up.
- **The fill** (`config/transform.yaml`) is keyed by column, so a nested
  variable's entry is its own code, from the last export's `variables.csv`
  or, before one, from its folder.
- **Adding.** Pointing at a dimension folder from the engine (`tec/`), or at
  `TEC_001_t` itself, offers each inner folder as a variable, and the copy
  **keeps the group**: it lands in `in/tec/TEC_001_t/TEC_001_sv003/`, the
  same tree the engine's own data has. A group is a folder above the variable
  that is named like a code and holds no data of its own; any other folder on
  the way (a `shp/`, a `data/`) says nothing and is dropped, so
  `SOC_025_sr/shp/x.shp` is the variable `SOC_025_sr`, not one called `shp`.
  Flattening to `in/tec/TEC_001_sv003/` would give the same column, so the
  group is kept only so the tree reads like the one it came from.
- **A code is taken anywhere it is used.** The loader names a column after
  the folder alone, and two folders with one name, in any dimension or
  group, both get renamed (it adds each file's name), so neither column is
  what the model expects. Suggested codes miss every code in the project,
  and adding one that is already used elsewhere is refused, naming where.
- **Fill and removal** go by the full id: the routes take the rest of the
  path after the dimension (`/inputs/{dimension}/{code:path}`). Removing the
  last variable of a group removes the group folder too, in `in/` and `out/`.

## Screens

| Screen | File | What it does |
|---|---|---|
| Projects | `screens/ProjectsScreen.tsx` | Project list, empty state, "new project" tile |
| New project | `screens/NewProjectScreen.tsx` | Name, mesh, results folder, description, and the resolutions the first run will use. Reached from the Projects screen, not the stepper |
| Add your data | `screens/DataScreen.tsx` | The project's folder path, folder dropzone, folder list, processing progress, "all done" dialog |
| Map | `screens/MapScreen.tsx` + `map/LayerTree.tsx` + `map/LayerFrame.tsx` | A list of what the engine rendered, and the selected document in an iframe |
| Tune the model | `screens/TuneScreen.tsx` + `tune/*` | A YAML text editor over the real file, with a read-only diagram of what it currently says |
| Writing the model | `screens/ExamplesScreen.tsx` | What every key in the config means, and blocks to start from. Reached from the Model screen, not the stepper |

Two screens are not in the stepper. `setup` is reached from the Projects
screen, which is where you are when you want a new project, and `examples`
from the Model screen it explains — neither is a step in the work, and a
stepper listing places you never pass through stops reading as an order.

Leaving the Model screen does not lose unsaved text: `lib/model-draft.ts`
keeps it, and the editor picks it up again on the way back. A module variable
rather than context, because the draft changes on every keystroke and context
would re-render every screen each time. Nothing renders from it.

## Where the backend plugs in

Every server call in the app goes through **`src/api/index.ts`**. Nothing else
imports the HTTP client, and no component fetches on its own. Each function
there carries an `ENDPOINT:` comment naming the route it should hit; today each
one forwards to `src/api/mock/`.

Wiring the real server means replacing the bodies in `src/api/index.ts` with
`request(...)` calls from `src/api/client.ts` and deleting `src/api/mock/`.
No component changes.

### The routes the UI expects

| Function | Route | Notes |
|---|---|---|
| `listProjects` | `GET /api/projects` | **live** |
| `getProject` | `GET /api/projects/{id}` | **live** |
| `createProject` | `POST /api/projects` | **live** |
| `deleteProject` | `DELETE /api/projects/{id}` | **live**: CSV rows, and its upload in `data/meshes/` once unused; never the folders |
| `listMeshes` | `GET /api/meshes` | **live**: Colombia (DANE), then the engine's Natural Earth 10m countries |
| `uploadMesh` | `POST /api/meshes` | **live**: multipart `file`; checked, kept in `data/meshes/`, answers with a `Mesh` |
| `pickFolder` | `POST /api/fs/pick-folder` | **live** — zenity / kdialog / tkinter / Windows-under-WSL |
| `inspectPath` | `POST /api/fs/inspect` | **live** — validates a typed path |
| `listFolders` | `GET /api/projects/{id}/folders` | **live** — existence re-checked each read |
| `addFolders` | `POST /api/projects/{id}/folders` | **live** — absolute paths, validated server-side |
| `removeFolder` | `DELETE /api/projects/{id}/folders/{folderId}` | **live** |
| `relocateFolder` | `PUT /api/projects/{id}/folders/{folderId}/path` | **live** — re-point a folder that moved |
| `startProcessing` | `POST /api/projects/{id}/process` | |
| `abortProcessing` | `POST /api/projects/{id}/process/abort` | **signalling the engine is not built yet** — see below |
| `watchProcessing` | `GET /api/projects/{id}/process/stream` | **SSE**, driven by `watchfiles` on the results folder |
| `listVariables` | `GET /api/projects/{id}/variables?mode=input\|model` | |
| `getLayerTree` | `GET /api/projects/{id}/layers` | what was rendered: the model tree and the flat input list, labels and ids only |
| `getLayerUrl` | `GET /api/projects/{id}/layers/{nodeId}/document` | returns the URL of the pre-rendered document the iframe loads |
| `getModel` | `GET /api/projects/{id}/model` | **live** — the file verbatim, plus what is wrong with it |
| `saveModel` | `PUT /api/projects/{id}/model` | **live** — writes the text as-is; valid or not |
| `getEngineConfig` | `GET /api/engine/config` | **live**: every setting of the engine's `.env`, with its default; never the password |
| `saveEngineConfig` | `PUT /api/engine/config` | **live**: `{changes: {KEY: value \| null}}`; checked, written in place; 409 during a run |
| `applyModel` | `POST /api/projects/{id}/model/apply` | **live for the write**; running the model is next |
| `watchModelApply` | `GET /api/projects/{id}/model/apply/stream` | **SSE**, one `ApplyProgress` per variable — drives the loading dialog |
| `listExamples` | `GET /api/model/examples` | mocked; the examples are UI copy |
| `addInputs` | `POST /api/projects/{id}/inputs/batch` | a folder of variables; reports per variable |
| `listProblems` | `GET /api/projects/{id}/problems` | which variables did not finish, and the engine's reason |
| `listModelRuns` | `GET /api/projects/{id}/model/runs` | newest first; only the first is ever drawn; each with the engine's verdict |
| `listModelRunFiles` | `GET /api/projects/{id}/model/runs/{runId}/files` | what a run wrote, reports first |
| `modelRunFileUrl` | `GET /api/projects/{id}/model/runs/{runId}/files/{path}` | text opens in the browser, the rest downloads (`?download=true` forces it) |
| `runReportUrl` | `GET /api/runs/{executionId}/report` | the engine's `run_report.yaml` for any run |
| `saveVariableSettings` | `PUT /api/projects/{id}/inputs/{dimension}/{code...}/settings` | a variable's fill; `{code...}` is the rest of its id, so a nested one works |
| `resetVariableSettings` | `DELETE /api/projects/{id}/inputs/{dimension}/{code...}/settings` | back to the default fill for its kind of file |
| `getValueColumns` | `GET /api/projects/{id}/inputs/value-columns` | files with several value columns, from the engine's own check: candidates, first values, what is chosen |
| `chooseValueColumn` | `PUT /api/projects/{id}/inputs/{dimension}/{code...}/value-column` | `{column, file?}`, checked against the engine's candidates |
| `clearValueColumn` | `DELETE /api/projects/{id}/inputs/{dimension}/{code...}/value-column` | `?file=` for one file of a folder of several |
| `getModelStatus` | `GET /api/projects/{id}/model/status` | whether the model map is out of date: the engine's check and a changed model file |
| `saveOptions` | `PUT /api/projects/{id}/settings/options` | the three switches passed with every run |
| `pruneModelRuns` | `POST /api/projects/{id}/model/runs/prune` | keep the newest N, in one container |
| `removeModelRun` | `DELETE /api/projects/{id}/model/runs/{runId}` | |
| `getEngineSettings` | `GET /api/settings` | the engine's own numbers, with no project to ask about |
| `getSettings` | `GET /api/projects/{id}/settings` | resolves blanks against the engine's `.env` |
| `saveSettings` | `PUT /api/projects/{id}/settings` | stores them; a run applies them |
| `clearSettings` | `DELETE /api/projects/{id}/settings` | "Default values": track the engine again, rather than pinning its current numbers |

The wire shapes are in **`src/types.ts`** — the Pydantic models should mirror
them one-for-one.

Vite proxies `/api` to `http://127.0.0.1:8000` in dev (`vite.config.ts`), so
uvicorn on its default port needs no extra config.

### What the engine has to supply

- **The layer tree.** `getLayerTree` returns both sides of the project, shaped
  differently on purpose:

  ```
  model.combined    Complete model          one document, everything in it
  model.variables   Mean wind speed
                    Grid access ──┬── Distance to substation ──┬── High-voltage …
                                  │                            └── Medium-voltage …
                                  └── Distance to road
  inputs            Mean wind speed, Terrain slope, Road network, …   (flat)
  ```

  The model is hierarchical — a variable can be built from other variables — so
  it arrives as a tree and the sidebar opens it like folders, at any depth. The
  inputs are one uploaded folder per variable, so they are flat and stay flat;
  the UI sorts them alphabetically rather than trusting the order they arrive
  in. The same component draws both: when nothing in a section is composite it
  drops the disclosure column instead of leaving empty space.

  `hasDocument: false` marks a node that exists only to group others — it still
  opens, but selecting it shows nothing. The UI draws whatever structure comes
  back; it does not derive it from the model config, because what the engine
  actually rendered is the only truth about what can be displayed.

- **One rendered document per node.** A node id names one document, and
  nothing else does — `getLayerUrl` is a string built from it.
- **Two resolutions.** `ProjectSettings.processingResolution` is what the
  engine computes and stores at; `mapResolution` is only what gets drawn.
  When the map resolution is coarser, the backend has to aggregate stored
  cells up before sending them.
- **Per-variable apply progress.** `watchModelApply` streams one
  `ApplyProgress` per variable so the loading dialog can name what is being
  processed. The mock walks the variable tree parents-first; the engine should
  emit in whatever order it actually works.

- **Abort is a stub.** The button on the processing panel stops the progress
  stream and returns the screen to its pre-run state. It does **not** yet stop
  the engine: `abortProcessing` is expected to signal the pipeline process, the
  equivalent of Ctrl-C, and that part is unwritten. Note that a half-finished
  run leaves whatever it already wrote in the results folder.

### Two things to decide before the backend lands

- **Caching the rendered documents.** They are ~9 MB each and there will be one
  per layer. The dev server sends `Cache-Control: no-store` so a regenerated
  file is picked up immediately; production wants the opposite — a long cache
  with a content hash or an ETag in the URL — or every layer switch re-downloads.
- **Who owns validation.** Syntax is checked in the browser so the editor
  responds immediately; structure is checked by the server on save, because
  the engine's rules decide. Nothing gates on a separate validate call.

## Notes on what was built

- **The whole simulation is one constant.** `LAYER_TREE` in
  `src/api/mock/fixtures.ts` is the tree the backend will send; replacing it is
  the entire migration for this feature. Its nesting is deliberately uneven —
  three levels under `grid_access`, two under `protected_areas`, flat
  elsewhere — so the tree is exercised rather than assumed.
- **Mock data still follows the design**, so the projects and variables are
  Ireland / Iberia / North Sea wind-farm fixtures while the one sample document
  is Colombian SOE-001. The frame shows the filename of the document actually
  on screen, so the mismatch is visible rather than misleading. Fixtures are in
  `src/api/mock/fixtures.ts`.
- **deck.gl, react-map-gl and h3-js are no longer used** by the app now that
  the engine renders the map. They are still in `package.json`; drop them when
  you are sure nothing else wants them.
- **The model file is the engine's config, not ours.** It was not always:
  this app invented a `variables: {weight, normalization, exclusion_variable}`
  shape before anyone had read what the MCDA actually loads. The engine reads
  `criteria -> subgroups -> leaves`, where a leaf names a master-table column
  and carries explicit `bins`, and it cannot run anything else — a
  `normalization: minmax` carries no cuts for it to score with. The editor,
  the validation, the diagram and the examples are all that schema now.

  `backend/app/model_store.py` holds the engine's key lists and type names,
  transcribed rather than imported: the engine runs in a container and this
  does not. They are worth re-reading against `mcda_score.py` when the engine
  moves — `_TOP_KEYS`, `_CRIT_KEYS`, `_SG_KEYS`, `_LEAF_KEYS`, and the
  `leaf_score` dispatch.

- **Errors and warnings are kept apart**, because the engine keeps them
  apart: it refuses nothing in its own config, it only prints. So a weight
  that does not add to 1 is a warning here and the Apply button stays live.
  Only YAML that does not parse stops anything. The weight warnings are
  checked against the engine's own `validate_weights` on its four shipped
  configs — same subgroups, same numbers.

- **The diagram has three columns, not arbitrary depth.** The old tree
  recursed through `subvariables` to any depth; the engine's model is exactly
  three levels, so `lib/diagram.ts` walks those three and each box says what
  it is. A leaf shows its column, its scoring type and how many cuts it has —
  the things you would otherwise scroll the file to find.

- **The model side is flat; the input side is one level deep.** The model is
  the whole thing and one map per criterion — the engine also renders each
  subcriterion, and those are still on disk, but a row that opened to reveal
  more rows was structure that side did not need.

  The input side does need it. A real project has sixty variables across
  three dimensions, and sixty rows in one list is a list nobody reads, so a
  dimension is a folder holding the variables in it — which is also how they
  sit on disk.

  A folder is one with children, not merely one without a document: the "no
  model run yet" placeholder has neither and is still the disabled row it
  always was. Folders start shut so the dimensions are what you see; opening
  the one holding the selection was the first instinct and made the first
  screen worse, pushing the other two dimensions off the bottom behind
  twenty-three variables.

  The Data screen's list groups the same way, and for the same reason — it is
  the screen you come to looking for one variable to remove. Grouped in the
  component rather than by the server, which sends that screen a flat list of
  what is on disk on purpose. One difference: adding a variable opens the
  dimension it went into, because a row appearing inside a shut folder has
  nowhere to appear and "did that work?" is the next question.

  There was also a raw/normalized switch, for a second document per variable
  the engine never rendered — so `ValueScale`, `MapView.scale` and
  `getLayerUrl`'s `scale` argument are all gone with it.
- **Base map** is CARTO Positron; override with `VITE_MAP_STYLE` to
  self-host.
- `optimizeDeps.exclude: ['maplibre-gl']` in `vite.config.ts` is required —
  without it maplibre's worker 404s and the base map stays silently blank.

## Design system

`design/_ds/organic-*/styles.css` is copied verbatim to
`frontend/src/styles/organic.css` and is the source of truth for colour, type,
spacing, radii and shadows. Take values from its variables rather than
hard-coding them.
