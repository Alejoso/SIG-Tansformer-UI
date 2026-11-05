/**
 * A file with several value columns: the engine needs one chosen.
 *
 * The engine makes one value per hexagon, so a file with several candidate
 * columns (a GeoJSON with `Anio_hecho`, `Total_Victimas_Caso`, `Tipo`) is
 * rejected at ingest until `transform.yaml` says which one is the value.
 * The app asks the engine's own check which files those are, before every
 * run, and offers each one's columns with their first value.
 *
 * Needs the engine: the check runs in its image. Everything is written to a
 * project of its own, in a throwaway folder (`MAPHEX_FIXTURE_DIR`, or the
 * system's temporary folder), deleted at the end. The run itself is held at
 * the door (the POST is answered by the suite), so nothing is processed:
 * what is checked is what reaches `transform.yaml`. The real run is the
 * end-to-end check described in the README.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, APP, captureFailure, goToScreen, open, suite } from './harness.mjs';

export const name = 'Value columns';

const PROJECT = 'Value column check';
const DIMENSION = 'soc';
const CODE = 'SOC_090';
const VARIABLE = `${DIMENSION}/${CODE}`;
const FILE = 'casos.geojson';

/** Points in La Guajira with three candidate value columns and one that is not. */
export function multiColumnGeojson() {
  const kinds = ['Sedimentarias', 'Igneas', 'Metamorficas'];
  const features = [];
  for (let i = 0; i < 12; i += 1) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [-72.9 + (i % 4) * 0.35, 11.1 + Math.floor(i / 4) * 0.3],
      },
      properties: {
        Anio_hecho: String(1992 + (i % 5)),
        Total_Victimas_Caso: i === 0 ? 9 : 1 + ((i * 7) % 11),
        // One value only: free of choice, so not a candidate.
        Nombre_Departamento: 'LA GUAJIRA',
        Tipo: kinds[i % 3],
      },
    });
  }
  return JSON.stringify({ type: 'FeatureCollection', features });
}

async function fixture() {
  const root = await mkdtemp(join(process.env.MAPHEX_FIXTURE_DIR || tmpdir(), 'maphex-columns-'));
  await mkdir(join(root, 'source', CODE), { recursive: true });
  await writeFile(join(root, 'source', CODE, FILE), multiColumnGeojson());
  await mkdir(join(root, 'project'), { recursive: true });
  return root;
}

/** The engine's own words when it rejects such a file, in the shape it writes them. */
async function engineRejection(projectFolder) {
  const reason =
    'tiene mas de 1 columna de valor (Anio_hecho, Total_Victimas_Caso, Tipo). ' +
    'Elige una en transform.yaml value_columns';
  const out = join(projectFolder, 'out', DIMENSION, CODE);
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, 'casos.pipeline.jsonl'),
    JSON.stringify({
      execution_id: '2026-11-05_10-00_rf_001',
      event: 'variable_stage',
      stage: 'INGESTA',
      status: 'error',
      details: { archivo_origen: FILE, error: reason },
    }) + '\n',
  );
}

