// sign.mjs — sign maker UI logic.
// AGPL-3.0 — part of the BrailleGen fork.

import { translate, loadCore, onEngineLog } from './engine.mjs';
import { asciiToBraille, describeInvalid } from './braille-ascii.mjs';
import { FONTS, DEFAULT_FONT, loadFont, layoutLine, layoutLineSpaced } from './fonts.mjs';
import { buildSign, SIGN_DEFAULTS } from './sign-mesh.mjs';
import { toBinaryStl } from './mesh.mjs';
import { createViewer } from './viewer.mjs';
import { recordEvent } from './metrics.mjs';

const $ = (id) => document.getElementById(id);
$('needsJs')?.remove();

const statusEl = $('status');
const alertEl = $('alert');
function announce(msg) {
  statusEl.textContent = '';
  requestAnimationFrame(() => { statusEl.textContent = msg; });
}
function raiseAlert(msg) {
  alertEl.textContent = '';
  requestAnimationFrame(() => { alertEl.textContent = msg; });
}
function clearAlert() { alertEl.textContent = ''; }

// Theme buttons (same behavior as the generator page).
for (const btn of document.querySelectorAll('[data-theme-choice]')) {
  btn.addEventListener('click', () => {
    const choice = btn.dataset.themeChoice;
    if (choice === 'auto') {
      delete document.documentElement.dataset.theme;
      try { localStorage.removeItem('bg-theme'); } catch {}
    } else {
      document.documentElement.dataset.theme = choice;
      try { localStorage.setItem('bg-theme', choice); } catch {}
    }
    for (const b of document.querySelectorAll('[data-theme-choice]')) {
      b.setAttribute('aria-pressed', String(b.dataset.themeChoice === (document.documentElement.dataset.theme ?? 'auto')));
    }
  });
}
onEngineLog(() => {});   // engine output has no console panel here; sink it

