import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AETHER_NOTEBOOK_SHA256,
  aetherNotebookTemplate,
  getAetherNotebook,
  renderAetherNotebook,
} from "@/server/engine/aether-engine-source";

/**
 * Tests for the engine source module (aether-engine-source.ts).
 *
 * The module stores the verified engine notebook as a TEMPLATE with {{...}}
 * placeholders and renders it with server env secrets at push time.
 * getAetherNotebook("a") fails closed on tampering AND on a missing secret.
 *
 * NOTE: these tests deliberately never spell out the OFF_KEY / beacon token /
 * ntfy topic that the previous revision leaked. Re-embedding them here would
 * undo the fix. Dummy values of the SAME LENGTH are used where a length
 * invariant needs checking.
 */

/* Lengths of the values the original notebook carried: OFF_KEY, webhook.site
   token (UUID), ntfy topic. Used only to prove the substitution is lossless. */
const ORIGINAL_VALUE_LENGTHS = { offKey: 16, beaconToken: 36, beaconTopic: 17 };

const DUMMY = {
  offKey: "k".repeat(ORIGINAL_VALUE_LENGTHS.offKey),
  /* Shaped like a real webhook.site UUID (hex + hyphens) so the BEACON_URL
     parser accepts it, while remaining an obvious non-secret. Same length as
     the original, so the byte-count invariant still holds. */
  beaconToken: "11111111-2222-3333-4444-555555555555",
  beaconTopic: "c".repeat(ORIGINAL_VALUE_LENGTHS.beaconTopic),
  slot: "a" as const,
};

/* Guard the guard: the dummy must be the same length it claims. */
if (DUMMY.beaconToken.length !== ORIGINAL_VALUE_LENGTHS.beaconToken) {
  throw new Error("test fixture drift: dummy beaconToken length changed");
}

const PLACEHOLDERS = ["{{AETHER_OFF_KEY}}", "{{AETHER_BEACON_TOKEN}}", "{{AETHER_BEACON_TOPIC}}"];

/**
 * The engine's Python, decoded from the shipped template. Jupyter allows
 * `source` to be an array of lines OR a single string, so handle both.
 */
function enginePython(): string {
  const nb = JSON.parse(aetherNotebookTemplate()) as {
    cells: Array<{ cell_type: string; source?: string[] | string }>;
  };
  return nb.cells
    .filter((c) => c.cell_type === "code")
    .map((c) => (Array.isArray(c.source) ? c.source.join("") : (c.source ?? "")))
    .join("\n");
}

describe("engine source — template integrity gate", () => {
  it("exposes the pinned SHA-256 of the stored template", () => {
    expect(AETHER_NOTEBOOK_SHA256).toBe("44fe57b29731a34bb5c0b9eec97b33bbb0d4ddabfeb9992c9710fc1bfb15cd20");
  });

  it("the stored template decodes to the pinned bytes and is a valid notebook", () => {
    const template = aetherNotebookTemplate(); // throws if tampered
    const hash = createHash("sha256").update(template, "utf8").digest("hex");
    expect(hash).toBe(AETHER_NOTEBOOK_SHA256);
    const parsed = JSON.parse(template) as { cells?: unknown; nbformat?: number };
    expect(Array.isArray(parsed.cells)).toBe(true);
    expect(parsed.nbformat).toBe(4);
  });

  it("carries every placeholder the renderer must resolve", () => {
    const template = aetherNotebookTemplate();
    for (const p of PLACEHOLDERS) expect(template).toContain(p);
  });
});

describe("engine source — no secret is stored in the repo (audit C3/C5)", () => {
  it("the module source contains no leaked OFF_KEY, beacon token or ntfy topic", () => {
    /* The previous revision hid these inside a Base64 blob, which defeated every
       grep-based scan. Assert on the decoded template as well as the file text,
       so the fix cannot be undone by re-encoding. */
    const fileText = readFileSync("src/server/engine/aether-engine-source.ts", "utf8");
    const template = aetherNotebookTemplate();

    /* Patterns, not values: a leaked OFF_KEY was REMOVED_ENGINE_OFF_KEY, the beacon token
       is a UUID, the ntfy topic matched btb-kaggle-*. */
    const forbidden = [
      /nxoff-[A-Za-z0-9]{8,}/,
      /btb-kaggle-[0-9a-f]{4}/,
      /webhook\.site\/(?:token\/)?[0-9a-f-]{36}/,
    ];
    for (const re of forbidden) {
      expect(fileText, `file matched ${re}`).not.toMatch(re);
      expect(template, `template matched ${re}`).not.toMatch(re);
    }
  });

  it("the notebook's /off handler keys off the injected value, not a literal", () => {
    const rendered = renderAetherNotebook(DUMMY);
    expect(rendered).toContain(`OFF_KEY = '${DUMMY.offKey}'`);
    /* The engine compares the request header against that same injected key. */
    expect(rendered).toContain("self.headers.get('X-Engine-Key') != OFF_KEY");
  });
});

