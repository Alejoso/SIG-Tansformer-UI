# Maphex — SIG UI

Local interface for the H3 multicriteria pipeline. This repository currently
holds **the frontend only**: every screen from the design is built and working,
running against an in-memory mock of the backend.

```
SIG-UI/
├── design/      the source mockup (Maphex.dc.html + the Organic design system)
├── frontend/    React + Vite + TypeScript
└── README.md
```

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
| Map | `screens/MapScreen.tsx` + `map/HexMap.tsx` | deck.gl `H3HexagonLayer` over MapLibre, input/model switch, raw/normalized switch, legend, hover tooltip |
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
| `getHexLayer` | `GET /api/projects/{id}/hexes?variable={id}` | heaviest response; see note below |
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

- **`HexCell.normalized`.** Every cell carries both its value in its own units
  and the same value on a 0-1 scale, because the map's raw/normalized toggle
  switches between them. The engine owns that number — the UI deliberately
  does not re-derive it, or the map would disagree with the weighting that
  actually ran.
- **Two resolutions.** `ProjectSettings.processingResolution` is what the
  engine computes and stores at; `mapResolution` is only what gets drawn.
  When the map resolution is coarser, the backend has to aggregate stored
  cells up before sending them.
- **Per-variable apply progress.** `watchModelApply` streams one
  `ApplyProgress` per variable so the loading dialog can name what is being
  processed. The mock walks the variable tree parents-first; the engine should
  emit in whatever order it actually works.

### Two things to decide before the backend lands

- **`getHexLayer` payload size.** The mock returns ~3,800 cells. A full
  Colombia mesh at resolution 8 is hundreds of thousands, and one JSON array of
  `{h3, value}` will not be pleasant. Worth paging, streaming, or sending a
  binary/Arrow column pair.
- **Who owns validation.** The UI validates locally so Apply can react as you
  type (`src/lib/model.ts`, `isValid`). `validateModel` exists for the server's
  stricter answer but nothing gates on it yet.

## Notes on what was built

- **The map is real.** The mockup drew a fake SVG hex grid, because a design
  canvas cannot run WebGL. This uses the actual stack — deck.gl
  `H3HexagonLayer` + MapLibre + `h3-js` — with mock cells from
  `src/lib/h3mock.ts`. Only that generator gets deleted when the engine
  supplies real cells.
- **Mock data follows the design**, so the meshes are Ireland / Iberia / North
  Sea rather than Colombia. It is all in `src/api/mock/fixtures.ts`.
- **The model tree is deliberately small** — `key`, `peso`, `excluyente`,
  `normalizacion`, `sub` — since the real config will change a lot. The YAML
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
