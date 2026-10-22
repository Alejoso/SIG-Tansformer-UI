"""
Serving the engine's rendered layers, with a control the engine does not add.

The pipeline writes each layer as a pydeck export: one self-contained HTML
file holding the hexagons inline, a CARTO basemap, and at the end

    const deckInstance = createDeck({container, jsonInput, ...});

Those files are the engine's to write, and re-rendering them to add a control
would mean a pipeline run for a slider. So the control is added on the way
out instead: the file on disk is untouched, and layers rendered months ago
get it too.

Injected rather than overlaid from our side because the document lives in an
iframe. Nothing outside it can reach in to the deck instance, and a slider
drawn over the frame would have nothing to talk to.
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

#: The control, appended just before `</html>`.
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


def _insert(tail: bytes) -> bytes:
    """
    Put the control in the last chunk, before the document closes.

    pydeck closes `</body>` *before* its own script, so the script block sits
    between `</body>` and `</html>` and `</html>` is the only anchor that is
    reliably after it. A document missing one gets the control appended,
    which parses the same.
    """
    marker = b"</html>"
    block = CONTROLS.encode("utf-8")
    at = tail.lower().rfind(marker)
    if at == -1:
        return tail + block
    return tail[:at] + block + tail[at:]


def with_opacity_control(path: Path) -> Iterator[bytes]:
    """
    The document, streamed, with the control added at the end.

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
