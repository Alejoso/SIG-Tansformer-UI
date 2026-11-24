/**
 * The legend the backend adds to the engine's layer documents.
 *
 * Checked against the served document rather than a copy on disk, because —
 * like the opacity control — it exists only in what is served.
 *
 * Two halves.
 *
 * The first takes layers this machine actually has and asks whether the
 * legend says what the data says: the numbers at the ends of a ramp, one
 * swatch per class, in the colours the hexagons are painted in. The document
 * is its own source of truth here — the tooltip names the column the map is
 * of, and every cell carries the colour it is drawn in.
 *
 * The second builds documents around the block as served, for the shapes
 * that only come out of a model run: cells the engine took out of the
 * measurement, the ring it draws on a flagged cell, and a classified layer
 * whose codes have labels. Waiting for a model run to check those would mean
 * never checking them.
 */

import { API, api, captureFailure, modelDocuments, open, suite } from './harness.mjs';

export const name = 'Layer legend';

/**
 * Documents sniffed before two are opened. A sniff reads the front of a
 * document and drops the rest, so the budget is generous: it is the opening
 * of a layer that costs, and only two are opened.
 */
const SNIFF_LIMIT = 90;

/** How much of a document to read to guess what kind of layer it is. */
const SNIFF_BYTES = 96 * 1024;

/* ── reading the document ─────────────────────────────────────────────── */

/**
 * What the data says, read in the page off `jsonInput`.
 *
 * Takes the column from the tooltip exactly as the legend does. That is not
 * the legend's own working repeated back at it: the tooltip is the engine's
 * statement of what the map is of, and both are reading it.
 */
function describe() {
  /* Top-level `const`s in the document's own script: global lexical
     bindings, which naming throws over when they are absent. */
  let json = null;
  let tip = null;
  try {
    json = jsonInput;
  } catch {
    json = null;
  }
  try {
    tip = tooltip;
  } catch {
    tip = null;
  }
  if (!json || !json.layers) return null;
  const fill = json.layers.find((l) => l.data && l.data.length && l.filled !== false);
  if (!fill) return null;

  /* The engine's tooltip, as text ('global: {global} | alerta: {alert}') or,
     since 2026-11-18, as HTML with the cell's code first
     ('<b>H3 (res 6):</b> {h3_index}<br/><b>global:</b> {global}'): the first
     "label: {column}" item that is not the H3 cell. */
  const template = (tip && (tip.html || tip.text)) || '';
  const items = template.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').split(/\n|\|/);
  let field = null;
  let label = '';
  for (const item of items) {
    const placeholder = /\{([^}]+)\}/.exec(item);
    if (!placeholder || placeholder[1] === 'h3_index') continue;
    field = placeholder[1];
    label = item.slice(0, placeholder.index).trim().replace(/:$/, '').trim();
    break;
  }

  const usable = (c) =>
    Array.isArray(c) && c.length >= 3 && c.every((n) => Number.isFinite(n) && n >= 0 && n <= 255);
  const excludedColour = (c) => c[0] === 0 && c[1] === 0 && c[2] === 0 && c[3] === 220;

  const byValue = new Map();
  let min = null;
  let max = null;
  let minColour = null;
  let maxColour = null;
  let excluded = 0;
  let numeric = true;

  for (const row of fill.data) {
    const value = row[field];
    const colour = row._color;
    if (!usable(colour)) continue;
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    if (excludedColour(colour)) {
      excluded += 1;
      continue;
    }
    if (typeof value === 'number') {
      if (min === null || value < min) {
        min = value;
        minColour = colour;
      }
      if (max === null || value > max) {
        max = value;
        maxColour = colour;
      }
    } else {
      numeric = false;
    }
    const key = `${typeof value}:${value}`;
    if (!byValue.has(key)) byValue.set(key, { value, colour });
  }

  const classes = [...byValue.values()];
  return {
    field,
    label,
    numeric,
    excluded,
    min,
    max,
    minColour,
    maxColour,
    distinct: classes.length,
    classes: classes.slice(0, 80),
  };
}

