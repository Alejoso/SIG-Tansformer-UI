# Maphex — SIG UI

Local interface for the H3 multicriteria pipeline. This repository currently
holds **the frontend only**: every screen from the design is built and working,
running against an in-memory mock of the backend.

```
SIG-UI/
├── design/      the source mockup (Maphex.dc.html + the Organic design system)
├── HTML/        the engine's pre-rendered layer documents (git-ignored)
├── backend/     FastAPI — projects, data folders, and the country list
│   └── reference/   vendored Natural Earth 110m countries (820 kB)
├── data/        projects.csv + folders.csv (git-ignored, machine-specific)
├── frontend/    React + Vite + TypeScript
└── README.md
```

## The map is rendered by the engine, not by us

The engine emits a finished pydeck HTML document per layer, and the map screen
drops it into an `<iframe>`. The UI never receives per-hexagon values and never
paints a map — a full mesh as JSON would be tens of megabytes to serialise,
transfer and re-draw, where the generated document is already a map the browser
can stream and cache.

Put the generated files in `HTML/` at the repo root. The dev server serves that
folder at `/layers/<filename>` (a small plugin in `frontend/vite.config.ts`);
in production FastAPI serves the same route. The folder is git-ignored — the
documents are ~9 MB each and the pipeline regenerates them.

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

## Running it

Two processes. The backend first:

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && ./run.sh
```

Then the frontend:

```bash
cd frontend && npm install && npm run dev
```

Opens on http://localhost:5173; Vite proxies `/api` to uvicorn on **:8765**.
The UI needs the backend — without it the projects list cannot load and says
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

## What is real and what is still mocked

| Area | State |
|---|---|
| Projects, data folders, meshes, path checking | **Live** — FastAPI, stored in `data/*.csv` |
| The model file | **Live** — a YAML file under the project's results folder |
| The map layers | **Live** — discovered from the project's `out/` folder |
| Layer tree, rendered maps, the model, processing, apply | Mocked in `frontend/src/api/mock/` |

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
because an iframe loads an error page as readily as a map.

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

**Save** writes the file. **Apply** writes it too — running the model from it
is the next step and is not built yet.

Saving does not require the document to be valid. Refusing to store work in
progress would mean losing it, and the problems come back in the response
either way.

### What goes in it

Checked in two places. **Syntax** is checked in the browser on every keystroke,
and shows as a gutter mark, an underline and a line-numbered message. **Structure**
is checked by the server on save, because the engine's rules are the ones that
decide.

```yaml
project: ridgeline            # free-form; yours to use
model: suitability_v2
objective: maximize
resolution: 8

variables:
  wind_speed:                 # any name you like
    weight: 0.45              # 0 to 1. A weight of 0 means "carry it, do not count it"
    exclusion_variable: false
    normalization: minmax     # minmax | standard | intervals

  land_cover:
    weight: 0.10
    exclusion_variable: false
    normalization: intervals
    intervals:                # [from, to, result]; null is unbounded
      - [null, 0.2, 1]        # ranges are (from, to] — exclusive lower, inclusive upper
      - [0.2, 0.4, 2]
      - [0.8, null, 5]

  grid_access:
    weight: 0.30
    exclusion_variable: false
    normalization: minmax
    subvariables:             # nest to any depth
      distance_to_substation:
        weight: 0.60
        exclusion_variable: false
        normalization: minmax

  protected_area:
    exclusion_variable: true  # rules a hexagon out; no weight, no normalization
```

The rules the server enforces, and nothing more:

- `variables` must exist and be a mapping.
- A variable either has `weight` **and** `normalization`, or
  `exclusion_variable: true`. Never both — an exclusion variable rules a
  hexagon out, so a weight on it would never be read.
- `weight` is a number from 0 to 1.
- `normalization` is `minmax`, `standard` or `intervals`.
- With `intervals`, the list must be non-empty and every row `[from, to,
  result]`: bounds are numbers or `null`, the result is a number, and a
  bounded lower must sit below its upper.
- `subvariables` is a mapping, checked the same way, to any depth.

Anything else in the file is left alone. The editor is meant to be free, so
the server rejects what cannot be run rather than everything unusual.

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
| New project | `screens/NewProjectScreen.tsx` | Name, mesh, results folder, description, advanced settings |
| Add your data | `screens/DataScreen.tsx` | Folder dropzone (max 10), folder list, processing progress, "all done" dialog |
| Map | `screens/MapScreen.tsx` + `map/LayerTree.tsx` + `map/LayerFrame.tsx` | A file-explorer tree of what the engine rendered, and the selected document in an iframe. Raw/normalized applies to input variables only |
| Tune the model | `screens/TuneScreen.tsx` + `tune/*` | A YAML text editor over the real file, with a read-only diagram of what it currently says |

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
| `listExamples` | `GET /api/model/examples` | |
| `getSettings` | `GET /api/projects/{id}/settings` | |
| `saveSettings` | `PUT /api/projects/{id}/settings` | |

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
- **Three transforms, no more.** `minmax` and `standard` (mean and standard
  deviation) are plain selections. `intervals` carries a table of ranges, each
  mapping to a number — which is also how a categorical result is expressed,
  since a category is a number with a meaning attached.

  Ranges are `(from, to]` — exclusive lower, inclusive upper — matching the
  engine's `range` bins, and a blank bound means unbounded. `toYaml` writes
  them the way the engine already does:

  ```yaml
  normalization: intervals
  intervals:
    - [null, 0.2, 1]
    - [0.2, 0.4, 2]
    - [0.8, null, 5]
  ```

  Switching to `intervals` seeds five rows rather than an empty table; adding a
  row continues the numbering and starts where the previous one ended, so it
  arrives valid instead of pre-flagged. Switching away keeps the table, so
  going back does not lose typed work. Validation covers each row on its own
  plus the one cross-row trap — a range open at both ends alongside others,
  which would silently swallow them. Full gap-and-overlap analysis is not
  attempted.

- **The config is English throughout** — `weight`, `exclusive`,
  `normalization`, `intervals`, `subvariables`. The keys were Spanish in the
  original mockup. The exclusion flag is `exclusion_variable`.
- **An exclusion variable has no weight and no transform.** It rules a hexagon
  out rather than contributing a share of the score, so those fields are not
  hidden but absent: nothing meaningful could go in them. They are left out of
  the weight sum and of validation, and the value is kept while hidden so
  toggling back does not lose it.
- **The model tree is deliberately small** — `key`, `weight`, `exclusive`,
  `normalization`, `intervals`, `sub` — since the real config will change a lot. The YAML
  editor and the node diagram are two renderings of that one structure
  (`src/lib/model.ts`), so they cannot disagree.
- **A weight of zero means "informative"**: the variable is carried to be
  looked at on the map, not counted in the score. Both panes tint it neutral
  and badge it, so a zero reads as a decision rather than an unfinished edit.
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
