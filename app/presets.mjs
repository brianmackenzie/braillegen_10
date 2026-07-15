// presets.mjs — braille dimensional standards, clamps, and validation.
//
// Sources: ADA 2010 Table 703.3.1, California CBC 11B-703.3.1, BANA/Library
// of Congress Spec 800 "Size and Spacing of Braille Characters", Marburg
// Medium / UKAAF B008, ISO 17049, and Perkins/RNIB jumbo geometry.
//
// All mm. `linePitch` is line-to-line distance (the standard number); the
// engine's line_spacing parameter is the extra gap and is derived as
// linePitch - (2*dotPitch + dotDiameter). For 8-dot content the engine grows
// the cell by one dot pitch automatically, preserving the gap.
//
// Dot HEIGHT defaults are biased +0.1 mm for FDM printing (measured prints
// undershoot designed height; see docs). AGPL-3.0 — part of the BrailleGen fork.

export const PRESETS = {
  'ada': {
    name: 'ADA signage (US)',
    dotDiameter: 1.5, dotHeight: 0.7, dotPitch: 2.4, cellPitch: 6.2, linePitch: 10.1,
    note: 'Within ADA 2010 §703.3.1 ranges; dot height biased up for FDM printing.',
  },
  'california': {
    name: 'California CBC (Title 24)',
    dotDiameter: 1.6, dotHeight: 0.7, dotPitch: 2.5, cellPitch: 7.6, linePitch: 10.2,
    note: 'CBC 11B-703.3.1 pins the ADA maxima. ADA-preset signs are NOT automatically California-compliant.',
  },
  'bana': {
    name: 'BANA / Library of Congress (paper feel)',
    dotDiameter: 1.44, dotHeight: 0.48, dotPitch: 2.34, cellPitch: 6.2, linePitch: 10.16,
    note: 'Embossed-paper geometry (Library of Congress Specification 800).',
  },
  'marburg': {
    name: 'Marburg Medium / UKAAF (Europe)',
    dotDiameter: 1.6, dotHeight: 0.5, dotPitch: 2.5, cellPitch: 6.0, linePitch: 10.0,
    note: 'UKAAF B008 + Marburg spacing; also the Australian Braille Authority standard.',
  },
  'jumbo': {
    name: 'Jumbo (learning / reduced touch sensitivity)',
    dotDiameter: 1.6, dotHeight: 0.8, dotPitch: 3.1, cellPitch: 9.4, linePitch: 15.0,
    note: 'Perkins Jumbo Brailler / RNIB geometry; line pitch at the ISO 17049 ceiling.',
  },
};

export const DEFAULT_PRESET = 'ada';

// Hard clamps (union of the standards + printable practice).
export const LIMITS = {
  dotDiameter: [1.0, 2.0],
  dotHeight: [0.3, 1.0],
  dotPitch: [2.0, 3.2],
  cellPitch: [5.1, 9.5],
  linePitch: [10.0, 20.6],   // ceiling admits BANA double spacing for beginners
  plateHeight: [0, 10],      // 0 = dots only
  margin: [0, 30],
  stlScale: [0.1, 10],
  charsPerLine: [1, 60],
};

export const GEOMETRY_DEFAULTS = {
  plateHeight: 2.0,          // rigid enough for handled labels when FDM-printed
  margin: 6.0,               // ISO 17049 exclusion-zone floor for signage
  stlScale: 1.0,
  charsPerLine: 32,
};

/** Engine line_spacing (extra gap) from the standard line-pitch number. */
export function linePitchToSpacing(v) {
  return v.linePitch - (2 * v.dotPitch + v.dotDiameter);
}

/**
 * Validate a set of dimension values.
 * @returns {{errors: {field: string, msg: string}[], warnings: string[]}}
 * Errors are typed to the field they belong to (so the UI can attach
 * aria-invalid and the message to the RIGHT input); warnings are advisory.
 */
