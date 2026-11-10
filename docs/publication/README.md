# Aether workspace publication — 2026-11-06

Repository: https://github.com/spencerbby8-gif/aether

Release: https://github.com/spencerbby8-gif/aether/releases/tag/workspace-archive-2026-11-06

## Contents

- Source and project documents are on `main`.
- `aether-workspace-artifacts-2026-11-06.zip` preserves **1,497** eligible workspace artifacts with their original relative paths: APKs, screenshots, logs, evidence bundles, reports, and local generated metadata.
- The archive includes **38 APK paths**, representing **29 distinct binaries**. Each distinct binary is also a separate release download. Some are instrumentation/test APKs rather than installable user-facing apps; consult their filenames and `apk-index.json`.
- `workspace-inventory.csv` records the 2,058 examined files, including source. 2,055 were eligible and three were excluded. `apk-index.json` maps identical APK copies to their original filenames. `SHA256SUMS.txt` contains download checksums.
- Existing evidence files retain their original claims and provenance. Inclusion does **not** certify each screenshot as a live run or each APK as working. This publication did not perform new application execution tests.

## Security review and exclusions

Reviewed Aether-named workspace files/directories, tracked repository files, repository-owned artifacts, and build-output APKs. Recursively inspected ZIP/APK/JAR/AAR contents, matched known recovered secrets and credential patterns, and OCR-scanned 1,131 unique embedded/standalone images. The only additional pattern finding was an explicit nonfunctional screenshot-fixture key in `ScreenshotTest.java`, manually cleared as a test value.

Excluded from publication:

1. Local GitHub authentication file.
2. `android/credentials.properties` containing recovered configuration.
3. `apk/aether-2.6.0-release.apk`, which contains an obfuscated credential asset.

Installed dependencies, caches, Git internals, runtime state, unrelated projects, and reproducible build intermediates are not part of the workspace artifact archive. Build-output APKs are included. The scan is a risk-reduction measure, not a mathematical guarantee that arbitrary encoded secrets cannot exist.

## Existing public-history exposure

The excluded 2.6.0 APK was already committed in public history at `ca3b74c`. This publication removes it from the current branch tree and removes the `.gitignore` exception that allowed it. The local file is retained, not destroyed.

**Removal from the current tree does not remove historical Git objects.** A separately approved history rewrite and coordinated force-push are required to purge affected refs. Any forks, clones, caches, or prior downloads may retain copies. The four recovered Kaggle tokens returned HTTP 401 during earlier checks; other embedded configuration should still be treated as exposed and rotated where applicable. Rotate any PAT pasted into chat as well.

## Functionality limitations retained from the audit

Publishing artifacts does not resolve the missing local tool execution loop, retired Kaggle credentials, or unproven end-to-end live flows. See `../agent-capability-audit.md` and the evidence reports for implementation status.
