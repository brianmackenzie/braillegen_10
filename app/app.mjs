// app.mjs — BrailleGen UI logic.
// AGPL-3.0 — part of the BrailleGen fork.

import { translate, generateStl, loadCore, onEngineLog, stlReady } from './engine.mjs';
import { createViewer } from './viewer.mjs';
import { parseBinaryStl } from './mesh.mjs';
import { brailleToSvg } from './braille-svg.mjs';
import { brailleToBrf } from './braille-brf.mjs';
import { asciiToBraille, describeInvalid } from './braille-ascii.mjs';
import { recordEvent } from './metrics.mjs';
import { TABLE_GROUPS, DEFAULT_TABLE, tableInfo } from './tables.mjs';
import {
  PRESETS, DEFAULT_PRESET, LIMITS, GEOMETRY_DEFAULTS,
  linePitchToSpacing, validateDimensions, satisfiedStandards, matchingPreset,
} from './presets.mjs';

const $ = (id) => document.getElementById(id);

// The static "needs JavaScript" notice is only for visitors where this module
// never ran; the app is booting, so clear it first.
$('needsJs')?.remove();

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
  if (inputMode() === 'ascii') {
    $('tableHint').textContent = 'Not used for Braille ASCII — characters map directly to cells.';
    $('textInput').removeAttribute('lang');
    return;
  }
  const info = tableInfo(tableSelect.value);
  $('tableHint').textContent = info.eightDot
    ? 'This table produces 8-dot braille (dots 7–8): taller cells; BRF export cannot represent it.'
    : '';
  // The typed text is in the selected table's language (WCAG 3.1.2).
  if (info.lang && info.lang !== 'und') $('textInput').setAttribute('lang', info.lang);
  else $('textInput').removeAttribute('lang');
}

// ---------------------------------------------------------------------------
// Input mode: translated print text vs direct Braille ASCII entry
// ---------------------------------------------------------------------------
function inputMode() {
  return $('modeAscii')?.checked ? 'ascii' : 'text';
}

// Braille ASCII entry must not be "helped" by the platform: autocapitalize
// and autocorrect would rewrite cell characters under the transcriber's
// fingers, and spellcheck underlines are meaningless noise there.
function applyInputMode() {
  const ascii = inputMode() === 'ascii';
  const input = $('textInput');
  $('textLabel').textContent = ascii ? 'Braille ASCII to convert' : 'Text to translate';
  input.placeholder = ascii ? ',hello ,world' : 'hello world';
  input.spellcheck = !ascii;
  input.setAttribute('autocapitalize', ascii ? 'off' : 'sentences');
  input.setAttribute('autocorrect', ascii ? 'off' : 'on');
  $('textHint').textContent = ascii
    ? 'One character = one cell (letters, digits and BRF symbols; case does not matter). Lines are never re-wrapped, so spatial layouts like Nemeth worked problems keep their columns.'
    : 'Each line becomes its own braille line. The preview below updates as you type.';
  tableSelect.disabled = ascii;
  $('charsPerLine').disabled = ascii;
  $('charsHint').textContent = ascii
    ? 'Not used for Braille ASCII — lines are kept exactly as typed.'
    : 'Braille embosser pages are typically 40 cells or fewer.';
  updateTableHint();
}

/**
 * The one translation path both the preview and every export use:
 * engine translation in text mode, the direct NABCC map in ASCII mode.
 * ASCII-mode issues (out-of-set characters, smart-quote fixes) come back as
 * `notes` for the caller to surface.
 */
async function runTranslation(s) {
  if (s.inputMode !== 'ascii') return translate(s.text, s.table, s.charsPerLine);
  const { lines, invalid, smartFixes } = asciiToBraille(s.text);
  const notes = [];
  if (invalid.length) notes.push(describeInvalid(invalid));
  if (smartFixes) notes.push(`${smartFixes} smart quote/dash character${smartFixes === 1 ? ' was' : 's were'} read as plain ASCII.`);
  // Pasted Unicode braille can carry dots 7/8 even though the ASCII set is 6-dot.
  const eightDot = lines.some(l => [...l].some(c => (c.codePointAt(0) - 0x2800) & 0xC0));
  return { ok: true, lines, eightDot, notes };
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
    inputMode: inputMode(),
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

  if (s.inputMode !== 'ascii') range('charsPerLine', 'Cells per line', LIMITS.charsPerLine, true);
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
function restoreInputMode(saved) {
  if (saved === 'ascii') $('modeAscii').checked = true;
  applyInputMode();
}
function restoreSettings() {
  applyPreset(DEFAULT_PRESET);
  $('plateHeight').value = String(GEOMETRY_DEFAULTS.plateHeight);
  $('marginSize').value = String(GEOMETRY_DEFAULTS.margin);
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) { restoreInputMode(); return; }
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
    restoreInputMode(s.inputMode);
    return;
  } catch {}
  restoreInputMode();
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
    r = await runTranslation(s);
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

  if (r.notes?.length) {
    raiseAlert(r.notes.join(' '));
  }

  // Untranslatable characters surface as escape cells carrying dots 7/8 even
  // in 6-dot tables — warn rather than let them emboss silently.
  const info = tableInfo(s.table);
  if (s.inputMode !== 'ascii' && r.eightDot && !info.eightDot) {
    raiseAlert('Some characters have no braille definition in this table — they appear as escape cells (with raised lower dots) in the output. Consider revising the text or choosing another table.');
  }

  const cells = r.lines.reduce((n, l) => n + [...l].length, 0);
  const dims = brailleToSvg(r.lines.length ? r.lines : ['⠀'], svgOptionsFrom(s));
  const sizeLabel = s.plateHeight > 0 ? 'plate' : 'dot field';
  meta.textContent =
    `${r.lines.length} line${r.lines.length === 1 ? '' : 's'} · ${cells} cell${cells === 1 ? '' : 's'}` +
    ` · ${sizeLabel} ≈ ${dims.widthMm} × ${dims.heightMm} mm` +
    (s.stlScale !== 1 && Number.isFinite(s.stlScale) ? ` (× ${s.stlScale} in the STL)` : '') +
    (r.eightDot ? ' · 8-dot' : '') +
    (s.inputMode === 'ascii' ? ' · Braille ASCII input' : '');

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
  schedule3dRefresh();
}

