/**
 * The in-app folder browser: "Choose" with no native dialog (in Docker).
 *
 * Only meaningful against a server that has no dialog — run with
 * MAPHEX_APP=http://127.0.0.1:8765 against `docker compose up`. Elsewhere the
 * real dialog would open and wait, so it is skipped.
 */

import { rmdir } from 'node:fs/promises';
import { APP, api, captureFailure, open, suite } from './harness.mjs';

export const name = 'Folder browser';

export async function run() {
  const { check, skip, results } = suite(name);
  // Asking opens the real dialog where there is one, and it would sit there
  // waiting; only a server without one answers at once.
  const picked = await api('/fs/pick-folder', { method: 'POST', body: JSON.stringify({}) })
    .catch(() => null);
  if (!picked?.browse) {
    skip('this server has a native folder dialog');
    return results;
  }

  const { browser, page, errors } = await open();
  let made = null;
  try {
    await page.goto(APP, { waitUntil: 'networkidle' });
    await page
      .getByRole('button', { name: /new project|create your first project/i })
      .first()
      .click();
    await page.getByRole('button', { name: /^choose$/i }).first().click();

    const dialog = page.getByRole('dialog', { name: 'Choose a folder' });
    await dialog.waitFor();
    const start = await dialog.locator('.folder-browser-current').textContent();
    check(`opens on a folder (${start})`, start && start.startsWith('/'));

    const first = dialog.locator('.folder-browser-row').first();
    const into = (await first.locator('.folder-browser-name').textContent()) ?? '';
    await first.click();
    await page.waitForTimeout(400);
    const inside = await dialog.locator('.folder-browser-current').textContent();
    check(`goes into ${into}`, inside === `${start === '/' ? '' : start}/${into}`);

    await dialog.getByRole('button', { name: 'Up' }).click();
    await page.waitForTimeout(400);
    check('goes back up', (await dialog.locator('.folder-browser-current').textContent()) === start);

    await dialog.locator('.folder-browser-row').first().click();
    await page.waitForTimeout(400);
    await dialog.getByRole('button', { name: 'Use this folder' }).click();
    check('closes on choosing', (await dialog.count()) === 0);
    const value = await page.getByPlaceholder(/results/i).inputValue();
    check(`fills the field (${value})`, value === inside);
    /* ── making a folder where the browser stands ──────────────────── */
    await page.getByRole('button', { name: /^choose$/i }).first().click();
    await dialog.waitFor();
    // '…' until the first listing arrives.
    await page.waitForFunction(
      () => document.querySelector('.folder-browser-current')?.textContent?.startsWith('/'),
    );
    const here = await dialog.locator('.folder-browser-current').textContent();
    const fresh = `maphex-test-${Date.now()}`;
    made = `${here === '/' ? '' : here}/${fresh}`;

    await dialog.getByRole('button', { name: 'New folder' }).click();
    const nameBox = dialog.getByLabel('New folder name');
    await nameBox.fill('../escape');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForTimeout(400);
    check(
      'refuses a name that is a path',
      (await dialog.locator('.is-error').count()) === 1 &&
        (await dialog.locator('.folder-browser-current').textContent()) === here,
    );

    await nameBox.press('Escape');
    check('Escape drops the name, not the browser', (await dialog.count()) === 1 && (await nameBox.count()) === 0);

    await dialog.getByRole('button', { name: 'New folder' }).click();
    await dialog.getByLabel('New folder name').fill(fresh);
    await dialog.getByLabel('New folder name').press('Enter');
    await page.waitForTimeout(500);
    check('creates it and goes in', (await dialog.locator('.folder-browser-current').textContent()) === made);
    await dialog.getByRole('button', { name: 'Use this folder' }).click();
    check('the new folder fills the field', (await page.getByPlaceholder(/results/i).inputValue()) === made);

    // The refusal above is a 400 on purpose; the browser logs it regardless.
    const unexpected = errors.filter((text) => !text.includes('status of 400'));
    check('no errors in the console', unexpected.length === 0, unexpected.join(' | '));
  } catch (error) {
    check('the suite ran to the end', false, error.message);
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
    if (made) {
      // Only ever the empty folder this run made, under its unique name.
      const gone = await rmdir(made).then(() => true, () => false);
      console.log(`  ...  the folder it made was ${gone ? 'removed' : `NOT removed: ${made}`}`);
    }
  }
  return results;
}