// --- form population ---
const fontSelect = $('signFont');
for (const [id, f] of Object.entries(FONTS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = f.name;
  if (id === DEFAULT_FONT) opt.selected = true;
  fontSelect.append(opt);
}

$('fastener').addEventListener('change', () => {
  const v = $('fastener').value;
  if (v !== 'custom') {
    const base = parseFloat(v);
    $('holeDiameter').value = String(($('fdmComp').checked ? base + 0.3 : base).toFixed(2));
  }
  rebuildSoon();
});
$('fdmComp').addEventListener('change', () => {
  const v = $('fastener').value;
  if (v !== 'custom') {
    const base = parseFloat(v);
    $('holeDiameter').value = String(($('fdmComp').checked ? base + 0.3 : base).toFixed(2));
  }
  rebuildSoon();
});

function parseNum(raw) {
  const v = parseFloat(String(raw).trim().replace(',', '.'));
  return Number.isFinite(v) ? v : NaN;
}
function setFieldError(id, msg) {
  const el = $(id + 'Error');
  if (!el) return;
  el.textContent = msg ?? '';
  el.hidden = !msg;
  $(id)?.setAttribute('aria-invalid', msg ? 'true' : 'false');
}

function readSign() {
  return {
    text: $('signText').value,
    grade: $('signGrade').value,
    brailleOverride: $('brailleOverride').value.replace(/[\r\n ]+$/, ''),   // leading blanks are layout
    fontId: fontSelect.value,
    capHeightMm: parseNum($('capHeight').value),
    textStyle: $('textStyle').value,
    textRelief: parseNum($('textRelief').value),
    plateThickness: parseNum($('plateThicknessS').value),
    cornerRadius: parseNum($('cornerRadius').value),
    margin: parseNum($('marginS').value),
    gapTextBraille: parseNum($('gapTextBraille').value),
    holeLayout: $('holeLayout').value,
    holeDiameter: parseNum($('holeDiameter').value),
  };
}

function validateSign(s) {
  const errors = [];
  const range = (field, label, lo, hi) => {
    const v = s[field];
    let msg = null;
    if (!Number.isFinite(v)) msg = `${label} must be a number.`;
    else if (v < lo || v > hi) msg = `${label} must be between ${lo} and ${hi} mm.`;
    setFieldError(field === 'plateThickness' ? 'plateThicknessS'
      : field === 'margin' ? 'marginS' : field, msg);
    if (msg) errors.push(msg);
  };
  range('capHeightMm', 'Letter height', 5, 80);
  range('textRelief', 'Letter relief', 0.3, 3);
  range('plateThickness', 'Plate thickness', 1.6, 10);
  range('cornerRadius', 'Corner radius', 0, 20);
  range('margin', 'Margin', 3, 40);
  range('gapTextBraille', 'Text-to-braille gap', 3, 30);
  if (s.holeLayout !== 'none') range('holeDiameter', 'Hole diameter', 1.5, 12);
  else setFieldError('holeDiameter', null);
  // The map key differs from the input id for capHeightMm.
  setFieldError('capHeight', errors.find(e => e.startsWith('Letter height')) ?? null);
  return errors;
}

// --- build pipeline ---
const viewer = createViewer($('signCanvas'));   // accessible name lives in the HTML
if (!viewer.supported) {
  $('signCanvas').hidden = true;
  document.querySelector('.viewer-controls').hidden = true;
  $('viewerHelp').textContent = '3D preview unavailable in this browser - the summary beside it lists every dimension.';
}
for (const btn of document.querySelectorAll('.viewer-controls [data-view]')) {
  btn.addEventListener('click', () => {
    const step = 0.3;
    switch (btn.dataset.view) {
      case 'left': viewer.rotate(-step, 0); break;
      case 'right': viewer.rotate(step, 0); break;
      case 'up': viewer.rotate(0, step); break;
      case 'down': viewer.rotate(0, -step); break;
      case 'in': viewer.zoom(0.85); break;
      case 'out': viewer.zoom(1.18); break;
      case 'reset': viewer.reset(); break;
    }
  });
}

// The mesh color must clear WCAG non-text contrast against the canvas tint
// in BOTH themes, and follow the system ink under forced-colors (Contrast
// Themes cannot recolor WebGL content themselves).
function applyViewerColor() {
  if (matchMedia('(forced-colors: active)').matches) {
    const probe = document.createElement('span');
    probe.style.color = 'CanvasText';
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color.match(/[0-9]+/g)?.map(Number) ?? [0, 0, 0];
    probe.remove();
    viewer.setColor(rgb.slice(0, 3).map(v => v / 255));
    return;
  }
  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  viewer.setColor(dark ? [0.62, 0.66, 0.94] : [0.20, 0.24, 0.50]);
}
applyViewerColor();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyViewerColor);
matchMedia('(forced-colors: active)').addEventListener?.('change', applyViewerColor);
for (const btn of document.querySelectorAll('[data-theme-choice]')) {
  btn.addEventListener('click', applyViewerColor);
}
let lastBuild = null;      // { sign, s, brailleLines }
let buildSeq = 0;

// Announce errors and geometry changes only when they CHANGE, after typing
// settles - per-keystroke live-region chatter stomps on typing echo.
let announceTimer = 0;
let lastAnnounceSig = null;
function scheduleSignAnnouncement(text) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    if (text !== lastAnnounceSig) {
      lastAnnounceSig = text;
      if (text) announce(text);
    }
  }, 900);
}

async function brailleFor(s) {
  if (s.brailleOverride) {
    const { lines, invalid } = asciiToBraille(s.brailleOverride);
    setFieldError('brailleOverride', invalid.length ? describeInvalid(invalid) : null);
    return lines;
  }
  setFieldError('brailleOverride', null);
  const text = s.text.trim();
  if (!text) return [];
  const r = await translate(text, s.grade, 0);
  if (!r.ok) throw new Error(r.error ?? 'Braille translation failed.');
  return r.lines;
}

