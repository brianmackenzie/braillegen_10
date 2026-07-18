// fonts.mjs — font registry, loading, and glyph-outline extraction for the
// sign maker.
//
// The bundled faces are all SIL Open Font License 1.1 with no Reserved Font
// Names (see assets/fonts/geometry/OFL-*.txt). Arial itself cannot be
// redistributed (it is Monotype's), so the Arial-compatible metric twin
// Arimo stands in for it, labeled as such.
//
// Glyph outlines become polygons here: bezier curves are flattened to short
// chords, then each contour is classified as an outer boundary or a hole by
// signed area and containment — NEVER by the font format's nominal winding
// convention, which real fonts routinely violate.
//
// AGPL-3.0 — part of the BrailleGen fork.

import * as opentype from './vendor/opentype.mjs';

const BASE = new URL('..', import.meta.url);

export const FONTS = {
  'atkinson-700': { name: 'Atkinson Hyperlegible Bold', file: 'atkinson-700.ttf' },
  'atkinson-400': { name: 'Atkinson Hyperlegible Regular', file: 'atkinson-400.ttf' },
  'arimo-700': { name: 'Arimo Bold (Arial-compatible)', file: 'arimo-700.ttf' },
  'arimo-400': { name: 'Arimo Regular (Arial-compatible)', file: 'arimo-400.ttf' },
  'jbmono-700': { name: 'JetBrains Mono Bold (monospace)', file: 'jbmono-700.ttf' },
};
export const DEFAULT_FONT = 'atkinson-400';

const cache = new Map();   // id -> Promise<opentype.Font>

