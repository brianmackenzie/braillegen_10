# Building the BrailleGen wasm engines

The deployed site is static — you only need this if you change `main.cpp`.

## Prerequisites

1. **emsdk** (verified with emcc 6.0.3):

   ```bash
   git clone https://github.com/emscripten-core/emsdk.git
   cd emsdk
   python emsdk.py install latest
   python emsdk.py activate latest
   # put emcc on PATH; on Windows/Git-Bash the wrapper scripts may resolve the
   # Microsoft Store python shim — if `./emsdk` prints "Python was not found",
   # call `python emsdk.py ...` directly and export:
   #   EMSDK=<emsdk-dir>  EM_CONFIG=<emsdk-dir>/.emscripten
   #   EMSDK_PYTHON=<emsdk-dir>/python/<ver>/python.exe
   #   PATH=<emsdk-dir>/upstream/emscripten:$PATH
   ```

2. **Node 18+** (tables manifest + tests).

3. **OpenCASCADE 8.0 headers.** The `occt/include/` directory committed in this
   repo contains *forwarding stubs* generated on the original author's machine —
   each hardcodes an absolute `/home/rhe/OCCT/...` path and cannot compile
   anywhere else. The prebuilt `occt/lib/*.a` archives are fine; only headers
   are needed:

   ```bash
   git clone --depth 1 --branch V8_0_0_p1 https://github.com/Open-Cascade-SAS/OCCT.git ../occt-src
   ./tools/make-occt-include.sh ../occt-src ../occt-flat-include
   export OCCT_INCLUDE=$(cd ../occt-flat-include && pwd)
   ```

   Match the OCCT tag to the version of the committed libs (currently 8.0 — the
   app console prints it at startup).

## Build

```bash
./build.sh
```

Produces:

- `engine/core.js` + `engine/core.wasm` — liblouis-only translator
  (`-DBRAILLEGEN_CORE_ONLY`), ~0.26 MB
- `engine/stl.js` + `engine/stl.wasm` (+ `.gz`) — translator + OpenCASCADE STL
  generator, ~9.6 MB (~3.5 MB gzipped)
- `engine/tables-manifest.json` — include-closure per table, generated from
  `liblouis/tables/` by `tools/gen-tables-manifest.mjs`

Tables are **not** embedded in the wasm: the app fetches each table's closure
from `liblouis/tables/` on demand and writes it into the module's MEMFS.

Notes that will save you time:

- `-s STACK_SIZE=5242880` is load-bearing: liblouis's table compiler recurses
  through `include` chains and overflows the 64 KB emscripten default stack.
- The prebuilt `.a` archives link cleanly with newer emsdk releases in practice
  (wasm object format is stable), but emscripten does not *guarantee* ABI
  stability across versions — after any emsdk upgrade, run the test suite; the
  golden vectors + STL geometry checks are the canary.
- liblouis is a UCS-2 (16-bit `widechar`) build; `main.cpp` decodes UTF-8 to
  UTF-16 before calling it. Japanese kantenji requires the `-ucs2` table
  variant for exactly this reason.

## Test

```bash
node tests/run-tests.mjs
```

Runs the translation golden vectors (validated against liblouis's own display
tables), the SVG/BRF module checks, the tables-manifest integrity check, and
drives the real STL engine end-to-end (binary STL structure validation).
