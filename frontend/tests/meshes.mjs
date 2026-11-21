/**
 * The mesh picker on New project, and what a mesh without a sea leaves out.
 *
 * Colombia (DANE) comes first; a Natural Earth country offers geoBoundaries
 * detail only when it has an ISO code, with the attribution and the note
 * that the first run downloads it; an uploaded outline offers its columns,
 * and as the code only those with a value for every area and none repeated.
 * A project created on a mesh other than DANE says on the Data screen that
 * it has no sea, and refuses a sea fill on the server.
 *
 * Creates one project in a temporary folder and removes it again (the CSV
 * rows; the temporary folder is left to the system). Never starts a run.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API, APP, api, captureFailure, open, suite } from './harness.mjs';

export const name = 'Meshes';

const OUTLINE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { nombre: 'Norte', codigo: 'N1', zona: 'A' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-74, 4], [-73, 4], [-73, 5], [-74, 5], [-74, 4]]],
      },
    },
    {
      type: 'Feature',
      // `zona` repeats, so it can name an area but not code one.
      properties: { nombre: 'Sur', codigo: 'S1', zona: 'A' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-73, 4], [-72, 4], [-72, 5], [-73, 5], [-73, 4]]],
      },
    },
  ],
};

async function pickMesh(page, text, label) {
  const box = page.locator('#project-mesh');
  await box.click();
  await box.fill(text);
  await page.locator('.combo-option', { hasText: label }).first().dispatchEvent('mousedown');
  await page.waitForTimeout(200);
}

export async function run() {
  const { check, results } = suite(name);
  const { browser, page, errors } = await open();
  const folder = await mkdtemp(join(tmpdir(), 'maphex-mesh-'));
  let createdId = null;

  try {
    /* ── the catalog ──────────────────────────────────────────────────── */
    const meshes = await api('/meshes');
    check('Colombia (DANE) is first', meshes[0]?.id === 'dane_colombia', meshes[0]?.id);
    check(
      'the rest are Natural Earth countries',
      meshes.slice(1).every((mesh) => mesh.id.startsWith('natural_earth:')),
    );

    await page.goto(APP, { waitUntil: 'networkidle' });
    await page
      .getByRole('button', { name: /new project|create your first project/i })
      .first()
      .click();
    await page.locator('#project-mesh').waitFor({ timeout: 10000 });

    await page.locator('#project-mesh').click();
    const first = await page.locator('.combo-option').first().innerText();
    check('the list opens on Colombia (DANE)', first.includes('Colombia (DANE)'), first);
    await page.keyboard.press('Escape');

    /* ── a country with an ISO code ───────────────────────────────────── */
    await pickMesh(page, 'Uruguay', 'Uruguay');
    const detail = page.locator('#project-mesh-detail');
    check('a country offers a detail level', (await detail.count()) === 1);
    check('the no-sea hint shows', await page.getByTestId('mesh-no-sea').isVisible());
    await detail.selectOption('ADM1');
    const body = await page.locator('.setup-card').innerText();
    check('geoBoundaries is attributed', /geoBoundaries \(CC BY 4\.0\)/.test(body));
    check('and its download is announced', /first run/.test(body) && /internet/.test(body));

    /* ── one without ─────────────────────────────────────────────────── */
    await pickMesh(page, 'France', 'France');
    const adm1 = page.locator('#project-mesh-detail option[value="ADM1"]');
    check('France has no geoBoundaries', await adm1.isDisabled());

    /* ── DANE ─────────────────────────────────────────────────────────── */
    await pickMesh(page, 'DANE', 'Colombia (DANE)');
    check('DANE has no detail level', (await page.locator('#project-mesh-detail').count()) === 0);
    check('nor the no-sea hint', (await page.getByTestId('mesh-no-sea').count()) === 0);

    /* ── an upload ────────────────────────────────────────────────────── */
    const file = join(folder, 'Zonas Norte.geojson');
    await writeFile(file, JSON.stringify(OUTLINE));
    await page.locator('input[type="file"]').setInputFiles(file);
    await page.locator('#project-mesh-name').waitFor({ timeout: 15000 });
    const columns = await page.locator('#project-mesh-name option').allInnerTexts();
    check('its columns are offered', columns.includes('Name: nombre') && columns.includes('Name: codigo'),
      columns.join(', '));
    check('the name column is suggested',
      (await page.locator('#project-mesh-name').inputValue()) === 'nombre');
    const codes = await page.locator('#project-mesh-code option').allInnerTexts();
    check('a repeated column is not offered as the code',
      codes.includes('Code: codigo') && !codes.includes('Code: zona') && columns.includes('Name: zona'),
      codes.join(', '));
    check('the code column is suggested',
      (await page.locator('#project-mesh-code').inputValue()) === 'codigo');

    const projectName = `Mesh check ${Date.now()}`;
    await page.locator('#project-name').fill(projectName);
    await page.locator('#out-folder').fill(join(folder, 'project'));
    await page.getByRole('button', { name: /create project/i }).click();
    await page.locator('.project-mesh-fact').waitFor({ timeout: 15000 });
    const fact = await page.locator('.project-mesh-fact').innerText();
    check('the Data screen names the mesh', /Zonas Norte \(uploaded\)/.test(fact), fact);
    check('and says it has no sea', await page.locator('.project-mesh-note').isVisible());

    const projects = await api('/projects');
    const created = projects.find((project) => project.name === projectName);
    createdId = created?.id ?? null;
    check('the project is on the upload', created?.meshSource === 'file' && !created.meshHasSea);

    check('no errors in the console', errors.length === 0, errors.join(' | '));
  } catch (error) {
    check('the suite ran to the end', false, error.message);
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
    if (createdId) {
      const removed = await fetch(`${API}/projects/${createdId}`, { method: 'DELETE' });
      console.log(`  ...  the project it made was ${removed.ok ? 'removed' : 'NOT removed'}`);
    }
  }
  return results;
}
