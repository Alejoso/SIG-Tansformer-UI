/**
 * A select you can type into.
 *
 * A plain `<select>` stops being usable somewhere around thirty options, and
 * the country list is 177. This keeps the shape of a form field but filters as
 * you type and is drivable from the keyboard.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface SearchableOption {
  id: string;
  label: string;
  /** Shown to the right of the label, e.g. a continent. */
  hint?: string;
  /** Matched against as well as the label — alternative names, codes. */
  search?: string;
}

interface SearchableSelectProps {
  options: SearchableOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  /** Shown when the filter matches nothing. */
  emptyText?: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Search…',
  disabled,
  id,
  emptyText = 'Nothing matches',
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listId = `${inputId}-list`;

  const selected = options.find((option) => option.id === value) ?? null;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;

    /**
     * How well an option answers to the query, lower being better.
     *
     * Ranking matters because aliases are generous: every country carries its
     * sovereign's name, so typing "United States of America" matches Puerto
     * Rico as well as the United States. A hit on the label itself has to beat
     * a hit on an alias, or the thing you asked for is not first.
     */
    const rank = (option: SearchableOption): number => {
      const label = option.label.toLowerCase();
      if (label === needle) return 0;
      if (label.startsWith(needle)) return 1;
      if (label.includes(needle)) return 2;
      return (option.search ?? '').toLowerCase().includes(needle) ? 3 : Infinity;
    };

    return options
      .map((option) => ({ option, score: rank(option) }))
      .filter((entry) => entry.score !== Infinity)
      .sort((a, b) => a.score - b.score || a.option.label.localeCompare(b.option.label))
      .map((entry) => entry.option);
  }, [options, query]);

  // Close when the click lands anywhere else.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted row in view while arrowing through 177 of them.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, open]);

  const choose = (optionId: string) => {
    onChange(optionId);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlighted((current) => {
        if (matches.length === 0) return 0;
        return (current + step + matches.length) % matches.length;
      });
      return;
    }
    if (event.key === 'Enter' && open) {
      event.preventDefault();
      const picked = matches[highlighted];
      if (picked) choose(picked.id);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div className="combo" ref={root}>
      <div className="combo-control">
        <input
          id={inputId}
          className="input combo-input"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[highlighted] ? `${listId}-${highlighted}` : undefined}
          autoComplete="off"
          disabled={disabled}
          // Showing the selection as the value until you type keeps this
          // reading as a filled-in field rather than an empty search box.
          value={open ? query : (selected?.label ?? '')}
          placeholder={selected ? selected.label : placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlighted(0);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <Icon name="chevronRight" size={14} className="combo-caret" />
      </div>

      {open && (
        <ul className="combo-list" id={listId} role="listbox" ref={listRef}>
          {matches.length === 0 && <li className="combo-empty">{emptyText}</li>}
          {matches.map((option, index) => (
            <li
              key={option.id}
              id={`${listId}-${index}`}
              data-index={index}
              role="option"
              aria-selected={option.id === value}
              className={`combo-option${index === highlighted ? ' is-highlighted' : ''}${
                option.id === value ? ' is-selected' : ''
              }`}
              // mousedown, not click: the input blurs first otherwise and the
              // list closes before the click lands.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option.id);
              }}
              onMouseEnter={() => setHighlighted(index)}
            >
              <span className="combo-option-label">{option.label}</span>
              {option.hint && <span className="combo-option-hint">{option.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