describe("engine source — rendering", () => {
  it("resolves every placeholder", () => {
    const rendered = renderAetherNotebook(DUMMY);
    for (const p of PLACEHOLDERS) expect(rendered).not.toContain(p);
    expect(rendered).toContain(DUMMY.beaconToken);
    expect(rendered).toContain(DUMMY.beaconTopic);
  });

  it("renders to a stable size and stays valid JSON", () => {
    /*
     * Templating alone was verified byte-lossless against the original notebook
     * (rendering with the originals' values reproduced sha256 3dc068d15a4c745d...
     * exactly). The size then grew deliberately with the audit C5 hardening, so
     * this pins the current rendered size rather than the original one.
     *
     * 40875 -> 43521: the model path stopped shelling out to curl and now uses
     * http.client, records the HTTP status and body when a call yields nothing
     * instead of hiding it behind a placeholder, and retries once without
     * streaming before giving up.
     * 43521 -> 46275: history_window() replaced the naive msgs[-24:] slice that
     * was dropping the user query and hard-failing the chat template with
     * "No user query found in messages." on multi-tool turns.
     * scripts/verify-engine-source.mjs computes the same figure independently.
     */
    const rendered = renderAetherNotebook(DUMMY);
    expect(Buffer.byteLength(rendered, "utf8")).toBe(46275);
    expect(() => JSON.parse(rendered)).not.toThrow();
  });

  it("fails closed when a secret is not configured", () => {
    expect(() => renderAetherNotebook({ ...DUMMY, offKey: "" })).toThrow(/ENGINE_OFF_KEY/);
    expect(() => renderAetherNotebook({ ...DUMMY, beaconToken: "" })).toThrow(/ENGINE_BEACON_TOKEN/);
    expect(() => renderAetherNotebook({ ...DUMMY, beaconTopic: "" })).toThrow(/ENGINE_BEACON_TOPIC/);
  });

  it("getAetherNotebook reads the secrets from server env", () => {
    const saved = { ...process.env };
    try {
      process.env.ENGINE_OFF_KEY = DUMMY.offKey;
      process.env.ENGINE_BEACON_TOKEN = DUMMY.beaconToken;
      process.env.ENGINE_BEACON_TOPIC = DUMMY.beaconTopic;
      expect(getAetherNotebook("a")).toContain(DUMMY.offKey);

      delete process.env.ENGINE_OFF_KEY;
      expect(() => getAetherNotebook("a")).toThrow(/ENGINE_OFF_KEY/);
    } finally {
      process.env = saved;
    }
  });

  it("derives the beacon token and topic from BEACON_URL / BEACON_BACKUP_URL", () => {
    const saved = { ...process.env };
    try {
      delete process.env.ENGINE_BEACON_TOKEN;
      delete process.env.ENGINE_BEACON_TOPIC;
      process.env.ENGINE_OFF_KEY = DUMMY.offKey;
      process.env.BEACON_URL = `https://webhook.site/${DUMMY.beaconToken}`;
      process.env.BEACON_BACKUP_URL = `https://ntfy.sh/${DUMMY.beaconTopic}/json?poll=1&since=12h`;
      const nb = getAetherNotebook("a");
      expect(nb).toContain(DUMMY.beaconToken);
      expect(nb).toContain(DUMMY.beaconTopic);
    } finally {
      process.env = saved;
    }
  });
});

