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
│   └── reference/   vendored Natural Earth 110m countries (820 kB)
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

Because the document owns its own pan, zoom, tooltip and opacity control, the
app adds no map chrome of its own. Anything drawn on top would duplicate or
contradict what is inside it.

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

**Use a branch with the fixes on it.** The engine's `main` is missing four
commits this app depends on. They are pushed as one branch, named after what
it is for:

```bash
cd SIG-Transformer && git checkout fix/compatibilidad-maphex
```

That branch carries, oldest first: the lint no longer renaming the pipeline's
own outputs (without it, **every run after the first fails at step 10.6**),
pyarrow held below 26 so it keeps working with the NumPy the image has,
`run_full.sh` honouring the `DATA_DIR` it advertises (without it every
project would read and write the engine's own folder — see
[A project folder is the pipeline's DATA_DIR](#a-project-folder-is-the-pipelines-data_dir)),
and an exact dependency lock. Merging it into `main` makes this step go away.

The same four commits also exist as two stacked branches,
`fix/lint-no-renombrar-salidas` and `chore/fijar-dependencias`, from when
they were meant to be reviewed separately. Same tree, same history — nothing
is lost by merging the one above and deleting the other two.

Then its configuration and its data:

```bash
cp .env.example .env     # then set POSTGRES_USER / PASSWORD / DB
docker compose up -d     # builds the image the first time; it is not quick
```

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

Python 3.12. Every version in `requirements.txt` is exact, including the
resolved ones — see the note at the bottom of that file before changing any.

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
is present.

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
- **the project's folder** — `in/`, `out/`, `model/model.yaml`, `MCDA/runs/`.
  All of it the engine's doing except the model file.
- **`out/maestro/`** — all but the newest master export is moved to
  `out/bck/` before a model run, because the MCDA refuses to choose between
  several.
- **`data/*.csv` here** — the project list, and where each variable was
  copied from.

Nothing is written to the folders variables were imported *from*. Those are
read and copied, never moved or changed.

## Checking it still works

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
| The model file, and running the model | **Live** — a YAML file under the project's folder, run with `MCDA/run_mcda.sh` |
| Processing | **Live** — `run_full.sh`, watched stage by stage |
| The layer tree and the rendered maps | **Live** — discovered from the project's `out/` folder |
| Project settings | **Live** — two resolutions, written into the engine's `.env` before a run |
| Uploading a mesh, and the model examples | Mocked in `frontend/src/api/mock/` |

Those last two are all that is left of the mocks. A mesh upload has no server
route, and the examples are UI copy with nowhere else to live yet.

## A variable's code comes from its folder, and is shown

The engine reads a variable's identity out of the folder it sits in:
`in/<dimension>/<CODE>/`, and `format_code` uppercases the leading
`abc_123`. So the folder name is what a suggested code is taken from — the
file inside may be called anything, and often is.

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

* one dataset at the top level → one variable, exactly as before;
* subfolders with one dataset each → a variable per subfolder;
* several datasets side by side → a variable per dataset. This one used to
  be refused outright, with a message saying to add them one folder at a time.

Codes are suggested across the whole batch at once, so each misses both what
is already on disk and what the rows above it were given — a rule one
function (`_next_code`) applies for a single variable and a batch alike, so
they cannot drift apart.

A subfolder with nothing readable is left out silently: a folder of variables
usually has a `docs` or a `.git` beside them, and those are not failures. A
subfolder with *several* datasets is listed with its reason, because it was
clearly meant to be a variable, and dropping it quietly is how one goes
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

Because the engine has one database and one `.env`, these are really
properties of the engine as it is configured right now; keeping them per
project means "set the engine to this before running this project". Two
projects that disagree about the processing resolution cost a master rebuild
each time you switch. The engine notices and does it; `settings.save` marks
the project stale so our own record of what the database holds is cleared
with it.

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

## The project store

Two CSV files, because the point is that you can open them, read them, and fix
them by hand:

```
data/projects.csv   id, name, mesh_id, mesh_label, description, out_folder, created_at, updated_at
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
<project folder>/out/<dimension>/<CODE>/<file>.h3.html     what it rendered
                                        <file>.h3.parquet
                                        <file>.pipeline.jsonl
<project folder>/model/model.yaml                 the model, edited here
```

`GET /api/projects/{id}/layers` scans `out/` and returns what is actually
there. Nothing is mocked and nothing is cached — the pipeline writes files,
and this is the same view a person would get listing the folder.

Two things fall out of that shape:

- **Input variables are a flat list** because the pipeline writes them as a
  mirror of the input tree, one folder per code. The model nests by criterion,
  which is why that side is a tree.
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
  - key: economia             # its name in the results
    nombre: Economia          # optional, readable
    weight: 0.5               # criteria add to 1
    subgroups:
      - key: dist_interes
        weight: 1.0           # subgroups of one criterion add to 1
        leaves:
          # The column is the master table's own column name — the variable's
          # folder, uppercased. out/maestro/<run>/*.variables.csv lists them.
          - {code: SOE-002, column: SOE_002, site: both, type: minmax}

  - key: recurso_eolico
    weight: 0.5
    subgroups:
      - key: densidad_wpd
        weight: 1.0
        leaves:
          - code: TEC-004
            column: TEC_004_sv003
            site: both        # both | onshore | offshore
            type: range
            bins:             # [from, to, score]; null is unbounded
              - [null, 300, 1]   # ranges are (from, to] — exclusive lower
              - [300, 400, 2]
              - [400, null, 5]

# Zoning. Present at all, and the engine treats this file as self-contained
# rather than falling back to its own MCDA/config/zoning.yaml.
exclude_columns: []           # any value in these columns excludes the hexagon
exclude_thresholds: []        # or a cut on a continuous one
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
  `bins`, `map` needs `map`. `site` must be `both`, `onshore` or `offshore` —
  anything else never applies, so the leaf would be skipped in silence.
- Each bin is `[from, to, score]` with numeric or null bounds, and a bounded
  lower below its upper.

**Warnings** — it runs, but probably not as meant:

- A key the engine does not read, at any level. This is the one worth having:
  a mistyped `binz:` leaves a leaf with no cuts and the run still finishes.
- Weights that do not add to 1, at any level — with the engine's own
  exemptions, so a subgroup that normalizes or combines with `min` is not
  counted, and onshore and offshore leaves are summed separately. These
  messages match `validate_weights` in the engine, checked against its four
  shipped configs.

Only YAML that does not parse stops Apply. The engine has the final word on
its own config, so neither finding blocks a run.

### The file starts from your own data

A project's model file is written the first time the screen is opened, from
the variables that project actually holds — one criterion per dimension, one
leaf per variable, `type: minmax` throughout. `minmax` because it is the one
type that needs no numbers chosen in advance: it reads the range out of the
column. So the file you open with is a model the engine can score, not an
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

### Study areas come from GeoPandas

`GET /api/meshes` returns all 177 countries from Natural Earth's 110m admin-0
set, read with GeoPandas.

The `world` dataframe everyone remembers —
`gpd.read_file(gpd.datasets.get_path("naturalearth_lowres"))` — **no longer
exists**: `geopandas.datasets` was removed in GeoPandas 1.0, which now points
you at naturalearthdata.com instead. So the file is vendored in
`backend/reference/`, which also keeps the app working offline.

Only names are served today. `countries.geometry_for(id)` loads the polygon
alongside them and is the seam the H3 mesh step plugs into.

Two details in that data worth knowing:

- **ISO_A3 is not a key.** Five rows have `-99`, Norway and France among them.
  The id is a slug of `NAME`, which is unique.
- **`SOVEREIGNT` is left out of the search terms.** Every dependency carries
  its parent's name there, so including it made "United States of America"
  match Puerto Rico. Each row is still findable by what it is actually called,
  by its short name, and by either ISO code.

The picker is a searchable combobox rather than a `<select>`, which stops being
usable well before 177 options. Matches on the label rank above matches on an
alias.

### Folders are paths, and paths go stale

A browser will not reveal an absolute path from a file picker, so folders are
**typed or pasted**, and the server is what validates them — it resolves `~`
and `$VARS`, checks the path is a readable directory, and reports the real
file count and size before anything is committed.

Because a path is only a path, the server re-checks every folder on **every
read**. When one has gone:

- the project card says how many are missing,
- the data screen offers **Locate…** to point it at its new home,
- or **Remove project**, which deletes the CSV rows and *nothing else*. The
  folders are the user's data; forgetting a project never touches disk.

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

## Screens

| Screen | File | What it does |
|---|---|---|
| Projects | `screens/ProjectsScreen.tsx` | Project list, empty state, "new project" tile |
| New project | `screens/NewProjectScreen.tsx` | Name, mesh, results folder, description, and the resolutions the first run will use. Reached from the Projects screen, not the stepper |
| Add your data | `screens/DataScreen.tsx` | The project's folder path, folder dropzone, folder list, processing progress, "all done" dialog |
| Map | `screens/MapScreen.tsx` + `map/LayerTree.tsx` + `map/LayerFrame.tsx` | A file-explorer tree of what the engine rendered, and the selected document in an iframe. Raw/normalized applies to input variables only |
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
| `deleteProject` | `DELETE /api/projects/{id}` | **live** — CSV rows only, never the folders |
| `listMeshes` | `GET /api/meshes` | **live** — 177 countries from Natural Earth via GeoPandas |
| `uploadMesh` | `POST /api/meshes` | mocked; no server route yet |
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
| `getLayerUrl` | `GET /api/projects/{id}/layers/{nodeId}?scale=raw\|normalized` | returns the URL of the pre-rendered document the iframe loads |
| `getModel` | `GET /api/projects/{id}/model` | **live** — the file verbatim, plus what is wrong with it |
| `saveModel` | `PUT /api/projects/{id}/model` | **live** — writes the text as-is; valid or not |
| `applyModel` | `POST /api/projects/{id}/model/apply` | **live for the write**; running the model is next |
| `watchModelApply` | `GET /api/projects/{id}/model/apply/stream` | **SSE**, one `ApplyProgress` per variable — drives the loading dialog |
| `listExamples` | `GET /api/model/examples` | mocked; the examples are UI copy |
| `addInputs` | `POST /api/projects/{id}/inputs/batch` | a folder of variables; reports per variable |
| `listModelRuns` | `GET /api/projects/{id}/model/runs` | newest first; only the first is ever drawn |
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

- **One rendered document per node.** A node id plus the raw/normalized scale
  names one document. Today every combination resolves to the same sample
  file; when the engine emits one per layer, only `getLayerUrl` changes.
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

- **`MapMode` is `input | model`, not `raw | model`.** "Raw" now belongs to
  `ValueScale` (`raw | normalized`), and two meanings of the word on one
  screen would be a trap.
- **Base map** is CARTO Positron; override with `VITE_MAP_STYLE` to
  self-host.
- `optimizeDeps.exclude: ['maplibre-gl']` in `vite.config.ts` is required —
  without it maplibre's worker 404s and the base map stays silently blank.

## Design system

`design/_ds/organic-*/styles.css` is copied verbatim to
`frontend/src/styles/organic.css` and is the source of truth for colour, type,
spacing, radii and shadows. Take values from its variables rather than
hard-coding them.
