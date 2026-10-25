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

    /* ── it can be reached before the first run, not only after ─────── */
    // This is the whole point of where the buttons are: the processing
    // resolution decides the size of every hexagon the first run computes,
    // so reaching it only from the Map — which you see after processing —
    // means the first run is always at whatever the engine happened to say.
    await page.getByRole('button', { name: /^resolution$/i }).first().click();
    await page.locator('#processing-res').waitFor({ timeout: 10000 });
    check('the Data screen can open it, beside Process', true);
    const state = await page.locator('.settings-source').innerText();
    check('it says which of the two states it is in', /default values|set for this project/i.test(state),
      JSON.stringify(state));
    await page.getByRole('button', { name: /^cancel$/i }).click();
    await page.waitForTimeout(400);

    await page.goto(process.env.MAPHEX_APP ?? 'http://127.0.0.1:5173', { waitUntil: 'networkidle' });
    await page.locator('.project-new').first().click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /^resolution$/i }).first().click();
    await page.locator('#processing-res').waitFor({ timeout: 10000 });
    const engineDefault = await page.locator('#processing-res').inputValue();
    check('New project offers it too, showing the engine\'s numbers',
      Number(engineDefault) > 0, engineDefault);
    await page.locator('#processing-res').fill('9');
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: /use these/i }).click();
    await page.waitForTimeout(500);
    const label = await page.getByRole('button', { name: /^res 9/i }).count();
    check('and the choice is carried on the button', label === 1);

    /* ── the dialog reads the backend ───────────────────────────────── */
    await openProject(page, project.name);
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
    check('moving the processing resolution says nothing changes until a reprocess',
      notes.some((n) => /until you process again/i.test(n)), JSON.stringify(notes));
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

    // Saving a resolution on a project with results does not close the
    // dialog: nothing on screen has moved yet, and closing would look like
    // it had.
    const next = page.locator('.settings-next');
    check('saving says what is still to do', (await next.count()) === 1,
      await next.innerText().catch(() => '(absent)'));
    check('and offers to go and do it',
      (await page.getByRole('button', { name: /go and process/i }).count()) === 1);

    const after = await api(`/projects/${project.id}/settings`);
    check('the change is on the server',
      after.processingResolution === before.processingResolution && after.mapResolution === wanted,
      JSON.stringify(after));
    check('and it no longer claims to follow the engine', after.followingEngine === false);

    await page.getByRole('button', { name: /go and process/i }).click();
    await page.waitForTimeout(800);
    check('which lands on the screen with the Process button',
      (await page.locator('.project-folder').count()) === 1);
    await goToScreen(page, 'Map');
    await page.waitForTimeout(1200);

    /* ── which is when the way back appears ─────────────────────────── */
    // It only exists once there is something to go back from, so with a
    // fresh workspace it is never on screen. The chip beside the title is
    // what says why.
    await page.getByRole('button', { name: /resolution & config|config/i }).first().click();
    await page.locator('#processing-res').waitFor({ timeout: 10000 });
    const pinned = await page.locator('.settings-source').innerText();
    check('a project with settings of its own says so',
      /set for this project/i.test(pinned), JSON.stringify(pinned));
    check('and offers the way back',
      (await page.getByRole('button', { name: /default values/i }).count()) === 1);
    await page.getByRole('button', { name: /default values/i }).click();
    await page.waitForTimeout(900);
    const followed = await api(`/projects/${project.id}/settings`);
    check('which clears them', followed.followingEngine === true, JSON.stringify(followed));
    await page.getByRole('button', { name: /^cancel$/i }).click();
    await page.waitForTimeout(300);

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
    // Put the project back. Leaving a different processing resolution behind
    // would have the next run rebuild the master at it — and a project that
    // was on the defaults has to go back to them, not to the same numbers
    // typed in and pinned.
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
