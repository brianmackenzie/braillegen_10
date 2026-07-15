// app.mjs — BrailleGen UI logic.
// AGPL-3.0 — part of the BrailleGen fork.

import { translate, generateStl, loadCore, onEngineLog, stlReady } from './engine.mjs';
import { brailleToSvg } from './braille-svg.mjs';
import { brailleToBrf } from './braille-brf.mjs';
import { TABLE_GROUPS, DEFAULT_TABLE, tableInfo } from './tables.mjs';
import {
  PRESETS, DEFAULT_PRESET, LIMITS, GEOMETRY_DEFAULTS,
  linePitchToSpacing, validateDimensions, satisfiedStandards, matchingPreset,
} from './presets.mjs';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const alertEl = $('alert');

// Clear-then-set must span a frame: both writes landing in the same task
// coalesce in the accessibility tree, so a message identical to the previous
// one would never be re-announced by screen readers.
function announce(msg) {
  statusEl.textContent = '';
  requestAnimationFrame(() => { statusEl.textContent = msg; });
}
function raiseAlert(msg) {
  alertEl.textContent = '';
  requestAnimationFrame(() => { alertEl.textContent = msg; });
}
function clearAlert() { alertEl.textContent = ''; }

// ---------------------------------------------------------------------------
// Theme (3-way: auto / light / dark, persisted, pre-paint script in index.html)
// ---------------------------------------------------------------------------
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
    syncThemeButtons();
  });
}
function syncThemeButtons() {
  const current = document.documentElement.dataset.theme ?? 'auto';
  for (const btn of document.querySelectorAll('[data-theme-choice]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeChoice === current));
  }
}
syncThemeButtons();

// ---------------------------------------------------------------------------
// Console panel
// ---------------------------------------------------------------------------
const consoleLog = $('consoleLog');
onEngineLog((line, isErr) => {
  const div = document.createElement('div');
  div.textContent = (isErr ? '! ' : '') + line;
  consoleLog.append(div);
  while (consoleLog.childElementCount > 400) consoleLog.firstElementChild.remove();
  consoleLog.scrollTop = consoleLog.scrollHeight;
});

// ---------------------------------------------------------------------------
// Form population
// ---------------------------------------------------------------------------
const tableSelect = $('brailleTable');
for (const g of TABLE_GROUPS) {
  const og = document.createElement('optgroup');
  og.label = g.group;
  for (const t of g.tables) {
    const opt = document.createElement('option');
    opt.value = t.file;
    opt.textContent = t.name;
    if (t.file === DEFAULT_TABLE) opt.selected = true;
    og.append(opt);
  }
  tableSelect.append(og);
}

const presetSelect = $('preset');
for (const [id, p] of Object.entries(PRESETS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = p.name;
  presetSelect.append(opt);
}
{
  const opt = document.createElement('option');
  opt.value = 'custom';
  opt.textContent = 'Custom dimensions';
  presetSelect.append(opt);
}

const DIM_FIELDS = ['dotDiameter', 'dotHeight', 'dotPitch', 'cellPitch', 'linePitch'];
const NUM_FIELDS = [...DIM_FIELDS, 'plateHeight', 'marginSize', 'stlScale', 'charsPerLine'];

function applyPreset(id) {
  const p = PRESETS[id];
  if (!p) return;
  for (const f of DIM_FIELDS) $(f).value = String(p[f]);
  $('presetNote').textContent = p.note;
  presetSelect.value = id;
}

function updateTableHint() {
  const info = tableInfo(tableSelect.value);
  $('tableHint').textContent = info.eightDot
    ? 'This table produces 8-dot braille (dots 7–8): taller cells; BRF export cannot represent it.'
    : '';
  // The typed text is in the selected table's language (WCAG 3.1.2).
  if (info.lang && info.lang !== 'und') $('textInput').setAttribute('lang', info.lang);
  else $('textInput').removeAttribute('lang');
}

presetSelect.addEventListener('change', () => {
  if (presetSelect.value !== 'custom') {
    applyPreset(presetSelect.value);
    onSettingsChanged();
  } else {
    $('presetNote').textContent = 'Free-form values. The badges below show which standards the current numbers satisfy.';
  }
});

// ---------------------------------------------------------------------------
// Settings read / validate / persist
// ---------------------------------------------------------------------------
function parseNum(raw) {
  const v = parseFloat(String(raw).trim().replace(',', '.'));
  return Number.isFinite(v) ? v : NaN;
}

function readSettings() {
  return {
    text: $('textInput').value,
    table: tableSelect.value,
    charsPerLine: parseNum($('charsPerLine').value),
    dotDiameter: parseNum($('dotDiameter').value),
    dotHeight: parseNum($('dotHeight').value),
    dotPitch: parseNum($('dotPitch').value),
    cellPitch: parseNum($('cellPitch').value),
    linePitch: parseNum($('linePitch').value),
    plateHeight: parseNum($('plateHeight').value),
    marginSize: parseNum($('marginSize').value),
    stlScale: parseNum($('stlScale').value),
    slabMode: $('slabMode').checked,
    verticalExport: $('verticalExport').checked,
    svgMirrored: $('svgMirrored').checked,
    svgEmptyDots: $('svgEmptyDots').checked,
    svgDrillMarks: $('svgDrillMarks').checked,
  };
}

function setFieldError(id, msg) {
  const el = $(id + 'Error');
  if (!el) return;
  el.textContent = msg ?? '';
  el.hidden = !msg;
  $(id)?.setAttribute('aria-invalid', msg ? 'true' : 'false');
}

// Debounced, change-only announcements for validation state: screen-reader
// users must hear errors and compliance changes (visually-painted state is
// silent otherwise) without per-keystroke chatter. Errors take precedence
// over badge changes.
let validationAnnounceTimer = 0;
let lastErrorSignature = '';
let lastBadgeSignature = null;   // null = not yet painted (skip initial announce)
function scheduleValidationAnnouncement(errorMsgs, badgeText) {
  const errSig = errorMsgs.join('|');
  clearTimeout(validationAnnounceTimer);
  validationAnnounceTimer = setTimeout(() => {
    if (errSig !== lastErrorSignature) {
      lastErrorSignature = errSig;
      if (errSig) { announce(errorMsgs.join(' ')); lastBadgeSignature = badgeText; return; }
    }
    if (lastBadgeSignature !== null && badgeText !== lastBadgeSignature && !errSig) {
      announce(badgeText ? `Dimensions now: ${badgeText}.` : 'Dimensions meet no published standard exactly.');
    }
    lastBadgeSignature = badgeText;
  }, 900);
}

/** Validate everything; paints per-field errors; returns {ok, s, errors}. */
function validateAll() {
  const s = readSettings();
  const errors = [];   // strings, for export-time summaries

  for (const f of NUM_FIELDS) setFieldError(f, null);

  const range = (field, label, [lo, hi], integer = false) => {
    const v = s[field];
    let msg = null;
    if (!Number.isFinite(v)) msg = `${label} must be a number.`;
    else if (v < lo || v > hi) msg = `${label} must be between ${lo} and ${hi}.`;
    else if (integer && !Number.isInteger(v)) msg = `${label} must be a whole number.`;
    if (msg) { setFieldError(field, msg); errors.push(msg); }
  };

  range('charsPerLine', 'Cells per line', LIMITS.charsPerLine, true);
  range('plateHeight', 'Plate thickness', LIMITS.plateHeight);
  range('marginSize', 'Margin', LIMITS.margin);
  range('stlScale', 'Export scale', LIMITS.stlScale);

  const dims = validateDimensions(s);
  for (const e of dims.errors) {
    errors.push(e.msg);
    setFieldError(e.field, e.msg);   // typed: lands on the field the message names
  }

  const badgeText = paintBadges(s, dims);
  scheduleValidationAnnouncement(errors, badgeText);
  return { ok: errors.length === 0, s, errors, warnings: dims.warnings };
}

/** Paints the compliance badges; returns a text signature for announcements. */
function paintBadges(s, dims) {
  const wrap = $('complianceBadges');
  wrap.textContent = '';
  const parts = [];
  const mk = (text, cls) => {
    const b = document.createElement('span');
    b.className = 'badge' + (cls ? ' ' + cls : '');
    b.textContent = text;
    wrap.append(b);
  };
  if (dims.errors.length === 0) {
    const sat = satisfiedStandards(s);
    if (sat.length) for (const id of sat) { mk(`Meets ${id}`, 'badge--ok'); parts.push(`meets ${id}`); }
    else mk('Meets no published standard exactly', '');
    for (const w of dims.warnings ?? []) { mk(w, 'badge--warn'); parts.push(w); }
  }
  // Keep the preset selector honest.
  const match = matchingPreset(s);
  if (presetSelect.value !== 'custom' && !match) presetSelect.value = 'custom';
  return parts.join('; ');
}

const PERSIST_KEY = 'bg-settings-v1';
function persistSettings() {
  try {
    const s = readSettings();
    delete s.text;                            // never store user text
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ ...s, preset: presetSelect.value }));
  } catch {}
}
function restoreSettings() {
  applyPreset(DEFAULT_PRESET);
  $('plateHeight').value = String(GEOMETRY_DEFAULTS.plateHeight);
  $('marginSize').value = String(GEOMETRY_DEFAULTS.margin);
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    const setVal = (id, v) => { if (v !== undefined && $(id)) $(id).value = String(v); };
    const setChk = (id, v) => { if (v !== undefined && $(id)) $(id).checked = !!v; };
    if (s.table && document.querySelector(`#brailleTable option[value="${CSS.escape(s.table)}"]`)) {
      tableSelect.value = s.table;
    }
    setVal('charsPerLine', s.charsPerLine);
    for (const f of DIM_FIELDS) setVal(f, s[f]);
    setVal('plateHeight', s.plateHeight);
    setVal('marginSize', s.marginSize);
    setVal('stlScale', s.stlScale);
    setChk('slabMode', s.slabMode);
    setChk('verticalExport', s.verticalExport);
    setChk('svgMirrored', s.svgMirrored);
    setChk('svgEmptyDots', s.svgEmptyDots);
    setChk('svgDrillMarks', s.svgDrillMarks);
    if (s.preset && (PRESETS[s.preset] || s.preset === 'custom')) presetSelect.value = s.preset;
    if (s.preset === 'custom') {
      $('presetNote').textContent = 'Free-form values. The badges below show which standards the current numbers satisfy.';
    } else if (PRESETS[s.preset]) {
      $('presetNote').textContent = PRESETS[s.preset].note;
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------
let lastTranslation = { lines: [], eightDot: false, text: '', table: '' };
let previewSeq = 0;

function svgOptionsFrom(s, extra = {}) {
  return {
    dotDiameter: s.dotDiameter,
    dotPitch: s.dotPitch,
    cellPitch: s.cellPitch,
    lineSpacing: linePitchToSpacing(s),
    margin: s.marginSize,
    labelText: s.text,
    ...extra,
  };
}

async function refreshPreview() {
  const seq = ++previewSeq;
  const { ok, s } = validateAll();
  const meta = $('previewMeta');
  const linesWrap = $('previewLines');

  if (!s.text.trim()) {
    linesWrap.textContent = '';
    const p = document.createElement('p');
    p.className = 'preview-empty';
    p.textContent = 'Nothing to translate yet — type some text above.';
    linesWrap.append(p);
    meta.textContent = '';
    return;
  }
  if (!ok) { meta.textContent = 'Fix the highlighted fields to update the preview.'; return; }

  let r;
  try {
    r = await translate(s.text, s.table, s.charsPerLine);
  } catch (e) {
    if (seq !== previewSeq) return;
    raiseAlert(`Translation failed: ${e.message}`);
    return;
  }
  if (seq !== previewSeq) return;   // superseded by newer input
  clearAlert();

  if (!r.ok) {
    raiseAlert(r.error ?? 'Translation failed.');
    return;
  }
  lastTranslation = { lines: r.lines, eightDot: r.eightDot, text: s.text, table: s.table };

  // Untranslatable characters surface as escape cells carrying dots 7/8 even
  // in 6-dot tables — warn rather than let them emboss silently.
  const info = tableInfo(s.table);
  if (r.eightDot && !info.eightDot) {
    raiseAlert('Some characters have no braille definition in this table — they appear as escape cells (with raised lower dots) in the output. Consider revising the text or choosing another table.');
  }

  const cells = r.lines.reduce((n, l) => n + [...l].length, 0);
  const dims = brailleToSvg(r.lines.length ? r.lines : ['⠀'], svgOptionsFrom(s));
  const sizeLabel = s.plateHeight > 0 ? 'plate' : 'dot field';
  meta.textContent =
    `${r.lines.length} line${r.lines.length === 1 ? '' : 's'} · ${cells} cell${cells === 1 ? '' : 's'}` +
    ` · ${sizeLabel} ≈ ${dims.widthMm} × ${dims.heightMm} mm` +
    (s.stlScale !== 1 && Number.isFinite(s.stlScale) ? ` (× ${s.stlScale} in the STL)` : '') +
    (r.eightDot ? ' · 8-dot' : '');

  linesWrap.textContent = '';
  const pxPerMm = 3;
  const rows = [];
  r.lines.forEach((line) => {
    const row = document.createElement('div');
    row.className = 'preview-line';
    row.setAttribute('role', 'listitem');

    const text = document.createElement('span');
    text.className = 'braille-text';
    text.textContent = line.length ? line : '⠀';
    row.append(text);

    const { svg, widthMm } = brailleToSvg([line.length ? line : '⠀'], {
      dotDiameter: s.dotDiameter,
      dotPitch: s.dotPitch,
      cellPitch: s.cellPitch,
      lineSpacing: 0,
      margin: 1,
      emptyDots: 'outline',
      dotColor: 'currentColor',
    });
    const holder = document.createElement('div');
    holder.innerHTML = svg;
    const svgEl = holder.firstElementChild;
    svgEl.setAttribute('aria-hidden', 'true');
    svgEl.removeAttribute('role');
    svgEl.removeAttribute('aria-labelledby');
    // The exported-SVG accessibility ids must not duplicate across preview rows.
    for (const idEl of svgEl.querySelectorAll('[id]')) idEl.removeAttribute('id');
    svgEl.style.width = `${widthMm * pxPerMm}px`;
    // faint outlines for absent dots use a class the theme can color
    for (const g of svgEl.querySelectorAll('g[stroke-opacity]')) {
      g.classList.add('empty-dot');
      g.setAttribute('stroke', 'currentColor');
    }
    for (const g of svgEl.querySelectorAll('g[fill]')) {
      if (g.getAttribute('fill') !== 'none') g.setAttribute('fill', 'currentColor');
    }
    row.append(svgEl);
    linesWrap.append(row);
    rows.push(row);
  });

  // Clipped rows must be keyboard-scrollable (WCAG 2.1.1); only overflowing
  // rows get a tab stop so short previews add none.
  requestAnimationFrame(() => {
    for (const row of rows) {
      if (row.scrollWidth > row.clientWidth) row.tabIndex = 0;
    }
  });
}

let debounceTimer = 0;
function onSettingsChanged() {
  persistSettings();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(refreshPreview, 220);
}

$('genform').addEventListener('input', () => { updateTableHint(); onSettingsChanged(); });
$('genform').addEventListener('submit', (e) => { e.preventDefault(); refreshPreview(); });

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
function slugify(text) {
  const s = text.trim().split('\n')[0].toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'braille';
}
function tableSlug(table) {
  return table.replace(/\.(ctb|utb|tbl)$/, '').replace(/[^a-z0-9]+/gi, '-');
}

let lastObjectUrl = null;
function offerDownload(bytes, filename, type, label) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  // The visible link must stay clickable, so only the PREVIOUS export's blob
  // is revoked — bounding the leak to one object URL at a time.
  if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); }
  lastObjectUrl = url;
  const note = $('downloadNote');
  note.textContent = '';
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  const size = blob.size > 1048576
    ? (blob.size / 1048576).toFixed(1) + ' MB'
    : Math.max(1, Math.round(blob.size / 1024)) + ' KB';
  a.textContent = `Download ${label} — ${filename}, ${size}`;
  note.append(a);
  a.click();
  note.focus();
  announce(`${label} ready: ${filename}, ${size}. A download link is available below the export buttons.`);
}

