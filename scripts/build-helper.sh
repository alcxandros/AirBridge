#!/usr/bin/env bash
# Builds native/helper.cpp -> vendor/helper/airbridge-helper.exe (static, no DLLs).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/vendor/helper"
mkdir -p "$OUT"
g++ -O2 -std=c++17 -static -mwindows -o "$OUT/airbridge-helper.exe" "$ROOT/native/helper.cpp" -lole32 -luuid
echo "==> Built $OUT/airbridge-helper.exe"
