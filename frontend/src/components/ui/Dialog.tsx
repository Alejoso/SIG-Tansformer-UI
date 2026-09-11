/**
 * The modal shell: backdrop, Escape to close, focus moved into the dialog.
 * The design system supplies `.dialog-backdrop` / `.dialog`; this adds the
 * behaviour those classes cannot.
 */

import { useEffect, useRef } from 'react';

interface DialogProps {
  onClose: () => void;
  /** Overrides the design system's 440px default. */
  width?: string;
  className?: string;
  style?: React.CSSProperties;
  labelledBy?: string;
  children: React.ReactNode;
}

export function Dialog({ onClose, width, className, style, labelledBy, children }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={className ? `dialog ${className}` : 'dialog'}
        style={{ width, ...style }}
      >
        {children}
      </div>
    </div>
  );
}
