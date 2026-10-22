/**
 * The Examples screen, the stepper it is deliberately absent from, and the
 * draft that has to survive the trip there.
 */

import { captureFailure, goToScreen, open, openProject, suite, typeAtTop } from './harness.mjs';

export const name = 'Examples screen';

/** Keys the screen has to explain, because these are the ones people ask about. */
const DOCUMENTED = ['key', 'nombre', 'code', 'column', 'site', 'type', 'weight', 'bins', 'map'];

export async function run({ project }) {
  const { check, results } = suite(name);
  const { browser, page, errors } = await open();

  try {
    /* ── the stepper is the work, not every screen ──────────────────── */
    await page.goto(process.env.MAPHEX_APP ?? 'http://127.0.0.1:5173', { waitUntil: 'networkidle' });
    const steps = await page.locator('.stepper .step').allInnerTexts();
    check('the stepper is the four steps of the work',
      JSON.stringify(steps) === JSON.stringify(['Projects', 'Data', 'Map', 'Model']),
      JSON.stringify(steps));
    check('a new project is still one click from the project list',
      (await page.locator('.project-new').count()) >= 1);

    await openProject(page, project.name);
    await goToScreen(page, 'Model');
    await page.locator('.yaml-body-editor').waitFor({ timeout: 15000 });
    await page.waitForTimeout(900);

    /* ── an unsaved edit, then off to read the reference ────────────── */
    const criteriaBefore = await page.locator('.node.is-criterion').count();
    const note = '# a note typed before leaving\n';
    await typeAtTop(page, note);
    check('the edit marks the file unsaved',
      /unsaved/.test(await page.locator('.yaml-kind').innerText()));

    await page.getByRole('button', { name: /examples/i }).click();
    await page.locator('.examples-screen').waitFor({ timeout: 10000 });
    await page.waitForTimeout(700);

    check('the examples are their own screen',
      (await page.locator('.examples-screen').count()) === 1);
    check('and are not in the stepper',
      !(await page.locator('.stepper .step').allInnerTexts()).some((s) => /example/i.test(s)));

    /* ── it explains the file, key by key ───────────────────────────── */
    const headings = await page.locator('.reference-block h2').allInnerTexts();
    check('every level has a section', headings.length >= 5, JSON.stringify(headings));
    const names = await page.locator('.field-row dt code').allInnerTexts();
    const missing = DOCUMENTED.filter((key) => !names.includes(key));
    check('every key people ask about is documented', missing.length === 0,
      missing.length ? `missing ${missing.join(', ')}` : `${names.length} keys`);

    // The distinction that costs an afternoon when it is not made.
    const columnRow = await page
      .locator('.field-row', { has: page.locator('dt code', { hasText: /^column$/ }) })
      .first()
      .innerText();
    check('`column` says it is the name that must match the data',
      /master table/i.test(columnRow) && /variables\.csv/.test(columnRow),
      JSON.stringify(columnRow.slice(0, 70)));
    const codeRow = await page
      .locator('.field-row', { has: page.locator('dt code', { hasText: /^code$/ }) })
      .first()
      .innerText();
    check('`code` says it is only a label', /label/i.test(codeRow),
      JSON.stringify(codeRow.slice(0, 70)));

    const types = await page.locator('.type-name').allInnerTexts();
    check('the five scoring types are listed',
      ['minmax', 'zscore', 'range', 'map', 'direct'].every((t) => types.includes(t)),
      JSON.stringify(types));

    const blocks = await page.locator('.example-block h3').count();
    const scopes = await page.locator('.example-scope').allInnerTexts();
    check('the starter blocks are there', blocks >= 3, `${blocks} blocks`);
    check('each says where it belongs', scopes.length === blocks, JSON.stringify(scopes));

    /* ── taking one back keeps the edit, and still parses ───────────── */
    await page.locator('.example-block').first()
      .getByRole('button', { name: /add to the editor/i }).click();
    await page.locator('.yaml-body-editor').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1200);

    const after = await page.locator('.node.is-criterion').count();
    check('the block joined the tree', after === criteriaBefore + 1, `${criteriaBefore} -> ${after}`);
    const syntax = await page.locator('.yaml-problem-kind.is-syntax').count();
    check('and the file still parses', syntax === 0, `syntax problems=${syntax}`);

    // On line 1, where CodeMirror has actually rendered it — it only draws
    // the lines in view, so a note at the end would not be in the DOM.
    const visible = await page.locator('.yaml-body-editor .cm-content').innerText();
    check('the edit made before leaving survived', visible.includes(note.trim()));

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
  }

  return results;
}
