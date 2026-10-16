/**
 * Stand-in data, lifted from the design mockup.
 *
 * None of this outlives the backend — it exists so every screen has something
 * real-shaped to render. Values follow the `src/types.ts` contracts exactly,
 * so components written against the mocks work unchanged against the server.
 */

import type { ModelExample, ProjectSettings } from '../../types';

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
