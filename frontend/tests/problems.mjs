/**
 * Variables the engine could not finish, and the reason it gave.
 *
 * A run reports a count and nothing else — "4 files could not be processed"
 * names none of them, and the number is gone by the next run. The reason has
 * been in the output folder all along: the engine writes a `.pipeline.jsonl`
 * with the failing stage, and for ingest an `.error.txt` beside it.
 *
 * The failures here are written by the suite, in the shape the engine writes
 * them, into a project of its own that is deleted afterwards. Making a real
 * one would mean feeding the engine a broken file and waiting for a run.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, captureFailure, goToScreen, open, suite, APP } from './harness.mjs';

export const name = 'Why a variable failed';

const RUN = '2026-10-24_10-00_rf_001';
const line = (stage, status, details) =>
  JSON.stringify({
    execution_id: RUN,
    event: 'variable_stage',
    stage,
    status,
    ...(details ? { details } : {}),
  }) + '\n';

/** An output tree with the four cases the engine can leave behind. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'maphex-problems-'));
  const out = join(root, 'out', 'ambiental');

  await mkdir(join(out, 'AMB_050'), { recursive: true });
  await writeFile(
    join(out, 'AMB_050', 'censo_2024.pipeline.jsonl'),
    line('INGESTA', 'error', {
      archivo_origen: 'censo_2024.csv',
      error: 'tiene referencia geografica (DIVIPOLA/nombre) pero ninguna columna de valor',
    }),
  );
  await writeFile(
    join(out, 'AMB_050', 'censo_2024.error.txt'),
    'Archivo NO transformado a H3.\nFuente: /data/in/ambiental/AMB_050/censo_2024.csv\n' +
      'Motivo: tiene referencia geografica (DIVIPOLA/nombre) pero ninguna columna de valor\n',
  );

  await mkdir(join(out, 'AMB_051'), { recursive: true });
  await writeFile(
    join(out, 'AMB_051', 'ruido.pipeline.jsonl'),
    line('INGESTA', 'ok') +
      line('CONVERSION_H3', 'error', {
        archivo_origen: 'ruido.gpkg',
        error: 'CRS inexistente o no resoluble',
      }),
  );

  // Stopped partway with nothing claiming to have failed.
  await mkdir(join(out, 'AMB_052'), { recursive: true });
  await writeFile(
    join(out, 'AMB_052', 'vias.pipeline.jsonl'),
    line('INGESTA', 'ok') + line('CONVERSION_H3', 'ok'),
  );

  // And one that finished, which must not be reported.
  await mkdir(join(out, 'AMB_053'), { recursive: true });
  await writeFile(
    join(out, 'AMB_053', 'poblacion.pipeline.jsonl'),
    line('INGESTA', 'ok') + line('CONVERSION_H3', 'ok') + line('CARGA_DB', 'ok') +
      line('RENDER_HTML', 'ok'),
  );

  return root;
}

export async function run() {
  const { check, results } = suite(name);
  const root = await fixture();
  let projectId = '';
  const { browser, page, errors } = await open();

  try {
    const project = await api('/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Problem check',
        meshId: 'colombia',
        outFolder: root,
        description: '',
      }),
    });
    projectId = project.id;

    const found = await api(`/projects/${projectId}/problems`);
    check('the three that did not finish are reported', found.length === 3,
      found.map((p) => `${p.code}:${p.status}`).join(' '));
    check('and the one that did is not',
      !found.some((p) => p.code === 'AMB_053'));

    const ingest = found.find((p) => p.code === 'AMB_050');
    check('a failure at ingest carries the engine\'s own reason',
      ingest?.status === 'error' &&
        ingest.stage === 'INGESTA' &&
        /ninguna columna de valor/.test(ingest.reason) &&
        ingest.source === 'censo_2024.csv',
      JSON.stringify(ingest));

    const convert = found.find((p) => p.code === 'AMB_051');
    check('and one later on names the stage it died at',
      convert?.stage === 'CONVERSION_H3' && /CRS inexistente/.test(convert.reason),
      JSON.stringify(convert));
    check('with the stage said in English too',
      convert?.stageLabel === 'converting to hexagons', convert?.stageLabel);

    const stalled = found.find((p) => p.code === 'AMB_052');
    check('one that just stopped is told apart from one that failed',
      stalled?.status === 'unfinished' && !stalled.reason, JSON.stringify(stalled));

    /* ── and it is on the screen, not only in the API ───────────────── */
    await page.goto(APP, { waitUntil: 'networkidle' });
    await page.getByText('Problem check', { exact: true }).first().click();
    await page.waitForTimeout(700);
    await goToScreen(page, 'Data');
    await page.locator('.folder-alert.is-problem').waitFor({ timeout: 15000 });

    const shown = await page.locator('.folder-alert.is-problem').innerText();
    check('the Data screen names each one', ['AMB_050', 'AMB_051', 'AMB_052'].every(
      (code) => shown.includes(code)), JSON.stringify(shown.slice(0, 120)));
    check('and quotes the reason the engine gave',
      /ninguna columna de valor/.test(shown) && /CRS inexistente/.test(shown));
    check('and says which step it failed at',
      /reading the file/.test(shown) && /converting to hexagons/.test(shown));

    // It is read off disk, so it is still there on the next visit.
    await goToScreen(page, 'Map');
    await page.waitForTimeout(800);
    await goToScreen(page, 'Data');
    await page.locator('.folder-alert.is-problem').waitFor({ timeout: 15000 });
    check('and it survives leaving the screen', true);

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
    if (projectId) {
      try {
        await fetch(`${APP}/api/projects/${projectId}`, { method: 'DELETE' });
      } catch {
        // Nothing to remove.
      }
    }
    await rm(root, { recursive: true, force: true });
  }

  return results;
}
