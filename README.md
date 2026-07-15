# BrailleGen

**Free, offline, open-source braille asset generator.** Type text, verify the
braille, and export it as:

- **STL** — 3D-printable braille tiles and signs (parametric plate + dome dots)
- **SVG** — physically-accurate vector art in true millimetre units, for laser
  engraving, swell/microcapsule paper, raster-bead signage (drill marks), and
  back-side embossing templates (mirrored)
- **BRF** — embosser-ready Braille ASCII (25-line pages, form feeds)
- **Unicode braille** — copy or download the translated text itself

Translation runs [liblouis](https://liblouis.io) 3.36.0 — the engine behind
NVDA, JAWS and BrailleBlaster — compiled to WebAssembly. Everything happens in
the browser: no server, no tracking, works offline after the first visit.

**Upstream live app:** https://braillegen.org (this fork deploys the same way —
GitHub Pages from the repo root, no build step).

## Why this fork

This is a modernization of [BrailleGen 10B](https://github.com/Richhe01/braillegen_10)
by Richhe01. It keeps the original's excellent core idea (liblouis + OpenCASCADE
in one WASM, fully client-side) and rebuilds everything around it:

| | Upstream 10B | This fork |
|---|---|---|
| Time to interactive | 26 MB monolithic wasm gates everything | 0.26 MB translator loads first; 9.6 MB STL engine lazy-loads on demand (gzipped to ~3.5 MB) |
| Accented characters | mojibake (UTF-8 bytes fed to liblouis one byte at a time) | correct UTF-8 → UTF-16 decoding — `café niño` translates cleanly |
| 8-dot braille | dots 7/8 silently dropped | full 8-dot support end-to-end (preview, SVG, STL geometry) |
| Braille preview | none — download STL to find out | live dual-audience preview: real Unicode braille text (readable on refreshable braille displays) + visual dot layout |
| Languages exposed | 5 tables | 36 curated tables across 4 groups (all 461 shipped tables addressable); tables lazy-load per language |
| Dimensions | hardcoded | named presets — ADA §703.3.1, California CBC, BANA/LoC, Marburg/UKAAF, Jumbo — plus validated custom values with live standards-compliance badges |
| Outputs | STL only | STL + SVG + BRF + Unicode text + clipboard |
| Accessibility | focus outlines removed, no announcements, tabs without semantics | WCAG 2.2 AA target: live regions, visible focus, keyboard-complete, forced-colors, reduced-motion, 7:1 text contrast |
| Offline | claimed | real: installable PWA with a service worker |
| Tests | none | 74 engine/module checks (golden UEB vectors, geometry parity, adversarial inputs) + a 19-check real-browser suite |

## Architecture

```
index.html / docs.html      app shell (semantic HTML, no framework, no build step)
app/
  app.mjs                   UI logic (ES modules)
  engine.mjs                wasm loading, lazy table fetching, progress
  braille-svg.mjs           braille -> SVG renderer (mm-true; mirrors the STL math)
  braille-brf.mjs           Unicode braille -> BRF (NABCC)
  tables.mjs                curated table registry
  presets.mjs               dimensional standards, clamps, validation
  app.css                   design system (OKLCH, light/dark/forced-colors)
main.cpp                    the wasm engine source (one file, two targets)
engine/
  core.js/.wasm             liblouis translator (~0.26 MB)
  stl.js/.wasm(.gz)         liblouis + OpenCASCADE STL generator (lazy)
  tables-manifest.json      per-table include-closure for lazy loading
liblouis/                   prebuilt liblouis.a + 461 translation tables (served as-is)
occt/                       prebuilt OpenCASCADE 8.0 static libs (see BUILDING.md)
tests/run-tests.mjs         the test suite (node tests/run-tests.mjs)
tools/                      build tooling (tables manifest, OCCT headers)
```

The same `translateAndWrap` pipeline in `main.cpp` feeds the preview, the SVG,
the BRF and the STL, so **what you preview is what you print** — and the test
suite asserts core/STL translation parity.

## Development

Serve the repo root over HTTP (ES modules + wasm don't run from `file:`):

```
python3 -m http.server    # then open http://localhost:8000
```

Run the tests (requires Node 18+):

```
node tests/run-tests.mjs          # full suite, including STL geometry
node tests/run-tests.mjs --fast   # skip the slow STL engine tests
```

Rebuilding the wasm engines requires emscripten — see [BUILDING.md](BUILDING.md).
The deployed site needs no build step at all: it is static files.

### Deploying

The site is plain static files — GitHub Pages, S3+CloudFront, Netlify, or any
web server works. Requirements that bite if missed:

1. **HTTPS.** The service worker (offline support) and the clipboard API only
   run on secure origins.
2. **Content types.** Serve `.wasm` as `application/wasm`, `.mjs` as
   `text/javascript`, `.webmanifest` as `application/manifest+json` — and
   `.wasm.gz` as `application/gzip` **without** a `Content-Encoding` header
   (the app inflates it client-side; transparent decoding double-decompresses).
3. **AGPL.** Update the GitHub/Source links in `index.html` and `docs.html`
   (nav, footer, issues) to point at the repository actually serving your
   deployment — a network-deployed modification must offer its own source.
4. Bump `VERSION` in `sw.js` on every deploy so returning visitors' service
   workers pick up the new build.

## Extending

The codebase is deliberately layered so common extensions are one-file changes:

- **Expose another language.** Add an entry to `app/tables.mjs` (the table file
  must exist in `liblouis/tables/`; all 461 shipped tables are already covered
  by `engine/tables-manifest.json`). The test suite's curated-table smoke test
  picks it up automatically — run `node tests/run-tests.mjs --fast` to verify
  it translates on the shipped liblouis build. On 16-bit builds like this one,
  prefer `-ucs2` table variants where they exist.
- **Add a dimensional preset.** Add it to `PRESETS` in `app/presets.mjs` and
  the table in `docs.html`. `matchingPreset`/`satisfiedStandards` and the
  preset round-trip test cover it from there; cite the standard in the note.
- **Add an export format.** `translate()` (in `app/engine.mjs`) returns wrapped
  Unicode braille lines; write a pure module that consumes them (see
  `app/braille-brf.mjs` for the pattern — ~60 lines), add a button in
  `index.html`, wire it in `app/app.mjs` next to the other export handlers,
  and give it a section in `tests/run-tests.mjs`.
- **Change the engine.** `main.cpp` builds both wasm targets (`build.sh`,
  prerequisites in [BUILDING.md](BUILDING.md)). The golden-vector tests are the
  safety net — run the full suite after any engine change.

## License & credits

- **AGPL-3.0** — see [LICENSE.md](LICENSE.md). Fork of
  [Richhe01/braillegen_10](https://github.com/Richhe01/braillegen_10).
- [liblouis](https://liblouis.io) (LGPL-2.1-or-later) — braille translation +
  tables, bundled unmodified.
- [Open CASCADE Technology](https://dev.opencascade.org) 8.0 (LGPL-2.1 with
  exception) — 3D geometry kernel.
- [Atkinson Hyperlegible](https://www.brailleinstitute.org/freefont/) (SIL OFL)
  — the Braille Institute's low-vision typeface.

Braille dimension presets are sourced from ADA 2010 §703.3.1, California CBC
11B-703.3.1, BANA/Library of Congress Specification 800, UKAAF B008 / Marburg
Medium, ISO 17049, and Perkins/RNIB jumbo geometry. See `docs.html` for the
full table and printing guidance.