export function loadFont(id) {
  if (!FONTS[id]) return Promise.reject(new Error(`Unknown font: ${id}`));
  if (!cache.has(id)) {
    const p = (async () => {
      const url = new URL(`assets/fonts/geometry/${FONTS[id].file}`, BASE);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${FONTS[id].file}`);
      return opentype.parse(await res.arrayBuffer());
    })();
    p.catch(() => cache.delete(id));   // failed loads are retryable
    cache.set(id, p);
  }
  return cache.get(id);
}

/** Cap height in font units, with a sensible fallback for fonts without OS/2. */
function capHeightUnits(font) {
  const os2 = font.tables?.os2;
  if (os2 && Number.isFinite(os2.sCapHeight) && os2.sCapHeight > 0) return os2.sCapHeight;
  // Measure the letter H directly as the fallback.
  const h = font.charToGlyph('H');
  if (h && h.getMetrics) {
    const m = h.getMetrics();
    if (Number.isFinite(m.yMax) && m.yMax > 0) return m.yMax;
  }
  return font.unitsPerEm * 0.7;
}

/** Flatten one glyph path's commands into closed contours of [x, y] points. */
function flattenCommands(commands, scale, tol) {
  const contours = [];
  let cur = null;
  let sx = 0, sy = 0, px = 0, py = 0;
  const push = (x, y) => cur.push([x * scale, y * scale]);   // font units are y-up, like the plate
  const seg = (steps, fx, fy) => {
    for (let i = 1; i <= steps; i++) { const t = i / steps; push(fx(t), fy(t)); }
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        if (cur && cur.length > 2) contours.push(cur);
        cur = [];
        push(c.x, c.y); sx = c.x; sy = c.y; px = c.x; py = c.y;
        break;
      case 'L': push(c.x, c.y); px = c.x; py = c.y; break;
      case 'Q': {
        const { x1, y1, x, y } = c;
        const d = Math.hypot(x - px, y - py) + Math.hypot(x1 - px, y1 - py);
        const steps = Math.max(2, Math.min(32, Math.ceil(Math.sqrt(d * scale / tol))));
        const [ax, ay] = [px, py];
        seg(steps,
          t => (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * x1 + t * t * x,
          t => (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * y1 + t * t * y);
        px = x; py = y; break;
      }
      case 'C': {
        const { x1, y1, x2, y2, x, y } = c;
        const d = Math.hypot(x1 - px, y1 - py) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2);
        const steps = Math.max(3, Math.min(48, Math.ceil(Math.sqrt(d * scale / tol) * 1.3)));
        const [ax, ay] = [px, py];
        seg(steps,
          t => (1 - t) ** 3 * ax + 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3 * x,
          t => (1 - t) ** 3 * ay + 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3 * y);
        px = x; py = y; break;
      }
      case 'Z':
        if (cur) {
          const pts = dedupe(cur);
          if (pts.length > 2) contours.push(pts);
          cur = null;
        }
        px = sx; py = sy; break;
    }
  }
  if (cur) {
    const pts = dedupe(cur);
    if (pts.length > 2) contours.push(pts);
  }
  return contours;
}

// Curve joints emit their shared on-curve point twice; identical consecutive
// points collapse extrusion side quads into degenerate slivers, so contours
// are deduplicated (including the closing wrap-around) before use.
function dedupe(pts, eps = 1e-4) {
  const out = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev[0] - p[0]) > eps || Math.abs(prev[1] - p[1]) > eps) out.push(p);
  }
  while (out.length > 1) {
    const [fx, fy] = out[0];
    const [lx, ly] = out[out.length - 1];
    if (Math.abs(fx - lx) <= eps && Math.abs(fy - ly) <= eps) out.pop();
    else break;
  }
  return out;
}

const signedArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

function pointInPolygon(pt, poly) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Extract a glyph's outline as { outers: [{ring, holes: [ring]}] } at the
 * requested scale, with outers counter-clockwise and holes clockwise.
 * Classification is geometric (area + containment depth), not format-based.
 */
export function glyphPolygons(font, glyph, scale, tol = 0.02) {
  const contours = flattenCommands(glyph.path.commands, scale, tol)
    .map(pts => ({ pts, area: signedArea(pts) }))
    .filter(c => Math.abs(c.area) > 1e-4);

  // Containment depth: even depth = outer boundary, odd = hole.
  for (const c of contours) {
    let depth = 0;
    for (const other of contours) {
      if (other === c) continue;
      if (Math.abs(other.area) > Math.abs(c.area) && pointInPolygon(c.pts[0], other.pts)) depth++;
    }
    c.depth = depth;
  }

  const outers = [];
  for (const c of contours.filter(c => c.depth % 2 === 0)) {
    if (c.area < 0) c.pts.reverse();               // outers counter-clockwise
    outers.push({ ring: c.pts, holes: [] });
  }
  for (const c of contours.filter(c => c.depth % 2 === 1)) {
    if (c.area > 0) c.pts.reverse();               // holes clockwise
    // attach to the smallest containing outer
    let best = null;
    for (const o of outers) {
      if (pointInPolygon(c.pts[0], o.ring)
        && (!best || Math.abs(signedArea(o.ring)) < Math.abs(signedArea(best.ring)))) best = o;
    }
    (best ?? outers[0])?.holes.push(c.pts);
  }
  return outers;
}

/**
 * Lay out one line of text at a given cap height.
 * @returns {{glyphs: {outers, x}[], widthMm: number, capMm: number,
 *            strokePct: number|null, oiPct: number|null}}
 * strokePct / oiPct feed the ADA character checks (stroke and O-width ratios).
 */
export function layoutLine(font, text, capHeightMm, letterSpacingMm = 0, tol = 0.02) {
  const scale = capHeightMm / capHeightUnits(font);
  const glyphs = [];
  let x = 0;
  let prev = null;
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    if (prev) x += font.getKerningValue(prev, glyph) * scale;
    if (ch !== ' ' && ch !== ' ') {
      const outers = glyphPolygons(font, glyph, scale, tol);
      // Tight horizontal bounds (relative to the pen position) - the ADA
      // character-spacing check measures gaps between these, not advances.
      let bMin = Infinity, bMax = -Infinity;
      for (const o of outers) for (const [px2] of o.ring) {
        if (px2 < bMin) bMin = px2;
        if (px2 > bMax) bMax = px2;
      }
      glyphs.push({ outers, x, ch, bbox: bMax > bMin ? [bMin, bMax] : null });
    }
    x += glyph.advanceWidth * scale + letterSpacingMm;
    prev = glyph;
  }
  const widthMm = Math.max(0, x - letterSpacingMm);

  // ADA character metrics, measured from real glyphs. Stroke width is the
  // uppercase I's stem measured at HALF cap height (its bounding box would
  // count Atkinson's legibility crossbars); the proportion check is the
  // uppercase O's width against the I's cap height.
  let strokePct = null, oiPct = null;
  try {
    const cap = capHeightUnits(font);
    const oM = font.charToGlyph('O').getMetrics();
    if (oM && Number.isFinite(oM.xMax)) oiPct = ((oM.xMax - oM.xMin) / cap) * 100;
    const iOuters = glyphPolygons(font, font.charToGlyph('I'), 1, cap / 200);
    const yMid = cap / 2;
    let lo = Infinity, hi = -Infinity;
    for (const o of iOuters) {
      const pts = o.ring;
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        if ((y1 > yMid) !== (y2 > yMid)) {
          const x = x1 + ((yMid - y1) / (y2 - y1)) * (x2 - x1);
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
      }
    }
    if (hi > lo) strokePct = ((hi - lo) / cap) * 100;
  } catch { /* metrics stay null when a glyph is missing */ }
  return { glyphs, widthMm, capMm: capHeightMm, strokePct, oiPct };
}