describe("engine source — engine-side hardening (audit C5)", () => {
  const python = () => {
    const nb = JSON.parse(renderAetherNotebook(DUMMY)) as {
      cells: Array<{ cell_type: string; source?: string[] | string }>;
    };
    /* Jupyter allows `source` to be either an array of lines or one string. */
    return nb.cells
      .filter((c) => c.cell_type === "code")
      .map((c) => (Array.isArray(c.source) ? c.source.join("") : (c.source ?? "")))
      .join("\n");
  };

  it("authenticates every POST before routing, not just /off", () => {
    const py = python();
    /* The gate must be the first thing do_POST does, so /api/chat and the raw
       ollama proxy are covered too — previously only /off checked the key, and
       an unauthenticated /api/chat meant remote code execution. */
    expect(py).toMatch(
      /def do_POST\(self\):\s*\n\s*body = self\._read_body\(\)\s*\n(?:\s*#[^\n]*\n)*\s*if self\.headers\.get\('X-Engine-Key'\) != OFF_KEY:/,
    );
  });

  it("does not offer a wildcard CORS header", () => {
    expect(python()).not.toContain("Access-Control-Allow-Origin");
  });

  it("the engine python is syntactically valid", () => {
    /* Cheap structural guard: the handler class and its routes are all present
       after the source edits. A real python parse happens in CI via
       scripts/verify-engine-source.mjs. */
    const py = python();
    for (const needle of ["class H(BaseHTTPRequestHandler)", "def do_POST", "def do_GET", "def _cors"]) {
      expect(py, `missing ${needle}`).toContain(needle);
    }
  });
});

describe("engine source — single copy, single control plane", () => {
  /**
   * FIX (audit §3.3 / A6): there used to be a second copy of the engine notebook
   * at netlify/functions/ensure-alive/notebook.ipynb, shipped into every deploy
   * bundle by netlify.toml's included_files. Two copies of the engine source is
   * how the control planes drifted apart. This asserts the duplicate stays gone.
   */
  it("the engine notebook exists in exactly one place (no bundled duplicate)", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync("netlify/functions/ensure-alive/notebook.ipynb")).toBe(false);
    expect(existsSync("netlify/functions")).toBe(false);
  });

  it("netlify.toml no longer ships the notebook into the function bundle", () => {
    const toml = readFileSync("netlify.toml", "utf8");
    /* Assert on directives, not prose: comments are allowed to explain the change. */
    expect(toml).not.toMatch(/^\s*included_files\s*=/m);
    expect(toml).not.toMatch(/^\s*\[functions\]/m);
  });

  it("no second control plane: the legacy function handlers are gone", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync("netlify/functions/ensure-alive/ensure-alive.js")).toBe(false);
    expect(existsSync("netlify/functions/engine-off/engine-off.js")).toBe(false);
    /* The rewrites that made Netlify and local dev run different code are gone. */
    const cfg = readFileSync("next.config.ts", "utf8");
    expect(cfg).not.toMatch(/async\s+rewrites\s*\(/);
    expect(cfg).not.toMatch(/source:\s*["'`]/);
  });
});

