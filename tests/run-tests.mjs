// BrailleGen fork test suite — drives the REAL wasm engines under Node plus
// the pure-JS export modules. Zero dependencies.
//
//   node tests/run-tests.mjs           # all tests
//   node tests/run-tests.mjs --fast    # skip the STL engine (geometry) tests
//
// AGPL-3.0 — part of the BrailleGen fork.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TABLES = join(ROOT, 'liblouis', 'tables');
const FAST = process.argv.includes('--fast');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

// ---------------------------------------------------------------------------
// Engine bootstrap helpers
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(ROOT, 'engine', 'tables-manifest.json'), 'utf8'));

function writeTables(mod, table) {
  const entry = manifest.tables[table];
  if (!entry) throw new Error(`table not in manifest: ${table}`);
  try { mod.FS.mkdir('/tables'); } catch {}
  for (const f of entry.files) {
    try { mod.FS.lookupPath(`/tables/${f}`); continue; } catch {}
    mod.FS.writeFile(`/tables/${f}`, readFileSync(join(TABLES, f)));
  }
}

async function loadEngine(name) {
  const { default: factory } = await import(pathToFileURL(join(ROOT, 'engine', `${name}.js`)));
  const logs = [];
  const mod = await factory({
    print: (t) => logs.push(String(t)),
    printErr: (t) => logs.push('[err] ' + String(t)),
  });
  mod.__logs = logs;
  return mod;
}

