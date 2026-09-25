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
    { key: 'wind_speed', weight: '0.45', exclusion_variable: false, normalization: 'minmax' },
    { key: 'terrain_slope', weight: '0.15', exclusion_variable: false, normalization: 'standard' },
    {
      key: 'grid_access', weight: '0.30', exclusion_variable: false, normalization: 'minmax',
      sub: [
        { key: 'distance_to_substation', weight: '0.60', exclusion_variable: false, normalization: 'minmax' },
        { key: 'distance_to_road', weight: '0.40', exclusion_variable: false, normalization: 'standard' },
      ],
    },
    {
      // Starts on intervals so the table is visible without configuring
      // anything first. Bounds follow the engine's own 1-5 scoring bins.
      key: 'land_cover',
      weight: '0.10',
      exclusion_variable: false,
      normalization: 'intervals',
      intervals: [
        { from: '', to: '0.2', value: '1' },
        { from: '0.2', to: '0.4', value: '2' },
        { from: '0.4', to: '0.6', value: '3' },
        { from: '0.6', to: '0.8', value: '4' },
        { from: '0.8', to: '', value: '5' },
      ],
    },
    // An exclusion variable, so it carries no weight and no transform — the other four
    // add to 1.00 between them.
    { key: 'protected_area', weight: '0', exclusion_variable: true, normalization: 'minmax' },
  ],
};

export const EXAMPLES: ModelExample[] = [
  {
    id: 'a',
    title: 'Example A — one normalization per variable',
    blurb:
      'Flat variables. Each weighted one picks its own normalization method. The last rules a record out instead, so it carries no weight and no transform at all.',
    yaml: [
      'variables:',
      '  age:',
      '    weight: 0.30',
      '    exclusion_variable: false',
      '    normalization: minmax',
      '  household_income:',
      '    weight: 0.40',
      '    exclusion_variable: false',
      '    normalization: standard',
      '  education_level:',
      '    weight: 0.30',
      '    exclusion_variable: false',
      '    normalization: intervals',
      '    intervals:',
      '      - [null, 5, 1]',
      '      - [5, 11, 2]',
      '      - [11, null, 3]',
      '  hazard_zone:',
      '    exclusion_variable: true',
    ].join('\n'),
    variables: [
      { key: 'age', weight: '0.30', exclusion_variable: false, normalization: 'minmax' },
      { key: 'household_income', weight: '0.40', exclusion_variable: false, normalization: 'standard' },
      {
        key: 'education_level',
        weight: '0.30',
        exclusion_variable: false,
        normalization: 'intervals',
        intervals: [
          { from: '', to: '5', value: '1' },
          { from: '5', to: '11', value: '2' },
          { from: '11', to: '', value: '3' },
        ],
      },
      { key: 'hazard_zone', weight: '0', exclusion_variable: true, normalization: 'minmax' },
    ],
  },
  {
    id: 'b',
    title: 'Example B — variables with nested subvariables',
    blurb:
      'A variable can be made of other variables. Each weighted subvariable carries its own weight and normalization; an exclusion variable carries neither.',
    yaml: [
      'variables:',
      '  academic_performance:',
      '    weight: 0.5',
      '    exclusion_variable: false',
      '    normalization: minmax',
      '    subvariables:',
      '      mathematics:',
      '        weight: 0.5',
      '        exclusion_variable: false',
      '        normalization: standard',
      '      language:',
      '        weight: 0.3',
      '        exclusion_variable: false',
      '        normalization: standard',
      '      science:',
      '        weight: 0.2',
      '        exclusion_variable: false',
      '        normalization: standard',
      '  socioeconomic_context:',
      '    weight: 0.5',
      '    exclusion_variable: false',
      '    normalization: minmax',
      '    subvariables:',
      '      income_bracket:',
      '        weight: 1.0',
      '        exclusion_variable: false',
      '        normalization: minmax',
      '      welfare_register:',
      '        exclusion_variable: true',
    ].join('\n'),
    variables: [
      {
        key: 'academic_performance', weight: '0.5', exclusion_variable: false, normalization: 'minmax',
        sub: [
          { key: 'mathematics', weight: '0.5', exclusion_variable: false, normalization: 'standard' },
          { key: 'language', weight: '0.3', exclusion_variable: false, normalization: 'standard' },
          { key: 'science', weight: '0.2', exclusion_variable: false, normalization: 'standard' },
        ],
      },
      {
        key: 'socioeconomic_context', weight: '0.5', exclusion_variable: false, normalization: 'minmax',
        sub: [
          { key: 'income_bracket', weight: '1.0', exclusion_variable: false, normalization: 'minmax' },
          { key: 'welfare_register', weight: '0', exclusion_variable: true, normalization: 'minmax' },
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
