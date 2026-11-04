/**
 * A variable's fill and absent: suggested when it is added, editable after.
 *
 * The engine fills a variable's gaps while processing (a chain of methods per
 * variable, in the project's transform.yaml) and the model scores what is
 * still empty with each leaf's `absent`. So every variable carries both, with
 * defaults that depend on the kind of file: a raster or a table is filled
 * (`spatial, median`), a vector is not (`none`), and `absent` starts at 1.
 *
 * Added through the screen against throwaway files, so nothing real is
 * touched; they are removed at the end.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, captureFailure, goToScreen, open, openProject, suite } from './harness.mjs';

export const name = 'Variable settings';

const DIMENSION = 'settingscheck';

async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), 'maphex-settings-'));
  // One table and one vector: their defaults differ.
  await mkdir(join(root, 'STC_001_tabla'), { recursive: true });
  await writeFile(join(root, 'STC_001_tabla', 'datos.csv'), 'codigo_dane,valor\n05001,1\n');
  await mkdir(join(root, 'STC_002_capa'), { recursive: true });
  await writeFile(join(root, 'STC_002_capa', 'capa.gpkg'), 'x'.repeat(256));
  return root;
}

export async function run({ project }) {
  const { check, results } = suite(name);
  const root = await fixtures();
  const { browser, page, errors } = await open();
  const added = [];

  try {
    /* ── suggested per file, before anything is copied ──────────────── */
    await openProject(page, project.name);
    await goToScreen(page, 'Data');
    await page.locator('.project-folder').waitFor({ timeout: 15000 });
    await page.locator('input[placeholder*="wind_atlas"]').first().fill(root);
    await page.locator('.batch-list').waitFor({ timeout: 15000 });

    const fills = await Promise.all(
      (await page.locator('.batch-list input[id$="-fill"]').all()).map((input) =>
        input.inputValue(),
      ),
    );
    check('every row asks for its fill', fills.length === 2, JSON.stringify(fills));
    check('a table is filled by default', fills.includes('spatial, median'), JSON.stringify(fills));
    check('a vector is not', fills.includes('none'), JSON.stringify(fills));
    const absents = await Promise.all(
      (await page.locator('.batch-list select[id$="-absent"]').all()).map((select) =>
        select.inputValue(),
      ),
    );
    check('and every row has an absent, 1 by default',
      absents.length === 2 && absents.every((value) => value === '1'), JSON.stringify(absents));

    // Change one before adding it: the choice has to survive the copy.
    await page.locator('.batch-list select[id$="-absent"]').last().selectOption('5');

    await page.locator('#variable-dimension').selectOption({ label: 'New dimension…' });
    await page.locator('input[aria-label="New dimension name"]').fill(DIMENSION);
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /^add \d+$/i }).click();
    await page.waitForTimeout(4000);

    let inputs = await api(`/projects/${project.id}/inputs`);
    let mine = inputs.filter((v) => v.dimension === DIMENSION);
    added.push(...mine.map((v) => v.code));
    check('both were added', mine.length === 2, mine.map((v) => v.id).join(' '));
    const changed = mine.find((v) => v.absent === 5);
    check('the absent chosen before adding was kept', Boolean(changed),
      mine.map((v) => `${v.id}:${v.absent}`).join(' '));
    check('and only that one is no longer on its defaults',
      mine.filter((v) => !v.settingsDefault).length === 1);

    /* ── edited afterwards, from the row ────────────────────────────── */
    const target = mine.find((v) => v.fill === 'spatial, median') ?? mine[0];
    // Open its dimension, unless adding already did.
    const group = page.locator('.dimension-row', { hasText: DIMENSION.toUpperCase() });
    if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
    await page.getByRole('button', { name: `Fill and absent for ${target.id}` }).click();
    const fill = page.locator('.variable-settings-editor input[id$="-fill"]');
    await fill.fill('region, nearest');
    await page.locator('.variable-settings-editor').getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(1200);
    inputs = await api(`/projects/${project.id}/inputs`);
    const saved = inputs.find((v) => v.id === target.id);
    check('an edited fill is saved', saved?.fill === 'region, nearest', saved?.fill);

    // A method the engine does not have is refused, with the reason.
    await page.getByRole('button', { name: `Fill and absent for ${target.id}` }).click();
    await fill.fill('magic');
    await page.locator('.variable-settings-editor').getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(800);
    const refusal = await page.locator('.variable-settings-editor .path-add-error').innerText()
      .catch(() => '');
    check('an unknown method is refused, saying why', /not a fill method/.test(refusal), refusal);

    await page.locator('.variable-settings-editor').getByRole('button', { name: 'Default values' })
      .click();
    await page.waitForTimeout(1000);
    inputs = await api(`/projects/${project.id}/inputs`);
    const reset = inputs.find((v) => v.id === target.id);
    check('"Default values" puts it back', reset?.settingsDefault && reset.fill === 'spatial, median',
      `${reset?.fill} ${reset?.settingsDefault}`);

    // The refused save above is a 400 on purpose, and the browser logs it.
    const unexpected = errors.filter((text) => !/status of 400/.test(text));
    check('no other page errors', unexpected.length === 0, unexpected.slice(0, 2).join(' | '));
  } catch (error) {
    await captureFailure(page, name);
    throw error;
  } finally {
    for (const code of added) {
      await api(`/projects/${project.id}/inputs/${DIMENSION}/${code}`, { method: 'DELETE' })
        .catch(() => {});
    }
    await browser.close();
  }
  return results;
}
