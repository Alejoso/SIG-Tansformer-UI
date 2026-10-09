/**
 * A YAML text editor.
 *
 * The model file used to be rendered as fixed rows with a control per field,
 * which made the shape of a model something the UI decided rather than
 * something the file expressed. This is a real editor: type anything, paste
 * anything, keep your comments and your ordering.
 *
 * What it gives back in exchange for that freedom is immediate feedback —
 * highlighting, a gutter mark and an underline on anything that does not
 * parse — so a mistake is visible where it was made rather than after a save.
 */

import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { yaml as yamlLanguage } from '@codemirror/lang-yaml';
import { tags } from '@lezer/highlight';

import { lintYaml } from '../../lib/yaml-lint';

/**
 * Syntax colours drawn from the Organic ramps, so the editor belongs to the
 * same interface as everything around it rather than looking like a window
 * from another application.
 */
const highlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--color-neutral-600)', fontStyle: 'italic' },
  { tag: [tags.definitionKeyword, tags.keyword], color: 'var(--color-accent-700)' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--color-accent-700)', fontWeight: '600' },
  { tag: tags.string, color: 'var(--color-accent-2-700)' },
  { tag: tags.number, color: 'var(--color-accent-2-800)', fontWeight: '600' },
  { tag: [tags.bool, tags.null, tags.atom], color: 'var(--color-accent-600)', fontWeight: '600' },
  { tag: [tags.punctuation, tags.separator], color: 'var(--color-neutral-500)' },
  { tag: tags.invalid, color: 'var(--color-accent)', textDecoration: 'underline wavy' },
]);

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--color-neutral-100)',
    color: 'var(--color-text)',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    lineHeight: '1.65',
  },
  '.cm-content': { padding: '10px 0 24px' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-neutral-100)',
    border: 'none',
    color: 'var(--color-neutral-400)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 7%, transparent)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
    color: 'var(--color-accent-800)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--color-accent)', borderLeftWidth: '2px' },
  '&.cm-focused': { outline: 'none' },
  // The default selection is invisible on a cream ground.
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 24%, transparent)',
  },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--color-accent)',
    textUnderlineOffset: '3px',
  },
  '.cm-tooltip': {
    border: 'none',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--color-neutral-900)',
    color: 'var(--color-neutral-100)',
    fontFamily: 'var(--font-body)',
    fontSize: '12px',
    padding: '4px 2px',
    boxShadow: 'var(--shadow-md)',
  },
});

interface YamlCodeEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** Disables editing while a save is in flight. */
  readOnly?: boolean;
}

export function YamlCodeEditor({ value, onChange, readOnly = false }: YamlCodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** Kept in a ref so the editor is built once rather than on every keystroke. */
  const emit = useRef(onChange);
  emit.current = onChange;

  useEffect(() => {
    if (!host.current) return;

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      bracketMatching(),
      highlightSelectionMatches(),
      // YAML is indentation-defined, so tabs must insert spaces or the file
      // stops parsing the moment someone presses Tab.
      indentUnit.of('  '),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      yamlLanguage(),
      syntaxHighlighting(highlightStyle),
      lintGutter(),
      linter((editorView): Diagnostic[] =>
        lintYaml(editorView.state.doc.toString()).map((problem) => ({
          from: Math.min(problem.from, editorView.state.doc.length),
          to: Math.min(problem.to, editorView.state.doc.length),
          severity: problem.severity,
          message: problem.message,
        })),
      ),
      editorTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) emit.current(update.state.doc.toString());
      }),
    ];

    const editor = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    });
    view.current = editor;

    return () => {
      editor.destroy();
      view.current = null;
    };
    // Built once: `value` is pushed in by the effect below, so rebuilding here
    // would throw away undo history and the cursor on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replace the document only when it differs from what is already shown —
  // otherwise typing would fight with the state it just produced.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.contentDOM.setAttribute('aria-readonly', String(readOnly));
    editor.contentDOM.contentEditable = String(!readOnly);
  }, [readOnly]);

  return <div className="yaml-editor" ref={host} />;
}
