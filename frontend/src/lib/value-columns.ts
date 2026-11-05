/**
 * How a file's candidate value columns read on screen: its name, its first
 * value and its type, as the engine's own check reported them.
 */

import type { ValueColumnCandidate, ValueColumnSource } from '../types';

/** The first value as it reads in a list: short, and saying so when empty. */
export function formatSample(sample: ValueColumnCandidate['sample']): string {
  if (sample === null || sample === undefined || sample === '') return 'empty';
  const text = String(sample);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** The column's type as a reader would say it, from the engine's dtype. */
export function kindOf(dtype: string): string {
  const lower = dtype.toLowerCase();
  if (!lower || lower === 'unknown') return '';
  if (/bool/.test(lower)) return 'yes/no';
  if (/date|time/.test(lower)) return 'date';
  if (/int|float|decimal|double/.test(lower)) return 'number';
  if (/object|str|category/.test(lower)) return 'text';
  return lower;
}

/** `Total_Victimas_Caso: 9 (number)` */
export function describeCandidate(candidate: ValueColumnCandidate): string {
  const kind = kindOf(candidate.dtype);
  return `${candidate.name}: ${formatSample(candidate.sample)}${kind ? ` (${kind})` : ''}`;
}

/** Where a source sits, for its label: the file, and its layer when it has several. */
export function sourceLabel(source: ValueColumnSource): string {
  return source.layer ? `${source.file} (layer ${source.layer})` : source.file;
}
