#!/usr/bin/env bash
# Builds UxPlay from source in MSYS2 (UCRT64) and assembles a self-contained
# bundle in vendor/uxplay: uxplay.exe, the DLLs it needs, and a trimmed set of
# GStreamer plugins. Run through scripts/build-uxplay.ps1 or from a UCRT64 shell.
set -euo pipefail

# UxPlay 1.74 (master): has the built-in mDNS responder, so no Bonjour needed.
UXPLAY_REPO="https://github.com/FDH2/UxPlay.git"
UXPLAY_REF="${UXPLAY_REF:-05b0275}"

PREFIX="${MINGW_PREFIX:-/ucrt64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.build/uxplay-src"
OUT="$ROOT/vendor/uxplay"

if [ "${MSYSTEM:-}" != "UCRT64" ]; then
  echo "Run this inside the MSYS2 UCRT64 environment." >&2
  exit 1
fi

echo "==> Installing build dependencies"
pacman -S --needed --noconfirm git \
  mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-ninja \
  mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-libplist mingw-w64-ucrt-x86_64-openssl \
  mingw-w64-ucrt-x86_64-gstreamer mingw-w64-ucrt-x86_64-gst-plugins-base \
  mingw-w64-ucrt-x86_64-gst-plugins-good mingw-w64-ucrt-x86_64-gst-plugins-bad \
  mingw-w64-ucrt-x86_64-gst-libav mingw-w64-ucrt-x86_64-ntldd >/dev/null

echo "==> Fetching UxPlay $UXPLAY_REF"
if [ ! -d "$SRC/.git" ]; then
  git clone --quiet "$UXPLAY_REPO" "$SRC"
fi
git -C "$SRC" fetch --quiet origin
git -C "$SRC" -c advice.detachedHead=false checkout --quiet "$UXPLAY_REF"

echo "==> Building"
# -mwindows: GUI-subsystem exe, so no console window appears and the app can
# launch it without the "hide window" flag (which would also hide the video window).
cmake -S "$SRC" -B "$SRC/build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXE_LINKER_FLAGS=-mwindows >/dev/null
cmake --build "$SRC/build"

echo "==> Assembling bundle in vendor/uxplay"
rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib/gstreamer-1.0" "$OUT/libexec/gstreamer-1.0" "$OUT/licenses"
cp "$SRC/build/uxplay.exe" "$OUT/bin/"
cp "$PREFIX/libexec/gstreamer-1.0/gst-plugin-scanner.exe" "$OUT/libexec/gstreamer-1.0/"

# Plugins UxPlay's mirroring + audio pipelines use on Windows.
PLUGINS=(
  coreelements app playback autodetect
  videoparsersbad audioparsers libav
  d3d11 d3d12 videoconvertscale videorate videofilter
  audioconvert audioresample volume level wasapi wasapi2 directsound
  jpeg imagefreeze pango isomp4
)
for p in "${PLUGINS[@]}"; do
  f="$PREFIX/lib/gstreamer-1.0/libgst$p.dll"
  if [ -f "$f" ]; then
    cp "$f" "$OUT/lib/gstreamer-1.0/"
  else
    echo "    (plugin $p not found, skipped)"
  fi
done

# Copy every MSYS2 DLL that the executables and plugins depend on.
win_prefix="$(cygpath -w "$PREFIX/bin" | tr '[:upper:]' '[:lower:]')"
deps() {
  ntldd -R "$@" 2>/dev/null | tr -d '\r' | awk '{print $3}' | while read -r p; do
    [ -n "$p" ] || continue
    lp="$(echo "$p" | tr '[:upper:]' '[:lower:]')"
    case "$lp" in "$win_prefix"\\*) echo "$p" ;; esac
  done | sort -u
}
mapfile -t BINS < <(ls "$OUT"/bin/*.exe "$OUT"/libexec/gstreamer-1.0/*.exe "$OUT"/lib/gstreamer-1.0/*.dll)
deps "${BINS[@]}" | while read -r dll; do
  cp -n "$(cygpath -u "$dll")" "$OUT/bin/"
done
# gst-plugin-scanner.exe finds these DLLs through PATH, which the app points at bin/.

echo "==> Licences"
cp "$SRC/LICENSE" "$OUT/licenses/UxPlay-GPL-3.0.txt"
cp "$SRC/lib/llhttp/LICENSE-MIT" "$OUT/licenses/llhttp-MIT.txt"
for pkg in gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav ffmpeg libplist openssl glib2; do
  d="$PREFIX/share/licenses/$pkg"
  [ -d "$d" ] && cp -r "$d" "$OUT/licenses/$pkg"
done
git -C "$SRC" rev-parse HEAD > "$OUT/UXPLAY_COMMIT"

echo "==> Smoke test"
GST_PLUGIN_SYSTEM_PATH_1_0="$(cygpath -w "$OUT/lib/gstreamer-1.0")" \
GST_PLUGIN_SCANNER_1_0="$(cygpath -w "$OUT/libexec/gstreamer-1.0/gst-plugin-scanner.exe")" \
PATH="$OUT/bin:/usr/bin" "$OUT/bin/uxplay.exe" -h | head -3 || true

du -sh "$OUT"
echo "==> Done: $OUT"
