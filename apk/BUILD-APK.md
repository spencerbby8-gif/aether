# Aether Android build

Built 2026-09-06T04:26:30Z.

| file | what it is |
|---|---|
| `aether-1.0.0-release.apk` | **install this one.** minified + resource-shrunk, signed with the Aether release key. 736K |
| `aether-1.0.0-debug.apk` | debug build, `com.aether.app.debug` package id so it can sit alongside release. 4.5M |
| `aether-1.0.0-release-mapping.txt` | R8 mapping — keep it, or crash reports from this build cannot be deobfuscated. |

## Signatures (verified with apksigner 36.0.0)

| | release | debug |
|---|---|---|
| scheme | APK Signature Scheme **v2** | v2 |
| certificate | `CN=Aether, OU=Aether, O=Aether, L=Port Harcourt, ST=Rivers, C=NG` | `C=US, O=Android, CN=Android Debug` |
| SHA-256 | `a4b7b616712902c7a7223633b0e0fc47f605086b9fd58894d16c693756b97f04` | `f7e99544ea9547215c26348ca4dcb3ca1e97c8247d37d0f08664f7073a8d47ae` |

## Toolchain

JDK 21.0.12.1 (Temurin) · Gradle 9.7.1 · AGP 9.4.0 · Build Tools 36.0.0 ·
compileSdk 37 · targetSdk 37 · minSdk 26.

## Install

    adb install aether-1.0.0-release.apk

First launch asks for the server URL and the control token
(`AETHER_CONTROL_TOKEN` from the server). Both must be filled in: the URL has
to be `https://` and the token at least 16 characters, matching what
`requireControlAuth()` enforces server-side.

## Rebuild

    ./scripts/build-apk.sh            # debug + release, copies into apk/

Signing material lives in `keystore/` and is **gitignored**. Lose the password
and the app can only be reinstalled, never updated.
