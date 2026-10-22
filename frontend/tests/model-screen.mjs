/**
 * The Model screen: the diagram, and how problems are reported.
 *
 * The states it checks are made rather than hoped for. Whether a given
 * project's file happens to carry a warning is not something a check should
 * depend on, so the suite writes the file into each state and puts it back
 * afterwards.
 */

import { api, captureFailure, goToScreen, open, openProject, suite } from './harness.mjs';

export const name = 'Model screen';

/**
 * The same file with one leaf's `type` made up.
 *
 * Done line by line rather than with one regex over the whole document: a
 * generated file writes its leaves as inline mappings, so `type:` is not at
 * the start of a line, and the comments at the top talk about types without
 * being one.
 */
function withBrokenType(text) {
  const lines = text.split('\n');
  const at = lines.findIndex(
    (line) => !line.trim().startsWith('#') && /type:\s*\w+/.test(line),
  );
  if (at === -1) return null;
  lines[at] = lines[at].replace(/type:\s*\w+/, 'type: wizard');
  return lines.join('\n');
}

export async function run({ project, model }) {
  const { check, skip, results } = suite(name);
  const original = model.text;

  const broken = withBrokenType(original);
  if (!/^\s*-\s*key:/m.test(original) || broken === null) {
    skip('this project\'s model file has no leaves to draw');
    return results;
  }

  const write = (text) =>
    api(`/projects/${project.id}/model`, { method: 'PUT', body: JSON.stringify({ text }) });

  const { browser, page, errors } = await open();
  const show = async () => {
    await openProject(page, project.name);
    await goToScreen(page, 'Model');
    await page.locator('.yaml-body-editor').waitFor({ timeout: 15000 });
    await page.waitForTimeout(900);
  };

  try {
    /* ── the diagram draws what the file says ───────────────────────── */
    await show();
    const counts = {
      criterion: await page.locator('.node.is-criterion').count(),
      subgroup: await page.locator('.node.is-subgroup').count(),
      leaf: await page.locator('.node.is-leaf').count(),
    };
    check('the diagram draws all three levels',
      counts.criterion > 0 && counts.subgroup > 0 && counts.leaf > 0, JSON.stringify(counts));

    const leaf = (await page.locator('.node.is-leaf').first().innerText()).replace(/\n/g, ' / ');
    // A leaf's job is to name a column of the master table, so the box has to
    // show which one without opening the file.
    check('a leaf names its column and scoring type',
      /[A-Z]{3}_\d{3}/.test(leaf) && /Cuts|Min-max|Z-score|Categories|Already/.test(leaf),
      JSON.stringify(leaf));

    const caption = (await page.locator('.diagram-caption').innerText()).replace(/\n/g, ' ');
    check('the caption totals the criteria weights', /criteria add to \d/.test(caption),
      JSON.stringify(caption));

    /* ── a key the engine ignores is a warning, not a failure ───────── */
    await write(`${original.trimEnd()}\n\nbinz_test: 1\n`);
    await show();
    const warnClass = await page.locator('.status-chip').first().getAttribute('class');
    const warnText = await page.locator('.status-chip').first().innerText();
    check('an unknown key does not read as invalid',
      /is-warning/.test(warnClass ?? ''), `${JSON.stringify(warnText)} class=${warnClass}`);
    const warnings = await page.locator('.yaml-problem-text').allInnerTexts();
    check('and it says the engine will ignore it',
      warnings.some((m) => /not a key the engine reads/.test(m)),
      JSON.stringify(warnings.slice(0, 1)));

    /* ── a type the engine cannot score is a problem, with a line ───── */
    await write(broken);
    await show();
    const badClass = await page.locator('.status-chip').first().getAttribute('class');
    check('an unknown type reads as invalid', /is-invalid/.test(badClass ?? ''), `class=${badClass}`);
    const problems = await page.locator('.yaml-problem-text').allInnerTexts();
    check('in the engine\'s own words',
      problems.some((m) => /not one the engine scores/.test(m)),
      JSON.stringify(problems.slice(0, 1)));
    const lines = await page.locator('.yaml-problem-line').allInnerTexts();
    check('and says which line', lines.some((l) => /line \d+/.test(l)), JSON.stringify(lines));

    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    const restored = await write(original);
    check('the file is back as it was', restored.text === original);
    await browser.close();
  }

  return results;
}
