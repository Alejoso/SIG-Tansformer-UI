/**
 * Client-side YAML checking.
 *
 * The server parses too and has the final word, but waiting for a round trip
 * to learn you mistyped an indent makes an editor feel broken. This runs on
 * every keystroke and reports the same kind of problem the server would.
 *
 * Only syntax is checked here. Whether the document *means* anything is the
 * engine's business, and the backend answers that on save.
 */

import { parseDocument, type Document } from 'yaml';

export interface YamlProblem {
  message: string;
  /** 1-based, for display. */
  line: number;
  column: number;
  /** Character offsets into the source, for marking the text. */
  from: number;
  to: number;
  severity: 'error' | 'warning';
}

/** Turn a character offset into a 1-based line and column. */
function locate(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * Parse the text and collect whatever the parser objected to.
 *
 * `parseDocument` keeps going after a problem rather than throwing on the
 * first one, so a document with three mistakes reports three.
 */
export function lintYaml(text: string): YamlProblem[] {
  if (!text.trim()) return [];

  let document: Document.Parsed;
  try {
    document = parseDocument(text, { prettyErrors: false });
  } catch (error) {
    // A parser crash is still a problem with the text, not a reason to show
    // the editor as fine.
    return [
      {
        message: error instanceof Error ? error.message : 'Could not parse this file',
        line: 1,
        column: 1,
        from: 0,
        to: Math.min(text.length, 1),
        severity: 'error',
      },
    ];
  }

  const problems: YamlProblem[] = [];

  const collect = (
    items: { message: string; pos: [number, number] }[],
    severity: 'error' | 'warning',
  ) => {
    for (const item of items) {
      const [from, to] = item.pos;
      const { line, column } = locate(text, from);
      problems.push({
        message: item.message,
        line,
        column,
        from,
        // An empty range draws no underline, so always cover a character.
        to: Math.max(to, from + 1),
        severity,
      });
    }
  };

  collect(document.errors, 'error');
  collect(document.warnings, 'warning');

  return problems.sort((a, b) => a.from - b.from);
}

/** The parsed document, or null when it does not parse. */
export function parseYaml(text: string): unknown {
  try {
    const document = parseDocument(text, { prettyErrors: false });
    if (document.errors.length > 0) return null;
    return document.toJS();
  } catch {
    return null;
  }
}
