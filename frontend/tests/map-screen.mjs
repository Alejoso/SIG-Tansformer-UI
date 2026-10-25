/**
 * The control where it is actually met: inside the app's iframe.
 *
 * Separate from the document check because the two fail differently. A
 * slider that works on its own can still be unreachable here — covered by
 * one of the app's own overlays, or in a frame that swallows the pointer.
 */

import { captureFailure, goToScreen, open, openProject, suite } from './harness.mjs';

export const name = 'Map screen';

export async function run({ project, inputs }) {
  const { check, skip, results } = suite(name);

  if (!inputs.length) {
    skip('nothing has been processed in this workspace yet');
    return results;
  }

  const { browser, page, errors } = await open();

  try {
    await openProject(page, project.name);
    await goToScreen(page, 'Map');
    await page.waitForTimeout(2500);

    const frame = page.frameLocator('iframe');
    await frame.locator('#maphex-opacity-range').waitFor({ timeout: 120000 });
    check('the control is in the frame the app shows', true);

    // The app draws its own things over this frame — the filename chip, the
    // zoom buttons. Ask the document which element is actually on top where
    // the slider sits.
    const onTop = await page.evaluate(() => {
      const box = document.querySelector('iframe').getBoundingClientRect();
      const element = document.elementFromPoint(box.right - 80, box.bottom - 24);
      return { tag: element?.tagName, cls: String(element?.className || '') };
    });
    check('nothing of ours covers it', onTop.tag === 'IFRAME', JSON.stringify(onTop));

    await frame.locator('#maphex-opacity-range').fill('35');
    await page.waitForTimeout(800);
    check('and it works through the frame',
      (await frame.locator('#maphex-opacity-value').innerText()) === '35%');

    /* ── two things the sidebar no longer has ───────────────────────── */
    check('no raw/normalized switch',
      (await page.getByRole('radio', { name: /normalized/i }).count()) === 0);
    /* ── the input side groups by dimension ─────────────────────────── */
    const folders = page.locator('.layer-row.is-folder');
    const folderCount = await folders.count();
    check('input variables sit in a folder per dimension', folderCount >= 1,
      `${folderCount} folders`);

    // All shut to start, so the dimensions are what you see. One alone
    // opens itself, since there is nothing to choose between.
    const openBefore = await page.locator('.layer-children').count();
    check('all shut to start, unless there is only one',
      folderCount === 1 ? openBefore === 1 : openBefore === 0,
      `${openBefore} open of ${folderCount}`);

    if (folderCount > 1) {
      const shut = folders.nth(0);
      const before = await page.locator('.layer-frame').getAttribute('src');
      await shut.locator('.layer-label').click();
      await page.waitForTimeout(600);
      check('clicking a folder opens it',
        (await page.locator('.layer-children').count()) > openBefore);
      check('and puts nothing new on the map',
        (await page.locator('.layer-frame').getAttribute('src')) === before);
      await shut.locator('.layer-label').click();
      await page.waitForTimeout(400);
      check('clicking it again shuts it',
        (await page.locator('.layer-children').count()) === openBefore);
    }

    // The model side is the whole model and one row per criterion, in one
    // list rather than two sections.
    // The radio itself is visually hidden behind the segmented control, so
    // the label is what there is to click.
    await page.locator('.mode-switch label', { hasText: /^Model$/ }).first().click();
    await page.waitForTimeout(1500);
    const sections = await page.locator('.layer-section-title').allInnerTexts();
    check('the model side is a single flat list',
      sections.length === 1 && /model/i.test(sections[0]), JSON.stringify(sections));
    const rows = await page.locator('.layer-list .layer-name').allInnerTexts();
    check('starting with the whole model',
      rows.length >= 1 && /complete model/i.test(rows[0]), JSON.stringify(rows));
    check('and with nothing to open on that side',
      (await page.locator('.layer-caret').count()) === 0);

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
  }

  return results;
}
