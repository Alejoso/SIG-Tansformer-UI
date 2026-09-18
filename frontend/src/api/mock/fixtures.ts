/**
 * Stand-in data, lifted from the design mockup.
 *
 * None of this outlives the backend — it exists so every screen has something
 * real-shaped to render. Values follow the `src/types.ts` contracts exactly,
 * so components written against the mocks work unchanged against the server.
 */

import type {
  DataFolder,
  Mesh,
  ModelConfig,
  ModelExample,
  Project,
  ProjectSettings,
  Variable,
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

/** Each variable carries a seed so the mock field is stable across renders. */
export const INPUT_VARIABLES: (Variable & { seed: number })[] = [
  { id: 'wind', name: 'Mean wind speed', unit: 'metres per second at 100 m', hint: 'How windy it is — higher is better for turbines', seed: 3, min: 4.1, max: 11.8, decimals: 1, suffix: ' m/s' },
  { id: 'slope', name: 'Terrain slope', unit: 'degrees', hint: 'How steep the ground is — steep land costs more to build on', seed: 7.4, min: 0, max: 27, decimals: 0, suffix: '°' },
  { id: 'sub', name: 'Distance to substation', unit: 'kilometres', hint: 'How far the power has to travel to reach the grid', seed: 11.2, min: 0.4, max: 62, decimals: 1, suffix: ' km' },
  { id: 'land', name: 'Land cover suitability', unit: 'index, 0 to 1', hint: 'How buildable the surface is — bare land scores high, forest low', seed: 15.8, min: 0, max: 1, decimals: 2, suffix: '' },
  { id: 'prot', name: 'Protected areas', unit: 'percent of hexagon covered', hint: 'How much of the hexagon is off limits', seed: 19.1, min: 0, max: 100, decimals: 0, suffix: '%' },
  { id: 'pop', name: 'Population density', unit: 'people per square kilometre', hint: 'How many people live nearby', seed: 23.6, min: 0, max: 1200, decimals: 0, suffix: ' /km²' },
];

export const MODEL_VARIABLES: (Variable & { seed: number })[] = [
  { id: 'score', name: 'Site suitability score', unit: '0 to 100, higher is better', hint: 'Every variable blended together using your weights', seed: 31.5, min: 0, max: 100, decimals: 0, suffix: '' },
  { id: 'cap', name: 'Buildable capacity', unit: 'megawatts per hexagon', hint: 'How much could realistically be installed here', seed: 37.2, min: 0, max: 48, decimals: 1, suffix: ' MW' },
  { id: 'cost', name: 'Grid connection cost', unit: 'dollars per kilowatt', hint: 'Estimated cost of getting the power to the grid', seed: 41.8, min: 40, max: 620, decimals: 0, suffix: ' $/kW' },
  { id: 'pen', name: 'Constraint penalty', unit: 'index, 0 to 1', hint: 'How much the site is held back by restrictions', seed: 47.3, min: 0, max: 1, decimals: 2, suffix: '' },
];

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
