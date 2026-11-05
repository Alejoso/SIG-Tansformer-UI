/**
 * Whether the model map is out of date, said on the Map and on the Model screen.
 *
 * The engine writes its own check of the master after processing and after
 * each model run (`out/model_status.json`); the server adds whether the model
 * file changed since the last Apply, compared parsed, so a comment does not
 * count. This changes the file the way an edit would and looks for the loud
 * notice, then puts the file back. It never presses Apply.
 *
 * Needs a project whose model has been applied at least once; without one it
 * only checks the answer's shape.
 */

import { api, captureFailure, goToScreen, open, openProject, suite } from './harness.mjs';

export const name = 'Model status';

const LEVELS = [
  'rerun', 'remask', 'alerts_only', 'informative_only', 'up_to_date', 'never_run', 'unknown',
];

export async function run({ project, model }) {
  const { check, results } = suite(name);
  const original = model.text;
  const before = await api(`/projects/${project.id}/model/status`);
  check('the server answers with one of the engine\'s levels', LEVELS.includes(before.status),
    before.status);
  check('and says which run it is about', before.status === 'never_run' || Boolean(before.lastRun),
    JSON.stringify(before));

  if (before.status === 'never_run') {
    results.skipped = 'the model has never been applied here, so nothing can be out of date';
    console.log(`  SKIP  ${results.skipped}`);
    return results;
  }

  const { browser, page, errors } = await open();
  try {
    /* ── a comment is not a change ──────────────────────────────────── */
    await api(`/projects/${project.id}/model`, {
      method: 'PUT',
      body: JSON.stringify({ text: `${original.trimEnd()}\n# a note, nothing more\n` }),
    });
    const commented = await api(`/projects/${project.id}/model/status`);
    check('a comment added to the file is not a change',
      commented.configChanged === before.configChanged, JSON.stringify(commented));

    /* ── an edit is, and says so loudly ─────────────────────────────── */
    await api(`/projects/${project.id}/model`, {
      method: 'PUT',
      body: JSON.stringify({ text: `${original.trimEnd()}\nmaphex_status_check: true\n` }),
    });
    const edited = await api(`/projects/${project.id}/model/status`);
    check('an edit to the file is', edited.configChanged && edited.status === 'rerun',
      JSON.stringify(edited));

    await openProject(page, project.name);
    await goToScreen(page, 'Map');
    await page.locator('.model-status.is-strong').waitFor({ timeout: 15000 });
    check('the Map says the model map is out of date',
      /out of date/i.test(await page.locator('.model-status.is-strong').innerText()));
    check('with the button that fixes it',
      (await page.locator('.model-status.is-strong').getByRole('button', { name: /^apply$/i })
        .count()) === 1);

    await goToScreen(page, 'Model');
    await page.locator('.model-status.is-strong').waitFor({ timeout: 15000 });
    check('and so does the Model screen',
      (await page.locator('.model-status.is-strong').count()) === 1);
    check('where it points at the screen\'s own Apply instead of adding another',
      (await page.locator('.model-status.is-strong').getByRole('button').count()) === 0 &&
        (await page.getByRole('button', { name: /^apply$/i }).count()) === 1);

    /* ── put back, it goes quiet again ──────────────────────────────── */
    await api(`/projects/${project.id}/model`, {
      method: 'PUT',
      body: JSON.stringify({ text: original }),
    });
    const restored = await api(`/projects/${project.id}/model/status`);
    check('the file put back is the one the run used again',
      restored.configChanged === before.configChanged, JSON.stringify(restored));
    if (!restored.configChanged && restored.status !== 'rerun') {
      await goToScreen(page, 'Map');
      await page.waitForTimeout(1500);
      check('and the loud notice goes', (await page.locator('.model-status.is-strong').count()) === 0);
    }

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (error) {
    await captureFailure(page, name);
    throw error;
  } finally {
    await api(`/projects/${project.id}/model`, {
      method: 'PUT',
      body: JSON.stringify({ text: original }),
    }).catch(() => {});
    const now = await api(`/projects/${project.id}/model`);
    check('the model file is back as it was', now.text === original);
    await browser.close();
  }
  return results;
}
