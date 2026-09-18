/**
 * Stand-in data, lifted from the design mockup.
 *
 * None of this outlives the backend — it exists so every screen has something
 * real-shaped to render. Values follow the `src/types.ts` contracts exactly,
 * so components written against the mocks work unchanged against the server.
 */

import type {
  DataFolder,
  LayerTree,
  Mesh,
  ModelConfig,
  ModelExample,
  Project,
  ProjectSettings,
} from '../../types';

export const MESHES: Mesh[] = [
  { id: 'ireland_5km_mesh.geojson', label: 'Ireland — 5 km mesh' },
  { id: 'iberia_10km_mesh.geojson', label: 'Iberia — 10 km mesh' },
  { id: 'north_sea_2km_mesh.geojson', label: 'North Sea — 2 km mesh' },
];

export const PROJECTS: Project[] = [
  {
    id: 'ridgeline',
    name: 'Ridgeline Wind — Phase 2',
    meshId: 'ireland_5km_mesh.geojson',
    meshLabel: 'Ireland — 5 km mesh',
    status: 'processed',
    description: '',
    outFolder: '/Projects/Ridgeline/results',
    variableCount: 6,
    hexagonCount: 4812,
    updatedAt: '2 days ago',
  },
  {
    id: 'coastal-solar',
    name: 'Coastal Solar Screening',
    meshId: 'iberia_10km_mesh.geojson',
    meshLabel: 'Iberia — 10 km mesh',
    status: 'processed',
    description: '',
    outFolder: '/Projects/CoastalSolar/results',
    variableCount: 4,
    hexagonCount: 9140,
    updatedAt: 'last week',
  },
  {
    id: 'north-sea-cable',
    name: 'North Sea Cable Route',
    meshId: 'north_sea_2km_mesh.geojson',
    meshLabel: 'North Sea — 2 km mesh',
    status: 'draft',
    description: '',
    outFolder: '',
    variableCount: 0,
    hexagonCount: 0,
    updatedAt: '3 folders added, not processed',
  },
  {
    id: 'grid-reinforcement',
    name: 'Grid Reinforcement Study',
    meshId: 'ireland_5km_mesh.geojson',
    meshLabel: 'Ireland — 5 km mesh',
    status: 'processed',
    description: '',
    outFolder: '/Projects/GridReinforcement/results',
    variableCount: 8,
    hexagonCount: 4812,
    updatedAt: '3 weeks ago',
  },
];

/** The pool the dropzone draws from when you "browse" for folders. */
export const AVAILABLE_FOLDERS: DataFolder[] = [
  { id: 'f0', name: 'wind_atlas_2024', path: '/data/in/wind_atlas_2024', fileCount: 18, sizeBytes: 412e6, state: 'pending' },
  { id: 'f1', name: 'srtm_terrain_tiles', path: '/data/in/srtm_terrain_tiles', fileCount: 64, sizeBytes: 1.2e9, state: 'pending' },
  { id: 'f2', name: 'grid_substations', path: '/data/in/grid_substations', fileCount: 3, sizeBytes: 8e6, state: 'pending' },
  { id: 'f3', name: 'corine_landcover', path: '/data/in/corine_landcover', fileCount: 22, sizeBytes: 640e6, state: 'pending' },
  { id: 'f4', name: 'natura2000_protected', path: '/data/in/natura2000_protected', fileCount: 7, sizeBytes: 96e6, state: 'pending' },
  { id: 'f5', name: 'population_grid_1km', path: '/data/in/population_grid_1km', fileCount: 4, sizeBytes: 128e6, state: 'pending' },
  { id: 'f6', name: 'road_network', path: '/data/in/road_network', fileCount: 11, sizeBytes: 210e6, state: 'pending' },
  { id: 'f7', name: 'existing_wind_farms', path: '/data/in/existing_wind_farms', fileCount: 2, sizeBytes: 4e6, state: 'pending' },
];

