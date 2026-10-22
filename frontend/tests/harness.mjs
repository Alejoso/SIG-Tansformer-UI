/**
 * Shared bits for the browser checks.
 *
 * These drive the real app against the real backend against real engine
 * output — there are no fixtures and nothing is stubbed. That is the point:
 * most of what has gone wrong here was not logic but the seam between the
 * three, and only the running thing shows that.
 *
 * Everything goes through the Vite dev server, including the API: it proxies
 * `/api` to uvicorn, so a suite needs one address and inherits whatever
 * `MAPHEX_PORT` the backend was started on.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/** Where a failing suite leaves its screenshot. Git-ignored. */
export const FAILURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'failures');

export const APP = process.env.MAPHEX_APP ?? 'http://127.0.0.1:5173';
export const API = `${APP}/api`;

/* ── saying what happened ─────────────────────────────────────────────── */

/**
 * One suite's tally.
 *
 * Checks rather than assertions: a failure prints what it saw and the suite
 * carries on, because when something breaks it is far more useful to see all
 * twelve things that changed than the first one.
 */
export function suite(name) {
  const results = { name, pass: 0, fail: 0, skipped: null };

  return {
    results,

    check(label, ok, extra = '') {
      if (ok) results.pass += 1;
      else results.fail += 1;
      const mark = ok ? 'PASS' : 'FAIL';
      console.log(`  ${mark}  ${label}${extra ? ` — ${extra}` : ''}`);
      return ok;
    },

    /** Nothing to check against — not a failure, but not a pass either. */
    skip(why) {
      results.skipped = why;
      console.log(`  SKIP  ${why}`);
    },
  };
}

/* ── the app ──────────────────────────────────────────────────────────── */

/** A browser and a page, with console and page errors collected as they happen. */
export async function open({ width = 1600, height = 1000 } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return { browser, page, errors };
}

/**
 * Open a project from the list.
 *
 * By exact text: project names nest — "Prueba 1" is inside "Prueba 111111" —
 * and a substring match quietly opens the wrong one, which then fails
 * somewhere else entirely.
 */
export async function openProject(page, name) {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.getByText(name, { exact: true }).first().click();
  await page.waitForTimeout(700);
}

/** Go to a screen by its button in the header stepper. */
export async function goToScreen(page, label) {
  await page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first().click();
}

/* ── the API, for setting up and putting back ─────────────────────────── */

export async function api(path, options) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${options?.method ?? 'GET'} ${path} → ${response.status}`);
  return response.json();
}

/**
 * A project with something to look at: processed variables, and a model file
 * the engine could run.
 *
 * Found rather than named, because the id is this machine's. A suite that
 * cannot find one says so and skips instead of failing — an empty workspace
 * is not a broken app.
 */
export async function findProject() {
  const projects = await api('/projects');
  for (const project of projects) {
    let layers;
    try {
      layers = await api(`/projects/${project.id}/layers`);
    } catch {
      continue;
    }
    const inputs = (layers.inputs ?? []).filter((node) => node.hasDocument);
    if (!inputs.length) continue;

    const model = await api(`/projects/${project.id}/model`);
    return { project, layers, inputs, model };
  }
  return null;
}

/** Every node in the model side of the tree that has a rendered document. */
export function modelDocuments(layers) {
  const found = [];
  const walk = (node) => {
    if (!node) return;
    if (node.hasDocument) found.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(layers.model?.combined);
  for (const node of layers.model?.variables ?? []) walk(node);
  return found;
}

/* ── the editor ───────────────────────────────────────────────────────── */

/**
 * Type into the CodeMirror editor.
 *
 * Through the keyboard, not by setting a value: it is a contenteditable, and
 * only real input events reach the document behind it.
 *
 * Reading it back is not offered on purpose. CodeMirror renders only the
 * lines in view, so the DOM holds part of the file and `innerText` looks like
 * a truncated document. Ask the API what the file says, or look at the
 * diagram.
 */
export async function typeAtTop(page, text) {
  const editor = page.locator('.yaml-body-editor .cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.insertText(text);
  // The editor debounces before it reports a change upwards.
  await page.waitForTimeout(500);
}

/**
 * A picture of the page a suite failed on.
 *
 * Worth the few lines: half of what goes wrong in here is layout — something
 * covering something else, a control off the edge — and no amount of printed
 * state shows that as fast as looking.
 */
export async function captureFailure(page, suiteName) {
  const file = join(FAILURE_DIR, `${suiteName.toLowerCase().replace(/\W+/g, '-')}.png`);
  try {
    await mkdir(FAILURE_DIR, { recursive: true });
    await page.screenshot({ path: file });
    console.log(`  ...  what it looked like: ${file}`);
  } catch {
    // A screenshot failing must not turn into the reported failure.
  }
}