export function validateDimensions(v) {
  const errors = [];
  const warnings = [];
  const inRange = (field, label) => {
    const [lo, hi] = LIMITS[field];
    const val = v[field];
    if (!Number.isFinite(val)) errors.push({ field, msg: `${label} must be a number.` });
    else if (val < lo || val > hi) errors.push({ field, msg: `${label} must be between ${lo} and ${hi} mm.` });
  };
  inRange('dotDiameter', 'Dot diameter');
  inRange('dotHeight', 'Dot height');
  inRange('dotPitch', 'Dot pitch');
  inRange('cellPitch', 'Cell pitch');
  inRange('linePitch', 'Line pitch');
  if (errors.length) return { errors, warnings };

  // Cross-parameter guards (physical readability).
  if (v.dotPitch < v.dotDiameter + 0.3) {
    errors.push({ field: 'dotPitch', msg: `Dot pitch must be at least dot diameter + 0.3 mm (≥ ${(v.dotDiameter + 0.3).toFixed(2)} mm) or the dot bases merge.` });
  }
  if (v.cellPitch - v.dotPitch < v.dotPitch) {
    errors.push({ field: 'cellPitch', msg: `Cell pitch must be at least twice the dot pitch (≥ ${(2 * v.dotPitch).toFixed(2)} mm) so cells stay tactilely distinct.` });
  }
  if (linePitchToSpacing(v) < 0) {
    errors.push({ field: 'linePitch', msg: `Line pitch is too small for this cell size (needs ≥ ${(2 * v.dotPitch + v.dotDiameter).toFixed(2)} mm).` });
  }

  if (v.dotHeight < 0.5) warnings.push('Dot height below 0.5 mm is under the ISO 17049 floor for outdoor/durable use.');
  if (v.dotHeight > 0.9) warnings.push('Dot height above 0.9 mm exceeds every braille standard; readers may find it uncomfortable.');
  if (Number.isFinite(v.marginSize) && v.marginSize < 6) warnings.push('Margins under 6 mm are below the ISO 17049 exclusion zone for signage.');
  if (Number.isFinite(v.charsPerLine) && v.charsPerLine > 40) warnings.push('More than 40 cells per line exceeds standard braille page and signage practice.');
  return { errors, warnings };
}

// Standards ranges for the live compliance readout.
const STANDARDS = [
  {
    id: 'ADA §703.3.1',
    dotDiameter: [1.5, 1.6], dotHeight: [0.6, 0.9], dotPitch: [2.3, 2.5],
    cellPitch: [6.1, 7.6], linePitch: [10.0, 10.2],
  },
  {
    id: 'ISO 17049',
    dotDiameter: [1.0, 1.7], dotHeight: [0.3, 0.7], dotPitch: [2.2, 2.8],
    cellPitch: [5.1, 6.8], linePitch: [10.0, 15.0],
  },
  {
    // UKAAF B008 grants tolerances ONLY on dot height (0.5±0.1) and dot base
    // (1.5±0.25); the spacings are exact values (2.50 / 6.00 / 10.00 mm).
    id: 'UKAAF / Marburg',
    dotDiameter: [1.25, 1.75], dotHeight: [0.4, 0.6], dotPitch: [2.5, 2.5],
    cellPitch: [6.0, 6.0], linePitch: [10.0, 10.0],
  },
];

/** Names of standards whose published ranges the current values satisfy. */
export function satisfiedStandards(v) {
  const out = [];
  for (const s of STANDARDS) {
    const ok = ['dotDiameter', 'dotHeight', 'dotPitch', 'cellPitch', 'linePitch']
      .every(k => v[k] >= s[k][0] - 1e-9 && v[k] <= s[k][1] + 1e-9);
    if (ok) out.push(s.id);
  }
  return out;
}

/** Which preset (if any) exactly matches the values. */
export function matchingPreset(v) {
  for (const [id, p] of Object.entries(PRESETS)) {
    if (['dotDiameter', 'dotHeight', 'dotPitch', 'cellPitch', 'linePitch']
      .every(k => Math.abs(p[k] - v[k]) < 0.005)) return id;
  }
  return null;
}