/** What the legend shows. */
function readPanel() {
  const panel = document.getElementById('maphex-legend');
  if (!panel) return null;
  const box = panel.getBoundingClientRect();
  const bar = panel.querySelector('.maphex-legend-bar');
  return {
    hidden: panel.hidden,
    title: document.getElementById('maphex-legend-title').textContent,
    top: Math.round(box.top),
    right: Math.round(window.innerWidth - box.right),
    overlapsOpacity: (() => {
      const other = document.getElementById('maphex-opacity');
      if (!other) return false;
      const b = other.getBoundingClientRect();
      return !(box.bottom <= b.top || box.top >= b.bottom || box.right <= b.left || box.left >= b.right);
    })(),
    rows: [...panel.querySelectorAll('.maphex-legend-row')].map((row) => {
      const swatch = row.querySelector('i');
      const style = getComputedStyle(swatch);
      return {
        label: row.querySelector('span').textContent,
        paint: style.backgroundImage,
        outline: style.boxShadow,
      };
    }),
    scale: [...panel.querySelectorAll('.maphex-legend-scale span')].map((s) => s.textContent),
    ramp: bar ? getComputedStyle(bar).backgroundImage : null,
    note: panel.querySelector('.maphex-legend-note')?.textContent ?? null,
  };
}

/* ── comparing ────────────────────────────────────────────────────────── */

/** Every `rgb(…)`/`rgba(…)` in a computed value, in order. */
function colours(css) {
  return [...(css ?? '').matchAll(/rgba?\(([^)]+)\)/g)].map((m) =>
    m[1].split(',').map((n) => Number(n.trim())),
  );
}

/** The same paint? Channels exactly; alpha is 0–255 on one side, 0–1 on the other. */
function samePaint(css, colour) {
  const found = colours(css)[0];
  if (!found || !colour) return false;
  const alpha = found.length > 3 ? found[3] : 1;
  const want = (colour.length > 3 ? colour[3] : 255) / 255;
  return (
    found[0] === colour[0] &&
    found[1] === colour[1] &&
    found[2] === colour[2] &&
    Math.abs(alpha - want) < 0.01
  );
}

/** A label off the scale against the number it stands for. */
function sameNumber(label, value) {
  const read = Number.parseFloat(label);
  if (!Number.isFinite(read)) return false;
  // The legend rounds to three decimals, or to two significant ones once the
  // number is large or small enough to be written as an exponent.
  return Math.abs(read - value) <= Math.max(0.001, Math.abs(value) * 0.01);
}

/* ── finding layers to look at ────────────────────────────────────────── */

/** Every rendered layer on this machine, the given project's first. */
async function everyLayer(workspace) {
  const found = [];
  const add = (project, nodes) => {
    for (const node of nodes) found.push({ project, node });
  };
  add(workspace.project, workspace.inputs);
  add(workspace.project, modelDocuments(workspace.layers));

  for (const project of await api('/projects')) {
    if (project.id === workspace.project.id) continue;
    let layers;
    try {
      layers = await api(`/projects/${project.id}/layers`);
    } catch {
      continue;
    }
    const inputs = (layers.inputs ?? []).flatMap((node) =>
      node.hasDocument ? [node] : (node.children ?? []).filter((child) => child.hasDocument),
    );
    // Two per project, so a project with sixty layers does not use up the
    // whole budget before the next one is reached.
    add(project, inputs.slice(0, 2));
    add(project, modelDocuments(layers).slice(0, 1));
  }
  return found;
}

/**
 * A guess at what a layer holds, from the front of the document.
 *
 * The engine's palette for classes is opaque (alpha 200) and its ramp is not
 * (alpha 180), so the first few colours say which this is without reading
 * nine megabytes. Only a guess — what is actually checked is read in the
 * page, off all of the data.
 */
async function sniff(url) {
  const response = await fetch(url);
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < SNIFF_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const alphas = new Set(
    [...text.matchAll(/"_color":\s*\[\s*-?\d+,\s*-?\d+,\s*-?\d+,\s*(\d+)/g)].map((m) => m[1]),
  );
  if (!alphas.size) return null;
  return alphas.has('200') ? 'classes' : 'ramp';
}

/* ── documents of our own ─────────────────────────────────────────────── */

/** The injected block, taken from a served document. */
function blockOf(served) {
  const from = served.indexOf('<div id="maphex-opacity"');
  const to = served.lastIndexOf('</html>');
  return from === -1 || to === -1 ? null : served.slice(from, to);
}

/**
 * One of our own documents, read in a page of its own.
 *
 * A page, not this one: `jsonInput` is a top-level `const`, and writing a
 * second document into a realm that already has one is a redeclaration.
 */
async function readSynthetic(browser, errors, html) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(readPanel);
  } finally {
    await page.close();
  }
}

/** A tooltip given as a string is the engine's old text form; an object is
    used as it is (the HTML form, `{ html }`). */
function synthetic(block, layers, tooltip) {
  const tip = typeof tooltip === 'string' ? { text: tooltip } : tooltip;
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>synthetic</title></head>' +
    '<body><div id="deck-container"></div></body><script>\n' +
    `const jsonInput = ${JSON.stringify({ layers })};\n` +
    `const tooltip = ${JSON.stringify(tip)};\n` +
    '</script>' +
    block +
    '</html>'
  );
}

