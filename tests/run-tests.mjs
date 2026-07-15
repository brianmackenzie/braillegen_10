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
  check('UTF-8 fix: Spanish accents translate cleanly',
    r.ok && r.lines[0] === '⠉⠁⠋⠮⠀⠝⠊⠻⠕',
    JSON.stringify(r));
  check('UTF-8 fix: single line output (upstream produced 2 garbage lines)',
    r.ok && r.lines.length === 1, JSON.stringify(r.lines));
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

// Golden UEB vectors (research pass 2026-07-15; see docs/research-synthesis.json)
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
    const uni = String.fromCodePoint(0x2800 + mask);
    const { brf } = brailleToBrf([uni]);
    const got = brf.replace(/[\r\n]/g, '');
    const want = expected.get(mask);
    if (got !== want) mismatches.push(`${mask.toString(2)}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
  check('NABCC table matches liblouis en-us-brf.dis for all 64 cells',
    mismatches.length === 0, mismatches.slice(0, 5).join('; '));
}
{
  const lines = Array.from({ length: 26 }, (_, i) => '⠁');
  const { brf } = brailleToBrf(lines, { linesPerPage: 25 });
  check('BRF: form feed after 25 lines', brf.includes('\f'));
  check('BRF: CRLF line endings', brf.includes('\r\n') && !/[^\r]\n/.test(brf));
}
{
  const { droppedDots } = brailleToBrf(['⡁']); // dot 1 + dot 7
  check('BRF: 8-dot cells counted as dropped', droppedDots === 1);
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
