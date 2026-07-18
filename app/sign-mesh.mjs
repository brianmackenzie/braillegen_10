// sign-mesh.mjs — builds the sign/label solid: plate, visual text, braille.
//
// Layout model (all mm, plate origin bottom-left, y up, z up):
//   - The plate auto-sizes around the content: braille NEVER scales, so when
//     content grows, the PLATE grows. Text/braille block is centered.
//   - Visual text sits above, braille below, separated by `gapTextBraille`
//     (ADA 703.3.2: 9.5 mm minimum, California caps it at 12.7 mm).
//   - Text styles: 'raised' (prisms on the plate), 'recessed' (cavities in a
//     single closed shell), 'flush' (recessed plate + a second inserts mesh
//     whose tops sit level with the plate for two-color printing).
//   - Braille dots are always raised domes, sunk 0.2 mm so the shells fuse.
//
// AGPL-3.0 — part of the BrailleGen fork.

import { MeshBuilder } from './mesh.mjs';
import earcut from './vendor/earcut.mjs';

export const SIGN_DEFAULTS = {
  capHeightMm: 19,             // inside ADA's 15.9–50.8 window
  textRelief: 0.8,             // = 1/32 in, the ADA raised minimum
  gapTextBraille: 11.1,        // 7/16 in, inside the 9.5–12.7 window
  margin: 9.5,                 // keeps raised content 3/8 in from edges
  plateThickness: 3.2,         // 1/8 in
  cornerRadius: 6.4,           // 1/4 in
  // Inch-true California-pinned braille geometry (satisfies federal ranges):
  dotDiameter: 1.55, dotHeight: 0.8, dotPitch: 2.54, cellPitch: 7.62, linePitch: 10.16,
  holeDiameters: { '#6': 3.97, '#8': 4.76, 'M3': 3.4, 'M4': 4.5 },
  holeInset: 9.5,
  fdmHoleCompensation: 0.3,
};

/** Rounded-rectangle ring, counter-clockwise, origin at (0,0). */
function roundedRect(w, h, r, segs = 8) {
  r = Math.max(0, Math.min(r, w / 2 - 0.01, h / 2 - 0.01));
  const pts = [];
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= segs; i++) {
      const a = a0 + (i / segs) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(w - r, r, -Math.PI / 2);
  corner(w - r, h - r, 0);
  corner(r, h - r, Math.PI / 2);
  corner(r, r, Math.PI);
  return pts;
}

function circle(cx, cy, r, segs = 32) {
  const pts = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Flatten rings into earcut's {verts, holes, ringIndex} form. */
function flattenRings(outer, holes) {
  const verts = [];
  const holeIdx = [];
  const rings = [];
  const add = (ring) => {
    const start = verts.length / 2;
    for (const [x, y] of ring) verts.push(x, y);
    rings.push(Array.from({ length: ring.length }, (_, i) => start + i));
    return start;
  };
  add(outer);
  for (const h of holes) holeIdx.push(add(h));
  return { verts, holeIdx, rings };
}

/**
 * A closed plate shell: rounded-rect outline, optional through-holes, and
 * optional glyph CAVITIES recessed `cavityDepth` into the top face.
 * Cavity rings must lie strictly inside the outline and not touch the holes.
 */
function buildPlate(m, w, h, thickness, cornerRadius, screwHoles, cavities, cavityDepth) {
  const outline = roundedRect(w, h, cornerRadius);
  const holes = screwHoles.map(hole => circle(hole.x, hole.y, hole.r).reverse()); // holes clockwise

  // Bottom face: outline + screw holes only (faces down).
  {
    const f = flattenRings(outline, holes);
    const tris = earcut(f.verts, f.holeIdx);
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
      m.tri(f.verts[2 * a], f.verts[2 * a + 1], 0,
            f.verts[2 * c], f.verts[2 * c + 1], 0,
            f.verts[2 * b], f.verts[2 * b + 1], 0);
    }
  }
  // Top face: outline + screw holes + cavity openings (faces up).
  const cavityRings = [];
  for (const cav of cavities) {
    for (const o of cav.outers) {
      cavityRings.push({ ring: o.ring.map(([x, y]) => [x + cav.x, y + cav.y]), inner: o.holes.map(hh => hh.map(([x, y]) => [x + cav.x, y + cav.y])) });
    }
  }
  {
    const topHoles = [...holes, ...cavityRings.map(c => [...c.ring].reverse())];
    const f = flattenRings(outline, topHoles);
    const tris = earcut(f.verts, f.holeIdx);
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
      m.tri(f.verts[2 * a], f.verts[2 * a + 1], thickness,
            f.verts[2 * b], f.verts[2 * b + 1], thickness,
            f.verts[2 * c], f.verts[2 * c + 1], thickness);
    }
  }
  // Outer walls (outline is CCW; walls face outward).
  const wall = (ring, z0, z1, flip = false) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (!flip) m.quad([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]);
      else m.quad([b[0], b[1], z0], [a[0], a[1], z0], [a[0], a[1], z1], [b[0], b[1], z1]);
    }
  };
  wall(outline, 0, thickness);
  for (const hole of holes) wall(hole, 0, thickness);            // CW rings face inward already

  // Cavities: side walls down to the floor, an up-facing floor around any
  // islands, and a top cap on each island (a letter counter like the inside
  // of an O stays at full plate height).
  const zFloor = thickness - cavityDepth;
  const face = (outer, holes, z, up) => {
    const f = flattenRings(outer, holes);
    const tris = earcut(f.verts, f.holeIdx);
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = up ? [tris[i], tris[i + 1], tris[i + 2]]
                           : [tris[i], tris[i + 2], tris[i + 1]];
      m.tri(f.verts[2 * a], f.verts[2 * a + 1], z,
            f.verts[2 * b], f.verts[2 * b + 1], z,
            f.verts[2 * c], f.verts[2 * c + 1], z);
    }
  };
  for (const c of cavityRings) {
    wall([...c.ring].reverse(), zFloor, thickness);              // CW = faces into cavity
    for (const inner of c.inner) {
      wall([...inner].reverse(), zFloor, thickness);             // island sides face outward
      face([...inner].reverse(), [], thickness, true);           // island top cap
    }
    face(c.ring, c.inner, zFloor, true);                         // cavity floor
  }
}

