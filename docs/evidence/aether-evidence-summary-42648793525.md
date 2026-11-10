# Aether hosted emulator evidence — run 42648793525

Branch `android/live-agent-execution-20261106`, commit `ca6384c`, `main` untouched.
Workflow: `Android UI verification` → https://github.com/spencerbby8-gif/aether/actions/runs/42648793525
Jobs: **build success**, **screenshots success** (hardware-accelerated x86_64 emulator, API 35).

## What the device actually proved

| suite | result | what it establishes |
|---|---|---|
| `ScreenshotTest` | OK (2 tests) | Product navigation, Settings/Legal/Privacy, activity card folding and re-expansion, agent question cards, keyboard state, new-chat reset |
| `LiveExecutionHandshakeTest` | OK (4 tests) | The real `ChatActivity` stream path over a live loopback HTTP NDJSON engine: exact-command approval before execution, approve-once (exactly 1 start), denial with 0 executions, auto-run with no approval controls, Stop sending a denial |
| `ExhaustiveThemeTest` | OK (1 test) | 100 screenshots — every declared Settings destination, documents, Auth/Backup/Workspace states, connector editors, dialogs, upload sheet, empty/error states, and chat welcome/drawer/model picker/attachment sheet/discussion composer — in **both** Light and Midnight |

Artifacts: Base screenshots 26, live-execution screenshots 5, theme audit 100 (blank captures now rejected: each shot must contain ≥24 distinct sampled colours).

Live-execution captures (real socket, not fixtures):

- `light-manual-command-before-execution.png` — approval card with the exact command `printf live-approval-proof`, Deny / Approve once, nothing executed yet.
- `light-command-expanded-live.png` — after approving: "Running a command", `$ printf live-approval-proof`.
- `light-command-folded-after-completion.png` — folded to "Ran a command · 738ms", stale "waiting for the engine to start it" notice gone.
- `dark-manual-command-before-execution.png`, `dark-command-denied.png`.

## Fixes this run produced (found from the evidence, not guessed)

1. Approved-command notice is retired the moment the engine reports the command, instead of claiming it is still waiting.
2. Sub-second tool work reports `738ms` instead of `0s` (`AgentActivity.summary`, proven in the JVM suite).
3. Theme audit rejects blank frames and waits for the first drawn frame — a blank light Settings capture had passed a size-only check.
4. Evidence shell: per-suite instrumentation commands instead of an unsupported multi-line loop; the first hosted attempt never ran a test.

## Proofs alongside this run

- Engine protocol/approval suite: **56 passed, 0 failed**.
- JVM suite: **25/26 clean**, only `StatusProof` failing (needs real Kaggle resources; `android/credentials.properties` absent).
- `AgentActivityCheck` 62 passed (now includes the sub-second duration rule).
- `CommandApprovalProof` 10 passed.

## Artifact hashes

- Debug APK: `030cfa57495035da7d9852fe2677201018d1de135b27eb055d238d1cc13ab0db`
- Evidence ZIP (run 42648793525): `d1ab41fce612eed4f72ae0315f3e02f5d7fa07e8b83658119577b7cd04e2524e`

## Still not proven — do not claim

- Real Kaggle wake → live URL → `/api/chat` (`StatusProof`); no credentials in this workspace.
- Uncensored-model wake failure remains undiagnosed live.
- Any real image-analysis turn; a successful upload is not vision.
- Google sign-in, Supabase session refresh/sign-out, Drive backup/restore: no real account, mailbox, or OAuth callback was used. Setup steps are in `docs/google-auth-backup-setup.md`.
- Supabase MCP OAuth end to end. Dynamic registration was accepted live (HTTP 201, redirect `aether://connector/callback`, client `82d0f5c1-…`), but no authorization-code exchange, token refresh, or tool call happened.
- Vercel MCP OAuth. Dynamic registration is rejected; CIMD client-ID support and docs exist (`docs/oauth-cimd-setup.md`, `public/oauth/aether-mcp-client.json`) but nothing is deployed or connected.
- Android APK bootstrap inside the engine, git push tools, Workspace edit/rollback against a real engine.
- Fixture screenshots (activity cards, question cards, provider rows) are rendering evidence only, never live execution.
