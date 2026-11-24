import { useEffect, useMemo, useState } from 'react';
import * as api from '../../api';
import type { EngineConfig, EngineSetting } from '../../types';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

interface EngineSettingsDialogProps {
  onClose: () => void;
  /**
   * Open on just these settings, with the reason they are shown (from a
   * problem that names what to change). The rest is one click away.
   */
  focus?: { keys: string[]; reason: string };
}

/**
 * What a setting shows before anything is typed: its value in the engine's
 * `.env`, or the engine's default when the file does not set it.
 */
const effective = (setting: EngineSetting) => (setting.isSet ? setting.value : setting.default);

/** A flag that is on. Off is 0, or no line at all for one that is off by default. */
const isOn = (value: string) => value === '1';

/**
 * The engine's own configuration: every setting of its `.env`, grouped as
 * the engine groups them, each with what it does and its default.
 *
 * Machine-wide, not per project: one engine, one file. So it opens from the
 * project list rather than from inside a project, and says when each group
 * takes effect, since none of it changes a run that is already going (and
 * the backend refuses to write while one is).
 *
 * The connection, the Docker project name and the resolutions are shown and
 * not offered, each with the reason: changing them here would lock the engine
 * out of its database, start an empty one, or fight each project's own
 * resolution.
 */
export function EngineSettingsDialog({ onClose, focus }: EngineSettingsDialogProps) {
  const [config, setConfig] = useState<EngineConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Edits not saved yet: the new value, or null for "the engine's default". */
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [filter, setFilter] = useState('');
  const [focused, setFocused] = useState(Boolean(focus?.keys.length));

  useEffect(() => {
    let live = true;
    api
      .getEngineConfig()
      .then((loaded) => {
        if (live) setConfig(loaded);
      })
      .catch((failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : 'Could not load them');
      });
    return () => {
      live = false;
    };
  }, []);

  const byKey = useMemo(() => {
    const map = new Map<string, EngineSetting>();
    config?.sections.forEach((section) => section.settings.forEach((s) => map.set(s.key, s)));
    return map;
  }, [config]);

  /** Only what really changes: typing a value back to what it was is no edit. */
  const changes = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const [key, wanted] of Object.entries(draft)) {
      const setting = byKey.get(key);
      if (!setting) continue;
      if (wanted === null) {
        if (!setting.isDefault) out[key] = null;
      } else if (wanted !== effective(setting)) {
        out[key] = setting.optional && wanted.trim() === '' ? null : wanted;
      }
    }
    return out;
  }, [draft, byKey]);
  const changed = Object.keys(changes).length;

  const shown = (setting: EngineSetting) =>
    setting.key in draft ? (draft[setting.key] ?? setting.default) : effective(setting);

  const edit = (key: string, value: string | null) => {
    setSaved(false);
    setError(null);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      setConfig(await api.saveEngineConfig(changes));
      setDraft({});
      setSaved(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save them');
    } finally {
      setSaving(false);
    }
  };

  const needle = filter.trim().toLowerCase();
  const matches = (setting: EngineSetting) =>
    needle
      ? matchesText(setting)
      : !focused || !focus || focus.keys.includes(setting.key);
  const matchesText = (setting: EngineSetting) =>
    setting.label.toLowerCase().includes(needle) ||
    setting.key.toLowerCase().includes(needle) ||
    setting.description.toLowerCase().includes(needle);

  return (
    <Dialog
      onClose={onClose}
      width="min(760px, 100%)"
      className="engine-settings"
      labelledBy="engine-settings-title"
    >
      <div className="settings-head">
        <div className="dialog-title" id="engine-settings-title">
          Engine settings
        </div>
        {changed > 0 && (
          <span className="settings-source">
            {changed} unsaved change{changed === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {!config ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
          {error ? (
            <p className="settings-note is-error" style={{ margin: 0 }}>
              {error}
            </p>
          ) : (
            <Icon name="spinner" size={20} color="var(--color-accent)" className="spin" />
          )}
        </div>
      ) : (
        <>
          <p className="dialog-body" style={{ margin: 0 }}>
            The engine&apos;s configuration for this computer, shared by every project. Each
            setting shows its default; a project&apos;s own settings still win over these.
          </p>
          {!config.envExists && (
            <p className="settings-note is-error">
              No engine settings file at {config.envFile}. Create it from the engine&apos;s
              .env.example first (it holds the database credentials), or point this app at
              the engine&apos;s folder with MAPHEX_PIPELINE_DIR.
            </p>
          )}

          {focused && focus && (
            <div className="engine-settings-focus">
              <span>{focus.reason}</span>
              <button type="button" className="btn btn-ghost" onClick={() => setFocused(false)}>
                Show all settings
              </button>
            </div>
          )}

          <input
            className="input engine-settings-filter"
            type="search"
            placeholder="Find a setting"
            aria-label="Find a setting"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />

          <div className="engine-settings-body">
            {config.sections.map((section) => {
              const visible = section.settings.filter(matches);
              if (visible.length === 0) return null;
              return (
                <fieldset key={section.title} className="settings-options engine-section">
                  <legend>{section.title}</legend>
                  <p className="field-hint muted-55 engine-applies">Applies: {section.applies}</p>
                  {visible.map((setting) => (
                    <SettingRow
                      key={setting.key}
                      setting={setting}
                      value={shown(setting)}
                      edited={setting.key in changes}
                      disabled={!config.envExists}
                      onChange={(value) => edit(setting.key, value)}
                    />
                  ))}
                </fieldset>
              );
            })}
          </div>

          {error && <p className="settings-note is-error">{error}</p>}
          {saved && changed === 0 && (
            <p className="settings-note">
              Saved to the engine&apos;s settings file. They take effect as each group says
              above, from the next run.
            </p>
          )}
        </>
      )}

      <div className="dialog-actions">
        {changed > 0 && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setDraft({})}
            disabled={saving}
            style={{ marginRight: 'auto' }}
          >
            Undo changes
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {changed > 0 ? 'Cancel' : 'Close'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={saving || changed === 0 || !config?.envExists}
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </Dialog>
  );
}

interface SettingRowProps {
  setting: EngineSetting;
  value: string;
  edited: boolean;
  disabled: boolean;
  onChange: (value: string | null) => void;
}

function SettingRow({ setting, value, edited, disabled, onChange }: SettingRowProps) {
  const id = `engine-${setting.key}`;
  const locked = Boolean(setting.readOnly) || disabled;
  const atDefault = !edited && setting.isDefault;
  const defaultText =
    setting.default !== ''
      ? setting.kind === 'flag'
        ? isOn(setting.default)
          ? 'on'
          : 'off'
        : setting.default
      : setting.kind === 'flag'
        ? 'off'
        : setting.optional
          ? 'worked out by the engine'
          : 'none';

  let control: React.ReactNode;
  if (setting.secret) {
    control = (
      <input id={id} className="input" value={setting.isSet ? 'Set (hidden)' : 'Not set'} readOnly />
    );
  } else if (setting.kind === 'flag') {
    control = (
      <label className="engine-flag" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={isOn(value)}
          disabled={locked}
          onChange={(e) => onChange(e.target.checked ? '1' : setting.optional ? null : '0')}
        />
        <span>{isOn(value) ? 'On' : 'Off'}</span>
      </label>
    );
  } else if (setting.kind === 'choice') {
    control = (
      <select
        id={id}
        className="input"
        value={value}
        disabled={locked}
        onChange={(e) => onChange(e.target.value)}
      >
        {setting.optional && <option value="">(not set)</option>}
        {setting.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        id={id}
        className="input mono"
        value={value}
        readOnly={locked}
        placeholder={setting.optional ? 'automatic' : undefined}
        inputMode={setting.kind === 'int' || setting.kind === 'float' ? 'decimal' : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className={`engine-setting${edited ? ' is-edited' : ''}`} data-key={setting.key}>
      <div className="engine-setting-head">
        <label htmlFor={id} className="settings-option-label">
          {setting.label}
        </label>
        <span className="engine-setting-key mono muted-50">{setting.key}</span>
      </div>
      <div className="engine-setting-control">
        {control}
        {!setting.readOnly && !atDefault && (
          <button
            type="button"
            className="btn btn-ghost engine-setting-reset"
            onClick={() => onChange(null)}
            disabled={disabled}
            title={`Back to the engine's default (${defaultText})`}
          >
            Default
          </button>
        )}
      </div>
      <p className="field-hint muted-55">
        {setting.description}
        {setting.readOnly ? (
          <> {setting.readOnly}</>
        ) : (
          <>
            {' '}
            Default: <span className="mono">{defaultText}</span>.
          </>
        )}
      </p>
    </div>
  );
}
