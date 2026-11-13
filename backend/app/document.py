"""
Serving the engine's rendered layers, with the chrome the engine does not add.

The pipeline writes each layer as a pydeck export: one self-contained HTML
file holding the hexagons inline, a CARTO basemap, and at the end

    const jsonInput = { "layers": [ { "data": [ ... ] } ] };
    const tooltip = {'text': 'poblacion: {poblacion}'};
    const deckInstance = createDeck({container, jsonInput, ...});

Those files are the engine's to write, and re-rendering them to add chrome
would mean a pipeline run for a slider. So it is added on the way out
instead: the file on disk is untouched, and layers rendered months ago get
it too.

Injected rather than overlaid from our side because the document lives in an
iframe. Nothing outside it can reach in to the deck instance, and a slider
drawn over the frame would have nothing to talk to.

Two things are added:

- an opacity slider, bottom right;
- a legend, top right, read off the hexagons the document already carries.

The legend is derived rather than declared. The engine bakes a colour into
every cell (`_color`) and says in the tooltip which column the map is of; it
writes no key. Reading the key back out of the data means every swatch is
the colour that is actually on screen, and that a layer rendered before any
of this existed gets a legend as well.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

#: Read size. These documents run to several megabytes — the hexagons are
#: inlined as JSON — so they are streamed rather than read into memory.
CHUNK = 256 * 1024

#: How much of the end to hold back for the insertion. `</html>` is the last
#: thing in the file; a few kilobytes is room to spare.
TAIL = 8 * 1024

#: The opacity control, appended just before `</html>`.
#:
#: Written as plain ES5 in one closure: it runs inside someone else's
#: document, next to a bundle we do not control, and leaves nothing behind
#: but one element and one listener.
CONTROLS = """
<div id="maphex-opacity" role="group" aria-label="Layer opacity">
  <label for="maphex-opacity-range">Opacity</label>
  <input id="maphex-opacity-range" type="range" min="0" max="100" step="1" value="100" />
  <span id="maphex-opacity-value">100%</span>
</div>
<style>
#maphex-opacity {
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(4px);
  font: 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #3d3a36;
  user-select: none;
}
#maphex-opacity label { letter-spacing: 0.04em; text-transform: uppercase; font-size: 10px; }
#maphex-opacity input { width: 132px; accent-color: #b4502f; }
/* Tabular so the number does not shuffle the row as it changes. */
#maphex-opacity span { min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
@media (prefers-color-scheme: dark) {
  #maphex-opacity { background: rgba(32, 30, 28, 0.92); color: #ece8e1; }
}
</style>
<script>
(function () {
  var range = document.getElementById('maphex-opacity-range');
  var readout = document.getElementById('maphex-opacity-value');
  if (!range) { return; }

  /* `deckInstance` is a top-level `const` in the document's own script, so it
     is a global lexical binding this script can see — but naming it when it
     is missing throws, hence the try. */
  function deck() {
    try { return deckInstance; } catch (error) { return null; }
  }

  /* The deck.gl way: `opacity` multiplies the alpha already in the colours,
     without touching the geometry or recomputing anything. clone() + setProps
     updates one prop rather than rebuilding the layer. */
  function setLayerOpacity(alpha) {
    var instance = deck();
    if (!instance || typeof instance.setProps !== 'function') { return false; }
    var layers = instance.props && instance.props.layers;
    if (!layers || !layers.length || typeof layers[0].clone !== 'function') { return false; }
    instance.setProps({
      layers: layers.map(function (layer) { return layer.clone({ opacity: alpha }); })
    });
    return true;
  }

  /* If the bundle ever stops exposing it, fade deck's own canvas instead —
     and only that one. The basemap is a separate canvas underneath, and
     dimming it as well would wash out the whole picture rather than the
     hexagons sitting on it. */
  function fadeCanvas(alpha) {
    var canvases = document.querySelectorAll('canvas');
    for (var i = 0; i < canvases.length; i += 1) {
      if (canvases[i].className.indexOf('mapboxgl') === -1) {
        canvases[i].style.opacity = alpha;
      }
    }
  }

  function apply() {
    var alpha = Number(range.value) / 100;
    readout.textContent = range.value + '%';
    if (!setLayerOpacity(alpha)) { fadeCanvas(alpha); }
  }

  range.addEventListener('input', apply);
}());
</script>
"""

#: The legend, appended after the opacity control.
#:
#: Reads `jsonInput`, not the deck instance: the data is inlined in the
#: document's own script, so the key is drawn before the CDN bundle has even
#: loaded and does not depend on deck.gl being reachable.
#:
#: The shape of a layer tells us how to describe it. A column with a handful
#: of distinct values is a set of classes and gets one swatch each; a column
#: with more than that is a measurement and gets the ramp, with the numbers
#: at its ends. That is the engine's own rule (render_html treats an integer
#: column with more than 12 distinct values as continuous), applied to what
#: the document holds rather than to the dtype we can no longer see.
LEGEND = """
<div id="maphex-legend" role="group" aria-label="Legend" hidden>
  <div id="maphex-legend-title"></div>
  <div id="maphex-legend-body"></div>
