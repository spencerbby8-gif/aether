#!/usr/bin/env bash
# ============================================================================
# Android toolchain bootstrap.
#
# WHY THIS EXISTS: the sandbox is recycled between turns and /home/user/.cache
# is NOT part of the saved snapshot, so the JDK, Gradle, Android SDK and the
# org.json jar used by the JVM checks all vanish. This restores them in one
# command instead of re-deriving every URL. The system java is 11, which AGP
# rejects, so JDK 21 is mandatory.
#
# Usage:  bash scripts/setup-android-toolchain.sh
# Then:   export JAVA_HOME=/home/user/.cache/toolchain/jdk
#         export ANDROID_HOME=/home/user/.cache/toolchain/sdk
#         export PATH="$JAVA_HOME/bin:/home/user/.cache/toolchain/gradle/gradle-9.7.1/bin:$PATH"
# ============================================================================
set -euo pipefail

T="${TOOLCHAIN_DIR:-/home/user/.cache/toolchain}"
GRADLE_VERSION="${GRADLE_VERSION:-9.7.1}"
PLATFORM="${PLATFORM:-android-37.2}"
BUILD_TOOLS="${BUILD_TOOLS:-36.0.0}"

mkdir -p "$T"

# --- 1. JDK 21 (Temurin) ----------------------------------------------------
if [ ! -x "$T/jdk/bin/java" ]; then
  echo "[1/6] JDK 21 (Temurin)"
  curl -fsSL -o "$T/jdk.tar.gz" \
    "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"
  mkdir -p "$T/jdk"
  tar -xzf "$T/jdk.tar.gz" -C "$T/jdk" --strip-components=1
  rm -f "$T/jdk.tar.gz"
else
  echo "[1/6] JDK 21 already present"
fi

export JAVA_HOME="$T/jdk"
export ANDROID_HOME="$T/sdk"
export PATH="$JAVA_HOME/bin:$PATH"

# --- 2. Gradle --------------------------------------------------------------
if [ ! -x "$T/gradle/gradle-$GRADLE_VERSION/bin/gradle" ]; then
  echo "[2/6] Gradle $GRADLE_VERSION"
  curl -fsSL -o "$T/gradle.zip" \
    "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
  mkdir -p "$T/gradle"
  unzip -q -o "$T/gradle.zip" -d "$T/gradle"
  rm -f "$T/gradle.zip"
else
  echo "[2/6] Gradle $GRADLE_VERSION already present"
fi

# --- 3. Android command line tools -----------------------------------------
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKMANAGER" ]; then
  echo "[3/6] Android command line tools"
  ok=0
  for id in 13114758 12700392 11076708 10406996; do
    if curl -fsSL -o "$T/cmdtools.zip" \
        "https://dl.google.com/android/repository/commandlinetools-linux-${id}_latest.zip"; then
      rm -rf "$ANDROID_HOME/cmdline-tools/latest" "$T/ct"
      mkdir -p "$ANDROID_HOME/cmdline-tools/latest"
      unzip -q -o "$T/cmdtools.zip" -d "$T/ct"
      # the zip wraps everything in a top-level cmdline-tools/ directory
      mv "$T/ct/cmdline-tools/"* "$ANDROID_HOME/cmdline-tools/latest/"
      rm -rf "$T/ct" "$T/cmdtools.zip"
      ok=1
      break
    fi
  done
  [ "$ok" = 1 ] || { echo "could not download command line tools"; exit 1; }
else
  echo "[3/6] command line tools already present"
fi

# --- 4. SDK packages --------------------------------------------------------
echo "[4/6] SDK packages ($PLATFORM, build-tools $BUILD_TOOLS)"
yes 2>/dev/null | "$SDKMANAGER" --licenses >/dev/null 2>&1 || true
"$SDKMANAGER" "platform-tools" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" >/dev/null

# --- 5. org.json for the JVM checks ----------------------------------------
# The Android platform supplies org.json at runtime, so the app must NOT bundle
# it (duplicate classes), but the JVM checks need a real implementation.
mkdir -p "$T/jars"
if [ ! -s "$T/jars/json-20240303.jar" ]; then
  echo "[5/6] org.json 20240303 (JVM checks only)"
  curl -fsSL -o "$T/jars/json-20240303.jar" \
    "https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar"
else
  echo "[5/6] org.json already present"
fi

# --- 6. Report --------------------------------------------------------------
echo "[6/6] verifying"
"$JAVA_HOME/bin/java" -version 2>&1 | head -1
"$T/gradle/gradle-$GRADLE_VERSION/bin/gradle" --version 2>/dev/null | grep -m1 "^Gradle" || true
[ -x "$SDKMANAGER" ] && echo "sdkmanager: ok"
[ -s "$T/jars/json-20240303.jar" ] && echo "org.json jar: $(stat -c%s "$T/jars/json-20240303.jar") bytes"
echo "TOOLCHAIN READY at $T"