async function freshTranslation() {
  const { ok, s, errors } = validateAll();
  if (!s.text.trim()) { raiseAlert('Type some text first.'); return null; }
  if (!ok) { raiseAlert('Fix these before exporting: ' + errors.join(' ')); return null; }
  const r = await translate(s.text, s.table, s.charsPerLine);
  if (!r.ok) { raiseAlert(r.error ?? 'Translation failed.'); return null; }
  return { s, r };
}

$('btnSvg').addEventListener('click', async () => {
  const t = await freshTranslation();
  if (!t) return;
  const { s, r } = t;
  const { svg } = brailleToSvg(r.lines, svgOptionsFrom(s, {
    mirrored: s.svgMirrored,
    emptyDots: s.svgEmptyDots ? 'outline' : 'none',
    drillCenters: s.svgDrillMarks,
  }));
  offerDownload(svg, `${slugify(s.text)}_${tableSlug(s.table)}${s.svgMirrored ? '_mirrored' : ''}.svg`,
    'image/svg+xml', 'SVG');
});

$('btnBrf').addEventListener('click', async () => {
  const t = await freshTranslation();
  if (!t) return;
  const { s } = t;
  // BRF pages are at most 40 cells wide. When the user's setting is wider,
  // RE-TRANSLATE at 40 so liblouis wraps at word boundaries — hard-slicing the
  // preview lines would split words and break braille semantics (a numeric
  // indicator is not restated after a mid-number cut).
  const brfWidth = Math.min(40, s.charsPerLine || 40);
  let lines = t.r.lines;
  let rewrapped = false;
  if ((s.charsPerLine || 0) > 40) {
    const r40 = await translate(s.text, s.table, brfWidth);
    if (!r40.ok) { raiseAlert(r40.error ?? 'Translation failed.'); return; }
    lines = r40.lines;
    rewrapped = true;
  }
  const { brf, droppedDots } = brailleToBrf(lines, { cellsPerLine: brfWidth });
  const notes = [];
  if (droppedDots > 0) {
    notes.push(`BRF is a 6-dot format: ${droppedDots} cell${droppedDots === 1 ? '' : 's'} using dots 7–8 were replaced with blank cells — for 8-dot content, use the braille text download instead.`);
  }
  if (rewrapped) {
    notes.push('BRF lines are capped at the conventional 40 cells, so the file was re-wrapped at word boundaries; its line layout differs from the preview.');
  }
  if (notes.length) raiseAlert(notes.join(' '));
  offerDownload(brf, `${slugify(s.text)}_${tableSlug(s.table)}.brf`, 'text/plain', 'BRF');
});

