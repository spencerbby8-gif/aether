# Aether Android build

Current builds in this directory:

| file | what it is |
|---|---|
| `aether-2.7.0-debug.apk` | **Built 2026-09-16** (session: security cleanup + browser recovery). versionCode 46, minSdk 26, targetSdk 37, debug-signed (`com.aether.app.debug`). Credential-free by construction: the whole APK scans clean for OFF-key / beacon-topic / KGAT / webhook-token patterns, template asset is byte-identical to the repo asset with `{{...}}` placeholders intact, and the browser-recovery agent code is verified present inside. 4,018,880 bytes, sha256 `9af462af0540cb3dcc4e995b2f02c0e2a38be0cea0f533a8cce6afacc92071f0`. |
| `aether-2.6.0-release.apk` | Previous release (2026-09-15/16 handoff). versionCode 45. Still the last RELEASE-signed build: the release keystore is gitignored and was never in the repo, so a release rebuild requires it (see below). 802,664 bytes. |

## Toolchain

JDK 21.0.12.1 (Temurin) · Gradle 9.7.1 · AGP 9.4.0 · Build Tools 36.0.0 ·
compileSdk 37 · targetSdk 37 · minSdk 26 — restored by
`bash scripts/setup-android-toolchain.sh`, built with
`TOOLCHAIN=~/.cache/toolchain bash scripts/build-apk.sh`.

## Credentials and the APK

The APK optionally reads `assets/aether-credentials.dat`, produced by
`bash scripts/bake-credentials.sh` from the **gitignored**
`android/credentials.properties` (see `.gitignore` lines 43–45). The bake
pipeline was verified end-to-end on 2026-09-16 with DUMMY values: the
`.dat` packages into the APK and XOR-decodes back to exactly the input
config. Two honest caveats:

1. The XOR+Base64 step is **obfuscation, not encryption** — the mask is a
   public constant in the script, so anyone holding an APK with a baked
   `.dat` can extract its credentials. A baked APK must be treated as
   containing those credentials in cleartext.
2. The build in this directory is intentionally **credential-free**: it
   uses the server-side session-pickup path. Baking real engine
   credentials is a deliberate act for a private build, done by the owner
   on their machine — never commit the `.properties` or the `.dat`.

## Release signing

`scripts/build-apk.sh` produces a release build automatically when
`keystore/aether-release.jks` and its password file exist (both gitignored).
Without them it builds debug-only, as the 2.7.0 build here.
