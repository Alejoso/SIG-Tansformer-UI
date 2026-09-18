# Maphex — SIG UI

Local interface for the H3 multicriteria pipeline. This repository currently
holds **the frontend only**: every screen from the design is built and working,
running against an in-memory mock of the backend.

```
SIG-UI/
├── design/      the source mockup (Maphex.dc.html + the Organic design system)
├── HTML/        the engine's pre-rendered layer documents (git-ignored)
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

```bash
cd frontend && npm install && npm run dev
```

Opens on http://localhost:5173. `npm run build` emits `frontend/dist`, which
FastAPI will serve once it exists.

## Screens

| Screen | File | What it does |
|---|---|---|
| Projects | `screens/ProjectsScreen.tsx` | Project list, empty state, "new project" tile |
| New project | `screens/NewProjectScreen.tsx` | Name, mesh, results folder, description, advanced settings |
| Add your data | `screens/DataScreen.tsx` | Folder dropzone (max 10), folder list, processing progress, "all done" dialog |
| Map | `screens/MapScreen.tsx` + `map/LayerTree.tsx` + `map/LayerFrame.tsx` | A file-explorer tree of what the engine rendered, and the selected document in an iframe |
| Tune the model | `screens/TuneScreen.tsx` + `tune/*` | YAML editor and node diagram over one shared tree, examples dialog |

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
| `listProjects` | `GET /api/projects` | |
| `getProject` | `GET /api/projects/{id}` | |
| `createProject` | `POST /api/projects` | |
| `deleteProject` | `DELETE /api/projects/{id}` | not yet called from the UI |
| `listMeshes` | `GET /api/meshes` | GeoJSON meshes on disk |
| `uploadMesh` | `POST /api/meshes` | multipart |
| `pickFolder` | `POST /api/fs/pick-folder` | **native dialog on the server** — the browser cannot do this |
| `listFolders` | `GET /api/projects/{id}/folders` | |
| `addFolders` | `POST /api/projects/{id}/folders` | browser sends folder names; server resolves paths, counts files, sizes |
| `removeFolder` | `DELETE /api/projects/{id}/folders/{folderId}` | |
| `startProcessing` | `POST /api/projects/{id}/process` | |
| `watchProcessing` | `GET /api/projects/{id}/process/stream` | **SSE**, driven by `watchfiles` on the results folder |
| `listVariables` | `GET /api/projects/{id}/variables?mode=input\|model` | |
| `getLayerTree` | `GET /api/projects/{id}/layers` | what was rendered: the model tree and the flat input list, labels and ids only |
| `getLayerUrl` | `GET /api/projects/{id}/layers/{nodeId}?scale=raw\|normalized` | returns the URL of the pre-rendered document the iframe loads |
| `getModel` | `GET /api/projects/{id}/model` | read with `ruamel.yaml` so comments and order survive |
| `saveModel` | `PUT /api/projects/{id}/model` | validate with Pydantic before writing |
| `applyModel` | `POST /api/projects/{id}/model/apply` | save, then re-run the weighting; returns once accepted |
| `watchModelApply` | `GET /api/projects/{id}/model/apply/stream` | **SSE**, one `ApplyProgress` per variable — drives the loading dialog |
| `validateModel` | `POST /api/model/validate` | the engine's rules are the ones that decide |
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

### Two things to decide before the backend lands

- **Caching the rendered documents.** They are ~9 MB each and there will be one
  per layer. The dev server sends `Cache-Control: no-store` so a regenerated
  file is picked up immediately; production wants the opposite — a long cache
  with a content hash or an ETag in the URL — or every layer switch re-downloads.
- **Who owns validation.** The UI validates locally so Apply can react as you
  type (`src/lib/model.ts`, `isValid`). `validateModel` exists for the server's
  stricter answer but nothing gates on it yet.

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
  normalizacion: intervals
  intervalos:
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

- **The model tree is deliberately small** — `key`, `peso`, `excluyente`,
  `normalizacion`, `intervals`, `sub` — since the real config will change a lot. The YAML
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