export async function run() {
  const { check, results } = suite(name);
  const root = await fixture();
  const folder = join(root, 'project');
  const transformPath = join(folder, 'config', 'transform.yaml');
  let projectId = '';
  const { browser, page, errors } = await open();
  const transform = () => readFile(transformPath, 'utf-8').catch(() => '');

  try {
    const project = await api('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: PROJECT, meshId: 'colombia', outFolder: folder, description: '' }),
    });
    projectId = project.id;
    await api(`/projects/${projectId}/inputs`, {
      method: 'POST',
      body: JSON.stringify({ path: join(root, 'source', CODE), dimension: DIMENSION, code: CODE }),
    });

    /* ── the engine's check, through the API ────────────────────────── */
    const state = await api(`/projects/${projectId}/inputs/value-columns`);
    if (!state.available) {
      check('the engine can be asked which files need a column', false, state.error);
      return results;
    }
    const source = state.sources.find((s) => s.variableId === VARIABLE);
    check('the file with several value columns is found', Boolean(source?.needsChoice),
      JSON.stringify(state.sources.map((s) => [s.variableId, s.needsChoice])));
    const names = (source?.candidates ?? []).map((c) => c.name);
    check('with its candidates', ['Anio_hecho', 'Total_Victimas_Caso', 'Tipo'].every(
      (n) => names.includes(n)), names.join(', '));
    check('and not a column with a single value', !names.includes('Nombre_Departamento'));
    const victims = source?.candidates.find((c) => c.name === 'Total_Victimas_Caso');
    check('each with its first value', victims?.sample === 9, JSON.stringify(victims));
    check('and nothing chosen yet', source?.chosen === null && !/value_columns/.test(await transform()));

    // A column the engine did not offer is refused, naming the ones it did.
    const refused = await fetch(
      `${APP}/api/projects/${projectId}/inputs/${DIMENSION}/${CODE}/value-column`,
      { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ column: 'Nombre_Departamento' }) },
    );
    const refusal = await refused.json().catch(() => ({}));
    check('a column that is not a candidate is refused', refused.status === 400 &&
      /Total_Victimas_Caso/.test(refusal.detail ?? ''), `${refused.status} ${refusal.detail}`);

    /* ── the Data screen says so ────────────────────────────────────── */
    // The run is held at the door: what matters here is what happens
    // before it and what reaches transform.yaml.
    let posts = 0;
    await page.route('**/api/projects/*/process', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Held by the test.' }),
      });
    });

    // A reload lands on the projects list, so the project is opened again.
    const openData = async () => {
      await page.goto(APP, { waitUntil: 'networkidle' });
      await page.getByText(PROJECT, { exact: true }).first().click();
      await page.waitForTimeout(700);
      await goToScreen(page, 'Data');
    };
    await openData();
    const badge = page.getByRole('button', { name: `Choose value column for ${VARIABLE}` });
    await badge.waitFor({ timeout: 30000 });
    check('the variable is flagged on the Data screen', await badge.isVisible());
    const rowText = await page.locator('.variable-item', { hasText: CODE }).innerText();
    check('saying it is not transformed until a column is chosen',
      /not transformed until a value column is chosen/.test(rowText), JSON.stringify(rowText));

    /* ── Process: the alert comes first ─────────────────────────────── */
    await page.getByRole('button', { name: /^process/i }).first().click();
    const dialog = page.locator('.value-columns-dialog');
    await dialog.waitFor({ timeout: 30000 });
    check('Process asks before the engine runs', posts === 0, `${posts} runs started`);
    const select = dialog.getByRole('combobox', { name: `Value column for ${VARIABLE}/${FILE}` });
    const options = await select.locator('option').allInnerTexts();
    check('the dialog lists the file with a dropdown of its columns',
      options.length === 4, JSON.stringify(options));
    check('each option shows the column and its first value',
      options.some((o) => o.startsWith('Total_Victimas_Caso: 9')) &&
        options.some((o) => o.startsWith('Anio_hecho: 1992')) &&
        options.some((o) => o.startsWith('Tipo: Sedimentarias')),
      JSON.stringify(options));
    check('and the choice to leave it for later', options[0] === 'Leave for later');
    const body = await dialog.innerText();
    check('saying plainly what leaving it means',
      /not transformed until a value column is chosen/.test(body));

    // Without choosing: the run goes ahead and the file stays out.
    await dialog.getByRole('button', { name: 'Process without them' }).click();
    await page.waitForTimeout(800);
    check('continuing without a choice starts the run', posts === 1, `${posts}`);
    let state2 = await api(`/projects/${projectId}/inputs/value-columns`);
    check('and leaves the file out: nothing chosen in transform.yaml',
      !/value_columns/.test(await transform()) &&
        state2.sources.find((s) => s.variableId === VARIABLE)?.needsChoice === true,
      await transform());

    // Again, choosing this time.
    await page.getByRole('button', { name: /^process/i }).first().click();
    await dialog.waitFor({ timeout: 30000 });
    await select.selectOption('Total_Victimas_Caso');
    await dialog.getByRole('button', { name: 'Save and process' }).click();
    await page.waitForTimeout(1500);
    check('choosing then processing starts the run', posts === 2, `${posts}`);
    state2 = await api(`/projects/${projectId}/inputs/value-columns`);
    const chosen = state2.sources.find((s) => s.variableId === VARIABLE);
    check('the choice is stored', chosen?.chosen === 'Total_Victimas_Caso' && !chosen.needsChoice,
      JSON.stringify(chosen));
    let text = await transform();
    check('and written to transform.yaml as value_columns',
      /\nvalue_columns:\n {2}SOC_090: Total_Victimas_Caso\n/.test(text), JSON.stringify(text));
    check('beside the fill, which is unchanged', /\nfill: \{\}\n/.test(text));

    /* ── shown, changed and cleared from the variable's settings ────── */
    await openData();
    const summary = page.locator('.variable-value-column', { hasText: 'Total_Victimas_Caso' });
    await summary.waitFor({ timeout: 30000 });
    check('the row shows the column chosen', await summary.isVisible());
    check('and the badge is gone',
      (await page.getByRole('button', { name: `Choose value column for ${VARIABLE}` }).count()) === 0);
    check('Process asks nothing now', await (async () => {
      await page.getByRole('button', { name: /^process/i }).first().click();
      await page.waitForTimeout(2500);
      return (await dialog.count()) === 0 && posts === 3;
    })(), `${posts}`);

    await page.getByRole('button', { name: `Fill for ${VARIABLE}` }).click();
    const editor = page.locator('.variable-settings-editor');
    const editSelect = editor.getByRole('combobox', { name: `Value column for ${VARIABLE}/${FILE}` });
    check('the settings show the same dropdown, on the current choice',
      (await editSelect.inputValue()) === 'Total_Victimas_Caso');
    await editSelect.selectOption('Anio_hecho');
    await editor.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(1500);
    text = await transform();
    // The file is rewritten before each run and each check; ask for one.
    await api(`/projects/${projectId}/inputs/value-columns`);
    text = await transform();
    check('a changed choice reaches transform.yaml', /SOC_090: Anio_hecho/.test(text), text);

    await page.getByRole('button', { name: `Fill for ${VARIABLE}` }).click();
    await editSelect.selectOption('');
    await editor.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(1500);
    await api(`/projects/${projectId}/inputs/value-columns`);
    text = await transform();
    check('a cleared choice leaves value_columns out entirely', !/value_columns/.test(text), text);
    await page.getByRole('button', { name: `Choose value column for ${VARIABLE}` })
      .waitFor({ timeout: 30000 });
    check('and the badge is back', true);

    /* ── the engine's rejection points to the fix ───────────────────── */
    await engineRejection(folder);
    await openData();
    await page.locator('.folder-alert.is-problem').waitFor({ timeout: 15000 });
    const fix = page.locator('.folder-alert.is-problem').getByRole('button', {
      name: 'Choose the value column',
    });
    check('the problem offers the fix, not a dead end', (await fix.count()) === 1);
    await fix.click();
    await editSelect.waitFor({ timeout: 10000 });
    check('which opens the dropdown', await editSelect.isVisible());
    await editSelect.selectOption('Tipo');
    await editor.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(1500);
    const viaProblem = await api(`/projects/${projectId}/inputs/value-columns`);
    check('and a choice made there is stored',
      viaProblem.sources.find((s) => s.variableId === VARIABLE)?.chosen === 'Tipo');

    /* ── removing the variable drops its choice ─────────────────────── */
    await api(`/projects/${projectId}/inputs/${DIMENSION}/${CODE}`, { method: 'DELETE' });
    const after = await api(`/projects/${projectId}/inputs/value-columns`);
    check('removing the variable drops its choice',
      after.sources.length === 0 && !/value_columns/.test(await transform()),
      JSON.stringify(after.sources));

    // The held runs are 409s on purpose, and the refused PUT a 400.
    const unexpected = errors.filter((t) => !/status of 409|status of 400/.test(t));
    check('no other page errors', unexpected.length === 0, unexpected.slice(0, 2).join(' | '));
  } catch (error) {
    await captureFailure(page, name);
    throw error;
  } finally {
    await browser.close();
    if (projectId) {
      await fetch(`${APP}/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {});
    }
    // The checks write nothing as root (no run is started), so this goes.
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return results;
}
