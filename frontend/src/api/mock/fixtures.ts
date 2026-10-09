/**
 * Stand-in data, lifted from the design mockup.
 *
 * None of this outlives the backend — it exists so every screen has something
 * real-shaped to render. Values follow the `src/types.ts` contracts exactly,
 * so components written against the mocks work unchanged against the server.
 */

import type { LayerTree, ModelExample, ProjectSettings } from '../../types';

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
   * One per uploaded folder. Deliberately not in alphabetical order here —
   * the UI sorts them, so the list stays findable whatever order the backend
   * happens to send.
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
