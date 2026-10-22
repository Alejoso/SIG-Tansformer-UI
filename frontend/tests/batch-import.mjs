/**
 * Adding a folder that holds several variables.
 *
 * Against fixtures the suite makes and removes itself — small files in a
 * temporary folder, imported into the project and then taken out again. It
 * never touches variables that were already there.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, captureFailure, goToScreen, open, openProject, suite } from './harness.mjs';

export const name = 'Batch import';

const DIMENSION = 'batchcheck';

/** A folder of folders, and a folder of files side by side. */
async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), 'maphex-batch-'));
  const nested = join(root, 'by-folder');
  for (const code of ['BCH_001', 'BCH_002', 'BCH_003']) {
    await mkdir(join(nested, code), { recursive: true });
    await writeFile(join(nested, code, `${code.toLowerCase()}.gpkg`), 'x'.repeat(512));
  }
  // One that cannot be a variable on its own, to check it is shown and not
  // silently dropped.
  await mkdir(join(nested, 'two_datasets'), { recursive: true });
  await writeFile(join(nested, 'two_datasets', 'a.gpkg'), 'x'.repeat(128));
  await writeFile(join(nested, 'two_datasets', 'b.geojson'), 'x'.repeat(128));
  // And one with nothing readable, which should not be listed at all.
  await mkdir(join(nested, 'notes'), { recursive: true });
  await writeFile(join(nested, 'notes', 'readme.txt'), 'nothing here');
  return { root, nested };
}

export async function run({ project }) {
  const { check, results } = suite(name);
  const { root, nested } = await fixtures();
  const { browser, page, errors } = await open();
  const added = [];

  try {
    await openProject(page, project.name);
    await goToScreen(page, 'Data');
    await page.locator('.project-folder').waitFor({ timeout: 15000 });

    await page.locator('input[placeholder*="wind_atlas"]').first().fill(nested);
    await page.locator('.batch-list').waitFor({ timeout: 15000 });

    const rows = page.locator('.batch-row');
    check('a folder of folders is read as several variables',
      (await rows.count()) === 4, `${await rows.count()} rows`);
    check('a subfolder with nothing readable is not listed',
      !(await rows.allInnerTexts()).some((r) => /notes/.test(r)));
    const blocked = page.locator('.batch-row.is-blocked');
    check('and one that cannot be a variable says why',
      (await blocked.count()) === 1 && /2 datasets/.test(await blocked.innerText()),
      JSON.stringify((await blocked.innerText()).replace(/\n/g, ' ')));

    const codes = await Promise.all(
      (await page.locator('.batch-code').all()).map((input) => input.inputValue()),
    );
    check('every one is offered its own code',
      new Set(codes).size === codes.length && codes.length === 3, JSON.stringify(codes));

    // Point them at a dimension of the suite's own, so nothing existing moves.
    await page.locator('#variable-dimension').selectOption({ label: 'New dimension…' });
    await page.locator('input[aria-label="New dimension name"]').fill(DIMENSION);
    await page.waitForTimeout(400);

    // Two codes the same must block the button rather than half-import.
    const first = page.locator('.batch-code').first();
    const second = page.locator('.batch-code').nth(1);
    const keep = await second.inputValue();
    await second.fill(await first.inputValue());
    await page.waitForTimeout(300);
    check('two of them with one code blocks adding',
      await page.getByRole('button', { name: /^add \d+$/i }).isDisabled());
    await second.fill(keep);
    await page.waitForTimeout(300);

    // Untick one: the button should count what is actually coming.
    await rows.nth(2).locator('input[type="checkbox"]').uncheck();
    await page.waitForTimeout(300);
    check('unticking one changes what the button says',
      (await page.getByRole('button', { name: /^add \d+$/i }).innerText()).includes('2'));
    await rows.nth(2).locator('input[type="checkbox"]').check();
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: /^add \d+$/i }).click();
    await page.waitForTimeout(4000);

    const inputs = await api(`/projects/${project.id}/inputs`);
    const mine = inputs.filter((v) => v.dimension === DIMENSION);
    added.push(...mine.map((v) => v.code));
    check('all three land in the project', mine.length === 3,
      mine.map((v) => v.id).join(' '));
    check('each in its own folder under the one dimension',
      new Set(mine.map((v) => v.code)).size === 3, mine.map((v) => v.code).join(' '));

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
    for (const code of added) {
      try {
        await api(`/projects/${project.id}/inputs/${DIMENSION}/${code}`, { method: 'DELETE' });
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true });
    const left = (await api(`/projects/${project.id}/inputs`)).filter(
      (v) => v.dimension === DIMENSION,
    );
    check('and the suite leaves none of them behind', left.length === 0,
      left.map((v) => v.id).join(' '));
  }

  return results;
}
