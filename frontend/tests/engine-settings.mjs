/**
 * The engine's settings (its `.env`), from the project list.
 *
 * Writes into the engine's settings file of whatever backend it runs
 * against, and puts every value it touched back to what it was at the end.
 * Run it against a backend pointed at a throwaway engine folder
 * (MAPHEX_PIPELINE_DIR) rather than a real one.
 */

import { APP, api, captureFailure, open, suite } from './harness.mjs';

export const name = 'Engine settings';

const setting = (config, key) =>
  config.sections.flatMap((section) => section.settings).find((s) => s.key === key);

export async function run() {
  const { check, results } = suite(name);
  const before = await api('/engine/config');
  const { browser, page, errors } = await open();

  const row = (key) => page.locator(`.engine-setting[data-key="${key}"]`);

  try {
    await page.goto(APP);
    await page.getByRole('button', { name: 'Engine settings' }).click();
    await page.locator('.engine-settings-body').waitFor({ timeout: 15000 });

    /* ── everything is there, grouped, with its default ──────────────── */
    const legends = await page.locator('.engine-section legend').allInnerTexts();
    check('the settings are grouped as the engine groups them',
      ['Connection', 'CPUs and memory', 'Workers per stage', 'Postgres'].every((t) => legends.includes(t)),
      JSON.stringify(legends));
    const keys = await page.locator('.engine-setting').evaluateAll(
      (rows) => rows.map((r) => r.getAttribute('data-key')));
    const everyKey = before.sections.flatMap((s) => s.settings.map((x) => x.key));
    check('every setting of the engine is listed', everyKey.every((k) => keys.includes(k)),
      `${keys.length} shown, ${everyKey.length} known`);
    check('each one says its default',
      (await row('PG_WORK_MEM').innerText()).includes('Default:'));

    /* ── what would break the installation is shown, not offered ─────── */
    const password = row('POSTGRES_PASSWORD').locator('input');
    check('the password is never shown',
      ['Set (hidden)', 'Not set'].includes(await password.inputValue()));
    check('the connection cannot be edited', await row('POSTGRES_USER').locator('input').evaluate(
      (input) => input.readOnly));

    /* ── a change is saved into the engine's file ────────────────────── */
    const memory = row('APP_MEM_LIMIT').locator('input');
    await memory.fill('12g');
    check('an edit is counted before it is saved',
      (await page.locator('.settings-source').innerText()).toLowerCase().includes('1 unsaved change'));
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText("Saved to the engine's settings file").waitFor({ timeout: 10000 });
    let now = await api('/engine/config');
    check('saved into the engine\'s settings', setting(now, 'APP_MEM_LIMIT').value === '12g',
      JSON.stringify(setting(now, 'APP_MEM_LIMIT')));

    /* ── a value the engine would not take is refused, and said why ──── */
    await memory.fill('lots');
    await page.getByRole('button', { name: 'Save settings' }).click();
    const refused = page.locator('.settings-note.is-error');
    await refused.waitFor({ timeout: 10000 });
    check('a bad value is refused with the reason', (await refused.innerText()).includes('a size like'),
      await refused.innerText());
    now = await api('/engine/config');
    check('and nothing is written', setting(now, 'APP_MEM_LIMIT').value === '12g');

    /* ── back to the default ─────────────────────────────────────────── */
    await row('APP_MEM_LIMIT').getByRole('button', { name: 'Default' }).click();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText("Saved to the engine's settings file").waitFor({ timeout: 10000 });
    now = await api('/engine/config');
    const back = setting(now, 'APP_MEM_LIMIT');
    check('Default puts the engine\'s own value back', back.isDefault && back.value === back.default,
      JSON.stringify(back));

    /* ── blank workers: the engine works them out ────────────────────── */
    const raster = row('RASTER_WORKERS').locator('input');
    await raster.fill('2');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText("Saved to the engine's settings file").waitFor({ timeout: 10000 });
    check('raster workers can be set', setting(await api('/engine/config'), 'RASTER_WORKERS').value === '2');
    await raster.fill('');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText("Saved to the engine's settings file").waitFor({ timeout: 10000 });
    check('blank hands them back to the engine', !setting(await api('/engine/config'), 'RASTER_WORKERS').isSet);

    /* ── finding one ──────────────────────────────────────────────────── */
    await page.getByLabel('Find a setting').fill('raster');
    const found = await page.locator('.engine-setting').evaluateAll(
      (rows) => rows.map((r) => r.getAttribute('data-key')));
    check('the search narrows the list', found.length >= 1 && found.includes('RASTER_WORKERS')
      && !found.includes('APP_MEM_LIMIT'), JSON.stringify(found));

    // The refused value above answers 400 on purpose; the browser logs that.
    const unexpected = errors.filter((e) => !e.includes('status of 400'));
    check('no page errors', unexpected.length === 0, unexpected.slice(0, 2).join(' | '));
  } catch (error) {
    await captureFailure(page, 'engine-settings', error);
    check('the suite ran to the end', false, String(error));
  } finally {
    // Every value touched, back as it was.
    const restore = {};
    for (const key of ['APP_MEM_LIMIT', 'RASTER_WORKERS']) {
      const was = setting(before, key);
      restore[key] = was.isSet ? was.value : null;
    }
    await api('/engine/config', { method: 'PUT', body: JSON.stringify({ changes: restore }) })
      .catch(() => {});
    await browser.close();
  }
  return results;
}
