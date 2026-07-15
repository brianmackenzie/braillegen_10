// Generate engine/tables-manifest.json: for every liblouis table, the full
// include-closure (the set of files that must exist under /tables in the wasm
// MEMFS before liblouis can compile the table).
//
// The app fetches exactly closure(table) on demand instead of embedding all
// ~14 MB of tables into the wasm binaries.
//
// Usage: node tools/gen-tables-manifest.mjs
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TABLES_DIR = join(ROOT, 'liblouis', 'tables');
const OUT = join(ROOT, 'engine', 'tables-manifest.json');

// braille-patterns.cti is prepended to every translation (it maps dot
// patterns to Unicode braille), so it is part of every closure.
const ALWAYS = ['braille-patterns.cti'];

const cache = new Map();

function closure(name, stack = []) {
  if (cache.has(name)) return cache.get(name);
  if (stack.includes(name)) return new Set([name]); // include cycle: stop
  const p = join(TABLES_DIR, name);
  let src;
  try {
    src = readFileSync(p, 'latin1');
  } catch {
    return new Set(); // missing include -> omit (liblouis will report at runtime)
  }
  const deps = new Set([name]);
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\s*include\s+(\S+)/i);
    if (m) {
      for (const d of closure(m[1], [...stack, name])) deps.add(d);
    }
  }
  cache.set(name, deps);
  return deps;
}

const entries = {};
let count = 0;
for (const f of readdirSync(TABLES_DIR).sort()) {
  const st = statSync(join(TABLES_DIR, f));
  if (!st.isFile()) continue;
  // Manifest every plausible entry table; include-only files (.uti/.cti/.dis)
  // still get entries (harmless) so the resolver never 404s.
  const deps = new Set(ALWAYS);
  for (const d of closure(f)) deps.add(d);
  let bytes = 0;
  for (const d of deps) {
    try { bytes += statSync(join(TABLES_DIR, d)).size; } catch {}
  }
  entries[f] = { files: [...deps].sort(), bytes };
  count++;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  generated_by: 'tools/gen-tables-manifest.mjs',
  tables_dir: 'liblouis/tables/',
  count,
  tables: entries,
}, null, 1));
console.log(`wrote ${OUT}: ${count} tables`);