function translate(mod, text, table, maxChars = 32) {
  if (manifest.tables[table]) writeTables(mod, table); // unknown tables reach the engine raw
  const json = mod.ccall('translateBraille', 'string',
    ['string', 'number', 'string'], [text, maxChars, table]);
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// 1. Core engine: translation correctness
// ---------------------------------------------------------------------------
section('core engine: translation');
const core = await loadEngine('core');

{
  const r = translate(core, 'hello world', 'en-ueb-g2.ctb');
  check('UEB G2 "hello world" (world contraction)',
    r.ok && r.lines.join('') === '⠓⠑⠇⠇⠕⠀⠸⠺',
    JSON.stringify(r));
}
{
  const r = translate(core, 'Hello 42 World', 'en-ueb-g1.ctb');
  check('UEB G1 capitals + number sign',
    r.ok && r.lines[0] === '⠠⠓⠑⠇⠇⠕⠀⠼⠙⠃⠀⠠⠺⠕⠗⠇⠙',
    JSON.stringify(r));
}
{
  const r = translate(core, 'café niño', 'es-g1.ctb');
  check('Spanish accented characters translate cleanly',
    r.ok && r.lines[0] === '⠉⠁⠋⠮⠀⠝⠊⠻⠕',
    JSON.stringify(r));
  check('accented input yields one line with no escape cells',
    r.ok && r.lines.length === 1 && !r.eightDot, JSON.stringify(r.lines));
}
{
  const r = translate(core, '', 'en-ueb-g2.ctb');
  check('empty input -> ok with zero lines', r.ok && r.lines.length === 0, JSON.stringify(r));
}
{
  const r = translate(core, 'hello', 'no-such-table.ctb');
  check('unknown table -> ok:false with error', !r.ok && /table/i.test(r.error || ''), JSON.stringify(r));
}
{
  const r = translate(core, 'aaa bbb ccc ddd eee', 'en-ueb-g1.ctb', 7);
  const widths = r.lines.map(l => [...l].length);
  check('wrap: no line exceeds limit', r.ok && widths.every(w => w <= 7), JSON.stringify(widths));
  check('wrap: words kept intact', r.ok && r.lines.length >= 3, JSON.stringify(r.lines));
}
{
  const r = translate(core, 'abcdefghijklmnop', 'en-ueb-g1.ctb', 5);
  const widths = r.lines.map(l => [...l].length);
  check('hard-break: overlong word split at limit',
    r.ok && widths.every(w => w <= 5) && widths.length >= 3, JSON.stringify(widths));
}
{
  const r = translate(core, 'one\ntwo', 'en-ueb-g1.ctb');
  check('newlines preserved as separate lines', r.ok && r.lines.length === 2, JSON.stringify(r.lines));
}
{
  const r = translate(core, 'no wrap when zero', 'en-ueb-g1.ctb', 0);
  check('maxChars=0 disables wrapping', r.ok && r.lines.length === 1, JSON.stringify(r.lines));
}
{
  const r = translate(core, 'ABC', 'en-us-comp8-ext.utb');
  const anyEight = r.ok && [...r.lines.join('')].some(c => (c.codePointAt(0) - 0x2800) & 0xC0);
  check('8-dot table: capitals use dot 7', anyEight, JSON.stringify(r));
  check('8-dot table: eightDot flag set', r.ok && r.eightDot === true, JSON.stringify(r));
}
{
  const r = translate(core, 'x'.repeat(2000), 'en-ueb-g1.ctb', 40);
  check('long input does not crash', r.ok && r.lines.length > 10, `${r.lines?.length} lines`);
}

// Adversarial input vectors (JSON-escaping path + formatting fidelity)
{
  const r = translate(core, 'quote " backslash \\ tab\ttext', 'en-ueb-g1.ctb');
  check('adversarial: quotes/backslash/tab survive the JSON path', r.ok && r.lines.length >= 1, JSON.stringify(r).slice(0, 120));
}
{
  const r = translate(core, 'emoji \u{1F600} here', 'en-ueb-g1.ctb');
  check('adversarial: astral input yields valid JSON + 8-dot escape flag',
    r.ok && r.eightDot === true, JSON.stringify(r).slice(0, 120));
}
{
  const r = translate(core, 'crlf\r\nline', 'en-ueb-g1.ctb');
  check('adversarial: CRLF treated as one line break', r.ok && r.lines.length === 2, JSON.stringify(r.lines));
}
{
  const r = translate(core, 'x', 'bad"name\\.ctb');
  check('adversarial: hostile table name yields parseable error JSON', !r.ok && typeof r.error === 'string');
}
{
  // Leading blank cells = braille indentation; the wrap path used to drop them.
  const wrapped = translate(core, '  indented text here', 'en-ueb-g1.ctb', 10);
  const noWrap = translate(core, '  indented text here', 'en-ueb-g1.ctb', 0);
  const lead = (l) => { let n = 0; for (const c of l) { if (c === '⠀') n++; else break; } return n; };
  check('wrap preserves leading blank cells (indentation)',
    wrapped.ok && lead(wrapped.lines[0]) === 2, JSON.stringify(wrapped.lines));
  check('no-wrap and wrap agree on indentation',
    noWrap.ok && lead(noWrap.lines[0]) === lead(wrapped.lines[0]), JSON.stringify(noWrap.lines));
  const widths = wrapped.lines.map(l => [...l].length);
  check('indented wrap still honors the line limit', widths.every(w => w <= 10), JSON.stringify(widths));
}

// Golden UEB vectors, checked against published references (NFB UEB lessons,
// BANA contraction summaries, APH UEB math lessons).
for (const [text, table, want, label] of [
  ['Hello World', 'en-ueb-g2.ctb', '⠠⠓⠑⠇⠇⠕⠀⠠⠸⠺', 'G2 capital indicator per word'],
  ['HELLO', 'en-ueb-g2.ctb', '⠠⠠⠓⠑⠇⠇⠕', 'G2 caps-word indicator'],
  ['3.14', 'en-ueb-g2.ctb', '⠼⠉⠲⠁⠙', 'numeric mode continues through period'],
  ['1a', 'en-ueb-g2.ctb', '⠼⠁⠰⠁', 'grade-1 indicator terminates numeric mode'],
  ['café', 'en-ueb-g1.ctb', '⠉⠁⠋⠘⠌⠑', 'UEB accented e via modifier'],
]) {
  const r = translate(core, text, table);
  check(`golden: ${label}`, r.ok && r.lines.join('\n') === want,
    `got ${JSON.stringify(r.lines)} want ${JSON.stringify([want])}`);
}

// Curated table smoke: every dropdown table must load + translate on THIS engine
// (guards the liblouis engine<->table version coupling, incl. the el.ctb caveat).
{
  const { TABLE_GROUPS } = await import(pathToFileURL(join(ROOT, 'app', 'tables.mjs')));
  const samples = {
    ar: 'مرحبا', he: 'שלום', fa: 'سلام', hi: 'नमस्ते',
    'zh-CN': '你好', 'zh-TW': '你好', ko: '안녕', ja: '点字',
    el: 'γεια', ru: 'привет', uk: 'привіт',
  };
  const bad = [];
  let n = 0;
  for (const g of TABLE_GROUPS) {
    for (const t of g.tables) {
      n++;
      const sample = samples[t.lang] ?? 'abc 123';
      try {
        const r = translate(core, sample, t.file);
        const cells = r.ok ? [...r.lines.join('')].filter(c => c.codePointAt(0) >= 0x2800).length : 0;
        if (!r.ok || cells === 0) bad.push(`${t.file}: ${r.error ?? 'empty output'}`);
      } catch (e) {
        bad.push(`${t.file}: ${e.message}`);
      }
    }
  }
  check(`curated tables: all ${n} translate on liblouis 3.36`, bad.length === 0, bad.join('; '));
}

// ---------------------------------------------------------------------------
// 2. SVG module
// ---------------------------------------------------------------------------
section('braille-svg module');
const { brailleToSvg, brailleDots, hasEightDot, SVG_DEFAULTS } = await import(pathToFileURL(join(ROOT, 'app', 'braille-svg.mjs')));

{
  check('brailleDots: dot-1 cell', brailleDots('⠁') === 0b000001);
  check('brailleDots: full 8-dot cell', brailleDots('⣿') === 0xFF);
  check('brailleDots: non-braille char -> 0', brailleDots('a') === 0);
  check('hasEightDot detects dot 7', hasEightDot(['⡁']) === true);
  check('hasEightDot false for 6-dot', hasEightDot(['⠿']) === false);
}
{
  const { svg, widthMm, heightMm, cells } = brailleToSvg(['⠁'], { margin: 4 });
  // width = 2*4 + 6.2*0 + 2.34 + 1.6 = 11.94; height = 8 + (2.34*2+1.6+3.72) - 3.72 = 14.28
  check('SVG: single-cell width math', Math.abs(widthMm - 11.94) < 0.001, String(widthMm));
  check('SVG: single-cell height math', Math.abs(heightMm - 14.28) < 0.001, String(heightMm));
  check('SVG: cells counted', cells === 1);
  check('SVG: mm units + matching viewBox',
    svg.includes(`width="11.94mm"`) && svg.includes(`viewBox="0 0 11.94 14.28"`));
  const m = svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"\/>/);
  check('SVG: dot-1 at (margin+r, margin+r)',
    !!m && Math.abs(+m[1] - 4.8) < 0.001 && Math.abs(+m[2] - 4.8) < 0.001 && Math.abs(+m[3] - 0.8) < 0.001,
    m ? m.slice(1).join(',') : 'no circle');
  check('SVG: role=img + title + desc present',
    svg.includes('role="img"') && svg.includes('<title') && svg.includes('<desc'));
}
{
  const plain = brailleToSvg(['⠁⠂'], {});
  const mirrored = brailleToSvg(['⠁⠂'], { mirrored: true });
  const cx = (s) => [...s.svg.matchAll(/<circle cx="([\d.]+)"/g)].map(m => +m[1]);
  const a = cx(plain), b = cx(mirrored);
  check('SVG: mirrored flips x positions',
    a.length === b.length && a.every((v, i) => Math.abs((v + b[i]) - plain.widthMm) < 0.001),
    `${a} vs ${b}`);
}
{
  const six = brailleToSvg(['⠁'], {});
  const eight = brailleToSvg(['⡁'], {}); // dot 1 + dot 7
  check('SVG: 8-dot line is taller (4 rows)', eight.heightMm > six.heightMm,
    `${six.heightMm} -> ${eight.heightMm}`);
}
{
  const r = brailleToSvg(['⠁'], { emptyDots: 'outline' });
  const outlines = [...r.svg.matchAll(/stroke-opacity/g)].length;
  check('SVG: emptyDots outline group present', outlines === 1 && r.svg.includes('fill="none"'));
}
{
  const r = brailleToSvg(['⠁'], { drillCenters: true });
  check('SVG: drill center crosses present', r.svg.includes('<path d="M '));
}
{
  const r = brailleToSvg(['⠓⠑'], { labelText: 'he' });
  check('SVG: desc embeds source text', r.svg.includes('Source text: he'));
}
{
  const r = brailleToSvg(['⠁'], { labelText: '<script>&"' });
  check('SVG: label is XML-escaped', !r.svg.includes('<script>') && r.svg.includes('&lt;script&gt;'));
}

// ---------------------------------------------------------------------------
// 3. BRF module — validated against liblouis's own en-us-brf.dis
// ---------------------------------------------------------------------------
section('braille-brf module');
const { brailleToBrf } = await import(pathToFileURL(join(ROOT, 'app', 'braille-brf.mjs')));

{
  // Parse the liblouis display table: lines "display <char> <dots>"
  const dis = readFileSync(join(TABLES, 'en-us-brf.dis'), 'latin1');
  const expected = new Map(); // mask -> char
  for (const line of dis.split(/\r?\n/)) {
    const m = line.match(/^display\s+(\S+)\s+(\S+)/);
    if (!m) continue;
    let ch = m[1];
    if (ch === '\\s') ch = ' ';
    if (ch === '\\\\') ch = '\\';
    const dots = m[2];
    let mask = 0;
    if (dots !== '0') for (const d of dots) mask |= 1 << (Number(d) - 1);
    expected.set(mask, ch);
  }
  check('en-us-brf.dis parsed 64 entries', expected.size === 64, String(expected.size));

  let mismatches = [];
  for (let mask = 0; mask < 64; mask++) {
    // Probe each cell in a NON-trailing position (followed by dots-12 'B'):
    // trailing spaces are trimmed from lines, so a lone blank cell would
    // otherwise read back as an empty line.
    const uni = String.fromCodePoint(0x2800 + mask) + '⠃';
    const { brf } = brailleToBrf([uni]);
    const got = brf.replace(/[\r\n\f]/g, '').slice(0, -1);
    const want = expected.get(mask);
    if (got !== want) mismatches.push(`${mask.toString(2)}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
  check('NABCC table matches liblouis en-us-brf.dis for all 64 cells',
    mismatches.length === 0, mismatches.slice(0, 5).join('; '));
}
{
  const lines26 = Array.from({ length: 26 }, () => '⠁');
  const { brf } = brailleToBrf(lines26, { linesPerPage: 25 });
  check('BRF: form feed between pages AND after the final page',
    (brf.match(/\f/g) ?? []).length === 2, JSON.stringify(brf.slice(-8)));
  check('BRF: CRLF line endings', brf.includes('\r\n') && !/[^\r]\n/.test(brf));

  const single = brailleToBrf(['⠁']).brf;
  check('BRF: single-page document still ends with a form feed', single.endsWith('\r\n\f'),
    JSON.stringify(single));
}
{
  const { brf, droppedDots } = brailleToBrf(['⡁⠃']); // dot 1+7, then dot 12
  check('BRF: 8-dot cells counted as dropped', droppedDots === 1);
  check('BRF: 8-dot cell becomes a BLANK, not a wrong-but-valid cell',
    brf.startsWith(' B'), JSON.stringify(brf.slice(0, 4)));
}
{
  const { brf } = brailleToBrf(['⠁⠃⠉'], { cellsPerLine: 0 }); // hostile option
  check('BRF: cellsPerLine 0 clamps instead of crashing', brf.length > 0);
}
{
  // The BRF byte inventory is closed: braille cells 0x20-0x5F plus CR/LF/FF
  // and nothing else (no tabs, no BOM, no lowercase, no 8-bit bytes).
  const es = translate(core, 'café ¿niño? ¡Hola! 3.14', 'es-g1.ctb');
  const en = translate(core, 'Hello World 42 (test) #x', 'en-ueb-g2.ctb');
  const { brf } = brailleToBrf([...es.lines, ...en.lines, '⡁']); // incl. an 8-dot cell
  const bad = [...brf].filter(c => {
    const b = c.charCodeAt(0);
    return !(b === 0x0D || b === 0x0A || b === 0x0C || (b >= 0x20 && b <= 0x5F));
  });
  check('BRF: byte inventory is strictly {CR,LF,FF} + 0x20-0x5F', bad.length === 0,
    JSON.stringify(bad.slice(0, 5)));
}
{
  // A substituted 8-dot cell at end of line must not leave a trailing space.
  const { brf } = brailleToBrf(['⠁⡁']);
  const firstLine = brf.split('\r\n')[0];
  check('BRF: trailing spaces trimmed from lines', firstLine === 'A', JSON.stringify(firstLine));
}

// ---------------------------------------------------------------------------
// 3.5 presets module
// ---------------------------------------------------------------------------
section('presets module');
const { PRESETS, validateDimensions, satisfiedStandards, matchingPreset, linePitchToSpacing } =
  await import(pathToFileURL(join(ROOT, 'app', 'presets.mjs')));

{
  const base = { dotDiameter: 1.5, dotHeight: 0.7, dotPitch: 2.4, cellPitch: 6.2, linePitch: 10.1 };
  check('validateDimensions: clean values pass', validateDimensions(base).errors.length === 0);

  const bad = validateDimensions({ ...base, cellPitch: 4.5 });
  check('validateDimensions: errors are typed to a field',
    bad.errors.length > 0 && bad.errors.every(e => e.field && e.msg));

  const cross = validateDimensions({ ...base, dotPitch: 3.2, cellPitch: 5.5 });
  check('cell-pitch guard attributes to cellPitch (not dot pitch)',
    cross.errors.some(e => e.field === 'cellPitch' && /cell pitch/i.test(e.msg)),
    JSON.stringify(cross.errors));

  const merge = validateDimensions({ ...base, dotDiameter: 2.0, dotPitch: 2.1 });
  check('dot-merge guard attributes to dotPitch',
    merge.errors.some(e => e.field === 'dotPitch'), JSON.stringify(merge.errors));
}
{
  const ada = PRESETS.ada;
  check('ADA preset satisfies ADA §703.3.1', satisfiedStandards(ada).includes('ADA §703.3.1'));
  const marburg = PRESETS.marburg;
  check('Marburg preset satisfies UKAAF / Marburg', satisfiedStandards(marburg).includes('UKAAF / Marburg'));
  // UKAAF spacings are EXACT values (B008): near-misses must NOT earn the badge.
  check('UKAAF badge rejects off-standard spacing (2.4 dot pitch)',
    !satisfiedStandards({ ...marburg, dotPitch: 2.4 }).includes('UKAAF / Marburg'));
  check('BANA preset satisfies ISO 17049', satisfiedStandards(PRESETS.bana).includes('ISO 17049'));
  for (const [id, p] of Object.entries(PRESETS)) {
    if (matchingPreset(p) !== id) { check(`matchingPreset roundtrip: ${id}`, false, matchingPreset(p)); }
  }
  check('matchingPreset roundtrips all presets', true);
  // Warnings: ISO signage practice
  const w = validateDimensions({ ...PRESETS.ada, marginSize: 3, charsPerLine: 50 });
  check('soft warnings: margin + cells-per-line', w.warnings.length >= 2, JSON.stringify(w.warnings));
}
{
  // linePitch -> engine lineSpacing algebra: plate_depth must equal linePitch.
  const v = PRESETS.ada;
  const spacing = linePitchToSpacing(v);
  const plateDepth = v.dotPitch * 2 + v.dotDiameter + spacing;
  check('line pitch algebra: plate_depth == linePitch', Math.abs(plateDepth - v.linePitch) < 1e-9,
    `${plateDepth} vs ${v.linePitch}`);
}

// ---------------------------------------------------------------------------
// 3.6 service worker shell integrity
// ---------------------------------------------------------------------------
section('braille-ascii module');
{
  const { asciiToBraille, describeInvalid } = await import(pathToFileURL(join(ROOT, 'app', 'braille-ascii.mjs')));
  const { NABCC, brailleToBrf } = await import(pathToFileURL(join(ROOT, 'app', 'braille-brf.mjs')));

  // The canonical example: ASCII 'g' is the cell with dots 1-2-4-5 (⠛),
  // which is the Nemeth equals sign.
  check('ascii: g -> dots 1245', asciiToBraille('g').lines[0] === '⠛');
  check('ascii: case folds (G == g)', asciiToBraille('G').lines[0] === asciiToBraille('g').lines[0]);

  // Whole-table round trip: ASCII -> Unicode -> BRF must reproduce the input.
  const all = NABCC.join('');
  const round = brailleToBrf(asciiToBraille(all).lines, { cellsPerLine: 64 }).brf.split('\r\n')[0];
  check('ascii: 64-cell NABCC round-trip', round === all.replace(/ +$/, ''));

  // Spatial layouts (Nemeth worked problems) keep their columns.
  const sp = asciiToBraille('  3+4\n  ---\n    7  ');
  check('ascii: leading blanks preserved', sp.lines[0].startsWith('⠀⠀'));
  check('ascii: trailing blanks trimmed', !sp.lines[2].endsWith('⠀'));
  check('ascii: line structure preserved', sp.lines.length === 3 && [...sp.lines[2]].length === 5);

  // Word-processor damage control + honest flagging.
  const bad = asciiToBraille('“x” é x');
  check('ascii: smart quotes normalized', bad.smartFixes === 2);
  check('ascii: invalid char flagged with position',
    bad.invalid.length === 1 && bad.invalid[0].ch === 'é' && bad.invalid[0].line === 1 && bad.invalid[0].col === 5);
  check('ascii: invalid becomes blank cell so columns stay true', [...bad.lines[0]].length === 7);
  check('ascii: describeInvalid names the spot', describeInvalid(bad.invalid).includes('line 1, column 5'));
  check('ascii: ellipsis expands to three dot cells', asciiToBraille('…').lines[0] === asciiToBraille('...').lines[0]);
  check('ascii: zero-width characters stripped', asciiToBraille('a​b').lines[0] === asciiToBraille('ab').lines[0]);

  // Pasting finished braille next to ASCII entry works.
  check('ascii: unicode braille passes through', asciiToBraille('⠛g').lines[0] === '⠛⠛');
  check('ascii: CRLF handled', asciiToBraille('a\r\nb').lines.length === 2);
}

section('mesh module');
{
  const { MeshBuilder, toBinaryStl, parseBinaryStl } = await import(pathToFileURL(join(ROOT, 'app', 'mesh.mjs')));
  const { default: earcut } = await import(pathToFileURL(join(ROOT, 'app', 'vendor', 'earcut.mjs')));

  // Every directed edge in a closed shell has exactly one reverse partner.
  const nonManifoldEdges = (t) => {
    const edges = new Map();
    const vk = (x, y, z) => `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    for (let i = 0; i < t.length; i += 9) {
      const v = [vk(t[i], t[i + 1], t[i + 2]), vk(t[i + 3], t[i + 4], t[i + 5]), vk(t[i + 6], t[i + 7], t[i + 8])];
      for (let e = 0; e < 3; e++) {
        const k = v[e] + '|' + v[(e + 1) % 3];
        edges.set(k, (edges.get(k) || 0) + 1);
      }
    }
    let bad = 0;
    for (const [k, n] of edges) {
      const [a, b] = k.split('|');
      if (n !== 1 || (edges.get(b + '|' + a) || 0) !== 1) bad++;
    }
    return bad;
  };
  // Signed volume: positive means outward-facing winding throughout.
  const signedVolume = (t) => {
    let vol = 0;
    for (let i = 0; i < t.length; i += 9) {
      vol += (t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7])
            + t[i + 1] * (t[i + 5] * t[i + 6] - t[i + 3] * t[i + 8])
            + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6])) / 6;
    }
    return vol;
  };

  const dotMesh = new MeshBuilder();
  dotMesh.dot(0, 0, 0, 0.75, 0.7);
  check('mesh: dot solid is watertight', nonManifoldEdges(dotMesh.t) === 0);
  check('mesh: dot winding faces outward', signedVolume(dotMesh.t) > 0);

  // A plate with a hole: the screw-hole construction pattern.
  const verts = [0, 0, 40, 0, 40, 20, 0, 20, 8, 6, 14, 6, 14, 14, 8, 14];
  const tris = earcut(verts, [4]);
  const plate = new MeshBuilder();
  plate.prism(verts, tris, [[0, 1, 2, 3], [7, 6, 5, 4]], 0, 2);
  check('mesh: prism with hole is watertight', nonManifoldEdges(plate.t) === 0);
  const vol = signedVolume(plate.t);
  check('mesh: prism-with-hole volume correct', Math.abs(vol - (40 * 20 * 2 - 6 * 8 * 2)) < 1e-6, String(vol));

  const stlBytes = toBinaryStl(dotMesh.t, 'x');
  const parsed = parseBinaryStl(stlBytes);
  check('mesh: binary STL round-trip', !!parsed && parsed.length === dotMesh.t.length);
  check('mesh: STL parser rejects malformed input', parseBinaryStl(new Uint8Array(10)) === null);
}

