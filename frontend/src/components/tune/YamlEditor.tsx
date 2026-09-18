/**
 * The left half of the tune screen: the config rendered as numbered YAML
 * lines, with every editable value as a real control.
 *
 * It renders from `toLines(model)` rather than from text, which is what makes
 * it impossible for this pane and the diagram to disagree. Free-text editing
 * would need a parser here — and, on the backend, ruamel.yaml to write the
 * file back without losing comments.
 */

import { NORMALISATIONS, type ModelLine } from '../../lib/model';
import type { ModelPath, Normalisation } from '../../types';
import { Icon } from '../ui/Icon';
import { ExcluyenteTip } from '../ui/InfoTip';

interface YamlEditorProps {
  lines: ModelLine[];
  onWeight: (path: ModelPath, value: string) => void;
  onExcluyente: (path: ModelPath, value: boolean) => void;
  onNormalisation: (path: ModelPath, value: Normalisation) => void;
  onResolution: (value: string) => void;
}

const isBadWeight = (value: string) => {
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) || parsed < 0 || parsed > 1;
};

export function YamlEditor({
  lines,
  onWeight,
  onExcluyente,
  onNormalisation,
  onResolution,
}: YamlEditorProps) {
  /** The value control for one line, chosen by what the line edits. */
  function renderValue(line: ModelLine) {
    const target = line.target;

    if (line.kind === 'plain') return <span className="yaml-plain">{line.value}</span>;

    if (line.kind === 'text' && target?.kind === 'resolution') {
      return (
        <input
          className={`yaml-input${/^\d+$/.test(line.value ?? '') ? '' : ' is-invalid'}`}
          value={line.value}
          aria-label="H3 resolution"
          onChange={(e) => onResolution(e.target.value)}
        />
      );
    }

    if (line.kind === 'text' && target?.kind === 'peso') {
      const { path } = target;
      return (
        <input
          className={`yaml-input${isBadWeight(line.value ?? '') ? ' is-invalid' : ''}`}
          value={line.value}
          aria-label="Weight"
          onChange={(e) => onWeight(path, e.target.value)}
        />
      );
    }

    if (line.kind === 'bool' && target?.kind === 'excluyente') {
      const { path, current } = target;
      return (
        <>
          <button
            type="button"
            className={`yaml-bool${current ? ' is-on' : ''}`}
            aria-pressed={current}
            onClick={() => onExcluyente(path, !current)}
          >
            {line.value}
          </button>
          {current && <ExcluyenteTip placement="bottom" />}
        </>
      );
    }

    if (line.kind === 'enum' && target?.kind === 'normalizacion') {
      const { path } = target;
      return (
        <select
          className="yaml-select"
          value={line.value}
          aria-label="Normalisation"
          onChange={(e) => onNormalisation(path, e.target.value as Normalisation)}
        >
          {NORMALISATIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }

    return null;
  }

  return (
    <section className="yaml-pane" aria-label="Model configuration">
      <header className="yaml-head">
        <Icon name="file" size={15} color="var(--color-accent-600)" />
        <span className="yaml-filename">model_weights.yaml</span>
        <span className="yaml-kind muted-50">plain text</span>
      </header>

      <div className="yaml-body">
        {lines.map((line) => (
          <div
            className={`yaml-line${line.informative ? ' is-informative' : ''}`}
            key={line.n}
          >
            <span className="yaml-gutter">{line.n}</span>
            <span className="yaml-indent" style={{ width: line.indent * 16 }} />
            <span
              className={`yaml-key ${line.indent > 1 ? 'depth-2' : line.indent === 1 ? 'depth-1' : ''}`}
            >
              {line.key}
            </span>
            {/* Section headings are drawn bare, as in the design. */}
            {line.kind !== 'section' && <span className="yaml-colon">:</span>}
            {renderValue(line)}
            {line.kind === 'section' && line.informative && (
              <span className="yaml-badge">informative</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