/**
 * The structure the engine would report after rendering a project.
 *
 * This is the one thing to replace when the backend lands: it will send the
 * same shape, built from what it actually generated. Nesting here is
 * deliberately uneven — two levels under `grid_access`, one under
 * `protected_areas`, and flat leaves elsewhere — so the tree is exercised
 * rather than assumed.
 */
export const LAYER_TREE: LayerTree = {
  model: {
    combined: {
      id: 'model',
      label: 'Complete model',
      description: 'Every variable blended together using your weights',
      hasDocument: true,
    },
    // Nesting here is deliberately uneven — three levels under `grid_access`,
    // two under `protected_areas`, flat elsewhere — so the tree is exercised
    // rather than assumed.
    variables: [
      {
        id: 'wind_speed',
        label: 'Mean wind speed',
        description: 'How windy it is — higher is better for turbines',
        hasDocument: true,
      },
      {
        id: 'terrain_slope',
        label: 'Terrain slope',
        description: 'How steep the ground is — steep land costs more to build on',
        hasDocument: true,
      },
      {
        id: 'grid_access',
        label: 'Grid access',
        description: 'How easily the power reaches the network',
        hasDocument: true,
        children: [
          {
            id: 'distance_to_substation',
            label: 'Distance to substation',
            description: 'How far the power has to travel to reach the grid',
            hasDocument: true,
            children: [
              { id: 'substation_hv', label: 'High-voltage substations', hasDocument: true },
              { id: 'substation_mv', label: 'Medium-voltage substations', hasDocument: true },
            ],
          },
          {
            id: 'distance_to_road',
            label: 'Distance to road',
            description: 'How far equipment has to be hauled',
            hasDocument: true,
          },
        ],
      },
      {
        id: 'land_cover',
        label: 'Land cover suitability',
        description: 'How buildable the surface is — bare land scores high, forest low',
        hasDocument: true,
      },
      {
        id: 'protected_areas',
        label: 'Protected areas',
        description: 'How much of the hexagon is off limits',
        hasDocument: true,
        children: [
          { id: 'natura_2000', label: 'Natura 2000 sites', hasDocument: true },
          { id: 'national_parks', label: 'National parks', hasDocument: true },
        ],
      },
    ],
  },
  /**
   * One per uploaded folder, matching `AVAILABLE_FOLDERS`. Deliberately not in
   * alphabetical order here — the UI sorts them, so the list stays findable
   * whatever order the backend happens to send.
   */
  inputs: [
    { id: 'wind_atlas_2024', label: 'Mean wind speed', description: 'Metres per second at 100 m', hasDocument: true },
    { id: 'srtm_terrain_tiles', label: 'Terrain slope', description: 'Degrees', hasDocument: true },
    { id: 'grid_substations', label: 'Distance to substation', description: 'Kilometres', hasDocument: true },
    { id: 'corine_landcover', label: 'Land cover suitability', description: 'Index, 0 to 1', hasDocument: true },
    { id: 'natura2000_protected', label: 'Protected areas', description: 'Percent of hexagon covered', hasDocument: true },
    { id: 'population_grid_1km', label: 'Population density', description: 'People per square kilometre', hasDocument: true },
    { id: 'road_network', label: 'Road network', description: 'Distance to the nearest road, in kilometres', hasDocument: true },
    { id: 'existing_wind_farms', label: 'Existing wind farms', description: 'Installed capacity nearby, in megawatts', hasDocument: true },
  ],
};

export const DEFAULT_MODEL: ModelConfig = {
  project: 'ridgeline_wind_phase_2',
  model: 'suitability_v2',
  objective: 'maximize',
  resolution: '8',
  variables: [
    { key: 'wind_speed', peso: '0.40', excluyente: false, normalizacion: 'minmax' },
    { key: 'terrain_slope', peso: '0.15', excluyente: false, normalizacion: 'zscore' },
    {
      key: 'grid_access', peso: '0.30', excluyente: false, normalizacion: 'ninguna',
      sub: [
        { key: 'distance_to_substation', peso: '0.60', excluyente: false, normalizacion: 'minmax' },
        { key: 'distance_to_road', peso: '0.40', excluyente: false, normalizacion: 'minmax' },
      ],
    },
    { key: 'land_cover', peso: '0.10', excluyente: false, normalizacion: 'log' },
    { key: 'protected_area', peso: '0.05', excluyente: true, normalizacion: 'ninguna' },
  ],
};

