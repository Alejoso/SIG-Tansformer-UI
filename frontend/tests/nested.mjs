/**
 * Variables nested the way the engine's own data is: `TEC_001_t/TEC_001_sv003/x.tif`.
 *
 * The engine reads its input tree at any depth: the dimension is the first
 * folder, the code is the folder holding the file (the master-table column),
 * and anything between is only a group. So a folder of such groups has to be
 * offered variable by variable, copied keeping its group, listed with its
 * group, filled and removed by its full id; and a `shp/` folder under a code
 * is that code's variable, not one called `shp`.
 *
 * Added through the screen against throwaway files, and removed at the end.
 */

import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, captureFailure, goToScreen, open, openProject, suite } from './harness.mjs';

export const name = 'Nested variables';

const DIMENSION = 'nestcheck';

async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), 'maphex-nested-'));
  const files = {
    'NST_901_t/NST_901_sv003/velocidad_100m.tif': 'x'.repeat(256),
    'NST_901_t/NST_901_sv001/velocidad_50m.tif': 'x'.repeat(256),
    // A shapefile one folder down from its code: the code is the variable.
    'NST_902/shp/Zonas.SHP': 'x'.repeat(256),
    'NST_902/shp/Zonas.dbf': 'x'.repeat(64),
    // Not a variable, and not a failure either.
    'docs/readme.txt': 'notes',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const exists = (path) => access(path).then(() => true, () => false);

export async function run({ project }) {
  const { check, results } = suite(name);
  const root = await fixtures();
  const { browser, page, errors } = await open();
  page.on('dialog', (dialog) => dialog.accept());
  let added = [];

  try {
    /* ── offered one by one, each with its group ────────────────────── */
    await openProject(page, project.name);
    await goToScreen(page, 'Data');
    await page.locator('.project-folder').waitFor({ timeout: 15000 });
    await page.locator('input[placeholder*="wind_atlas"]').first().fill(root);
    await page.locator('.batch-list').waitFor({ timeout: 15000 });

    const rows = await page.locator('.batch-row').count();
    check('every dataset folder is a row, the docs folder is not', rows === 3, `${rows} rows`);
    const codes = await Promise.all(
      (await page.locator('.batch-code').all()).map((input) => input.inputValue()),
    );
    check('the codes are the folders holding the data',
      ['NST_901_sv003', 'NST_901_sv001', 'NST_902'].every((code) => codes.includes(code)),
      JSON.stringify(codes));
    const groups = await page.locator('.batch-group').allInnerTexts();
    check('the nested ones show the group they will be filed under',
      groups.length === 2 && groups.every((text) => text.trim() === 'NST_901_t/'),
      JSON.stringify(groups));

    await page.locator('#variable-dimension').selectOption({ label: 'New dimension…' });
    await page.locator('input[aria-label="New dimension name"]').fill(DIMENSION);
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /^add \d+$/i }).click();
    await page.waitForTimeout(4000);

    /* ── copied keeping the group, listed by full id ────────────────── */
    let inputs = await api(`/projects/${project.id}/inputs`);
    let mine = inputs.filter((v) => v.dimension === DIMENSION);
    added = mine.map((v) => v.id);
    const nested = mine.find((v) => v.id === `${DIMENSION}/NST_901_t/NST_901_sv003`);
    check('a nested variable keeps its group', nested?.group === 'NST_901_t' &&
      nested?.code === 'NST_901_sv003', mine.map((v) => v.id).join(' '));
    check('the shapefile one folder down is its code\'s variable',
      mine.some((v) => v.id === `${DIMENSION}/NST_902` && v.format === 'SHP'),
      mine.map((v) => `${v.id}:${v.format}`).join(' '));
    check('and renamed as the engine\'s lint would',
      mine.some((v) => v.filename === 'zonas.shp'), mine.map((v) => v.filename).join(' '));
    check('nothing in the group is listed as a variable of its own',
      !mine.some((v) => v.id === `${DIMENSION}/NST_901_t`));
    check('a raster nested or not gets the raster fill', nested?.fill === 'spatial, median',
      nested?.fill);

    const group = page.locator('.dimension-row', { hasText: DIMENSION });
    if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
    const shownGroups = await page.locator('.variable-group').allInnerTexts();
    check('the row shows the group before the code',
      shownGroups.some((text) => text.trim() === 'NST_901_t/'), JSON.stringify(shownGroups));

    /* ── its fill, by its full id ───────────────────────────────────── */
    await page.getByRole('button', { name: `Fill for ${DIMENSION}/NST_901_t/NST_901_sv003` })
      .click();
    await page.locator('.variable-settings-editor input[id$="-fill"]').fill('nearest');
    await page.locator('.variable-settings-editor').getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(1200);
    inputs = await api(`/projects/${project.id}/inputs`);
    check('a nested variable\'s fill is saved',
      inputs.find((v) => v.id === `${DIMENSION}/NST_901_t/NST_901_sv003`)?.fill === 'nearest');

    /* ── removed by its full id, the empty group with it ────────────── */
    await page.getByRole('button', { name: `Remove ${DIMENSION}/NST_901_t/NST_901_sv001` }).click();
    await page.waitForTimeout(2500);
    inputs = await api(`/projects/${project.id}/inputs`);
    check('a nested variable can be removed',
      !inputs.some((v) => v.id === `${DIMENSION}/NST_901_t/NST_901_sv001`));
    check('its sibling stays',
      inputs.some((v) => v.id === `${DIMENSION}/NST_901_t/NST_901_sv003`));
    await api(
      `/projects/${project.id}/inputs/${DIMENSION}/NST_901_t/NST_901_sv003`,
      { method: 'DELETE' },
    );
    if (project.outFolder) {
      check('a group left empty goes too',
        !(await exists(join(project.outFolder, 'in', DIMENSION, 'NST_901_t'))));
    }

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (error) {
    await captureFailure(page, name);
    throw error;
  } finally {
    const left = (await api(`/projects/${project.id}/inputs`)).filter(
      (v) => v.dimension === DIMENSION,
    );
    for (const variable of left) {
      await api(
        `/projects/${project.id}/inputs/${variable.id.split('/').map(encodeURIComponent).join('/')}`,
        { method: 'DELETE' },
      ).catch(() => {});
    }
    await browser.close();
    await rm(root, { recursive: true, force: true });
    const after = (await api(`/projects/${project.id}/inputs`)).filter(
      (v) => v.dimension === DIMENSION,
    );
    check('and the suite leaves none behind', after.length === 0,
      after.map((v) => v.id).join(' ') || `${added.length} added`);
  }
  return results;
}
