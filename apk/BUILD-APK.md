# Aether Android build

Current builds in this directory:

| file | what it is |
|---|---|
| `aether-2.7.0-release.apk` | **Built + NEW-KEY signed 2026-09-16** (recheck session). versionCode 46, versionName 2.7.0, minSdk 26, targetSdk 37, `com.aether.app`, launchable `SplashActivity`, R8-minified (see `aether-2.7.0-release-mapping.txt`). Signed with a **newly generated release key** (RSA-4096, valid to 2056, cert SHA-256 `1a0072201e4663710370b433861231410889351d74b77474247ce36acbd4e93c`), v2 scheme — same scheme set as 2.6.0. Content-verified: template byte-identical to the repo asset, all four `{{...}}` placeholders intact, browser-recovery code present, zero secret-pattern hits across all 350 files, no credential `.dat`. 803,441 bytes, sha256 `662266500afb3b354e39d7d378e374348bb3c32b129e4954bdebba14c6e72e47`. **Caveat: this is a different signing key than 2.6.0-release** (the old keystore was lost in a workspace wipe) — Android will not install it as an in-place update over an old release build; uninstall first. |
| `aether-2.7.0-release.apk` **(credential-baked, private — NOT committed)** | Built 2026-09-16 later the same day, per owner instruction for private use: same release build as above plus `assets/aether-credentials.dat` baked from the gitignored `android/credentials.properties` (all four engine slots + OFF key + beacon topic + kernel slug). Verified: the `.dat` decodes with the app's own XOR to exactly the input config; **0 plaintext secret hits across all 351 files** in the APK; template parsed-equal with placeholders intact; v2-signed by the new key; 804,080 bytes, sha256 `58728892bc415605cd5ce94eca39693a620b086917092417801abb817dae071d`. All four keys verified live read-only (HTTP 200 kernel status). The obfuscation is NOT encryption — if this APK ever leaves the owner's phone, rotate every value in it. |
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
The current keystore was **generated 2026-09-16** (alias `aether`, RSA-4096,
valid to 2056) after the previous key was lost; its password lives in
`keystore/README-DO-NOT-COMMIT.txt`. **Back the keystore folder up outside
this machine** — losing it again means the next release cannot update over
2.7.0, the same way 2.7.0 cannot update over 2.6.0.