/** Extrude positioned glyph outlines as prisms from z0 to z1. */
function buildGlyphPrisms(m, cavities, z0, z1) {
  for (const cav of cavities) {
    for (const o of cav.outers) {
      const ring = o.ring.map(([x, y]) => [x + cav.x, y + cav.y]);
      const inner = o.holes.map(hh => hh.map(([x, y]) => [x + cav.x, y + cav.y]));
      const f = flattenRings(ring, inner);
      const tris = earcut(f.verts, f.holeIdx);
      // Hole rings arrive clockwise from glyphPolygons; walked in that order
      // their side walls already face out of the solid (into the counter).
      m.prism(f.verts, tris, f.rings, z0, z1);
    }
  }
}

/**
 * Build the sign.
 * @param {object} p - resolved parameters:
 *   textLayouts: [{glyphs, widthMm, capMm}] from fonts.layoutLine (one per line)
 *   lineSpacingMm, brailleLines (unicode braille strings), braille geometry
 *   (dotDiameter/dotHeight/dotPitch/cellPitch/linePitch), textStyle
 *   ('raised'|'recessed'|'flush'), textRelief, gapTextBraille, margin,
 *   plateThickness, cornerRadius, holeLayout ('none'|'2'|'4'), holeDiameter,
 *   holeInset, align ('center'|'left'), plateW/plateH (0 = auto).
 * @returns {{plate: MeshBuilder, inserts: MeshBuilder|null, widthMm, heightMm,
 *            dotCount, warnings: string[]}}
 */
