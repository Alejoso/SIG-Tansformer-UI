/**
 * Project settings, and the folder path on the Data screen.
 *
 * The settings suite puts the project back to whatever it was: the
 * processing resolution is not a harmless number to leave changed — the next
 * run would rebuild the master table at it.
 */

import { api, captureFailure, goToScreen, open, openProject, suite } from './harness.mjs';

export const name = 'Settings';

export async function run({ project }) {
  const { check, results } = suite(name);
  const before = await api(`/projects/${project.id}/settings`);
  const { browser, page, errors } = await open();

  try {
    /* ── the folder is on the Data screen ───────────────────────────── */
    await openProject(page, project.name);
    await goToScreen(page, 'Data');
    await page.locator('.project-folder').waitFor({ timeout: 15000 });
    const shown = await page.locator('.project-folder-path').innerText();
    const title = await page.locator('.project-folder-path').getAttribute('title');
    check('the Data screen names the project folder',
      title === project.outFolder && shown.length > 0, JSON.stringify(title));

    /* ── the dialog reads the backend ───────────────────────────────── */
    await goToScreen(page, 'Map');
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /resolution & config|config/i }).first().click();
    await page.locator('#processing-res').waitFor({ timeout: 10000 });

    const processing = await page.locator('#processing-res').inputValue();
    const map = await page.locator('#map-res').inputValue();
    check('it shows what the server says',
      Number(processing) === before.processingResolution && Number(map) === before.mapResolution,
      `${processing}/${map} vs ${before.processingResolution}/${before.mapResolution}`);
    check('the pipeline version is gone',
      (await page.locator('#pipeline-version').count()) === 0);
    check('the coordinate system is read-only',
      await page.locator('#crs').getAttribute('readonly') !== null);

    /* ── changing the expensive one says so ─────────────────────────── */
    // Typed, looked at, and typed back. Saving a different processing
    // resolution would mark the project stale, and a check that quietly
    // costs the next run a full reset is a bad check.
    await page.locator('#processing-res').fill(String(before.processingResolution + 1));
    await page.waitForTimeout(300);
    const notes = await page.locator('.settings-note').allInnerTexts();
    check('moving the processing resolution warns about reprocessing',
      notes.some((n) => /rebuilds the hexagon master table/.test(n)), JSON.stringify(notes));
    await page.locator('#processing-res').fill(String(before.processingResolution));
    await page.waitForTimeout(300);

    await page.locator('#map-res').fill('99');
    await page.waitForTimeout(300);
    check('an impossible resolution blocks saving',
      await page.getByRole('button', { name: /save settings/i }).isDisabled());

    /* ── saving reaches the store ───────────────────────────────────── */
    // Only the map resolution, which costs a redraw and nothing else.
    const wanted = before.mapResolution === 5 ? 4 : 5;
    await page.locator('#map-res').fill(String(wanted));
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /save settings/i }).click();
    await page.waitForTimeout(1200);
    const after = await api(`/projects/${project.id}/settings`);
    check('the change is on the server',
      after.processingResolution === before.processingResolution && after.mapResolution === wanted,
      JSON.stringify(after));
    check('and it no longer claims to follow the engine', after.followingEngine === false);

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
    // Put the project back. Leaving a different processing resolution behind
    // would have the next run rebuild the master at it — and a project that
    // was following the engine has to go back to following it, not to the
    // same numbers pinned.
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
    const restored = await api(`/projects/${project.id}/settings`);
    check('the settings are back as they were',
      restored.processingResolution === before.processingResolution &&
        restored.mapResolution === before.mapResolution &&
        restored.followingEngine === before.followingEngine);
  }

  return results;
}
