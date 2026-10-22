/**
 * The opacity control the backend adds to the engine's layer documents.
 *
 * Checked against the served document rather than a copy on disk, because
 * the control exists only in what is served — the file is never modified.
 */

import { API, captureFailure, modelDocuments, open, suite } from './harness.mjs';

export const name = 'Layer opacity';

export async function run({ project, layers, inputs }) {
  const { check, skip, results } = suite(name);

  // One input layer and, when there has been a model run, one of its outputs:
  // they come from different parts of the engine and are rendered separately.
  const targets = [['a variable', inputs[0]]];
  const fromModel = modelDocuments(layers)[0];
  if (fromModel) targets.push(['a model layer', fromModel]);

  if (!inputs.length) {
    skip('nothing has been processed in this workspace yet');
    return results;
  }

  const { browser, page, errors } = await open({ width: 1200, height: 800 });

  try {
    for (const [what, node] of targets) {
      const url = `${API}/projects/${project.id}/layers/${node.id}/document`;
      // These documents are several megabytes and pull deck.gl from a CDN.
      await page.goto(url, { waitUntil: 'load', timeout: 120000 });
      await page.waitForTimeout(6000);

      const slider = page.locator('#maphex-opacity-range');
      if (!(await slider.count())) {
        check(`${what}: the control is there`, false, 'no slider in the served document');
        continue;
      }
      check(`${what}: the control is there`, true);

      const placed = await page.evaluate(() => {
        const box = document.getElementById('maphex-opacity').getBoundingClientRect();
        return {
          bottomGap: Math.round(window.innerHeight - box.bottom),
          rightGap: Math.round(window.innerWidth - box.right),
          visible: box.width > 0 && box.height > 0,
        };
      });
      check(`${what}: bottom right of the frame`,
        placed.visible && placed.bottomGap < 24 && placed.rightGap < 24, JSON.stringify(placed));

      // The deck.gl way: `opacity` multiplies the alpha already baked into
      // each hexagon's colour. Read off the layer itself, so this fails if
      // the control ever stops reaching it.
      const read = () => page.evaluate(() => deckInstance.props.layers.map((l) => l.props.opacity));
      const before = await read();
      await slider.fill('40');
      await page.waitForTimeout(600);
      const after = await read();
      check(`${what}: the slider reaches the layer`,
        before.every((o) => o === 1) && after.every((o) => Math.abs(o - 0.4) < 1e-9),
        `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      check(`${what}: the readout follows`,
        (await page.locator('#maphex-opacity-value').innerText()) === '40%');

      // There are two canvases in these documents and the other one is the
      // basemap. Fading it with the hexagons would wash out the whole
      // picture instead of what sits on it.
      const canvases = await page.evaluate(() =>
        [...document.querySelectorAll('canvas')].map((c) => ({
          base: c.className.indexOf('mapboxgl') !== -1,
          opacity: c.style.opacity || '(unset)',
        })));
      check(`${what}: the basemap is untouched`,
        canvases.some((c) => c.base) && canvases.every((c) => c.opacity === '(unset)'),
        JSON.stringify(canvases));
    }

    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
  }

  return results;
}