$('btnTxt').addEventListener('click', async () => {
  const t = await freshTranslation();
  if (!t) return;
  const { s, r } = t;
  offerDownload(r.lines.join('\r\n'), `${slugify(s.text)}_${tableSlug(s.table)}.txt`,
    'text/plain;charset=utf-8', 'braille text');
});

$('btnCopy').addEventListener('click', async () => {
  const t = await freshTranslation();
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t.r.lines.join('\n'));
    announce('Braille copied to the clipboard.');
    $('exportStatus').textContent = 'Braille copied to the clipboard.';
    $('exportStatus').dataset.tone = 'ok';
  } catch {
    raiseAlert('The browser blocked clipboard access — select the preview text and copy manually.');
  }
});

let stlBusy = false;
$('btnStl').addEventListener('click', async () => {
  if (stlBusy) { announce('An STL export is already in progress.'); return; }
  const t = await freshTranslation();
  if (!t) return;
  const { s } = t;
  const exportStatus = $('exportStatus');
  const progressWrap = $('stlProgressWrap');
  const progress = $('stlProgress');
  stlBusy = true;
  $('btnStl').setAttribute('aria-disabled', 'true');
  $('downloads').setAttribute('aria-busy', 'true');
  try {
    if (!stlReady()) {
      progressWrap.hidden = false;
      announce('Loading the 3D engine — about nine megabytes, one time only. Your STL will generate when it is ready.');
    } else {
      announce('Generating STL…');
    }
    exportStatus.dataset.tone = '';
    exportStatus.textContent = stlReady() ? 'Generating STL…' : 'Loading 3D engine…';

    let lastMilestone = 0;
    const { filename, bytes } = await generateStl({
      text: s.text,
      table: s.table,
      charsPerLine: s.charsPerLine,
      brailleHeight: s.dotHeight,
      plateHeight: s.plateHeight,
      lineSpacing: linePitchToSpacing(s),
      marginSize: s.marginSize,
      stlScale: s.stlScale,
      slabMode: s.slabMode,
      verticalExport: s.verticalExport,
      dotDiameter: s.dotDiameter,
      dotPitch: s.dotPitch,
      cellPitch: s.cellPitch,
    }, ({ loaded, total }) => {
      if (total) {
        // Clamp: if the server transparently decompresses, decoded bytes can
        // exceed the encoded Content-Length.
        const pct = Math.min(100, Math.round((loaded / total) * 100));
        progress.value = pct;
        const milestone = Math.min(100, Math.floor(pct / 25) * 25);
        if (milestone > lastMilestone) {
          lastMilestone = milestone;
          announce(`3D engine download: ${milestone} percent.`);
        }
      } else {
        progress.removeAttribute('value');
      }
      if (total && loaded >= total) {
        exportStatus.textContent = 'Generating STL…';
        announce('Engine loaded. Generating STL…');
      }
    });

    progressWrap.hidden = true;
    exportStatus.textContent = 'STL generated.';
    exportStatus.dataset.tone = 'ok';
    const name = `${slugify(s.text)}_${tableSlug(s.table)}_${s.dotHeight}mm.stl`;
    offerDownload(bytes, name, 'model/stl', 'STL');
    void filename;
  } catch (e) {
    progressWrap.hidden = true;
    exportStatus.textContent = '';
    raiseAlert(`STL export failed: ${e.message}`);
  } finally {
    stlBusy = false;
    $('btnStl').removeAttribute('aria-disabled');
    $('downloads').removeAttribute('aria-busy');
  }
});

