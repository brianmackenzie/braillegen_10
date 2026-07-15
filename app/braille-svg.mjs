// braille-svg.mjs — render Unicode braille to physically-accurate SVG.
//
// The dot layout math intentionally mirrors main.cpp's plate math so the SVG,
// the on-screen preview, and the STL are the same geometry:
//   line depth  = dotPitch * (rowsPerCell - 1) + dotDiameter + lineSpacing
//   plate width = 2*margin + cellPitch * (cells - 1) + dotPitch + dotDiameter
// All units are millimetres; the SVG sets width/height in mm with a matching
// viewBox, so Inkscape / LightBurn / Illustrator import at true scale.
//
// AGPL-3.0 — part of the BrailleGen fork.

/** Unicode braille codepoint -> dot bitmask (bit 0..7 = dot 1..8). */
export function brailleDots(ch) {
  const cp = ch.codePointAt(0);
  return cp >= 0x2800 && cp <= 0x28FF ? cp - 0x2800 : 0;
}

/** True if any cell in the lines uses dot 7 or 8. */
export function hasEightDot(lines) {
  for (const line of lines) {
    for (const ch of line) {
      if (brailleDots(ch) & 0xC0) return true;
    }
  }
  return false;
}

/**
 * Dot centre positions for one cell, in cell-local mm.
 * col 0 = dots 1,2,3(,7); col 1 = dots 4,5,6(,8). Row 3 exists only in 8-dot.
 */
function* cellDots(mask, rowsPerCell, dotPitch, r) {
  for (let col = 0; col < 2; col++) {
    for (let row = 0; row < rowsPerCell; row++) {
      const bit = row < 3 ? col * 3 + row : 6 + col;
      const present = (mask & (1 << bit)) !== 0;
      yield { col, row, present, cx: col * dotPitch + r, cy: row * dotPitch + r };
    }
  }
}

export const SVG_DEFAULTS = {
  dotDiameter: 1.6,   // mm — dot base diameter
  dotPitch: 2.34,     // mm — dot-to-dot within a cell
  cellPitch: 6.2,     // mm — cell-to-cell (corresponding dots)
  lineSpacing: 3.72,  // mm — extra gap between line strips (matches STL param)
  margin: 4,          // mm — border around the dot field
  mirrored: false,    // true = horizontally flipped (back-side embossing template)
  emptyDots: 'none',  // 'none' | 'outline' — show absent dot positions faintly
  drillCenters: false,// true = add centre cross-marks (raster-bead / drill workflows)
  dotColor: '#000000',
  background: 'none', // 'none' | any CSS color
  labelText: '',      // source text, embedded in <desc> for accessibility
};

/**
 * Render wrapped braille lines to an SVG document string.
 * @param {string[]} lines - Unicode braille lines (already wrapped).
 * @param {object} options - see SVG_DEFAULTS.
 * @returns {{svg: string, widthMm: number, heightMm: number, cells: number}}
 */
export function brailleToSvg(lines, options = {}) {
  const o = { ...SVG_DEFAULTS, ...options };
  const rowsPerCell = hasEightDot(lines) ? 4 : 3;
  const r = o.dotDiameter / 2;

  const longest = Math.max(1, ...lines.map(l => [...l].length));
  const lineDepth = o.dotPitch * (rowsPerCell - 1) + o.dotDiameter + o.lineSpacing;

  const widthMm = 2 * o.margin + o.cellPitch * (longest - 1) + o.dotPitch + o.dotDiameter;
  const heightMm = 2 * o.margin + Math.max(1, lines.length) * lineDepth - o.lineSpacing;

  const fmt = (n) => +n.toFixed(4);

  const filled = [];
  const empty = [];
  const crosses = [];
  let cellCount = 0;

  lines.forEach((line, li) => {
    const chars = [...line];
    chars.forEach((ch, ci) => {
      const mask = brailleDots(ch);
      cellCount++;
      const cellX = o.margin + ci * o.cellPitch;
      const cellY = o.margin + li * lineDepth;
      for (const d of cellDots(mask, rowsPerCell, o.dotPitch, r)) {
        let cx = cellX + d.cx;
        const cy = cellY + d.cy;
        if (o.mirrored) cx = widthMm - cx;
        if (d.present) {
          filled.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}"/>`);
          if (o.drillCenters) {
            const c = Math.min(0.4, r * 0.6);
            crosses.push(
              `<path d="M ${fmt(cx - c)} ${fmt(cy)} H ${fmt(cx + c)} M ${fmt(cx)} ${fmt(cy - c)} V ${fmt(cy + c)}"/>`
            );
          }
        } else if (o.emptyDots === 'outline') {
          empty.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}"/>`);
        }
      }
    });
  });

  const esc = (s) => String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

  const descParts = [];
  if (o.labelText) descParts.push(`Source text: ${o.labelText}`);
  descParts.push(`Braille: ${lines.join(' / ')}`);
  descParts.push(`${lines.length} line(s), ${cellCount} cell(s). ` +
    `Dot diameter ${o.dotDiameter} mm, dot pitch ${o.dotPitch} mm, cell pitch ${o.cellPitch} mm.` +
    (o.mirrored ? ' Mirrored for back-side embossing.' : ''));

  const bg = o.background && o.background !== 'none'
    ? `\n <rect width="${fmt(widthMm)}" height="${fmt(heightMm)}" fill="${esc(o.background)}"/>`
    : '';
  const emptyGroup = empty.length
    ? `\n <g fill="none" stroke="${esc(o.dotColor)}" stroke-opacity="0.25" stroke-width="0.1">\n  ${empty.join('\n  ')}\n </g>`
    : '';
  const crossGroup = crosses.length
    ? `\n <g fill="none" stroke="#ffffff" stroke-width="0.15">\n  ${crosses.join('\n  ')}\n </g>`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(widthMm)}mm" height="${fmt(heightMm)}mm" viewBox="0 0 ${fmt(widthMm)} ${fmt(heightMm)}" role="img" aria-labelledby="bg-title bg-desc">
 <title id="bg-title">Braille${o.labelText ? `: ${esc(o.labelText)}` : ''}</title>
 <desc id="bg-desc">${esc(descParts.join(' '))}</desc>${bg}${emptyGroup}
 <g fill="${esc(o.dotColor)}">
  ${filled.join('\n  ')}
 </g>${crossGroup}
</svg>
`;

  return { svg, widthMm: fmt(widthMm), heightMm: fmt(heightMm), cells: cellCount };
}