export const EXAMPLES: ModelExample[] = [
  {
    id: 'a',
    title: 'Example A — one normalisation per variable',
    blurb:
      'Flat variables. Each one picks its own normalisation method, and one of them rules the record out instead of weighting it.',
    yaml: [
      'variables:',
      '  edad:',
      '    peso: 0.25',
      '    excluyente: false',
      '    normalizacion: minmax',
      '  ingreso_familiar:',
      '    peso: 0.35',
      '    excluyente: false',
      '    normalizacion: zscore',
      '  nivel_educativo:',
      '    peso: 0.25',
      '    excluyente: false',
      '    normalizacion: log',
      '  zona_riesgo:',
      '    peso: 0.15',
      '    excluyente: true',
      '    normalizacion: ninguna',
    ].join('\n'),
    variables: [
      { key: 'edad', peso: '0.25', excluyente: false, normalizacion: 'minmax' },
      { key: 'ingreso_familiar', peso: '0.35', excluyente: false, normalizacion: 'zscore' },
      { key: 'nivel_educativo', peso: '0.25', excluyente: false, normalizacion: 'log' },
      { key: 'zona_riesgo', peso: '0.15', excluyente: true, normalizacion: 'ninguna' },
    ],
  },
  {
    id: 'b',
    title: 'Example B — variables with nested subvariables',
    blurb:
      'A variable can be made of other variables. Every subvariable carries its own weight, exclusion flag and normalisation.',
    yaml: [
      'variables:',
      '  desempeno_academico:',
      '    peso: 0.5',
      '    excluyente: false',
      '    normalizacion: minmax',
      '    subvariables:',
      '      matematicas:',
      '        peso: 0.5',
      '        excluyente: false',
      '        normalizacion: zscore',
      '      lenguaje:',
      '        peso: 0.3',
      '        excluyente: false',
      '        normalizacion: zscore',
      '      ciencias:',
      '        peso: 0.2',
      '        excluyente: false',
      '        normalizacion: zscore',
      '  contexto_socioeconomico:',
      '    peso: 0.5',
      '    excluyente: false',
      '    normalizacion: ninguna',
      '    subvariables:',
      '      estrato:',
      '        peso: 0.6',
      '        excluyente: false',
      '        normalizacion: minmax',
      '      sisben:',
      '        peso: 0.4',
      '        excluyente: true',
      '        normalizacion: ninguna',
    ].join('\n'),
    variables: [
      {
        key: 'desempeno_academico', peso: '0.5', excluyente: false, normalizacion: 'minmax',
        sub: [
          { key: 'matematicas', peso: '0.5', excluyente: false, normalizacion: 'zscore' },
          { key: 'lenguaje', peso: '0.3', excluyente: false, normalizacion: 'zscore' },
          { key: 'ciencias', peso: '0.2', excluyente: false, normalizacion: 'zscore' },
        ],
      },
      {
        key: 'contexto_socioeconomico', peso: '0.5', excluyente: false, normalizacion: 'ninguna',
        sub: [
          { key: 'estrato', peso: '0.6', excluyente: false, normalizacion: 'minmax' },
          { key: 'sisben', peso: '0.4', excluyente: true, normalizacion: 'ninguna' },
        ],
      },
    ],
  },
];

export const DEFAULT_SETTINGS: ProjectSettings = {
  pipelineVersion: 'v2.4 (current)',
  processingResolution: 8,
  // Defaults to the processing resolution: showing every cell that was
  // computed is the honest starting point, and coarsening is a deliberate
  // choice the user makes for speed.
  mapResolution: 8,
  coordinateSystem: 'EPSG:4326',
};

export const PIPELINE_VERSIONS = ['v2.4 (current)', 'v2.3', 'v1.9 (legacy)'];
