# Aether

Chat-first Android AI workspace backed by self-hosted Qwen3 engines running as
Kaggle GPU kernels behind Cloudflare tunnels, with 4-slot failover (A→B→C→D),
task-state continuity across engines, a real TaskGraph tool executor, and a
Next.js control server.

## Repository map
- `android/` — the Android app (Java). Latest signed release: **`apk/aether-2.6.0-release.apk`** (versionCode 45).
- `src/` — Next.js server + UI: engine manager/routing (`src/server/engine/`), API routes (`src/app/api/`), chat components.
- `scripts/` — engine wake/profile/bench tooling (`scripts/perf/`), live proof harnesses (`scripts/proofs/`), APK build (`scripts/build-apk.sh`).
- `tests/` — vitest suite (352 tests) + JVM suite; `node scripts/verify-engine-source.mjs` gates the kernel template.
- `HANDOFF_PROMPT.md` — full project state + pickup instructions for a new session (credential-free).
- Reports: `PERFORMANCE_CEILING.md`, `RUNTIME_GAPS.md`, `ENGINE_AUDIT.md`, `RELIABILITY_PASS.md`, and the other `*.md` files at the root.

## Credentials
No credentials are stored in this repo. Engine wake tooling reads Kaggle keys
from the environment (`KAGGLE_USERNAME_x` / `KAGGLE_KEY_x`); the Android build
reads `android/credentials.properties` (gitignored, see
`android/credentials.properties.example`).

## Gate
`npx vitest run` · `npx tsc --noEmit` · `node scripts/verify-engine-source.mjs`
