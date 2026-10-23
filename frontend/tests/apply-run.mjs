/**
 * Applying the model without the app being stuck behind a modal.
 *
 * The run itself is faked at the network boundary rather than started for
 * real. Two reasons: a real score takes minutes, and what changed here is
 * only what the app does *around* a run — the dialog being dismissible, the
 * Apply button becoming the way back, the header carrying it between
 * screens, and finishing being announced wherever you are. The run's own
 * machinery is covered by the engine and by `model-runs`.
 *
 * Nothing is written: the two calls that would touch the project — applying
 * the file and starting the engine — are both intercepted.
 */

import { captureFailure, goToScreen, open, openProject, suite } from './harness.mjs';

export const name = 'Apply without blocking';

const STAGES = [
  { number: 1, key: 'distances', label: 'Measure distances', status: 'ok', detail: '' },
  { number: 2, key: 'presence', label: 'Work out coverage', status: 'ok', detail: '' },
  { number: 3, key: 'masks', label: 'Build exclusion masks', status: 'running', detail: '' },
  { number: 4, key: 'score', label: 'Score every hexagon', status: 'pending', detail: '' },
];

const runAt = (percent, status = 'running') => ({
  projectId: 'fake',
  status,
  executionId: '0000-00-00_00-00_fake_001',
  percent,
  statusText: status === 'done' ? 'Finished' : 'Building exclusion masks',
  stages: STAGES.map((stage, index) =>
    status === 'done' ? { ...stage, status: 'ok' } : index === 2 ? stage : stage,
  ),
  startedAt: Date.now() / 1000 - 12,
  finishedAt: status === 'done' ? Date.now() / 1000 : null,
  error: '',
  hexagonCount: null,
  skippedFiles: 0,
  erroredFiles: 0,
  reset: false,
  resetReason: '',
});

export async function run({ project }) {
  const { check, results } = suite(name);
  const { browser, page, errors } = await open();

  // How far the fake run has got. The suite moves it.
  let percent = 20;
  let status = 'running';
  // Nothing is running until Apply is pressed. It matters: opening a project
  // asks whether a run is already going, so answering "yes" from the start
  // would have the screen resume a run nobody started — which is the resume
  // path working, not this one.
  let startedRun = false;

  try {
    await page.route('**/api/projects/*/model/apply', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          path: '/fake/model.yaml',
          text: 'criteria: []\n',
          created: false,
          syntaxErrors: [],
          structureErrors: [],
        }),
      }),
    );
    await page.route('**/api/projects/*/model/run', (route) => {
      if (route.request().method() === 'POST') startedRun = true;
      return route.fulfill({
        status: route.request().method() === 'POST' ? 202 : 200,
        contentType: 'application/json',
        body: startedRun ? JSON.stringify(runAt(percent, status)) : 'null',
      });
    });

    await openProject(page, project.name);
    await goToScreen(page, 'Model');
    await page.locator('.yaml-body-editor').waitFor({ timeout: 15000 });
    await page.waitForTimeout(900);

    await page.getByRole('button', { name: /^apply$/i }).click();
    await page.locator('#apply-progress-title').waitFor({ timeout: 10000 });
    check('applying opens the progress dialog', true);

    /* ── the dialog is no longer a wall ─────────────────────────────── */
    await page.getByRole('button', { name: /^hide$/i }).click();
    await page.waitForTimeout(400);
    check('it can be put away',
      (await page.locator('#apply-progress-title').count()) === 0);

    const applyButton = page.locator('.tune-actions .btn-primary');
    check('and the Apply button says what is happening',
      /applying/i.test(await applyButton.innerText()),
      await applyButton.innerText().catch(() => '(absent)'));
    check('with no second indicator beside it',
      (await page.locator('.header-run').count()) === 0);
    await applyButton.click();
    await page.locator('#apply-progress-title').waitFor({ timeout: 5000 });
    check('clicking it brings the dialog back', true);
    await page.getByRole('button', { name: /^hide$/i }).click();
    await page.waitForTimeout(300);

    /* ── and the app is usable while it runs ────────────────────────── */
    await goToScreen(page, 'Data');
    await page.locator('.project-folder').waitFor({ timeout: 15000 });
    check('another screen opens while the run is going', true);
    // The engine is one engine: the server would refuse a second run, so the
    // button that would ask for one says why instead of offering an error.
    check('and does not offer to start a second run',
      await page.getByRole('button', { name: /^process/i }).isDisabled());
    const why = await page.locator('.path-add-status').innerText();
    check('saying what is holding it', /one run at a time/i.test(why), JSON.stringify(why));
    const chip = page.locator('.header-run');
    check('the header carries it across', (await chip.count()) === 1,
      await chip.innerText().catch(() => '(absent)'));

    percent = 60;
    await page.waitForTimeout(1600);
    check('and keeps counting', /60%/.test(await chip.innerText()),
      await chip.innerText());

    await chip.click();
    await page.locator('#apply-progress-title').waitFor({ timeout: 5000 });
    check('the header chip reopens it, from another screen', true);
    await page.getByRole('button', { name: /^hide$/i }).click();
    await page.waitForTimeout(300);

    /* ── finishing says so wherever you are ─────────────────────────── */
    await goToScreen(page, 'Map');
    await page.waitForTimeout(1200);
    percent = 100;
    status = 'done';
    await page.locator('#apply-done-title').waitFor({ timeout: 10000 });
    check('it announces itself on a screen that did not start it', true);
    check('and the header chip is gone with it',
      (await page.locator('.header-run').count()) === 0);

    await page.getByRole('button', { name: /stay here/i }).click();
    await page.waitForTimeout(500);
    check('dismissing it is the end of it',
      (await page.locator('#apply-done-title').count()) === 0);
    await page.waitForTimeout(1500);
    check('and it does not come back', (await page.locator('#apply-done-title').count()) === 0);

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
  }

  return results;
}
