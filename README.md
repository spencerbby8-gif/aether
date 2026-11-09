# Aether

Chat-first Android AI workspace backed by self-hosted Qwen3 engines running as
Kaggle GPU kernels behind Cloudflare tunnels, with 4-slot failover (A→B→C→D),
task-state continuity across engines, a real TaskGraph tool executor, and a
Next.js control server.

## Repository map
- `android/` — the Android app (Java). Latest signed release: **`apk/aether-2.6.0-release.apk`** (versionCode 45).
- `src/` — Next.js server + UI: engine manager/routing (`src/server/engine/`), API routes (`src/app/api/`), chat components.
- `scripts/` — engine wake/profile/bench tooling (`scripts/perf/`), live proof harnesses (`scripts/proofs/`), APK build (`scripts/build-apk.sh`).
- `tests/` — vitest suite (374 tests) + JVM suite; `node scripts/verify-engine-source.mjs` gates the kernel template.
- `HANDOFF_PROMPT.md` — full project state + pickup instructions for a new session (credential-free).
- Reports: `PERFORMANCE_CEILING.md`, `RUNTIME_GAPS.md`, `ENGINE_AUDIT.md`, `RELIABILITY_PASS.md`, and the other `*.md` files at the root.

## Unified chat and BYOK
The web chat exposes the built-in 4-slot fleet only as **Aether Uncensored**.
Chat always requests server-side `auto` routing, preserving sequential
A→B→C→D failover without exposing slot identities in Settings, the model
selector, or rendered fallback errors. The underlying engine manager and
lifecycle APIs remain intact.

**Settings → Models & BYOK** configures personal OpenAI-compatible providers,
including OpenAI, OpenRouter, Groq, Mistral, Together, Cerebras, xAI, DeepSeek,
and custom public HTTPS endpoints. The provider editor supports real `/models`
discovery, connection testing, manual model IDs, enable/disable, editing, and
key removal. `/api/byok/chat` proxies streaming or non-streaming chat through
the existing control-auth and guarded-network policies.

BYOK keys are stored unencrypted in the current browser's IndexedDB, excluded
from workspace exports, and sent request-only through the server proxy. The
application does not provide a server-side secret vault or per-user cloud
sync. A saved key is not shown as verified until the provider returns a real
successful response. Personal providers currently support chat completions;
Aether workspace tools remain on Aether Uncensored.

## Android app: unified model, BYOK and Settings
The Android chat uses the same public **Aether Uncensored** identity. Its
collapsible composer selector offers the built-in model or an enabled personal
provider/model. The built-in chat always uses AUTO, tries all four configured
slots during cold-start wake, and tracks attempted slots during mid-turn
failover so continuation can traverse A→B→C→D without looping. Individual slot
identities, routing rows, and per-engine status/power controls are not part of
the public Android chat or Settings.

Android **Settings → Models & BYOK → Add provider** supports the same nine
OpenAI-compatible connectors, manual model IDs, real `/models` discovery and
connection tests, editing, enable/disable, and deletion. Personal chat is sent
**directly from the Android app to the selected provider**; it does not use the
Next.js BYOK proxy. Personal-provider chat supports streaming and non-streaming
chat completions, history, custom instructions, temperature, output-token and
timeout controls. Aether workspace tools remain on the built-in fleet.

Unlike the web implementation, Android encrypts each personal API key with
AES-GCM using a non-exportable Android Keystore key. Only key-free provider
metadata is kept in private SharedPreferences. There is no cloud sync or
server-side key vault. Saving a key does not mean the provider is verified;
only a successful provider response sets that state. The Settings data/privacy
section also explains local chat history and the personal-provider tool limit.

The Android source version is 2.8.0 (versionCode 47). Build and offline-check it
with the pinned toolchain:

```sh
bash scripts/setup-android-toolchain.sh
bash scripts/proofs/jvm-suite.sh
cd android
gradle --no-daemon :app:assembleDebug
```

The JVM suite includes deterministic fake-transport BYOK tests and four-slot
routing checks. `StatusProof` and the other live-engine proofs require real
`android/credentials.properties` and Kaggle resources; compilation, mocks, and
saved provider configuration do not establish live provider/fleet availability.
Android Keystore behavior and touch interaction still require an emulator or
physical-device test.

## Credentials
No credentials are stored in this repo. Engine wake tooling reads Kaggle keys
from the environment (`KAGGLE_USERNAME_x` / `KAGGLE_KEY_x`); the Android build
reads `android/credentials.properties` (gitignored, see
`android/credentials.properties.example`). Personal BYOK keys entered in the
web UI are browser-local; Android keys are Keystore-encrypted on the device.
Keys and credential files must never be committed.

## Gate
`npx vitest run` · `npx tsc --noEmit` · `node scripts/verify-engine-source.mjs`