const EXCLUDED = [0, 0, 0, 220];
/** A plausible H3 cell string. Nothing here reads it; the legend is about
    the colour and the value. */
const cell = (i) => `8666${i.toString(16).padStart(4, '0')}fffffff`;

/** A score map with excluded cells, and the ring the MCDA draws on a flag. */
function scoreWithAlert() {
  const scored = [];
  for (let i = 0; i < 60; i += 1) {
    const t = i / 59;
    scored.push({
      _color: [Math.round(255 * t), 50, Math.round(255 * (1 - t)), 180],
      h3_index: cell(i),
      global: 1 + i * 0.05,
      alert: i % 7 === 0,
    });
  }
  for (let i = 60; i < 70; i += 1) {
    scored.push({ _color: EXCLUDED, h3_index: cell(i), global: -1, alert: false });
  }
  return [
    { data: scored, filled: true, getFillColor: '@@=_color' },
    {
      data: scored.filter((row) => row.alert),
      filled: false,
      stroked: true,
      getLineColor: [220, 20, 60, 255],
    },
  ];
}

/** A classified layer: integer codes the engine's legend sidecar names, the
    names in `labels` (`_categoria` before 2026-11-18, `_category` since). */
function classified(labels = '_categoria') {
  const palette = [
    [31, 119, 180, 200],
    [255, 127, 14, 200],
    [44, 160, 44, 200],
  ];
  const names = ['3C', '4A', '4B'];
  return [
    {
      data: Array.from({ length: 30 }, (unused, i) => ({
        _color: palette[i % 3],
        h3_index: cell(i),
        clase: 11 + (i % 3),
        [labels]: names[i % 3],
      })),
    },
  ];
}

/* ── the suite ────────────────────────────────────────────────────────── */

