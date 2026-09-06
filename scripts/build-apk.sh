#!/usr/bin/env bash
# Reproducible Aether APK build.
#
# The toolchain is deliberately pinned to versions checked against their
# official endpoints: AGP 9.4.0 needs Gradle >= 9.6.0 and JDK >= 17.
set -euo pipefail

TOOLCHAIN="${TOOLCHAIN:-/home/user/toolchain}"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
export JAVA_HOME="$TOOLCHAIN/jdk"
export ANDROID_HOME="$TOOLCHAIN/sdk"
export GRADLE_USER_HOME="$TOOLCHAIN/gradle-home"
export PATH="$JAVA_HOME/bin:$TOOLCHAIN/gradle/gradle-9.7.1/bin:$PATH"

KS="$PROJECT/keystore/aether-release.jks"
PASS_FILE="$PROJECT/keystore/README-DO-NOT-COMMIT.txt"

cd "$PROJECT/android"
echo "sdk.dir=$ANDROID_HOME" > local.properties

ARGS=(--no-daemon :app:assembleDebug)
if [[ -f "$KS" && -f "$PASS_FILE" ]]; then
  PASS="$(head -1 "$PASS_FILE")"
  ARGS+=(:app:assembleRelease
         "-PAETHER_KS=$KS" "-PAETHER_KS_PASS=$PASS"
         "-PAETHER_KEY_ALIAS=aether" "-PAETHER_KEY_PASS=$PASS")
else
  echo "WARNING: no keystore at $KS — building debug only." >&2
fi

gradle "${ARGS[@]}"

# Artifacts go somewhere obvious, never into a nested build/outputs path.
mkdir -p "$PROJECT/apk"
VERSION="$(grep -oP "versionName '\K[^']+" app/build.gradle | head -1)"
cp app/build/outputs/apk/debug/app-debug.apk "$PROJECT/apk/aether-$VERSION-debug.apk"
if [[ -f app/build/outputs/apk/release/app-release.apk ]]; then
  cp app/build/outputs/apk/release/app-release.apk "$PROJECT/apk/aether-$VERSION-release.apk"
  cp app/build/outputs/mapping/release/mapping.txt "$PROJECT/apk/aether-$VERSION-release-mapping.txt" 2>/dev/null || true
fi

echo
echo "=== verifying signatures ==="
for f in "$PROJECT"/apk/aether-*.apk; do
  echo "--- $(basename "$f")"
  "$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs "$f" \
    | grep -E "^Verifies|Verified using v2|certificate DN|SHA-256 digest" | sed 's/^/    /'
done
echo
ls -la "$PROJECT/apk/"