section('fonts + sign-mesh modules');
{
  const otMod = await import(pathToFileURL(join(ROOT, 'app', 'vendor', 'opentype.mjs')));
  const parseFont = otMod.parse ?? otMod.default?.parse;
  const { glyphPolygons, layoutLine } = await import(pathToFileURL(join(ROOT, 'app', 'fonts.mjs')));
  const { buildSign, SIGN_DEFAULTS } = await import(pathToFileURL(join(ROOT, 'app', 'sign-mesh.mjs')));

  // Every shipped subset parses and yields lettering geometry (opentype.js
  // 2.0.0 is newly released — this is the pin-and-verify guard).
  const faces = ['atkinson-400', 'atkinson-700', 'arimo-400', 'arimo-700', 'jbmono-700'];
  const fonts = {};
  let parsed = 0;
  for (const f of faces) {
    const buf = readFileSync(join(ROOT, 'assets', 'fonts', 'geometry', `${f}.ttf`));
    const font = parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    fonts[f] = font;
    if (layoutLine(font, 'ROOM 101 Café', 19).glyphs.length === 11) parsed++;
  }
  check('fonts: all 5 subsets parse and lay out Latin-1 text', parsed === 5, String(parsed));

  const atk = fonts['atkinson-400'];
  const O = glyphPolygons(atk, atk.charToGlyph('O'), 0.02);
  const B = glyphPolygons(atk, atk.charToGlyph('B'), 0.02);
  check('fonts: counters classified as holes (O=1+1, B=1+2)',
    O.length === 1 && O[0].holes.length === 1 && B.length === 1 && B[0].holes.length === 2);
  const metrics = layoutLine(atk, 'I', 19);
  check('fonts: default face meets the ADA raised-stroke rule (<=15%)',
    metrics.strokePct != null && metrics.strokePct <= 15, String(metrics.strokePct));
  check('fonts: proportions inside the ADA 60-110% window',
    metrics.oiPct != null && metrics.oiPct >= 60 && metrics.oiPct <= 110, String(metrics.oiPct));

  // Sign shells must be watertight with outward winding in every style.
  const nonManifoldEdges = (t) => {
    const edges = new Map();
    const vk = (x, y, z) => `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    for (let i = 0; i < t.length; i += 9) {
      const v = [vk(t[i], t[i + 1], t[i + 2]), vk(t[i + 3], t[i + 4], t[i + 5]), vk(t[i + 6], t[i + 7], t[i + 8])];
      for (let e = 0; e < 3; e++) {
        const k = v[e] + '|' + v[(e + 1) % 3];
        edges.set(k, (edges.get(k) || 0) + 1);
      }
    }
    let bad = 0;
    for (const [k, n] of edges) {
      const [a, b] = k.split('|');
      if (n !== 1 || (edges.get(b + '|' + a) || 0) !== 1) bad++;
    }
    return bad;
  };
  const signedVolume = (t) => {
    let vol = 0;
    for (let i = 0; i < t.length; i += 9) {
      vol += (t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7])
            + t[i + 1] * (t[i + 5] * t[i + 6] - t[i + 3] * t[i + 8])
            + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6])) / 6;
    }
    return vol;
  };

  const d = SIGN_DEFAULTS;
  const layout = layoutLine(atk, 'ROOM 101', 19, 0.5);
  const params = (style) => ({
    textLayouts: [layout], lineSpacingMm: 19 * 1.5, capHeightMm: 19,
    brailleLines: ['⠐⠗⠕⠕⠍⠀⠼⠁⠚⠁'], textStyle: style, textRelief: d.textRelief,
    gapTextBraille: d.gapTextBraille, margin: d.margin, plateThickness: d.plateThickness,
    cornerRadius: d.cornerRadius, holeLayout: '4', holeDiameter: 4.27, holeInset: d.holeInset,
    align: 'center', plateW: 0, plateH: 0, bedSize: 220,
    dotDiameter: d.dotDiameter, dotHeight: d.dotHeight, dotPitch: d.dotPitch,
    cellPitch: d.cellPitch, linePitch: d.linePitch,
  });
  for (const style of ['raised', 'recessed', 'flush']) {
    const sign = buildSign(params(style));
    // The plate shell and each glyph prism are separate closed shells in the
    // raised style, so watertightness is checked per style via edge pairing —
    // multi-shell output still pairs every directed edge within its shell.
    check(`sign(${style}): watertight shell set`, nonManifoldEdges(sign.plate.t) === 0);
    check(`sign(${style}): outward winding (positive volume)`, signedVolume(sign.plate.t) > 0);
    if (style === 'flush') {
      check('sign(flush): inserts mesh watertight', sign.inserts && nonManifoldEdges(sign.inserts.t) === 0);
    }
    if (style === 'raised') {
      check('sign(raised): no warnings at ADA defaults', sign.warnings.length === 0, sign.warnings.join('; '));
    } else {
      check(`sign(${style}): carries the not-ADA-tactile warning`,
        sign.warnings.some(w => w.includes('not ADA-tactile')));
    }
  }
  const over = buildSign({ ...params('raised'), capHeightMm: 60,
    textLayouts: [layoutLine(atk, 'VERY LONG CORRIDOR NAME', 60, 0.5)] });
  check('sign: bed-size overflow warns instead of shrinking braille',
    over.warnings.some(w => w.includes('print bed')));

  // Braille placement: on a braille-only sign the bottom dot's lowest edge
  // must sit exactly one margin above the plate edge (the doubled-radius
  // regression put it 0.775 mm low).
  {
    const only = buildSign({ ...params('raised'), textLayouts: [], brailleLines: ['⠿'], holeLayout: 'none' });
    let minY = Infinity, minZ = Infinity;
    const t = only.plate.t;
    for (let i = 0; i < t.length; i += 9) {
      for (let v = 0; v < 3; v++) {
        const y = t[i + v * 3 + 1], z = t[i + v * 3 + 2];
        if (z > d.plateThickness + 0.01 && y < minY) minY = y;   // dot geometry only
      }
    }
    void minZ;
    const expected = d.margin;   // block bottom edge = margin above the plate edge
    check('sign: braille block sits exactly one margin from the edge',
      Math.abs(minY - expected) < 0.05, `${minY.toFixed(3)} vs ${expected}`);
  }

  // Large corner radius with a small margin must not corrupt recessed shells;
  // the plate grows instead (with a warning).
  {
    const tight = buildSign({ ...params('recessed'), margin: 3, cornerRadius: 20, holeLayout: 'none' });
    check('sign: corner radius vs margin keeps the shell watertight',
      nonManifoldEdges(tight.plate.t) === 0);
    check('sign: corner-radius growth is announced',
      tight.warnings.some(w => w.includes('corner radius')));
  }

  // All-blank braille override adds no phantom block.
  {
    const a = buildSign({ ...params('raised'), brailleLines: [''] });
    const b = buildSign({ ...params('raised'), brailleLines: [] });
    check('sign: all-blank braille reserves no plate space', a.heightMm === b.heightMm && a.dotCount === 0);
  }
}

section('metrics module (logic only)');
{
  const src = readFileSync(join(ROOT, 'app', 'metrics.mjs'), 'utf8');
  check('metrics: honors Global Privacy Control', src.includes('globalPrivacyControl'));
  check('metrics: event allowlist only', src.includes("new Set([") && src.includes('generate-stl'));
  check('metrics: same-origin beacon path', src.includes("'/api/event/'"));
  check('metrics: no user text in payload (the event name is the whole request)',
    src.includes("fetch('/api/event/' + name"));
  const docs = readFileSync(join(ROOT, 'docs.html'), 'utf8');
  check('docs: privacy section discloses the beacon honestly',
    docs.includes('generate-stl') && docs.includes('Global Privacy Control') && docs.includes('metricsToggle'));
  check('docs: no stale absolute no-analytics claim', !docs.includes('no analytics, no tracking'));
}

section('service worker');
{
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const m = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  const files = [...m[1].matchAll(/'\.\/([^']+)'/g)].map(x => x[1]);
  const missing = files.filter(f => { try { readFileSync(join(ROOT, f)); return false; } catch { return true; } });
  check(`sw.js SHELL entries all exist on disk (${files.length})`, files.length > 10 && missing.length === 0,
    missing.join(', '));
}

// ---------------------------------------------------------------------------
// 4. Tables manifest
// ---------------------------------------------------------------------------
section('tables manifest');
{
  check('manifest covers all table files',
    manifest.count >= 400 && Object.keys(manifest.tables).length === manifest.count);
  const g2 = manifest.tables['en-ueb-g2.ctb'];
  check('en-ueb-g2 closure includes g1 + braille-patterns',
    g2 && g2.files.includes('en-ueb-g1.ctb') && g2.files.includes('braille-patterns.cti'),
    JSON.stringify(g2?.files));
  const missing = [];
  for (const [t, e] of Object.entries(manifest.tables)) {
    for (const f of e.files) {
      try { readFileSync(join(TABLES, f)); } catch { missing.push(`${t} -> ${f}`); }
    }
    if (missing.length > 3) break;
  }
  check('every manifest file exists on disk', missing.length === 0, missing.slice(0, 3).join('; '));
}

// ---------------------------------------------------------------------------
// 5. STL engine (slow — skipped with --fast)
// ---------------------------------------------------------------------------
if (!FAST) {
  section('stl engine: geometry');
  const stl = await loadEngine('stl');

  {
    const r = translate(stl, 'café niño', 'es-g1.ctb');
    check('stl engine translation parity with core',
      r.ok && r.lines[0] === '⠉⠁⠋⠮⠀⠝⠊⠻⠕',
      JSON.stringify(r));
  }
  const stlBbox = (bytes) => {
    const tri = new DataView(bytes.buffer, bytes.byteOffset + 80, 4).getUint32(0, true);
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tri; i++) {
      const off = 84 + i * 50 + 12;
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          const v = dv.getFloat32(off + j * 12 + k * 4, true);
          bb[k] = Math.min(bb[k], v); bb[3 + k] = Math.max(bb[3 + k], v);
        }
      }
    }
    return { x: bb[3] - bb[0], y: bb[4] - bb[1], z: bb[5] - bb[2], tri };
  };

  {
    writeTables(stl, 'en-ueb-g2.ctb');
    const fname = stl.ccall('generateBrailleSTL', 'string',
      ['string', 'number', 'string', 'number', 'number', 'number', 'number', 'number', 'boolean', 'boolean', 'number', 'number', 'number'],
      ['hello world', 32, 'en-ueb-g2.ctb', 0.6, 1.0, 3.72, 1.0, 1.0, false, false, 1.6, 2.34, 6.2]);
    check('STL: file generated', !!fname, fname);
    const bytes = stl.FS.readFile(fname);
    check('STL: non-trivial size', bytes.length > 100000, String(bytes.length));
    const header = Buffer.from(bytes.slice(0, 34)).toString('latin1');
    check('STL: binary header', header === 'Binary STL generated by BrailleGen');
    const triCount = new DataView(bytes.buffer, bytes.byteOffset + 80, 4).getUint32(0, true);
    check('STL: triangle count matches payload size',
      bytes.length === 84 + triCount * 50, `${triCount} tris, ${bytes.length} bytes`);
  }
  {
    // "What you preview is what you print": the STL bounding box must match
    // the SVG module's plate math for the same parameters (multi-line, ragged).
    const params = { dotDiameter: 1.5, dotPitch: 2.4, cellPitch: 6.2, lineSpacing: 10.1 - (2 * 2.4 + 1.5), margin: 6 };
    const r = translate(stl, 'first line\nsecond longer line here', 'en-ueb-g1.ctb', 32);
    const fname = stl.ccall('generateBrailleSTL', 'string',
      ['string', 'number', 'string', 'number', 'number', 'number', 'number', 'number', 'boolean', 'boolean', 'number', 'number', 'number'],
      ['first line\nsecond longer line here', 32, 'en-ueb-g1.ctb', 0.7, 2.0, params.lineSpacing, 6.0, 1.0, false, false, 1.5, 2.4, 6.2]);
    const bytes = stl.FS.readFile(fname);
    const bb = stlBbox(bytes);
    const svgDims = brailleToSvg(r.lines, params);
    check('geometry parity: STL bbox width == SVG widthMm',
      Math.abs(bb.x - svgDims.widthMm) < 0.02, `${bb.x.toFixed(3)} vs ${svgDims.widthMm}`);
    check('geometry parity: STL bbox depth == SVG heightMm',
      Math.abs(bb.y - svgDims.heightMm) < 0.02, `${bb.y.toFixed(3)} vs ${svgDims.heightMm}`);
    check('geometry parity: STL height = plate + dot',
      Math.abs(bb.z - 2.7) < 0.02, bb.z.toFixed(3));
  }
  {
    // 8-dot geometry: taller cells must not crash and must produce output
    writeTables(stl, 'en-us-comp8-ext.utb');
    const fname = stl.ccall('generateBrailleSTL', 'string',
      ['string', 'number', 'string', 'number', 'number', 'number', 'number', 'number', 'boolean', 'boolean', 'number', 'number', 'number'],
      ['ABC', 32, 'en-us-comp8-ext.utb', 0.6, 1.0, 3.72, 1.0, 1.0, false, false, 1.6, 2.34, 6.2]);
    const bytes = stl.FS.readFile(fname);
    check('STL: 8-dot generation works (dots 7/8 rendered)', bytes.length > 50000, String(bytes.length));
  }
  {
    // Slab mode + vertical export smoke
    const fname = stl.ccall('generateBrailleSTL', 'string',
      ['string', 'number', 'string', 'number', 'number', 'number', 'number', 'number', 'boolean', 'boolean', 'number', 'number', 'number'],
      ['hi', 32, 'en-ueb-g2.ctb', 0.6, 1.0, 3.72, 2.0, 1.0, true, true, 1.5, 2.5, 6.0]);
    const bytes = stl.FS.readFile(fname);
    check('STL: slab + vertical + custom geometry params', bytes.length > 10000, String(bytes.length));
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed${FAST ? ' (fast mode: STL skipped)' : ''}`);
if (failures.length) {
  console.log('Failures:'); for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
