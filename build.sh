#!/bin/bash
# BrailleGen engine build — produces engine/core.{js,wasm} + engine/stl.{js,wasm}
# plus engine/tables-manifest.json.
#
# Prerequisites (see BUILDING.md):
#   - emsdk installed + activated (emcc/em++ on PATH)
#   - node on PATH (for the tables manifest)
#   - OCCT 8.0 headers as a FLAT directory (the occt/include stubs committed in
#     this repo hardcode the original author's /home path and do not work
#     elsewhere). Generate with: ./tools/make-occt-include.sh <occt-src-checkout>
#     then: export OCCT_INCLUDE=<flat-dir>
#
# The liblouis + OpenCASCADE static libs are the prebuilt emscripten archives
# committed in this repo (liblouis 3.36.0, OCCT 8.0). Wasm object files are
# forward-compatible: linking them with a newer emsdk is verified working
# (emcc 6.0.3, 2026-07).
set -euo pipefail
cd "$(dirname "$0")"

OCCT_INCLUDE="${OCCT_INCLUDE:-/e/projects/occt-flat-include}"

echo "== BrailleGen engine build =="
mkdir -p engine

COMMON_FLAGS=(
  -Os
  -s ALLOW_MEMORY_GROWTH=1
  -s MODULARIZE=1
  -s EXPORT_ES6=1
  -s 'EXPORTED_RUNTIME_METHODS=["ccall","FS"]'
  # liblouis's table compiler recurses through `include` chains; the emcc
  # default 64 KB stack overflows on real-world tables (e.g. UEB G2's chain).
  -s STACK_SIZE=5242880
)

echo "-- [1/3] engine/core.js (liblouis translator, no OCCT)"
em++ main.cpp liblouis/liblouis.a \
  -DBRAILLEGEN_CORE_ONLY \
  -I liblouis \
  "${COMMON_FLAGS[@]}" \
  -s EXPORT_NAME=createBrailleCore \
  -o engine/core.js

echo "-- [2/3] engine/stl.js (liblouis + OpenCASCADE STL generator)"
if [ ! -f "$OCCT_INCLUDE/gp_Trsf.hxx" ]; then
  echo "!! OCCT_INCLUDE ($OCCT_INCLUDE) missing gp_Trsf.hxx — run tools/make-occt-include.sh first" >&2
  exit 1
fi
em++ main.cpp \
  liblouis/liblouis.a \
  occt/lib/libTKMath.a occt/lib/libTKernel.a occt/lib/libTKG2d.a occt/lib/libTKG3d.a \
  occt/lib/libTKBRep.a occt/lib/libTKGeomBase.a occt/lib/libTKGeomAlgo.a occt/lib/libTKTopAlgo.a \
  occt/lib/libTKBool.a occt/lib/libTKBO.a occt/lib/libTKPrim.a occt/lib/libTKMesh.a occt/lib/libTKShHealing.a \
  -I . -I liblouis -I "$OCCT_INCLUDE" \
  "${COMMON_FLAGS[@]}" \
  -s EXPORT_NAME=createBrailleStl \
  -o engine/stl.js

echo "-- [3/4] engine/stl.wasm.gz (GitHub Pages does not gzip wasm; the app streams + DecompressionStream's this)"
gzip -9 -c engine/stl.wasm > engine/stl.wasm.gz

echo "-- [4/4] engine/tables-manifest.json"
node tools/gen-tables-manifest.mjs

echo
echo "== build complete =="
ls -la engine/
echo "Serve the repo root (e.g. python3 -m http.server) to test."
