/**
 * Stand-in data, lifted from the design mockup.
 *
 * None of this outlives the backend — it exists so every screen has something
 * real-shaped to render. Values follow the `src/types.ts` contracts exactly,
 * so components written against the mocks work unchanged against the server.
 */

import type { ModelExample } from '../../types';

/**
 * The starter structures, in the engine's own schema.
 *
 * Each is a whole criterion, ready to be pasted under `criteria:` and have
 * its columns changed. They cover the three cases that come up: a continuous
 * variable scored from its own spread, one scored by hand-written cuts, and
 * a presence layer where anything found rules the hexagon down.
 */
export const EXAMPLES: ModelExample[] = [
  {
    id: 'spread',
    scope: 'criterion',
    title: 'Scored from the data',
    blurb:
      'The least you can write. `minmax` reads the range out of the column itself and stretches it onto 1-5, so there are no numbers to choose in advance. `direction: cost` is how you say a high value is bad.',
    yaml: [
      '  - key: economia',
      '    nombre: Economia',
      '    weight: 1.0',
      '    subgroups:',
      '      - key: dist_interes',
      '        weight: 0.6',
      '        leaves:',
      '          - {code: SOE-002, column: SOE_002, site: both, type: minmax}',
      '      - key: cond_vida',
      '        weight: 0.4',
      '        leaves:',
      '          - {code: SOE-003, column: SOE_003, site: both, type: minmax, direction: cost}',
    ].join('\n'),
  },
  {
    id: 'cuts',
    scope: 'criterion',
    title: 'Your own cuts',
    blurb:
      'When the thresholds matter more than the spread. Each bin is [from, to, score] and reads as (from, to] — exclusive below, inclusive above. `null` is unbounded, so the first and last bin catch everything outside.',
    yaml: [
      '  - key: recurso_eolico',
      '    nombre: Recurso eolico',
      '    weight: 1.0',
      '    subgroups:',
      '      - key: densidad_wpd',
      '        weight: 1.0',
      '        leaves:',
      '          - code: TEC-004',
      '            column: TEC_004_sv003',
      '            site: both',
      '            type: range',
      '            bins:',
      '              - [null, 300, 1]',
      '              - [300, 400, 2]',
      '              - [400, 500, 3]',
      '              - [500, 600, 4]',
      '              - [600, null, 5]',
    ].join('\n'),
  },
  {
    id: 'presence',
    scope: 'criterion',
    title: 'Presence, and the worst case',
    blurb:
      'A layer that only says "something is here". `map` turns the value into a score, `absent: 5` says an uncovered hexagon is fine, and `combine: min` lets one bad leaf decide the subgroup instead of being averaged away.',
    yaml: [
      '  - key: bioticas',
      '    nombre: Variables bioticas',
      '    weight: 1.0',
      '    subgroups:',
      '      - key: areas_protegidas',
      '        weight: 1.0',
      '        combine: min',
      '        absent: 5',
      '        leaves:',
      '          - {code: AMB-012, column: AMB_012, site: onshore, type: map, map: {"1": 0}}',
      '          - {code: AMB-021, column: AMB_021, site: offshore, type: map, map: {"1": 0}}',
    ].join('\n'),
  },
  {
    id: 'zoning',
    scope: 'top',
    title: 'Ruling hexagons out',
    blurb:
      'Zoning does not score anything — it removes hexagons before the model runs, and they come back marked excluded. By presence: any value in the column at all. By threshold: a cut on a continuous one. These are top-level keys, not part of a criterion.',
    yaml: [
      '# Any value in these columns excludes the hexagon.',
      'exclude_columns:',
      '  - AMB_001',
      '',
      '# Or a cut on a continuous variable: wind under 5 m/s is not worth building on.',
      'exclude_thresholds:',
      '  - code: TEC-001',
      '    source_column: TEC_001_sv004',
      '    op: lt',
      '    value: 5',
      '    out_column: TEC_001_excl',
    ].join('\n'),
  },
];