</div>
<style>
#maphex-legend {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 10;
  /* Wide enough that the two ends of a ramp are not printed on top of each
     other, narrow enough to stay out of the map. */
  min-width: 172px;
  max-width: 232px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(4px);
  font: 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #3d3a36;
  user-select: none;
}
/* `display: flex` above would otherwise win over the `hidden` attribute, and
   a layer with nothing to describe would show an empty box. */
#maphex-legend[hidden] { display: none; }
#maphex-legend-title {
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.72;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#maphex-legend-body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  /* A column of place names can run to dozens of classes. Scroll rather than
     grow: the panel sits over the map. */
  max-height: 46vh;
  overflow-y: auto;
}
.maphex-legend-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.maphex-legend-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* White underneath both of these: the engine's colours carry their own alpha
   (180 of 255), so over white they composite here the way they do over the
   basemap. A swatch on the panel's own background would be the wrong colour. */
.maphex-legend-swatch {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background-color: #fff;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);
}
.maphex-legend-bar {
  height: 10px;
  border-radius: 3px;
  background-color: #fff;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);
}
.maphex-legend-scale {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.maphex-legend-scale span { white-space: nowrap; }
.maphex-legend-note { font-size: 10px; opacity: 0.6; }
@media (prefers-color-scheme: dark) {
  #maphex-legend { background: rgba(32, 30, 28, 0.92); color: #ece8e1; }
}
</style>
<script>
(function () {
  /* Up to here a column reads as a set of classes: one swatch per value.
     render_html's own threshold for calling an integer column categorical. */
  var AS_CLASSES = 12;
  /* Ceiling on the classes drawn. Text columns (a department, a typology) can
     run past AS_CLASSES and still be classes, but not without end. */
  var CLASS_CEILING = 60;
  /* Stops sampled out of the data to draw the ramp. */
  var STOPS = 12;
  /* Cells read. Everything the engine renders at map resolution is far under
     this; the cap is only here so a pathological document cannot hang the
     panel before the map has drawn. */
  var SAMPLE = 500000;
  /* The one colour in a continuous layer that is not a measurement: the
     engine paints an excluded cell solid black (render_html._numeric_color). */
  var EXCLUDED = [0, 0, 0, 220];

  var panel = document.getElementById('maphex-legend');
  var titleBox = document.getElementById('maphex-legend-title');
  var body = document.getElementById('maphex-legend-body');
  if (!panel || !body) { return; }

  /* Top-level `const`s in the document's own script: global lexical bindings
     this script can see, but naming one that is missing throws. */
  function inlineJson() {
    try { return jsonInput; } catch (error) { return null; }
  }
  function inlineTooltip() {
    try { return tooltip; } catch (error) { return null; }
  }
  function deck() {
    try { return deckInstance; } catch (error) { return null; }
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function rgba(color) {
    return 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ','
      + Math.round((color[3] / 255) * 1000) / 1000 + ')';
  }

  /* An RGBA of four numbers in range, or null. Not fussiness: a column that is
     entirely null arrives with NaN cast to int, i.e. -9223372036854775808 in
     every channel, and a legend built on that would be an invention. */
  function colorOf(value) {
    if (!value || typeof value.length !== 'number' || value.length < 3) { return null; }
    var out = [];
    for (var i = 0; i < 4; i += 1) {
      var n = i < value.length ? value[i] : 255;
      if (typeof n !== 'number' || !isFinite(n) || n < 0 || n > 255) { return null; }
      out.push(Math.round(n));
    }
    return out;
  }

  function same(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  }

  function fmt(value) {
    if (typeof value !== 'number') { return String(value); }
    if (!isFinite(value)) { return String(value); }
    var size = Math.abs(value);
    if (value === Math.round(value) && size < 1e7) { return String(value); }
    if (size >= 1e7 || (size > 0 && size < 1e-4)) { return value.toExponential(2); }
    return String(Math.round(value * 1000) / 1000);
  }

  /* The layers worth describing: the one that is filled with the colours of
     the measurement, and — on the MCDA's combined map — the outline-only one
     drawn on top of it to flag a cell. */
  function pickLayers() {
    var layers = null;
    var json = inlineJson();
    if (json && json.layers && json.layers.length) {
      layers = json.layers;
    } else {
      var instance = deck();
      var live = instance && instance.props && instance.props.layers;
      if (!live || !live.length) { return null; }
      layers = [];
      for (var k = 0; k < live.length; k += 1) { layers.push(live[k].props || {}); }
    }
    var found = { fill: null, outline: null };
    for (var i = 0; i < layers.length; i += 1) {
      var layer = layers[i] || {};
      var rows = layer.data;
      if (!rows || typeof rows.length !== 'number' || !rows.length) { continue; }
      if (layer.filled === false) {
        if (layer.stroked && colorOf(layer.getLineColor)) { found.outline = layer; }
      } else if (!found.fill) {
        found.fill = layer;
      }
    }
    return found.fill ? found : null;
  }

  /* What the map is of. The tooltip is the engine's own answer — its first
     placeholder names the column the colours came from, and on a classified
     layer it points at the label column rather than at the class codes. */
  function subject(rows) {
    var text = inlineTooltip();
    text = text && text.text;
    if (typeof text === 'string') {
      var placeholder = text.match(/\\{([^}]+)\\}/);
      var head = text.split(':')[0].replace(/^\\s+|\\s+$/g, '');
      if (placeholder && placeholder[1] in rows[0]) {
        return { field: placeholder[1], label: head || placeholder[1] };
      }
    }
    /* No tooltip to go by: the value is the one column that is neither the H3
       cell nor something the render added for itself. */
    var keys = Object.keys(rows[0] || {});
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (key.charAt(0) === '_' || key === 'h3_index') { continue; }
      var value = rows[0][key];
      if (typeof value === 'string' && /^[0-9a-f]{15}$/.test(value)) { continue; }
      return { field: key, label: key };
    }
    return null;
  }

  /* One pass: the range, the distinct values with the colour each is drawn
     in, and how many cells the engine took out of the measurement. */
  function readRows(rows, field) {
    var seen = {};
    var classes = [];
    var read = { classes: classes, excluded: 0, used: 0, numeric: true,
                 min: Infinity, max: -Infinity, overflow: false };
    var count = Math.min(rows.length, SAMPLE);
    for (var i = 0; i < count; i += 1) {
      var row = rows[i];
      if (!row) { continue; }
      var value = row[field];
      var color = colorOf(row._color);
      if (color === null) { continue; }
      /* value !== value catches NaN, which arrives as null in JSON but not
         when the rows are read off a live layer. */
      if (value === null || value === undefined || value !== value) { continue; }
      if (same(color, EXCLUDED)) { read.excluded += 1; continue; }
      read.used += 1;
      if (typeof value === 'number') {
        if (value < read.min) { read.min = value; }
        if (value > read.max) { read.max = value; }
      } else {
        read.numeric = false;
      }
      /* Keyed by type as well, so 1 and "1" are not folded together. */
      var key = (typeof value) + ':' + value;
      if (!Object.prototype.hasOwnProperty.call(seen, key)) {
        if (classes.length >= CLASS_CEILING) {
          read.overflow = true;
        } else {
          seen[key] = true;
          classes.push({ value: value, color: color });
        }
      }
    }
    return read;
  }

  /* The ramp as the data actually draws it: the colour of the cell nearest
     each stop, not the formula we think the engine used. Nearest rather than
     first, so the two ends are the colours of the cells the numbers under
     the bar name. Gaps — a stop no cell landed on — take the nearest filled
     one. */
  function rampStops(rows, field, min, max) {
    var picked = new Array(STOPS);
    var closest = new Array(STOPS);
    var span = max - min;
    var count = Math.min(rows.length, SAMPLE);
    for (var i = 0; i < count; i += 1) {
      var row = rows[i];
      if (!row) { continue; }
      var value = row[field];
      var color = colorOf(row._color);
      if (color === null || typeof value !== 'number' || value !== value) { continue; }
      if (same(color, EXCLUDED)) { continue; }
      var at = span > 0 ? ((value - min) / span) * (STOPS - 1) : 0;
      var slot = Math.round(at);
      var off = Math.abs(at - slot);
      if (!picked[slot] || off < closest[slot]) { picked[slot] = color; closest[slot] = off; }
    }
    var carry = null;
    for (var a = 0; a < STOPS; a += 1) {
      if (picked[a]) { carry = picked[a]; } else if (carry) { picked[a] = carry; }
    }
    carry = null;
    for (var b = STOPS - 1; b >= 0; b -= 1) {
      if (picked[b]) { carry = picked[b]; } else if (carry) { picked[b] = carry; }
    }
    var out = [];
    for (var c = 0; c < STOPS; c += 1) { if (picked[c]) { out.push(rgba(picked[c])); } }
    return out;
  }

  function swatch(color, outlined) {
    var node = el('i', 'maphex-legend-swatch');
    if (outlined) {
      node.style.boxShadow = 'inset 0 0 0 2px ' + rgba(color);
    } else {
      node.style.backgroundImage = 'linear-gradient(' + rgba(color) + ',' + rgba(color) + ')';
    }
    return node;
  }

  function row(color, label, outlined) {
    var node = el('div', 'maphex-legend-row');
    node.appendChild(swatch(color, outlined));
    node.appendChild(el('span', null, label));
    return node;
  }

  var chosen = pickLayers();
  if (!chosen) { return; }
  var rows = chosen.fill.data;
  var of = subject(rows);
  if (!of) { return; }

  var read = readRows(rows, of.field);
  if (!read.used && !read.excluded) { return; }

  /* A single value has no range to draw, so it reads as its own class. */
  var asClasses = !read.numeric
    || (!read.overflow && read.classes.length <= AS_CLASSES)
    || read.min === read.max;

  if (!read.used) {
    /* Everything the layer holds was taken out of the measurement. Saying so
       is the whole of the legend. */
    body.appendChild(row(EXCLUDED, 'Excluded'));
  } else if (asClasses) {
    read.classes.sort(function (a, b) {
      if (read.numeric) { return a.value - b.value; }
      var x = String(a.value);
      var y = String(b.value);
      return x < y ? -1 : (x > y ? 1 : 0);
    });
    for (var i = 0; i < read.classes.length; i += 1) {
      body.appendChild(row(read.classes[i].color, fmt(read.classes[i].value)));
    }
    if (read.overflow) {
      body.appendChild(el('div', 'maphex-legend-note',
        'More classes than fit — the first ' + read.classes.length + ' are listed.'));
    }
  } else {
    var stops = rampStops(rows, of.field, read.min, read.max);
    if (stops.length < 2) { return; }
    var bar = el('div', 'maphex-legend-bar');
    bar.style.backgroundImage = 'linear-gradient(to right,' + stops.join(',') + ')';
    body.appendChild(bar);
    var scale = el('div', 'maphex-legend-scale');
    scale.appendChild(el('span', null, fmt(read.min)));
    scale.appendChild(el('span', null, fmt(read.min + (read.max - read.min) / 2)));
    scale.appendChild(el('span', null, fmt(read.max)));
    body.appendChild(scale);
  }

  if (read.used && read.excluded) {
    body.appendChild(row(EXCLUDED, 'Excluded'));
  }
  if (chosen.outline) {
    /* The MCDA's combined map draws the score and rings the cells it flags.
       The ring is the second thing on screen and needs saying. */
    body.appendChild(row(colorOf(chosen.outline.getLineColor), 'Flagged', true));
  }

  titleBox.textContent = of.label;
  panel.hidden = false;
}());
</script>
"""

#: Everything added on the way out, in the order it is read on screen.
BLOCK = CONTROLS + LEGEND


def _insert(tail: bytes) -> bytes:
    """
    Put the chrome in the last chunk, before the document closes.

    pydeck closes `</body>` *before* its own script, so the script block sits
    between `</body>` and `</html>` and `</html>` is the only anchor that is
    reliably after it — which is also what the legend needs, since it reads
    the data the document declares in that script. A document missing one
    gets the chrome appended, which parses the same.
    """
    marker = b"</html>"
    block = BLOCK.encode("utf-8")
    at = tail.lower().rfind(marker)
    if at == -1:
        return tail + block
    return tail[:at] + block + tail[at:]


def with_controls(path: Path) -> Iterator[bytes]:
    """
    The document, streamed, with the opacity control and the legend added.

    Only the last few kilobytes are ever held, so a nine-megabyte layer costs
    one chunk of memory rather than nine megabytes of it.
    """
    with path.open("rb") as document:
        held = b""
        while True:
            chunk = document.read(CHUNK)
            if not chunk:
                break
            held += chunk
            if len(held) > TAIL:
                yield held[:-TAIL]
                held = held[-TAIL:]
        yield _insert(held)
