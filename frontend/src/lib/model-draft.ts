/**
 * The model file as it is being edited, kept while you look at something else.
 *
 * The examples are their own screen now, so going to read them unmounts the
 * editor — and without this, coming back would quietly discard whatever had
 * been typed and not saved. (That was already true of going to the Map and
 * back; it just never cost anything, because nobody had a reason to.)
 *
 * Deliberately a module variable rather than context: the draft changes on
 * every keystroke, and putting it in context would re-render every screen
 * each time. Nothing renders from this — the editor reads it once on mount —
 * so it does not need to be state.
 */

import type { ModelExample } from '../types';

interface Draft {
  projectId: string;
  text: string;
}

let draft: Draft | null = null;
let pending: ModelExample | null = null;

/** Keep the current text, so a trip away from the screen does not lose it. */
export function rememberDraft(projectId: string, text: string): void {
  draft = { projectId, text };
}

/** The text last typed for this project, or null — another project's is not it. */
export function recallDraft(projectId: string): string | null {
  return draft && draft.projectId === projectId ? draft.text : null;
}

/** Called once the file on disk says the same thing, so there is nothing to keep. */
export function forgetDraft(): void {
  draft = null;
}

/**
 * An example chosen on the Examples screen, waiting for the editor to open.
 *
 * Handed over rather than written straight into the file: the editor is where
 * the unsaved text lives, and inserting into the file behind it would either
 * be overwritten by the draft or overwrite it.
 */
export function queueExample(example: ModelExample): void {
  pending = example;
}

/** Take the queued example, if there is one. Taking it clears it. */
export function takeExample(): ModelExample | null {
  const taken = pending;
  pending = null;
  return taken;
}
