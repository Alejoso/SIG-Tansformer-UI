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

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
  }

  return results;
}
