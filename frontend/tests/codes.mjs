/**
 * Where a variable's code comes from, and where it is shown.
 *
 * Two halves of the same thing: the engine reads a variable's identity out
 * of its folder name, so that is what should be suggested when adding one —
 * and it is what should be visible on the map, where the label is only
 * whatever the processed file happened to be called.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, captureFailure, goToScreen, open, openProject, suite } from './harness.mjs';

export const name = 'Variable codes';

const DIMENSION = 'codecheck';

/** Folders named the way they arrive: a code, often with a tail. */
async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), 'maphex-codes-'));
  const folders = ['BCD_001_poblacion_rural', 'BCD_002', 'sin_ningun_codigo'];
  for (const folder of folders) {
    await mkdir(join(root, folder), { recursive: true });
    // Named nothing like the folder, which is the point: the folder is what
    // the engine goes by.
    await writeFile(join(root, folder, 'datos_exportados_2024.gpkg'), 'x'.repeat(256));
  }
  return root;
}

export async function run({ project }) {
  const { check, results } = suite(name);
  const root = await fixtures();
  const { browser, page, errors } = await open();
  const added = [];

  try {
    /* ── suggested from the folder, tail and all ────────────────────── */
    await openProject(page, project.name);
    await goToScreen(page, 'Data');
    await page.locator('.project-folder').waitFor({ timeout: 15000 });
    await page.locator('input[placeholder*="wind_atlas"]').first().fill(root);
    await page.locator('.batch-list').waitFor({ timeout: 15000 });

    const codes = await Promise.all(
      (await page.locator('.batch-code').all()).map((input) => input.inputValue()),
    );
    check('a folder with a code is taken at its word',
      codes.includes('BCD_001_POBLACION_RURAL'), JSON.stringify(codes));
    check('including one that is only a code', codes.includes('BCD_002'));
    check('and a folder without one still gets a code',
      codes.length === 3 && codes.every((code) => /^[A-Z]{3}_\d{3}/.test(code)),
      JSON.stringify(codes));
    check('a long code is not truncated',
      codes.some((code) => code.length > 14), JSON.stringify(codes.map((c) => c.length)));

    /* ── and it survives being added ────────────────────────────────── */
    await page.locator('#variable-dimension').selectOption({ label: 'New dimension…' });
    await page.locator('input[aria-label="New dimension name"]').fill(DIMENSION);
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /^add \d+$/i }).click();
    await page.waitForTimeout(4000);

    const inputs = await api(`/projects/${project.id}/inputs`);
    const mine = inputs.filter((v) => v.dimension === DIMENSION);
    added.push(...mine.map((v) => v.code));
    check('the long code reaches the project',
      mine.some((v) => v.code === 'BCD_001_POBLACION_RURAL'),
      mine.map((v) => v.code).join(' '));

    /* ── the map names variables by code ────────────────────────────── */
    // Against what is already rendered: these new ones have not been
    // processed, so they have no layer yet.
    const layers = await api(`/projects/${project.id}/layers`);
    // The input side is a folder per dimension; the layers are inside them.
    const leaves = layers.inputs.flatMap((node) => node.children ?? []);
    if (!leaves.length) {
      check('the map shows the code beside the name', true, 'nothing rendered to check');
    } else {
      check('the server sends the code with each layer',
        leaves.every((node) => typeof node.code === 'string' && node.code),
        leaves.slice(0, 4).map((n) => `${n.code}:${n.label}`).join(' '));

      await goToScreen(page, 'Map');
      await page.locator('.layer-list').first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(800);

      // The folders start shut, so open one and check what it reveals.
      const folder = layers.inputs.find((node) => (node.children ?? []).length > 0);
      await page.locator('.layer-row.is-folder .layer-label').first().click();
      await page.waitForTimeout(500);
      const shown = await page.locator('.layer-list .layer-name').allInnerTexts();
      check('the sidebar names each variable by its code',
        (folder?.children ?? []).every((node) => shown.includes(node.code)),
        JSON.stringify(shown.slice(0, 6)));
      // The point of the change: the label is often `A` or `At`, which tells
      // two variables apart not at all.
      const labels = leaves.map((node) => node.label).filter((l) => l.length < 4);
      check('and not by the name built from the file',
        labels.every((label) => !shown.includes(label)),
        `labels ${JSON.stringify(labels)} vs rows ${JSON.stringify(shown.slice(0, 6))}`);
    }

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
    check('and the suite leaves none behind', left.length === 0,
      left.map((v) => v.id).join(' '));
  }

  return results;
}