async function rebuild() {
  const seq = ++buildSeq;
  const s = readSign();
  const errors = validateSign(s);
  const meta = $('signMeta');
  if (errors.length) {
    meta.textContent = 'Fix the highlighted fields to update the preview.';
    scheduleSignAnnouncement(errors.join(' '));
    return false;
  }
  if (!s.text.trim() && !s.brailleOverride) {
    meta.textContent = 'Type the sign text above.';
    $('signFacts').textContent = '';
    $('signWarnings').textContent = '';
    return false;
  }

  try {
    const [font, brailleLines] = await Promise.all([loadFont(s.fontId), brailleFor(s)]);
    if (seq !== buildSeq) return;

    const textLines = s.text.replace(/\r\n?/g, '\n').split('\n')
      .map(l => l.trim().toUpperCase()).filter(Boolean);
    // Raised lettering auto-widens to the ADA 703.2.7 minimum of 3.2 mm
    // between characters; recessed/flush keep normal print spacing.
    const layouts = s.textStyle === 'raised'
      ? textLines.map(l => layoutLineSpaced(font, l, s.capHeightMm, 0.5, 3.2))
      : textLines.map(l => layoutLine(font, l, s.capHeightMm, 0.5));

    const d = SIGN_DEFAULTS;
    const sign = buildSign({
      textLayouts: layouts,
      lineSpacingMm: s.capHeightMm * 1.5,          // inside the ADA 135–170% window
      capHeightMm: s.capHeightMm,
      brailleLines,
      textStyle: s.textStyle,
      textRelief: s.textRelief,
      gapTextBraille: s.gapTextBraille,
      margin: s.margin,
      plateThickness: s.plateThickness,
      cornerRadius: s.cornerRadius,
      holeLayout: s.holeLayout,
      holeDiameter: s.holeDiameter,
      holeInset: d.holeInset,
      align: 'center',
      plateW: 0, plateH: 0,
      bedSize: 220,
      dotDiameter: d.dotDiameter, dotHeight: d.dotHeight,
      dotPitch: d.dotPitch, cellPitch: d.cellPitch, linePitch: d.linePitch,
    });
    if (seq !== buildSeq) return;
    clearAlert();
    lastBuild = { sign, s, brailleLines };

    // ADA character checks from the measured font metrics.
    const warn = [...sign.warnings];
    const L = layouts[0];
    if (L?.strokePct != null && s.textStyle === 'raised' && L.strokePct > 15) {
      warn.push(`This font's stroke is ${L.strokePct.toFixed(0)}% of letter height — ADA raised characters allow at most 15%. A Regular weight fits.`);
    }
    if (L?.oiPct != null && (L.oiPct < 55 || L.oiPct > 110)) {
      warn.push('This font\'s letter proportions fall outside the ADA 703.2.4 55-110% width window.');
    }

    // ADA 703.2.7: adjacent raised characters need 1/8" (3.2 mm) between
    // their closest points. Bounding-box gaps are the conservative measure.
    if (s.textStyle === 'raised') {
      let minGap = Infinity;
      for (const line of layouts) {
        for (let i = 0; i + 1 < line.glyphs.length; i++) {
          const a = line.glyphs[i], b = line.glyphs[i + 1];
          if (!a.bbox || !b.bbox) continue;
          const gapMm = (b.x + b.bbox[0]) - (a.x + a.bbox[1]);
          if (gapMm < minGap) minGap = gapMm;
        }
      }
      if (Number.isFinite(minGap) && minGap < 3.2) {
        warn.push(`Some letters sit about ${Math.max(0, minGap).toFixed(1)} mm apart - ADA 703.2.7 requires 3.2 mm (1/8 inch) between raised characters. Larger letters or wider spacing fixes it.`);
      }
    }


    const mergedTris = sign.plate.t;
    viewer.setMesh(mergedTris);

    meta.textContent = `${sign.widthMm.toFixed(0)} × ${sign.heightMm.toFixed(0)} × ${s.plateThickness} mm plate`;
    const facts = $('signFacts');
    facts.textContent = '';
    const fact = (k, v) => {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      facts.append(dt, dd);
    };
    fact('Plate', `${sign.widthMm.toFixed(1)} × ${sign.heightMm.toFixed(1)} × ${s.plateThickness} mm`);
    fact('Lettering', textLines.length
      ? `${textLines.join(' / ')} — ${s.capHeightMm} mm capitals, ${s.textStyle}${layouts.some(l => l.spacedForTouch) ? ', letter spacing widened to the ADA 3.2 mm minimum' : ''}`
      : 'none');
    fact('Braille', brailleLines.length
      ? `${brailleLines.join('  ')} (${sign.dotCount} dots, ${s.brailleOverride ? 'custom cells' : (s.grade.includes('g2') ? 'Grade 2' : 'Grade 1')})`
      : 'none');
    fact('Triangles', String(sign.plate.triangleCount + (sign.inserts?.triangleCount ?? 0)));

    const list = $('signWarnings');
    list.textContent = '';
    for (const w of warn) {
      const li = document.createElement('li');
      li.textContent = w;
      list.append(li);
    }
    $('btnInsertsStl').hidden = s.textStyle !== 'flush' || !(sign.inserts && sign.inserts.triangleCount);
    scheduleSignAnnouncement(`Sign updated: ${sign.widthMm.toFixed(0)} by ${sign.heightMm.toFixed(0)} millimeters, ${sign.dotCount} braille dots${warn.length ? `, ${warn.length} warning${warn.length === 1 ? '' : 's'}` : ''}.`);
    return true;
  } catch (e) {
    if (seq !== buildSeq) return false;
    raiseAlert(`Preview failed: ${e.message}`);
    return false;
  }
}

