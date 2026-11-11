# Aether local Agent runtime — Android 3.2.0 development

## What changed

Personal-provider **Agent** mode is no longer limited to a single chat-completion
request. `ByokAgent` runs a bounded OpenAI-compatible function-calling loop:

1. Send the conversation and real JSON tool schemas to the selected provider.
2. Parse each `tool_calls` entry and its complete JSON arguments.
3. Validate and execute the requested tool once.
4. Stream genuine tool/process output to the chat activity card.
5. Return a correlated `role: tool` result to the provider.
6. Continue for at most ten model rounds and at most eight calls per round.

Discussion mode retains the original direct chat path. There is no implicit
cross-provider failover and no claim that a provider supports tools until it
returns a valid tool call. A failed or unsupported call is returned honestly to
the model and shown in the activity record.

## Live activity UI

`AgentActivity` correlates a provider call ID with its step, stdout/stderr,
completion state and exit code. `AgentTimelineView` provides:

- active pulses only while a turn is actually running;
- ordered phases and per-step durations;
- compact command rows with `$ command` previews;
- expandable output wells with real output, not generated progress text;
- live/failed output labels, exit status and returned-character counts;
- automatic folding when the turn finishes and manual expand/collapse controls;
- structured persistence in `ChatMessage.activitySteps` for later inspection.

Private model reasoning is neither requested for display nor persisted.

## Local tools

| Tool | Behavior |
|---|---|
| `web_search` | Public web search; returns result titles, URLs and snippets when parseable. |
| `fetch_page` | Public HTTPS text fetch with redirect revalidation, response limits and private-address blocking. |
| `list_files` | Lists the current chat's app-private Agent workspace. |
| `read_file` | Reads at most 2 MB of UTF-8 text from that workspace. |
| `write_file` | Writes at most 2 MB after explicit approval. |
| `delete_file` | Deletes a file or empty directory after explicit approval. |
| `run_command` | Runs a real allowlisted system command with streaming combined stdout/stderr. |
| `current_time` | Reports UTC, device-local time and timezone. |

### Command boundary

Allowed read commands: `pwd`, `ls`, `cat`, `echo`, `stat`, `wc`, `head`, `tail`,
`grep`, and `find`. Allowed write commands, each requiring approval: `mkdir`,
`touch`, `cp`, `mv`, and `rm`.

This is deliberately **not a shell**. Aether directly starts `/system/bin/<name>`
with an argument vector. It does not invoke `sh`, evaluate substitutions, pipes,
redirection or command separators. `find` execution/deletion expressions and
advanced `grep` file/command options are refused. Paths are canonicalized and
must remain under `files/agent-workspace/<chat-id>`. The process receives a
minimal environment, a 30-second deadline, a 256 KB captured-output ceiling and
cancellation through the existing Stop control.

Android does not provide a general Linux development environment. This runtime
is useful for workspace inspection and file operations, but it does not claim to
run arbitrary Python, Node, package managers or root commands. Those need a
separately sandboxed remote executor or an embedded runtime.

## MCP connectors

`McpClient` implements Streamable HTTP JSON-RPC `initialize`,
`notifications/initialized`, `tools/list`, and `tools/call`, including
`Mcp-Session-Id`, JSON and SSE responses. Enabled connector tokens are decrypted
only in memory by `ConnectorStore.enabledLocalGrants()`.

Every connector call requires a separate explicit approval. Connector read/write
/execute grants remain part of the user's configuration, but remote descriptions
and annotations are treated as untrusted and are not used to bypass approval.
URLs require HTTPS and public DNS results. Responses are size-limited and error
bodies redact the configured token. A failed connector is identified as a warning;
it never creates a fake successful step.

## Verification

JVM proofs:

```sh
bash scripts/proofs/jvm-suite.sh
```

The new `ByokAgentProof`, `LocalToolRegistryProof`, and `McpClientProof` cover
provider/tool correlation, real file and process behavior, shell/path refusal,
and MCP lifecycle/content handling. `StatusProof` remains a live-engine proof
and requires `android/credentials.properties`; its absence is not a local-Agent
failure.

Android build:

```sh
bash scripts/setup-android-toolchain.sh
TOOLCHAIN="$HOME/.cache/toolchain" bash scripts/build-apk.sh
```

GitHub Actions `Android UI verification` builds the APK and runs the hardware-
accelerated emulator. `LocalAgentInteractionTest` types a prompt, taps Send,
executes a real Android child process, checks output, clicks collapse and expand,
and verifies final folding. Its model transport is a deterministic test double;
the test never claims live external-provider connectivity. Existing tests also
navigate Settings and connectors and exercise real HTTP command approval/denial.

## Still not included

- Arbitrary local Python/Node/Linux package execution.
- Background autonomy after the app closes.
- Live external-provider or third-party connector credentials in CI.
- Full streaming tool-call argument deltas; calls execute only after complete,
  valid JSON arrives, avoiding execution of partial arguments.
- A guarantee that every OpenAI-compatible provider supports function calling.