export async function run(workspace) {
  const { check, skip, results } = suite(name);
  if (!workspace.inputs.length) {
    skip('nothing has been processed in this workspace yet');
    return results;
  }

  const { browser, page, errors } = await open({ width: 1200, height: 800 });
  const url = (layer) => `${API}/projects/${layer.project.id}/layers/${layer.node.id}/document`;

  try {
    /* ── layers this machine has ────────────────────────────────────── */

    const wanted = new Map();
    let sniffed = 0;
    for (const layer of await everyLayer(workspace)) {
      if (wanted.size === 2 || sniffed >= SNIFF_LIMIT) break;
      sniffed += 1;
      let kind;
      try {
        kind = await sniff(url(layer));
      } catch {
        continue;
      }
      if (kind && !wanted.has(kind)) wanted.set(kind, layer);
    }

    if (!wanted.size) {
      check('a layer to read', false, 'no served document could be read');
    }

    for (const [kind, layer] of wanted) {
      const what = kind === 'ramp' ? 'a measurement' : 'classes';
      // Nothing here waits on deck.gl: the legend is built from the data the
      // document declares, so it is there before the map draws.
      await page.goto(url(layer), { waitUntil: 'domcontentloaded', timeout: 120000 });

      const data = await page.evaluate(describe);
      const panel = await page.evaluate(readPanel);
      if (!data || !panel) {
        check(`${what}: the document could be read`, false, JSON.stringify({ data: !!data, panel: !!panel }));
        continue;
      }

      check(`${what} (${layer.node.code || layer.node.label}): the legend is there`, !panel.hidden);
      check(`${what}: top right, clear of the opacity control`,
        panel.top < 24 && panel.right < 24 && !panel.overlapsOpacity,
        JSON.stringify({ top: panel.top, right: panel.right, overlaps: panel.overlapsOpacity }));
      check(`${what}: titled with the column the map is of`,
        panel.title === data.label, `${panel.title} vs ${data.label}`);

      const asRamp = data.numeric && data.distinct > 12 && data.min !== data.max;
      if (asRamp) {
        check(`${what}: drawn as a ramp`, panel.ramp !== null);
        check(`${what}: the ends are the data's own ends`,
          panel.scale.length === 3 &&
            sameNumber(panel.scale[0], data.min) &&
            sameNumber(panel.scale[2], data.max),
          `${JSON.stringify(panel.scale)} vs ${data.min}..${data.max}`);
        const stops = colours(panel.ramp);
        check(`${what}: it starts and ends in the colours on the map`,
          stops.length > 1 &&
            samePaint(`rgba(${stops[0].join(',')})`, data.minColour) &&
            samePaint(`rgba(${stops[stops.length - 1].join(',')})`, data.maxColour),
          `${JSON.stringify([stops[0], stops[stops.length - 1]])} vs ` +
            `${JSON.stringify([data.minColour, data.maxColour])}`);
      } else {
        const shown = panel.rows.filter((row) => row.label !== 'Excluded' && row.label !== 'Flagged');
        check(`${what}: one swatch per value`,
          shown.length === data.distinct, `${shown.length} shown, ${data.distinct} in the data`);
        const paints = new Map(data.classes.map((c) => [String(c.value), c.colour]));
        const wrong = shown.filter((row) => !samePaint(row.paint, paints.get(row.label)));
        check(`${what}: each swatch is the colour that value is drawn in`,
          wrong.length === 0, wrong.slice(0, 2).map((row) => row.label).join(', '));
        const labels = shown.map((row) => row.label);
        const inOrder = data.numeric
          ? labels.every((l, i) => i === 0 || Number(labels[i - 1]) <= Number(l))
          : labels.join('|') === [...labels].sort().join('|');
        check(`${what}: listed in order`, inOrder, labels.slice(0, 5).join(', '));
      }

      check(`${what}: the excluded are called out, and only when there are some`,
        panel.rows.some((row) => row.label === 'Excluded') === (data.excluded > 0),
        `${data.excluded} excluded cells`);
    }

    /* ── shapes a model run would produce ───────────────────────────── */

    const first = [...wanted.values()][0];
    const block = first ? blockOf(await (await fetch(url(first))).text()) : null;
    if (!block) {
      check('the block could be taken from a served document', false);
    } else {
      const score = await readSynthetic(browser, errors,
        synthetic(block, scoreWithAlert(), 'global: {global} | alerta: {alert}'));
      check('a score map: the excluded get their own swatch',
        score.rows.some((row) => row.label === 'Excluded' && samePaint(row.paint, EXCLUDED)),
        JSON.stringify(score.rows.map((row) => row.label)));
      check('a score map: and are kept out of the range',
        score.scale.length === 3 && sameNumber(score.scale[0], 1) && sameNumber(score.scale[2], 3.95),
        JSON.stringify(score.scale));
      check('a score map: the ring on a flagged cell is in the legend',
        score.rows.some((row) => row.label === 'Flagged' && row.outline.includes('220, 20, 60')),
        JSON.stringify(score.rows.map((row) => `${row.label}:${row.outline}`)));

      const codes = await readSynthetic(browser, errors,
        synthetic(block, classified(), 'clase: {_categoria}'));
      check('a classified layer: the labels, not the codes',
        codes.rows.map((row) => row.label).join(',') === '3C,4A,4B',
        JSON.stringify(codes.rows.map((row) => row.label)));

      // The tooltip as the engine writes it since 2026-11-18: HTML, one item
      // per line, the H3 cell first and its alert as yes/no. The legend has to
      // skip the cell and title itself with the score, not with the alert.
      const htmlScore = await readSynthetic(browser, errors, synthetic(block, scoreWithAlert(), {
        html: '<b>H3 (res 6):</b> {h3_index}<br/><b>global:</b> {global}<br/><b>alert:</b> {alert}',
        style: { whiteSpace: 'nowrap' },
      }));
      check('an HTML tooltip: titled with the score, not the H3 cell or the alert',
        htmlScore.title === 'global', htmlScore.title);
      check('an HTML tooltip: the ramp is the score\'s',
        htmlScore.scale.length === 3 && sameNumber(htmlScore.scale[0], 1)
          && sameNumber(htmlScore.scale[2], 3.95),
        JSON.stringify(htmlScore.scale));

      const htmlCodes = await readSynthetic(browser, errors, synthetic(block, classified('_category'), {
        html: '<b>H3 (res 6):</b> {h3_index}<br/><b>clase:</b> {_category}',
      }));
      check('an HTML tooltip on a classified layer: the labels, not the codes',
        htmlCodes.title === 'clase' && htmlCodes.rows.map((row) => row.label).join(',') === '3C,4A,4B',
        JSON.stringify({ title: htmlCodes.title, rows: htmlCodes.rows.map((row) => row.label) }));

      // A column that is entirely null reaches the render as NaN and is cast
      // to int, so every channel of every cell is int64's floor. There is no
      // legend to be had from that, and inventing one would be worse than
      // showing none.
      const broken = await readSynthetic(browser, errors, synthetic(block, [{
        data: [{
          _color: [-(2 ** 63), 50, -(2 ** 63), 180],
          h3_index: cell(1),
          value: null,
        }],
      }], 'value: {value}'));
      check('a layer with no usable colour shows no legend', broken.hidden === true);
    }

    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (results.fail) await captureFailure(page, name);
    await browser.close();
  }

  return results;
}
