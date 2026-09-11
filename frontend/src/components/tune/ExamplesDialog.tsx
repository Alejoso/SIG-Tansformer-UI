/**
 * The starter structures. "Copy to editor" appends an example's variables to
 * the current model rather than replacing it, so nothing you have already
 * tuned is lost.
 */

import { useEffect, useState } from 'react';
import * as api from '../../api';
import type { ModelExample } from '../../types';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';

interface ExamplesDialogProps {
  onClose: () => void;
  onInsert: (example: ModelExample) => void;
}

export function ExamplesDialog({ onClose, onInsert }: ExamplesDialogProps) {
  const [examples, setExamples] = useState<ModelExample[]>([]);

  useEffect(() => {
    let live = true;
    api.listExamples().then((list) => {
      if (live) setExamples(list);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <Dialog onClose={onClose} className="examples-dialog" labelledBy="examples-title">
      <div className="examples-head">
        <div>
          <div className="dialog-title" id="examples-title">
            Example structures
          </div>
          <p className="dialog-body" style={{ margin: '4px 0 0', maxWidth: 560 }}>
            This is how a model is written. Every variable carries a <strong>peso</strong> (weight),
            can be <strong>excluyente</strong> — it rules the record out instead of just weighting
            it — has its own <strong>normalizacion</strong>, and may hold nested{' '}
            <strong>subvariables</strong>.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-icon btn-secondary"
          aria-label="Close examples"
          onClick={onClose}
          style={{ marginLeft: 'auto', flex: 'none' }}
        >
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="examples-list">
        {examples.map((example) => (
          <div key={example.id} className="example-card">
            <div className="example-title">{example.title}</div>
            <p className="example-blurb muted">{example.blurb}</p>
            <pre className="example-yaml">{example.yaml}</pre>
            <button
              type="button"
              className="btn btn-secondary btn-block"
              onClick={() => onInsert(example)}
              style={{ gap: 8 }}
            >
              <Icon name="copy" size={15} />
              Copy to editor
            </button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