let debounce = 0;
function rebuildSoon() {
  clearTimeout(debounce);
  debounce = setTimeout(rebuild, 250);
}
$('signform').addEventListener('input', rebuildSoon);
$('signform').addEventListener('submit', (e) => { e.preventDefault(); rebuild(); });

// --- exports ---
let lastObjectUrl = null;
function offerDownload(bytes, filename, label) {
  const blob = new Blob([bytes], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  lastObjectUrl = url;
  const note = $('signDownloadNote');
  note.textContent = '';
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  const size = Math.max(1, Math.round(blob.size / 1024)) + ' KB';
  a.textContent = `Download ${label} — ${filename}, ${size}`;
  note.append(a);
  a.click();
  // Focusing the note makes screen readers read the link text - that IS the
  // announcement; a parallel status message would say everything twice.
  note.focus();
}
function slugify(text) {
  const s = text.trim().split('\n')[0].toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'sign';
}

$('btnSignStl').addEventListener('click', async () => {
  const ok = await rebuild();
  if (!ok || !lastBuild) {
    raiseAlert('Fix the highlighted fields before exporting.');
    return;
  }
  const { sign, s } = lastBuild;
  offerDownload(toBinaryStl(sign.plate.t, 'braillegen sign'), `${slugify(s.text)}_sign.stl`, 'sign STL');
  const status = s.textStyle === 'flush'
    ? 'Plate exported. Download the letter inserts too, print them in a contrasting color, and glue them in flush.'
    : 'Sign exported.';
  $('signExportStatus').textContent = status;
  if (s.textStyle === 'flush') announce(status);
  recordEvent('generate-sign');
});
$('btnInsertsStl').addEventListener('click', () => {
  if (!lastBuild?.sign.inserts) { raiseAlert('Switch the print style to flush two-piece first.'); return; }
  offerDownload(toBinaryStl(lastBuild.sign.inserts.t, 'braillegen sign inserts'),
    `${slugify(lastBuild.s.text)}_sign-inserts.stl`, 'letter inserts STL');
  recordEvent('generate-sign-inserts');
});
$('btnSignBraille').addEventListener('click', async () => {
  if (!(await rebuild()) || !lastBuild) {
    raiseAlert('Fix the highlighted fields first.');
    return;
  }
  try {
    await navigator.clipboard.writeText(lastBuild.brailleLines.join('\n'));
    announce('Braille copied to the clipboard.');
    $('signExportStatus').textContent = 'Braille copied to the clipboard.';
  } catch {
    raiseAlert('The browser blocked clipboard access — copy from the summary instead.');
  }
});

// --- service worker (same offline behavior as the generator page) ---
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').then(() => {
    $('offlineState').textContent = 'Offline: ready after first visit';
  }).catch(() => {});
}

// --- boot ---
$('signMeta').textContent = 'Loading fonts and the braille engine…';
Promise.all([loadCore(), loadFont(DEFAULT_FONT)]).then(() => {
  announce('Sign maker ready.');
  rebuild();
}).catch((e) => {
  raiseAlert(`Loading failed: ${e.message}. Reload the page to retry.`);
});
