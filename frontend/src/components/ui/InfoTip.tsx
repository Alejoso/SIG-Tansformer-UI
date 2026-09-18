/**
 * A small "what is this?" marker with an explanation on hover and focus.
 *
 * Deliberately not `title=""`: the native tooltip never appears for keyboard
 * users and cannot be styled to match the design system. This renders a real
 * element, is reachable by Tab, and is wired up with `aria-describedby` so a
 * screen reader reads the explanation along with the control.
 */

import { useId, useState } from 'react';

interface InfoTipProps {
  /** The explanation. Kept short — one or two sentences. */
  children: React.ReactNode;
  /** Describes the marker itself, e.g. "About exclusive variables". */
  label: string;
  /** Which side of the marker the bubble opens on. */
  placement?: 'top' | 'bottom';
}

export function InfoTip({ children, label, placement = 'top' }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className="infotip">
      <button
        type="button"
        className="infotip-marker"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // Tapping is the only way in on touch, where there is no hover.
        onClick={(e) => {
          e.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        ?
      </button>
      {open && (
        <span role="tooltip" id={id} className={`infotip-bubble is-${placement}`}>
          {children}
        </span>
      )}
    </span>
  );
}

/**
 * The one explanation of what `exclusive` requires of the underlying data.
 * Shared so the YAML editor and the diagram cannot drift apart on it.
 */
export function ExclusiveTip({ placement = 'top' }: { placement?: 'top' | 'bottom' }) {
  return (
    <InfoTip label="About exclusive variables" placement={placement}>
      An exclusive variable rules a hexagon out instead of weighting it, so its
      data has to be <strong>boolean</strong>: <strong>1</strong> where the
      variable excludes the cell, <strong>0</strong> where it does not. Any
      other value cannot be read as a yes-or-no.
    </InfoTip>
  );
}
