#!/bin/bash
# Build a FLAT OpenCASCADE include directory from an OCCT source checkout.
#
# Why: this repo's committed occt/include/ contains forwarding stubs generated
# on the original author's machine — each one hardcodes an absolute
# /home/rhe/OCCT/... path, so they cannot compile anywhere else. The prebuilt
# occt/lib/*.a archives are fine; only headers are needed to rebuild main.cpp.
#
# Usage:
#   git clone --depth 1 --branch V8_0_0_p1 https://github.com/Open-Cascade-SAS/OCCT.git <occt-src>
#   ./tools/make-occt-include.sh <occt-src> <flat-out-dir>
#   export OCCT_INCLUDE=<flat-out-dir>
#   ./build.sh
#
# Match the OCCT tag to the version of the committed libs (currently 8.0 —
# check with: node tools/... or the app console banner "OpenCASCADE version").
set -euo pipefail

SRC="${1:?usage: make-occt-include.sh <occt-src-checkout> [flat-out-dir]}"
OUT="${2:-../occt-flat-include}"

mkdir -p "$OUT"
echo "Flattening headers from $SRC/src -> $OUT ..."
find "$SRC/src" -type f \( -name '*.hxx' -o -name '*.lxx' -o -name '*.gxx' -o -name '*.h' \) \
  -exec cp {} "$OUT/" \;

# Standard_Version.hxx is generated at OCCT configure time; render it from the
# template with the checkout's version numbers.
V_CMAKE="$SRC/adm/cmake/version.cmake"
MAJOR=$(grep -oP 'OCC_VERSION_MAJOR\s+\K[0-9]+' "$V_CMAKE")
MINOR=$(grep -oP 'OCC_VERSION_MINOR\s+\K[0-9]+' "$V_CMAKE")
MAINT=$(grep -oP 'OCC_VERSION_MAINTENANCE\s+\K[0-9]+' "$V_CMAKE")
DEV=$(grep -oP 'OCC_VERSION_DEVELOPMENT\s+"\K[^"]*' "$V_CMAKE" || true)

if [ -n "$DEV" ]; then
  DEV_LINE="#define OCC_VERSION_DEVELOPMENT \"$DEV\""
else
  DEV_LINE="// #define OCC_VERSION_DEVELOPMENT"
fi

sed -e "s/@OCCT_VERSION_DATE@/generated-by-make-occt-include/" \
    -e "s/@OCC_VERSION_MAJOR@/$MAJOR/" \
    -e "s/@OCC_VERSION_MINOR@/$MINOR/" \
    -e "s/@OCC_VERSION_MAINTENANCE@/$MAINT/" \
    -e "s|@SET_OCC_VERSION_DEVELOPMENT@|$DEV_LINE|" \
    "$SRC/adm/templates/Standard_Version.hxx.in" > "$OUT/Standard_Version.hxx"

echo "done: $(ls "$OUT" | wc -l) headers (OCCT $MAJOR.$MINOR.$MAINT${DEV:+-$DEV})"
