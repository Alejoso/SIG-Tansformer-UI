/*
 * HexMap — a small canvas renderer for the mockups.
 *
 * Draws Colombia as real H3 cells (h3-js, resolution 5 by default) with a
 * made-up but plausible score per criterion, so every direction shows the
 * same "Vento" result. The scores are SAMPLE DATA: wind is strongest in La
 * Guajira, the Amazon and the páramos are environmentally restricted, and
 * conflict zones pull the social score down. Nothing here comes from the
 * engine; in the real app the map stays the engine's pydeck document.
 */
(function () {
  const CRITERIA = ['ambiental', 'social', 'socioeconomica', 'tecnica'];

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
  }
  const bump = (lat, lng, cLat, cLng, r) => Math.exp(-(((lat - cLat) ** 2) + ((lng - cLng) ** 2)) / (2 * r * r));
  const clamp = (v) => Math.max(1, Math.min(5, v));

  function scores(lat, lng, id) {
    const n = (hash(id) - 0.5) * 0.7;
    const wave = Math.sin(lat * 1.7) * Math.cos(lng * 1.3) * 0.35;
    const tecnica = clamp(1.4 + 3.4 * bump(lat, lng, 11.6, -72.2, 1.1) + 1.4 * bump(lat, lng, 10.4, -75.3, 1.4)
      + 0.8 * bump(lat, lng, 5.5, -71.5, 2.5) + wave + n);
    const ambiental = clamp(3.6 - 2.4 * bump(lat, lng, 0.5, -71.5, 3.2) - 1.6 * bump(lat, lng, 4.8, -74.6, 1.1)
      - 1.2 * bump(lat, lng, 2.0, -77.6, 1.3) + 1.2 * bump(lat, lng, 11.6, -72.2, 1.2) + n * 0.8);
    const social = clamp(3.4 - 1.8 * bump(lat, lng, 8.6, -73.0, 0.9) - 1.7 * bump(lat, lng, 2.4, -77.2, 1.2)
      - 0.9 * bump(lat, lng, 7.0, -76.4, 0.9) + 0.6 * bump(lat, lng, 4.6, -74.1, 1.5) + wave * 0.6 + n);
    const socioeconomica = clamp(1.8 + 2.2 * bump(lat, lng, 6.2, -75.6, 1.2) + 2.0 * bump(lat, lng, 4.6, -74.1, 1.3)
      + 1.6 * bump(lat, lng, 10.9, -74.8, 1.1) + 1.0 * bump(lat, lng, 3.4, -76.5, 1.0) + n);
    const total = 0.25 * (ambiental + social + socioeconomica + tecnica);
    return { ambiental, social, socioeconomica, tecnica, total };
  }

  /** All cells inside Colombia with their scores. Cached across instances. */
  let CACHE = null;
  function cells(res) {
    if (CACHE && CACHE.res === res) return CACHE.list;
    const ring = window.GEO.Colombia[0].map(([lng, lat]) => [lat, lng]);
    const ids = h3.polygonToCells(ring, res);
    const list = ids.map((id) => {
      const [lat, lng] = h3.cellToLatLng(id);
      const boundary = h3.cellToBoundary(id);
      return { id, lat, lng, boundary, s: scores(lat, lng, id) };
    });
    CACHE = { res, list };
    return list;
  }

  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function ramp(stops) {
    const rgb = stops.map(hexToRgb);
    return (t) => {
      t = Math.max(0, Math.min(1, t));
      const x = t * (rgb.length - 1), i = Math.min(rgb.length - 2, Math.floor(x)), f = x - i;
      const a = rgb[i], b = rgb[i + 1];
      return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
    };
  }

  class HexMap {
    constructor(canvas, opts) {
      this.c = canvas; this.ctx = canvas.getContext('2d');
      this.o = Object.assign({
        res: 5, field: 'total', ramp: ['#f2efe6', '#0f5257'], land: '#e9e6dc', neighbours: '#e2dfd5',
        neighbourStroke: '#d3cfc3', water: 'transparent', cellStroke: null, selectStroke: '#111',
        padding: 40, offsetX: 0, labels: [], labelColor: '#555', filter: null,
      }, opts);
      this.colour = ramp(this.o.ramp);
      this.list = cells(this.o.res);
      this.zoom = 1; this.panX = 0; this.panY = 0; this.selected = null; this.hover = null;
      this._bind(); this.resize();
      new ResizeObserver(() => this.resize()).observe(canvas);
    }
    set(field) { this.o.field = field; this.draw(); }
    setRamp(stops) { this.o.ramp = stops; this.colour = ramp(stops); this.draw(); }
    setFilter(fn) { this.o.filter = fn; this.draw(); }
    resize() {
      const r = this.c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      if (!r.width) return;
      this.c.width = r.width * d; this.c.height = r.height * d; this.w = r.width; this.h = r.height;
      this.ctx.setTransform(d, 0, 0, d, 0, 0);
      // Fit Colombia's box into the area right of offsetX.
      const lng0 = -79.5, lng1 = -66.6, lat0 = -4.4, lat1 = 12.6, k = Math.cos(4 * Math.PI / 180);
      const pw = this.w - this.o.offsetX - this.o.padding * 2, ph = this.h - this.o.padding * 2;
      this.base = Math.min(pw / ((lng1 - lng0) * k), ph / (lat1 - lat0));
      this.k = k;
      this.cx = this.o.offsetX + this.o.padding + pw / 2; this.cy = this.o.padding + ph / 2;
      this.mid = [(lng0 + lng1) / 2, (lat0 + lat1) / 2];
      this.draw();
    }
    px(lng, lat) {
      const s = this.base * this.zoom;
      return [this.cx + this.panX + (lng - this.mid[0]) * this.k * s, this.cy + this.panY - (lat - this.mid[1]) * s];
    }
    ring(ctx, pts, latFirst) {
      pts.forEach((p, i) => { const [x, y] = latFirst ? this.px(p[1], p[0]) : this.px(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
    }
    draw() {
      const ctx = this.ctx; if (!this.w) return;
      ctx.clearRect(0, 0, this.w, this.h);
      for (const name of ['Venezuela', 'Ecuador', 'Peru', 'Brazil', 'Panama']) {
        for (const r of window.GEO[name]) {
          ctx.beginPath(); this.ring(ctx, r); ctx.fillStyle = this.o.neighbours; ctx.fill();
          ctx.strokeStyle = this.o.neighbourStroke; ctx.lineWidth = 1; ctx.stroke();
        }
      }
      const f = this.o.field, [lo, hi] = this.domain();
      for (const cell of this.list) {
        const v = cell.s[f];
        ctx.beginPath(); this.ring(ctx, cell.boundary, true);
        const dim = this.o.filter && !this.o.filter(cell);
        ctx.fillStyle = dim ? this.o.land : this.colour((v - lo) / (hi - lo));
        ctx.fill();
        if (this.o.cellStroke && this.zoom > 1.6) { ctx.strokeStyle = this.o.cellStroke; ctx.lineWidth = 0.5; ctx.stroke(); }
      }
      for (const cell of [this.hover, this.selected]) {
        if (!cell) continue;
        ctx.beginPath(); this.ring(ctx, cell.boundary, true);
        ctx.strokeStyle = this.o.selectStroke; ctx.lineWidth = cell === this.selected ? 2.5 : 1.5; ctx.stroke();
      }
      ctx.font = `500 12px "${this.o.labelFont || 'system-ui'}", sans-serif`; ctx.fillStyle = this.o.labelColor;
      for (const l of this.o.labels) {
        const [x, y] = this.px(l.lng, l.lat);
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
        if (this.o.labelHalo) { ctx.save(); ctx.strokeStyle = this.o.labelHalo; ctx.lineWidth = 3.5; ctx.lineJoin = 'round'; ctx.strokeText(l.name, x + 6, y + 4); ctx.restore(); }
        ctx.fillText(l.name, x + 6, y + 4);
      }
    }
    /** Colour is stretched to the range present in the field (2nd–98th percentile). */
    domain() {
      const vals = this.list.map((c) => c.s[this.o.field]).sort((a, b) => a - b);
      return [vals[Math.floor(vals.length * 0.02)], vals[Math.floor(vals.length * 0.98)]];
    }
    colourOf(v) { const [lo, hi] = this.domain(); return this.colour((v - lo) / (hi - lo)); }
    pick(x, y) {
      const s = this.base * this.zoom;
      const lng = (x - this.cx - this.panX) / (this.k * s) + this.mid[0];
      const lat = -(y - this.cy - this.panY) / s + this.mid[1];
      try {
        const id = h3.latLngToCell(lat, lng, this.o.res);
        return this.list.find((c) => c.id === id) || null;
      } catch { return null; }
    }
    _bind() {
      let drag = null;
      this.c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = this.c.getBoundingClientRect(), mx = e.clientX - r.left - this.cx, my = e.clientY - r.top - this.cy;
        const z = Math.max(0.8, Math.min(8, this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))), f = z / this.zoom;
        this.panX = mx - (mx - this.panX) * f; this.panY = my - (my - this.panY) * f; this.zoom = z; this.draw();
      }, { passive: false });
      this.c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY, moved: false }; });
      window.addEventListener('pointerup', (e) => {
        if (drag && !drag.moved) {
          const r = this.c.getBoundingClientRect();
          const cell = this.pick(e.clientX - r.left, e.clientY - r.top);
          if (cell && e.target === this.c) { this.selected = cell; this.draw(); this.o.onSelect && this.o.onSelect(cell); }
        }
        drag = null;
      });
      this.c.addEventListener('pointermove', (e) => {
        const r = this.c.getBoundingClientRect();
        if (drag) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
          this.panX = drag.px + dx; this.panY = drag.py + dy; this.draw(); return;
        }
        const cell = this.pick(e.clientX - r.left, e.clientY - r.top);
        if (cell !== this.hover) { this.hover = cell; this.draw(); }
        this.o.onHover && this.o.onHover(cell, e.clientX - r.left, e.clientY - r.top);
      });
      this.c.addEventListener('pointerleave', () => { this.hover = null; this.draw(); this.o.onHover && this.o.onHover(null); });
    }
    zoomBy(f) { this.zoom = Math.max(0.8, Math.min(8, this.zoom * f)); this.draw(); }
    reset() { this.zoom = 1; this.panX = 0; this.panY = 0; this.draw(); }
  }

  /** Counts of cells per 0.25-wide score bin, for histograms. */
  function histogram(field, bins = 16) {
    const out = new Array(bins).fill(0);
    for (const c of cells(5)) out[Math.min(bins - 1, Math.floor(((c.s[field] - 1) / 4) * bins))]++;
    return out;
  }

  const CITIES = [
    { name: 'Bogotá', lat: 4.71, lng: -74.07 }, { name: 'Medellín', lat: 6.24, lng: -75.58 },
    { name: 'Cali', lat: 3.45, lng: -76.53 }, { name: 'Barranquilla', lat: 10.96, lng: -74.80 },
    { name: 'Riohacha', lat: 11.54, lng: -72.91 }, { name: 'Leticia', lat: -4.2, lng: -69.94 },
  ];

  window.HexMap = HexMap; window.HexData = { cells, histogram, CRITERIA, CITIES, ramp };
})();