// ---------------------------------------------------------------------------
// Service worker + offline state
// ---------------------------------------------------------------------------
async function initSw() {
  const offlineState = $('offlineState');
  if (!('serviceWorker' in navigator)) {
    offlineState.textContent = 'Offline: not supported in this browser';
    return;
  }
  if (location.protocol === 'file:') {
    offlineState.textContent = 'Offline: unavailable when opened as a file';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    const paintState = () => {
      if (navigator.serviceWorker.controller) {
        offlineState.textContent = 'Offline: ready — this app works without a connection';
      } else if (reg.active) {
        offlineState.textContent = 'Offline: ready after the next reload';
      } else {
        offlineState.textContent = 'Offline: caching… available after this visit';
      }
    };
    paintState();
    navigator.serviceWorker.addEventListener('controllerchange', paintState);
    reg.installing?.addEventListener('statechange', paintState);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          announce('A new version of BrailleGen is available. Reload the page to update.');
          $('exportStatus').textContent = 'Update available — reload the page to apply.';
        }
      });
    });
  } catch {
    offlineState.textContent = 'Offline: unavailable';
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
restoreSettings();
updateTableHint();
validateAll();
initSw();

$('previewMeta').textContent = 'Loading the braille engine (about a quarter of a megabyte)…';
loadCore().then(() => {
  announce('Braille engine ready.');
  refreshPreview();
}).catch((e) => {
  raiseAlert(`The braille engine failed to load: ${e.message}. Reload the page to retry.`);
  $('previewMeta').textContent = '';
});