$('genform').addEventListener('input', () => { updateTableHint(); onSettingsChanged(); });
$('genform').addEventListener('submit', (e) => { e.preventDefault(); refreshPreview(); });

for (const id of ['modeText', 'modeAscii']) {
  $(id).addEventListener('change', () => {
    applyInputMode();
    announce($(id) === $('modeAscii') && $('modeAscii').checked
      ? 'Braille ASCII input: characters map directly to cells; lines are kept as typed. The language and cells-per-line settings are disabled.'
      : 'Print text input: text is translated with the selected braille table. The language and cells-per-line settings are enabled again.');
    onSettingsChanged();
  });
}

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
function exportSlug(s) {
  return s.inputMode === 'ascii' ? 'braille-ascii' : tableSlug(s.table);
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
  // Focusing the note makes screen readers read the link text - that IS the
  // announcement; a parallel status message would say everything twice.
  note.focus();
}

async function freshTranslation() {
  const { ok, s, errors } = validateAll();
  if (!s.text.trim()) { raiseAlert('Type some text first.'); return null; }
  if (!ok) { raiseAlert('Fix these before exporting: ' + errors.join(' ')); return null; }
  const r = await runTranslation(s);
  if (!r.ok) { raiseAlert(r.error ?? 'Translation failed.'); return null; }
  if (r.notes?.length) raiseAlert(r.notes.join(' '));
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
  offerDownload(svg, `${slugify(s.text)}_${exportSlug(s)}${s.svgMirrored ? '_mirrored' : ''}.svg`,
    'image/svg+xml', 'SVG');
  recordEvent('generate-svg');
});

$('btnBrf').addEventListener('click', async () => {
  const t = await freshTranslation();
  if (!t) return;
  const { s } = t;
  // BRF pages are at most 40 cells wide. When the user's setting is wider,
  // RE-TRANSLATE at 40 so liblouis wraps at word boundaries — hard-slicing the
  // preview lines would split words and break braille semantics (a numeric
  // indicator is not restated after a mid-number cut).
  //
  // Braille ASCII input is NEVER re-wrapped: its line layout is authorial
  // (Nemeth worked problems lose their meaning if columns move). Long lines
  // go out as typed, with a warning instead of a rewrap.
  let brfWidth = Math.min(40, s.charsPerLine || 40);
  let lines = t.r.lines;
  let rewrapped = false;
  let asciiWidthNote = '';
  if (s.inputMode === 'ascii') {
    const longest = lines.reduce((n, l) => Math.max(n, [...l].length), 0);
    brfWidth = Math.max(40, longest);
    if (longest > 40) {
      asciiWidthNote = `Lines up to ${longest} cells are kept as typed — embossers set narrower than that will truncate them.`;
    }
  } else if ((s.charsPerLine || 0) > 40) {
    const r40 = await translate(s.text, s.table, brfWidth);
    if (!r40.ok) { raiseAlert(r40.error ?? 'Translation failed.'); return; }
    lines = r40.lines;
    rewrapped = true;
  }
  const { brf, droppedDots } = brailleToBrf(lines, { cellsPerLine: brfWidth });
  // One aggregated alert: raiseAlert is last-writer-wins, so stacking calls
  // would silently drop earlier notes (ASCII-mode issues included).
  const notes = [...(t.r.notes ?? [])];
  if (asciiWidthNote) notes.push(asciiWidthNote);
  if (droppedDots > 0) {
    notes.push(`BRF is a 6-dot format: ${droppedDots} cell${droppedDots === 1 ? '' : 's'} using dots 7–8 were replaced with blank cells — for 8-dot content, use the braille text download instead.`);
  }
  if (rewrapped) {
    notes.push('BRF lines are capped at the conventional 40 cells, so the file was re-wrapped at word boundaries; its line layout differs from the preview.');
  }
  if (notes.length) raiseAlert(notes.join(' '));
  offerDownload(brf, `${slugify(s.text)}_${exportSlug(s)}.brf`, 'text/plain', 'BRF');
  recordEvent('generate-brf');
});