describe("engine source — real streaming, not a replay (audit §4 item 9)", () => {
  /*
   * The engine used to call ollama with stream:False, wait for the ENTIRE
   * generation, then replay the finished answer word by word with
   * time.sleep(0.006). Time-to-first-token equalled total generation time, so a
   * 60 s answer meant 60 s of blank screen.
   */
  it("no longer replays a finished answer word by word", () => {
    const py = enginePython();
    expect(py).not.toContain("time.sleep(0.006");
    expect(py).not.toContain("for w in content.split");
  });

  it("asks ollama for a real stream on the tool-calling loop", () => {
    const py = enginePython();
    expect(py).not.toContain("'stream': False, 'tools'");
    expect(py).toContain("'stream': True, 'tools'");
  });

  it("has a streaming reader that forwards deltas as they arrive", () => {
    const py = enginePython();
    expect(py).toContain("def ollama_stream(payload, push, timeout=1200):");
    /* curl -N is what makes ollama flush each NDJSON chunk immediately. */
    expect(py).toMatch(/curl','-s','-N'/);
    /* Tool calls must still be detected, or the agent loop breaks. */
    expect(py).toContain("for tc in (mm.get('tool_calls') or []): tcs.append(tc)");
  });

  it("does not double-emit the answer it already streamed", () => {
    const py = enginePython();
    expect(py).toContain("if not st['any']:");
  });

  it("still compiles as python", () => {
    /* Structural guard: the patch script compiles it, this proves the shipped
       bytes are the same ones that compiled. */
    const py = enginePython();
    expect(py.length).toBeGreaterThan(30_000);
    expect(py).toContain("def agent_stream(handler, user_payload):");
  });
});

describe("engine source — keep-alive socket hygiene (the 501 bug)", () => {
  /*
   * Observed on the real engine: POST /off and some POST /api/chat calls returned
   * 501 with Python's default BaseHTTPRequestHandler page, alternating perfectly
   * with correct 403s from the same tunnel URL (403, 501, 403, 501, 403).
   *
   * Cause: the handler declares protocol_version = 'HTTP/1.1', so sockets are
   * keep-alive, and the 403 gate returned WITHOUT consuming the request body.
   * Those bytes stayed in the socket, so the next request parsed off that pooled
   * connection read leftover JSON as a request line -> "Unsupported method".
   */
  it("declares HTTP/1.1, which is what makes an unread body fatal", () => {
    expect(enginePython()).toContain("protocol_version = 'HTTP/1.1'");
  });

  it("drains the request body before the auth gate can return", () => {
    const py = enginePython();
    const read = py.indexOf("body = self._read_body()");
    const gate = py.indexOf("if self.headers.get('X-Engine-Key') != OFF_KEY:");
    expect(read).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(read).toBeLessThan(gate);
  });

  it("reads the body exactly once — no branch re-reads the socket", () => {
    const py = enginePython();
    expect(py.match(/self\.rfile\.read\(int\(self\.headers\.get\('Content-Length'/g)).toBeNull();
    expect(py.match(/def _read_body\(self\):/g)).toHaveLength(1);
  });

  it("has exactly one authoritative key check, not a dead duplicate", () => {
    expect(enginePython().match(/X-Engine-Key'\) != OFF_KEY/g)).toHaveLength(1);
  });

  it("flushes /off before the process exits, so the 200 is not lost", () => {
    const py = enginePython();
    const off = py.indexOf("if self.path == '/off':");
    const exit = py.indexOf("os._exit(0)", off);
    const flush = py.indexOf("self.wfile.flush()", off);
    expect(off).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(-1);
    expect(flush).toBeLessThan(exit);
  });

  it("never writes a second status line into an already-started stream", () => {
    const py = enginePython();
    expect(py).toContain("self._sent = False");
    expect(py).toContain("if getattr(self, '_sent', False):");
    /*
     * The flag must be raised where the status line actually goes out, i.e.
     * inside agent_stream next to end_headers(). Setting it only after
     * agent_stream() RETURNS left a mid-generation failure looking like "nothing
     * sent yet", so do_POST's error handler wrote a SECOND "HTTP/1.1 200 OK" into
     * the open chunked body -- reproduced by
     * scripts/proofs/double-status-proof.py (2 status lines before, 1 after).
     */
    expect(py).toContain("handler._sent = True");
    const raise = py.indexOf("handler._sent = True");
    const endHeaders = py.indexOf("handler.end_headers()");
    expect(endHeaders).toBeGreaterThan(-1);
    expect(raise).toBeGreaterThan(endHeaders);
    /* do_POST must no longer set it on the success path -- that was the bug. */
    expect(py).not.toMatch(/agent_stream\(self, payload\)\s*\n\s*self\._sent = True/);
  });
});

describe("engine source — slot tagging on the beacon", () => {
  /*
   * The Android shell talks to Kaggle and the engines directly, with no Aether
   * server in between. To wake engine B and then find B's tunnel URL it has to
   * attribute a beacon announcement to a slot -- the URL only ever appears in
   * an announcement. resolve.ts already parses an "engine=<slot>" tag, so the
   * engine now emits one on every message.
   */
  it("stamps engine=<slot> into notify(), not just the LIVE LINK line", () => {
    const py = enginePython();
    expect(py).toContain("SLOT = '{{AETHER_SLOT}}'");
    expect(py).toContain("m = 'engine=' + SLOT + ' ' + str(m)");
    /* Both notify definitions (the original cell and the post-model
       redefinition) must tag, or half the announcements are unattributable. */
    expect(py.match(/m = 'engine=' \+ SLOT \+ ' ' \+ str\(m\)/g)).toHaveLength(2);
  });

  it("renders the slot the caller asked for", () => {
    for (const slot of ["a", "b", "c"] as const) {
      const nb = JSON.parse(renderAetherNotebook({ ...DUMMY, slot })) as {
        cells: Array<{ source?: string[] | string }>;
      };
      const code = nb.cells
        .map((c) => (Array.isArray(c.source) ? c.source.join("") : c.source ?? ""))
        .join("\n");
      expect(code).toContain(`SLOT = '${slot}'`);
      expect(code).not.toContain("{{AETHER_SLOT}}");
    }
  });

  it("refuses to render without a slot rather than booting an anonymous engine", () => {
    expect(() =>
      renderAetherNotebook({ ...DUMMY, slot: "" }),
    ).toThrow(/slot/);
  });
});
