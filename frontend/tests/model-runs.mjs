/**
 * Past model runs: what they cost, and removing one.
 *
 * The removal is tested against a throwaway run the suite makes itself, not
 * against real results. These are the engine's output and someone's work —
 * a check that quietly deletes 191 MB of it would be the bug, not the test.
 * Making one needs the container, because the folder they live in belongs to
 * root; without Docker the suite checks the listing and stops.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { api, captureFailure, goToScreen, open, openProject, suite } from './harness.mjs';

const exec = promisify(execFile);

export const name = 'Model runs';

const PROBE = '0000-00-00_00-00_probe_999';
const PIPELINE_DIR = process.env.MAPHEX_PIPELINE_DIR ?? '/home/alejo/Vento/SIG-Transformer';

/** A run-shaped folder owned by root, like the engine's own. */
async function makeProbe(dataDir) {
  await exec(
    'docker',
    [
      'compose', 'run', '--rm', '--no-deps', '--entrypoint', 'sh', 'app', '-c',
      `mkdir -p "/data/MCDA/runs/${PROBE}/criterios/global" && ` +
        `head -c 1000000 /dev/zero > "/data/MCDA/runs/${PROBE}/criterios/global/probe.h3.html"`,
    ],
    { cwd: PIPELINE_DIR, env: { ...process.env, DATA_DIR: dataDir }, timeout: 120000 },
  );
}

export async function run({ project }) {
  const { check, skip, results } = suite(name);

  const before = await api(`/projects/${project.id}/model/runs`);
  if (before.length === 0) {
    skip('this project has never run the model');
    return results;
  }
  check('the newest is the one the map draws',
    before[0].current && before.slice(1).every((r) => !r.current),
    before.map((r) => `${r.id}:${r.current}`).join(' '));
  check('each run reports a size and a count',
    before.every((r) => r.sizeBytes > 0 && r.documentCount > 0));

  let probed = false;
  if (!before.some((r) => r.id === PROBE)) {
    try {
      await makeProbe(project.outFolder);
      probed = true;
    } catch {
      // No Docker, or no engine checkout. The listing is still worth having.
    }
  } else {
    probed = true;
  }

  // However many there are now — the probe may not have been makeable.
  const current = await api(`/projects/${project.id}/model/runs`);

  const { browser, page, errors } = await open();
  try {
    await openProject(page, project.name);
    await goToScreen(page, 'Model');
    await page.locator('.yaml-body-editor').waitFor({ timeout: 15000 });
    await page.waitForTimeout(900);

    const line = page.locator('.runs-line');
    if (current.length < 2) {
      // One run is just the result, so the line stays away on purpose. Worth
      // checking rather than skipping over: a line that said "1 model run ·
      // only the newest is on the map" would be noise on every project.
      check('one run alone says nothing', (await line.count()) === 0);
      skip('needs a second run to clean up, and one could not be made');
      await browser.close();
      return results;
    }

    check('the Model screen says what the runs cost', (await line.count()) === 1,
      `${current.length} runs`);
    const text = await line.innerText();
    check('and that only the newest is on the map', /only the newest is on the map/.test(text),
      JSON.stringify(text.replace(/\n/g, ' ')));

    await line.click();
    await page.locator('.run-list').waitFor({ timeout: 10000 });
    const rows = await page.locator('.run-row').count();
    check('the dialog lists every run', rows === current.length, `${rows} rows`);
    check('and marks the one on the map',
      (await page.locator('.run-row.is-current .run-badge').count()) === 1);

    if (!probed) {
      skip('no throwaway run to delete — Docker is not available');
      await browser.close();
      return results;
    }

    // Removing takes two clicks: one arms it, the next does it.
    const probeRow = page.locator('.run-row', { has: page.locator('.run-id', { hasText: PROBE }) });
    await probeRow.waitFor({ timeout: 10000 });
    const remove = probeRow.locator('.run-remove');
    await remove.click();
    await page.waitForTimeout(250);
    check('one click only asks', /sure/i.test(await remove.innerText()));

    await remove.click();
    // The removal runs a container, which takes a few seconds to start.
    await page.locator('.run-row', { has: page.locator('.run-id', { hasText: PROBE }) })
      .waitFor({ state: 'detached', timeout: 120000 });
    check('the second click removes it', true);

    const left = await api(`/projects/${project.id}/model/runs`);
    check('and it is gone from disk', !left.some((r) => r.id === PROBE),
      left.map((r) => r.id).join(' '));
    check('nothing else was touched',
      before.filter((r) => r.id !== PROBE).every((r) => left.some((l) => l.id === r.id)));

    const note = await page.locator('.settings-note').first().innerText();
    check('it says how much that freed', /freed/i.test(note), JSON.stringify(note));

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
    // Leave nothing of the suite's own behind.
    try {
      await api(`/projects/${project.id}/model/runs/${PROBE}`, { method: 'DELETE' });
    } catch {
      // Already gone, which is the point.
    }
  }

  return results;
}