export function buildSign(p) {
  const warnings = [];
  // Lines that are entirely blank cells carry no dots; an all-blank set is no
  // braille at all (otherwise an empty block would still reserve plate space).
  if (p.brailleLines.every(l => l.length === 0)) p = { ...p, brailleLines: [] };
  const eightDot = p.brailleLines.some(l => [...l].some(ch => (ch.codePointAt(0) - 0x2800) & 0xC0));
  const rowsPerCell = eightDot ? 4 : 3;

  // --- content extents ---
  const textW = Math.max(0, ...p.textLayouts.map(l => l.widthMm));
  const textH = p.textLayouts.length
    ? p.textLayouts.length * p.capHeightMm + (p.textLayouts.length - 1) * (p.lineSpacingMm - p.capHeightMm)
    : 0;
  const cellsWide = Math.max(0, ...p.brailleLines.map(l => [...l].length));
  const brailleW = cellsWide > 0 ? (cellsWide - 1) * p.cellPitch + p.dotPitch + p.dotDiameter : 0;
  const cellH = (rowsPerCell - 1) * p.dotPitch + p.dotDiameter;
  const brailleH = p.brailleLines.length
    ? (p.brailleLines.length - 1) * p.linePitch + cellH
    : 0;
  const gap = (textH && brailleH) ? p.gapTextBraille : 0;

  const contentW = Math.max(textW, brailleW);
  const contentH = textH + gap + brailleH;
  // Rounded corners curve inward by r*(1 - 1/sqrt(2)); the margin band must
  // absorb that or letter cavities cross the outline and corrupt the shell.
  const cornerIntrusion = p.cornerRadius * (1 - Math.SQRT1_2);
  const layoutMargin = Math.max(p.margin, cornerIntrusion + 1);
  if (layoutMargin > p.margin + 0.01) {
    warnings.push(`The ${p.cornerRadius} mm corner radius needs about ${layoutMargin.toFixed(1)} mm of margin - the plate grew to keep content clear of the curves.`);
  }
  let w = Math.max(p.plateW || 0, contentW + 2 * layoutMargin);
  let h = Math.max(p.plateH || 0, contentH + 2 * layoutMargin);

  // --- screw holes ---
  const screwHoles = [];
  if (p.holeLayout !== 'none') {
    const r = p.holeDiameter / 2;
    const inset = Math.max(p.holeInset, 2 * p.holeDiameter);
    const needW = contentW + 2 * (inset + r + 2) ;
    if (p.holeLayout === '4' && w < needW) w = Math.max(w, needW);
    if (p.holeLayout === '2') {
      w = Math.max(w, contentW + 2 * (2 * inset));
      screwHoles.push({ x: inset, y: h / 2, r }, { x: w - inset, y: h / 2, r });
    } else {
      h = Math.max(h, contentH + 2 * (inset + r + 2));
      screwHoles.push(
        { x: inset, y: inset, r }, { x: w - inset, y: inset, r },
        { x: inset, y: h - inset, r }, { x: w - inset, y: h - inset, r });
    }
  }

  // --- content placement (top-down: text block, gap, braille block) ---
  const xFor = (blockW) => p.align === 'left' ? layoutMargin : (w - blockW) / 2;
  const topY = h - (h - contentH) / 2;

  const T = p.plateThickness;
  const cavities = [];
  let yCursor = topY;
  for (const line of p.textLayouts) {
    yCursor -= p.capHeightMm;
    const x0 = xFor(line.widthMm);
    for (const g of line.glyphs) cavities.push({ outers: g.outers, x: x0 + g.x, y: yCursor });
    yCursor -= (p.lineSpacingMm - p.capHeightMm);
  }

  const plate = new MeshBuilder();
  const recessDepth = Math.min(p.textRelief, T - 0.8);
  if (p.textStyle === 'raised') {
    buildPlate(plate, w, h, T, p.cornerRadius, screwHoles, [], 0);
    buildGlyphPrisms(plate, cavities, T - 0.2, T + p.textRelief);
  } else {
    buildPlate(plate, w, h, T, p.cornerRadius, screwHoles, cavities, recessDepth);
  }

  let inserts = null;
  if (p.textStyle === 'flush') {
    inserts = new MeshBuilder();
    // Printed separately, flat on the bed; drops into the cavities top-flush.
    buildGlyphPrisms(inserts, cavities, 0, recessDepth);
  }

  // --- braille dots ---
  let dotCount = 0;
  let by = topY - textH - gap;                 // top EDGE of the braille block
  const bx0 = xFor(brailleW);
  for (const line of p.brailleLines) {
    let cellX = bx0 + p.dotDiameter / 2;
    const rowTop = by - p.dotDiameter / 2;      // centre of the top dot row
    for (const ch of line) {
      const mask = ch.codePointAt(0) - 0x2800;
      for (let bit = 0; bit < 8; bit++) {
        if (!(mask & (1 << bit))) continue;
        const col = bit < 6 ? (bit / 3) | 0 : bit - 6;
        const row = bit < 6 ? bit % 3 : 3;
        plate.dot(cellX + col * p.dotPitch, rowTop - row * p.dotPitch,
          T - 0.2, p.dotDiameter / 2, p.dotHeight + 0.2);
        dotCount++;
      }
      cellX += p.cellPitch;
    }
    by -= p.linePitch;
  }

  // --- guardrail warnings (never blocking) ---
  if (p.capHeightMm < 15.9 || p.capHeightMm > 50.8) {
    warnings.push('Raised character height is outside the ADA 703.2 window (5/8"–2", 15.9–50.8 mm).');
  }
  if (p.textStyle !== 'raised' && p.textLayouts.length) {
    warnings.push('Recessed and flush text is not ADA-tactile — ADA 703.2 requires characters raised at least 0.8 mm.');
  }
  if (gap && p.gapTextBraille < 9.5) {
    warnings.push('Text-to-braille separation is under the ADA 703.3.2 minimum of 9.5 mm (3/8").');
  } else if (gap && p.gapTextBraille > 12.7) {
    warnings.push('Text-to-braille separation exceeds 12.7 mm (1/2") — fine federally, but California 11B-703.3.2 caps it there.');
  }
  if (p.textRelief < 0.8 && p.textStyle === 'raised') {
    warnings.push('Raised text under 0.8 mm (1/32") is below the ADA tactile minimum.');
  }
  if (w > p.bedSize || h > p.bedSize) {
    warnings.push(`The plate (${w.toFixed(0)} × ${h.toFixed(0)} mm) exceeds the ${p.bedSize} mm print bed — shorten the text, drop the cap height, or print in sections.`);
  }
  {
    // True clearance test: distance from each hole edge to the content box.
    const cx0 = xFor(contentW), cx1 = cx0 + contentW;
    const cy0 = (h - contentH) / 2, cy1 = cy0 + contentH;
    const tooClose = screwHoles.some(hole => {
      const dx = Math.max(cx0 - hole.x, 0, hole.x - cx1);
      const dy = Math.max(cy0 - hole.y, 0, hole.y - cy1);
      return Math.hypot(dx, dy) < hole.r + 2;
    });
    if (tooClose) warnings.push('A screw hole sits within 2 mm of the text/braille area - enlarge the plate or switch the hole layout.');
  }
  if (eightDot) warnings.push('8-dot braille detected: signage braille is conventionally 6-dot.');

  return { plate, inserts, widthMm: w, heightMm: h, dotCount, warnings };
}
