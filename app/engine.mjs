// engine.mjs — loads and drives the two wasm engines.
//
//   core (engine/core.js + core.wasm, ~0.3 MB): liblouis translation only.
//     Loaded at startup; powers the live preview, SVG, BRF and copy actions.
//   stl  (engine/stl.js + stl.wasm, ~9.6 MB): translation + OpenCASCADE.
//     Lazy-loaded the first time an STL is requested, with download progress.
//
// liblouis tables are NOT embedded in the wasm. Each table's include-closure
// (from engine/tables-manifest.json) is fetched on demand from
// liblouis/tables/ and written into the module's MEMFS under /tables.
// Fetched table bytes are cached in JS so the STL engine reuses them without
// refetching; the service worker caches network requests for offline use.
//
// AGPL-3.0 — part of the BrailleGen fork.

const BASE = new URL('..', import.meta.url); // repo root

const state = {
  manifest: null,
  core: null,
  stl: null,
  corePromise: null,
  stlPromise: null,
  tableBytes: new Map(),          // filename -> Uint8Array
  written: { core: new Set(), stl: new Set() },
  logSinks: [],
};

/** Subscribe to engine console output: fn(line, isError). Returns unsubscribe. */
export function onEngineLog(fn) {
  state.logSinks.push(fn);
  return () => {
    const i = state.logSinks.indexOf(fn);
    if (i >= 0) state.logSinks.splice(i, 1);
  };
}

function log(line, isError = false) {
  for (const fn of state.logSinks) {
    try { fn(String(line), isError); } catch { /* sink errors never propagate */ }
  }
}

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

export async function getManifest() {
  if (!state.manifest) {
    const res = await fetchOk(new URL('engine/tables-manifest.json', BASE));
    state.manifest = await res.json();
  }
  return state.manifest;
}

/** Fetch a URL to bytes with progress callbacks ({loaded, total|null}). */
async function fetchBytes(url, onProgress) {
  const res = await fetchOk(url);
  const total = Number(res.headers.get('Content-Length')) || null;
  if (!res.body || !onProgress) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.({ loaded: buf.length, total: total ?? buf.length });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({ loaded, total });
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function moduleConfig(extra = {}) {
  return {
    print: (t) => log(t, false),
    printErr: (t) => log(t, true),
    ...extra,
  };
}

/** Load the small translator engine (idempotent, retryable after failure). */
export function loadCore() {
  if (!state.corePromise) {
    state.corePromise = (async () => {
      const { default: createBrailleCore } = await import(new URL('engine/core.js', BASE));
      state.core = await createBrailleCore(moduleConfig());
      log(`[engine] core ready`);
      return state.core;
    })();
    state.corePromise.catch(() => { state.corePromise = null; }); // allow retry
  }
  return state.corePromise;
}

/** Gunzip a byte buffer via DecompressionStream. */
async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Load the STL engine (idempotent), reporting download progress. */
export function loadStl(onProgress) {
  if (!state.stlPromise) {
    state.stlPromise = (async () => {
      // GitHub Pages serves .wasm uncompressed; we ship a pre-gzipped copy and
      // inflate client-side (~3x smaller download). Falls back to the plain
      // binary when the .gz is missing or DecompressionStream is unavailable.
      let wasmBinary = null;
      if (typeof DecompressionStream === 'function') {
        try {
          const gz = await fetchBytes(new URL('engine/stl.wasm.gz', BASE), onProgress);
          wasmBinary = await gunzip(gz);
        } catch { /* fall through to the plain binary */ }
      }
      if (!wasmBinary) {
        wasmBinary = await fetchBytes(new URL('engine/stl.wasm', BASE), onProgress);
      }
      const { default: createBrailleStl } = await import(new URL('engine/stl.js', BASE));
      state.stl = await createBrailleStl(moduleConfig({ wasmBinary }));
      log(`[engine] stl ready (${(wasmBinary.length / 1048576).toFixed(1)} MB)`);
      return state.stl;
    })();
    state.stlPromise.catch(() => { state.stlPromise = null; }); // allow retry
  }
  return state.stlPromise;
}

/** True once the STL engine finished loading. */
export function stlReady() {
  return !!state.stl;
}

/** Ensure a table's full include-closure exists in the module's MEMFS. */
async function ensureTables(which, mod, table) {
  const manifest = await getManifest();
  const entry = manifest.tables[table];
  if (!entry) throw new Error(`Unknown braille table: ${table}`);
  const written = state.written[which];

  const need = entry.files.filter(f => !written.has(f));
  if (need.length === 0) return;

  // tableBytes stores PROMISES so concurrent ensureTables calls for the same
  // table share one in-flight fetch instead of double-fetching.
  await Promise.all(need.map(async (f) => {
    if (!state.tableBytes.has(f)) {
      const p = fetchBytes(new URL(`liblouis/tables/${f}`, BASE));
      p.catch(() => state.tableBytes.delete(f)); // failed fetches are retryable
      state.tableBytes.set(f, p);
    }
    await state.tableBytes.get(f);
  }));

  try { mod.FS.mkdir('/tables'); } catch { /* exists */ }
  for (const f of need) {
    mod.FS.writeFile(`/tables/${f}`, await state.tableBytes.get(f));
    written.add(f);
  }
}

/**
 * Translate text to wrapped Unicode braille lines.
 * @returns {Promise<{ok:boolean, lines?:string[], eightDot?:boolean, error?:string}>}
 */
export async function translate(text, table, maxCharsPerLine) {
  const core = await loadCore();
  await ensureTables('core', core, table);
  const json = core.ccall('translateBraille', 'string',
    ['string', 'number', 'string'],
    [text, maxCharsPerLine | 0, table]);
  try {
    return JSON.parse(json);
  } catch {
    return { ok: false, error: 'Engine returned malformed output.' };
  }
}

/**
 * Generate a 3D-printable STL.
 * @param {object} p - {text, table, charsPerLine, brailleHeight, plateHeight,
 *   lineSpacing, marginSize, stlScale, slabMode, verticalExport,
 *   dotDiameter, dotPitch, cellPitch}
 * @param {function} [onProgress] - STL engine download progress.
 * @returns {Promise<{filename:string, bytes:Uint8Array}>}
 */
export async function generateStl(p, onProgress) {
  const stl = await loadStl(onProgress);
  await ensureTables('stl', stl, p.table);
  const filename = stl.ccall('generateBrailleSTL', 'string',
    ['string', 'number', 'string', 'number', 'number', 'number', 'number',
     'number', 'boolean', 'boolean', 'number', 'number', 'number'],
    [p.text, p.charsPerLine | 0, p.table,
     +p.brailleHeight, +p.plateHeight, +p.lineSpacing, +p.marginSize,
     +p.stlScale, !!p.slabMode, !!p.verticalExport,
     +p.dotDiameter, +p.dotPitch, +p.cellPitch]);
  if (!filename) throw new Error('STL generation failed — see the console panel for details.');
  const bytes = stl.FS.readFile(filename);
  try { stl.FS.unlink(filename); } catch { /* MEMFS cleanup is best-effort */ }
  return { filename, bytes };
}
