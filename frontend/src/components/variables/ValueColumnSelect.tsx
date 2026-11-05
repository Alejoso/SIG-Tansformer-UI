/**
 * Which column is the value, for a file that has several.
 *
 * The engine turns a file into one value per hexagon, so a file with several
 * value columns (a shapefile with `Tipo_Roca`, `cohesion_M`, ...) is not
 * transformed until one is chosen. The candidates and their first value come
 * from the engine's own check, so what is offered is what the ingest sees.
 *
 * The same control in both places a choice is made: the dialog before
 * processing, and a variable's settings on the Data screen.
 */

import { describeCandidate, sourceLabel } from '../../lib/value-columns';
import type { ValueColumnSource } from '../../types';

interface Props {
  source: ValueColumnSource;
  value: string;
  onChange: (column: string) => void;
  /** What the empty choice says: "Leave for later", "Not chosen". */
  emptyLabel: string;
  disabled?: boolean;
  id?: string;
}

export function ValueColumnSelect({ source, value, onChange, emptyLabel, disabled, id }: Props) {
  // A chosen column the file no longer has is still shown, so the select
  // says what is stored rather than silently showing the empty choice.
  const missing = value && !source.candidates.some((candidate) => candidate.name === value);
  return (
    <select
      id={id}
      className="input value-column-select"
      aria-label={`Value column for ${source.variableId}/${sourceLabel(source)}`}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{emptyLabel}</option>
      {source.candidates.map((candidate) => (
        <option key={candidate.name} value={candidate.name}>
          {describeCandidate(candidate)}
        </option>
      ))}
      {missing && <option value={value}>{value}: not in the file any more</option>}
    </select>
  );
}
