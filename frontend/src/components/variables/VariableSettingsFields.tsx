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
  /**
   * The project's mesh has a sea (only Colombia from DANE does). Without one
   * the engine refuses the `sea` domain, so it is not offered, and `land`
   * and everywhere both mean the whole mesh.
   */
  hasSea?: boolean;
  onChange: (value: VariableSettings) => void;
  /** Distinguishes the fields of one row from the next, for labels. */
  idPrefix: string;
  disabled?: boolean;
  /** Without the explanations: for the rows of a batch, where they repeat. */
  compact?: boolean;
}

export function VariableSettingsFields({
  value,
  onChange,
  idPrefix,
  disabled,
  compact,
  hasSea = true,
}: Props) {
  const listId = `${idPrefix}-fill-options`;
  // A sea already chosen stays visible, so the field does not silently read
  // as something else; the server refuses it on save, saying why.
  const domains = DOMAINS.filter(
    (domain) => hasSea || domain.value !== 'sea' || value.fillDomain === 'sea',
  );

  return (
    <div className={`variable-settings${compact ? ' is-compact' : ''}`}>
      <label className="variable-settings-field" htmlFor={`${idPrefix}-fill`}>
        <span>
          Fill
          {!compact && (
            <InfoTip label="About fill">
              How the engine fills this variable's empty hexagons while processing: each
              method fills what the previous one left. <code>spatial</code> takes the
              neighbours' mean, <code>region</code> the{' '}
              {hasSea ? "municipality's" : "mesh area's"}, <code>nearest</code>{' '}
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
        <span>
          Where
          {!compact && !hasSea && (
            <InfoTip label="About where">
              This project's mesh has no sea, so land and everywhere both cover the whole mesh.
              Onshore and offshore need two projects.
            </InfoTip>
          )}
        </span>
        <select
          id={`${idPrefix}-domain`}
          className="input"
          value={value.fillDomain}
          disabled={disabled || value.fill.trim() === 'none'}
          onChange={(e) => onChange({ ...value, fillDomain: e.target.value as FillDomain })}
        >
          {domains.map((domain) => (
            <option key={domain.value} value={domain.value}>
              {domain.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