$('btnTxt').addEventListener('click', async () => {
  const t = await freshTranslation();
  if (!t) return;
  const { s, r } = t;
  offerDownload(r.lines.join('\r\n'), `${slugify(s.text)}_${exportSlug(s)}.txt`,
    'text/plain;charset=utf-8', 'braille text');
  recordEvent('generate-txt');
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

// ASCII mode hands the engine finished BRAILLE characters: every table
// passes braille codepoints through unchanged (they are defined as
// themselves), and charsPerLine 0 disables re-wrapping so spatial layouts
// keep their columns. Shared by the STL download and the 3D preview.
function stlParams(s, r) {
  return {
    text: s.inputMode === 'ascii' ? r.lines.join('\n') : s.text,
    table: s.table,
    charsPerLine: s.inputMode === 'ascii' ? 0 : s.charsPerLine,
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
  };
}

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
    const { filename, bytes } = await generateStl(stlParams(s, t.r), ({ loaded, total }) => {
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
    const name = `${slugify(s.text)}_${exportSlug(s)}_${s.dotHeight}mm.stl`;
    offerDownload(bytes, name, 'model/stl', 'STL');
    recordEvent('generate-stl');
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
// 3D print preview: the same engine and settings as the STL download, shown
// in the viewer. Opt-in (first use fetches the 3D engine), then it follows
// edits with a debounce.
// ---------------------------------------------------------------------------
let tileViewer = null;
let preview3dBusy = false;
let preview3dTimer = 0;

function tileViewerColor() {
  if (matchMedia('(forced-colors: active)').matches) {
    const probe = document.createElement('span');
    probe.style.color = 'CanvasText';
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color.match(/[0-9]+/g)?.map(Number) ?? [0, 0, 0];
    probe.remove();
    return rgb.slice(0, 3).map(v => v / 255);
  }
  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? [0.62, 0.66, 0.94] : [0.20, 0.24, 0.50];
}

async function refresh3dPreview() {
  if (!tileViewer || preview3dBusy) return;
  const t = await freshTranslation();
  if (!t) return;
  preview3dBusy = true;
  const status = $('tilePreviewStatus');
  try {
    if (!stlReady()) status.textContent = 'Loading the 3D engine (about 9 MB, one time)…';
    else status.textContent = 'Updating the 3D preview…';
    const { bytes } = await generateStl(stlParams(t.s, t.r), ({ loaded, total }) => {
      if (total) status.textContent = `Loading the 3D engine: ${Math.min(100, Math.round((loaded / total) * 100))}%…`;
    });
    const tris = parseBinaryStl(bytes);
    if (tris) {
      tileViewer.setMesh(tris);
      tileViewer.setColor(tileViewerColor());
      status.textContent = `Showing the tile the STL download produces (${Math.max(1, Math.round(bytes.length / 1024))} KB). It updates as you edit.`;
    }
  } catch (e) {
    status.textContent = `3D preview failed: ${e.message}`;
  } finally {
    preview3dBusy = false;
  }
}

function schedule3dRefresh() {
  if (!tileViewer) return;
  clearTimeout(preview3dTimer);
  preview3dTimer = setTimeout(refresh3dPreview, 1200);
}

$('btn3dPreview').addEventListener('click', async () => {
  $('tilePreviewEnable').hidden = true;
  $('tileViewerWrap').hidden = false;
  tileViewer = createViewer($('tileCanvas'));
  if (!tileViewer.supported) {
    $('tileViewerWrap').hidden = true;
    $('tilePreviewStatus').textContent = '3D preview unavailable in this browser — the braille preview above and the STL download still work.';
    return;
  }
  for (const btn of document.querySelectorAll('#tileViewerWrap .viewer-controls [data-view]')) {
    btn.addEventListener('click', () => {
      const step = 0.3;
      switch (btn.dataset.view) {
        case 'left': tileViewer.rotate(-step, 0); break;
        case 'right': tileViewer.rotate(step, 0); break;
        case 'up': tileViewer.rotate(0, step); break;
        case 'down': tileViewer.rotate(0, -step); break;
        case 'in': tileViewer.zoom(0.85); break;
        case 'out': tileViewer.zoom(1.18); break;
        case 'reset': tileViewer.reset(); break;
      }
    });
  }
  for (const btn of document.querySelectorAll('[data-theme-choice]')) {
    btn.addEventListener('click', () => tileViewer?.setColor(tileViewerColor()));
  }
  announce('Loading the 3D preview.');
  refresh3dPreview();
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
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      paintState();
      // A controller SWAP means a new version just activated (skipWaiting in
      // sw.js). Reload once so the visible page matches the new deploy; the
      // guard prevents any reload loop, and first-ever installs don't reload.
      if (hadController && !window.__bgReloaded) {
        window.__bgReloaded = true;
        announce('BrailleGen updated — reloading.');
        location.reload();
      }
    });
    reg.installing?.addEventListener('statechange', paintState);
    // Updates apply automatically: the new worker skipWaiting()s, the
    // controllerchange handler above reloads the page once.
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
