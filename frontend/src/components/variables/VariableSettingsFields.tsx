/**
 * A variable's fill: how the engine fills its empty hexagons while
 * processing. What is still empty after it is scored by the model's
 * `absent`, which belongs in the model file, not here.
 *
 * The same two fields wherever a variable is set up: on each row of a folder
 * being added (already holding the default for that kind of file), and when
 * an added variable is edited. The backend has the final word on what is
 * valid; the fields only offer the common choices.
 */

import { FILL_SUGGESTIONS } from '../../lib/variable-settings';
import type { FillDomain, VariableSettings } from '../../types';
import { InfoTip } from '../ui/InfoTip';

const DOMAINS: { value: FillDomain; label: string }[] = [
  { value: 'all', label: 'everywhere' },
  { value: 'land', label: 'land' },
  { value: 'sea', label: 'sea' },
];

interface Props {
  value: VariableSettings;
  onChange: (value: VariableSettings) => void;
  /** Distinguishes the fields of one row from the next, for labels. */
  idPrefix: string;
  disabled?: boolean;
  /** Without the explanations: for the rows of a batch, where they repeat. */
  compact?: boolean;
}

export function VariableSettingsFields({ value, onChange, idPrefix, disabled, compact }: Props) {
  const listId = `${idPrefix}-fill-options`;

  return (
    <div className={`variable-settings${compact ? ' is-compact' : ''}`}>
      <label className="variable-settings-field" htmlFor={`${idPrefix}-fill`}>
        <span>
          Fill
          {!compact && (
            <InfoTip label="About fill">
              How the engine fills this variable's empty hexagons while processing: each
              method fills what the previous one left. <code>spatial</code> takes the
              neighbours' mean, <code>region</code> the municipality's, <code>nearest</code>{' '}
              the closest value, <code>median</code> the variable's median, a number a fixed
              value. <code>none</code> leaves the gaps; the model's <code>absent</code>{' '}
              scores whatever is still empty.
            </InfoTip>
          )}
        </span>
        <input
          id={`${idPrefix}-fill`}
          className="input mono"
          list={listId}
          value={value.fill}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, fill: e.target.value })}
        />
        <datalist id={listId}>
          {FILL_SUGGESTIONS.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      </label>

      <label className="variable-settings-field" htmlFor={`${idPrefix}-domain`}>
        <span>Where</span>
        <select
          id={`${idPrefix}-domain`}
          className="input"
          value={value.fillDomain}
          disabled={disabled || value.fill.trim() === 'none'}
          onChange={(e) => onChange({ ...value, fillDomain: e.target.value as FillDomain })}
        >
          {DOMAINS.map((domain) => (
            <option key={domain.value} value={domain.value}>
              {domain.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
