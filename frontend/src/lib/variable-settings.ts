/**
 * A variable's fill and absent, as the Data screen shows them. See
 * `components/variables/VariableSettingsFields.tsx` for the fields.
 */

import type { VariableSettings } from '../types';

/** The chains worth offering. Anything else the engine accepts can be typed. */
export const FILL_SUGGESTIONS = [
  'spatial, median',
  'region, nearest',
  'nearest',
  'idw, median',
  'median',
  'mean',
  'none',
];

/** One line saying what a variable will get, for its row in the list. */
export function describeSettings(value: VariableSettings): string {
  const fill =
    value.fill.trim() === 'none'
      ? 'not filled'
      : `filled with ${value.fill}${value.fillDomain === 'all' ? '' : ` (${value.fillDomain})`}`;
  return `${fill} · absent ${value.absent}`;
}

/** The three fields out of anything that carries them. */
export const settingsOf = (source: VariableSettings): VariableSettings => ({
  fill: source.fill,
  fillDomain: source.fillDomain,
  absent: source.absent,
});
