#!/usr/bin/env bash
# ============================================================================
# Chromium runtime-library bootstrap for the sandbox.
#
# WHY THIS EXISTS: `python3 -m playwright install chromium` downloads a
# browser that then dies with exit code 127. 127 from Playwright means the
# browser binary itself could not start -- here, eleven shared libraries are
# missing from the sandbox image. We are not root, so we cannot `apt install`;
# but we CAN `apt-get download` the .deb files and unpack them into a private
# prefix, then point LD_LIBRARY_PATH at it. No root, no system mutation.
#
# Package names on Debian trixie: several were renamed with a `t64` suffix for
# the 64-bit time_t transition, and libavahi is split into two packages. The
# non-t64 names have no candidate and `apt-get download` fails on them.
#
# Usage:  bash scripts/setup-browser-libs.sh
# Then:   source scripts/browser-env.sh
# ============================================================================
set -uo pipefail

PREFIX="${CRLIBS_DIR:-/home/user/.cache/crlibs}"
WORK="${PREFIX}.build"
LIBDIR="$PREFIX/usr/lib/x86_64-linux-gnu"

PKGS=(
  libnss3
  libnspr4
  libatk1.0-0t64
  libatk-bridge2.0-0t64
  libcups2t64
  libxkbcommon0
  libasound2t64
  libxdamage1
  libatspi2.0-0t64
  libavahi-common3
  libavahi-client3
)

mkdir -p "$PREFIX" "$WORK"

# 1. Fetch the .deb files. apt-get download needs no root.
echo "[1/3] downloading ${#PKGS[@]} packages"
cd "$WORK"
apt-get update -qq >/dev/null 2>&1
failed=0
for p in "${PKGS[@]}"; do
  if ls "${p}"_*.deb >/dev/null 2>&1; then continue; fi
  if ! apt-get download "$p" >/dev/null 2>&1; then
    echo "  FAILED to download $p"
    failed=1
  fi
done

# 2. Unpack every .deb straight into the private prefix.
echo "[2/3] unpacking into $PREFIX"
shopt -s nullglob
for deb in "$WORK"/*.deb; do
  dpkg-deb -x "$deb" "$PREFIX" || { echo "  FAILED to unpack $deb"; failed=1; }
done

# 3. Verify against the actual browser binary, not against a guess.
echo "[3/3] verifying the browser binary resolves every library"
# Playwright ships two browser builds with different directory names:
#   chromium-1234/chrome-linux64/chrome
#   chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell
# A non-matching glob must not be mistaken for a real binary, so the loop
# requires an actual executable file and reports how many binaries it checked.
BINS=()
for cand in \
  "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome \
  "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-*-linux*/chrome-headless-shell
do
  [ -f "$cand" ] && [ -x "$cand" ] && BINS+=("$cand")
done
if [ "${#BINS[@]}" -eq 0 ]; then
  echo "  no browser binary found -- run: python3 -m playwright install chromium"
  echo "setup-browser-libs: INCOMPLETE"
  exit 1
fi
missing=0
for bin in "${BINS[@]}"; do
  echo "  checking $(basename "$bin")"
  out="$(LD_LIBRARY_PATH="$LIBDIR" ldd "$bin" 2>&1 | grep -c 'not found' || true)"
  echo "    unresolved libraries: $out"
  [ "$out" != "0" ] && missing=1
done

if [ "$failed" != "0" ] || [ "$missing" != "0" ]; then
  echo "setup-browser-libs: INCOMPLETE"
  exit 1
fi
echo "setup-browser-libs: OK"
echo "  source scripts/browser-env.sh   # exports LD_LIBRARY_PATH=$LIBDIR"
