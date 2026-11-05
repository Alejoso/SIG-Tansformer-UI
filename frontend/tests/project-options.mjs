/**
 * The project's switches: the master table as CSV, the model's tables as
 * CSV, and keeping the computer awake while a run is going.
 *
 * Off unless turned on, stored per project, and kept apart from the
 * resolutions: turning one on must not pin the resolutions to today's
 * engine numbers, which is what "Default values" is about. Whether the
 * engine receives them is checked end to end, not here: these suites never
 * start a run.
 *
 * Puts the project back as it was.
 */

import { api, captureFailure, goToScreen, open, openProject, suite } from './harness.mjs';

export const name = 'Project options';

const KEYS = ['masterCsv', 'modelTablesCsv', 'keepAwake'];

export async function run({ project }) {
  const { check, results } = suite(name);
  const before = await api(`/projects/${project.id}/settings`);
  const { browser, page, errors } = await open();

  const openDialog = async () => {
    await page.getByRole('button', { name: /resolution & config|config/i }).first().click();
    await page.locator('#processing-res').waitFor({ timeout: 10000 });
  };

  try {
    check('the server reports all three', KEYS.every((key) => typeof before.options?.[key] === 'boolean'),
      JSON.stringify(before.options));

    await openProject(page, project.name);
    await goToScreen(page, 'Map');
    await page.waitForTimeout(1000);
    await openDialog();

    /* ── one box each, showing what is stored ───────────────────────── */
    for (const key of KEYS) {
      const box = page.locator(`#option-${key}`);
      check(`a box for ${key}`, (await box.count()) === 1);
      check(`${key} shows what is stored`, (await box.isChecked()) === before.options[key]);
    }

    // Start from all off, the default.
    await api(`/projects/${project.id}/settings/options`, {
      method: 'PUT',
      body: JSON.stringify({ masterCsv: false, modelTablesCsv: false, keepAwake: false }),
    });
    await page.getByRole('button', { name: /^cancel$/i }).click();
    await page.waitForTimeout(300);
    await openDialog();

    /* ── turned on and saved, the resolutions left alone ────────────── */
    await page.locator('#option-masterCsv').check();
    await page.locator('#option-keepAwake').check();
    await page.getByRole('button', { name: /save settings/i }).click();
    await page.waitForTimeout(1200);
    const saved = await api(`/projects/${project.id}/settings`);
    check('the boxes ticked are stored',
      saved.options.masterCsv && saved.options.keepAwake && !saved.options.modelTablesCsv,
      JSON.stringify(saved.options));
    check('and the resolutions are not pinned by it',
      saved.followingEngine === before.followingEngine &&
        saved.processingResolution === before.processingResolution,
      JSON.stringify({ before: before.followingEngine, after: saved.followingEngine }));

    await openDialog();
    check('reopened, the boxes are as saved',
      (await page.locator('#option-masterCsv').isChecked()) &&
        !(await page.locator('#option-modelTablesCsv').isChecked()));
    const state = await page.locator('.settings-source').innerText();
    check('a switch turned on counts as settings of its own',
      /set for this project/i.test(state), JSON.stringify(state));

    /* ── "Default values" turns them off ────────────────────────────── */
    await page.getByRole('button', { name: /default values/i }).click();
    await page.waitForTimeout(900);
    const cleared = await api(`/projects/${project.id}/settings`);
    check('"Default values" turns every switch off',
      KEYS.every((key) => cleared.options[key] === false), JSON.stringify(cleared.options));
    check('and the boxes follow',
      !(await page.locator('#option-masterCsv').isChecked()) &&
        !(await page.locator('#option-keepAwake').isChecked()));
    await page.getByRole('button', { name: /^cancel$/i }).click();

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (error) {
    await captureFailure(page, name);
    throw error;
  } finally {
    await browser.close();
    // Back as it was: the resolutions (pinned or following) and the switches.
    if (before.followingEngine) {
      await api(`/projects/${project.id}/settings`, { method: 'DELETE' });
    } else {
      await api(`/projects/${project.id}/settings`, {
        method: 'PUT',
        body: JSON.stringify({
          processingResolution: before.processingResolution,
          mapResolution: before.mapResolution,
        }),
      });
    }
    await api(`/projects/${project.id}/settings/options`, {
      method: 'PUT',
      body: JSON.stringify(before.options),
    });
    const restored = await api(`/projects/${project.id}/settings`);
    check('the settings are back as they were',
      restored.followingEngine === before.followingEngine &&
        restored.processingResolution === before.processingResolution &&
        KEYS.every((key) => restored.options[key] === before.options[key]));
  }
  return results;
}
