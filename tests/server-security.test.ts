import { afterEach, describe, expect, it } from "vitest";
import {
  ToolSecurityError,
  assertUrlAllowed,
  redactSecrets,
  resolveWorkspacePath,
  WORKSPACE_ROOT,
} from "@/server/tools/security";

describe("workspace path guard", () => {
  it("resolves relative paths inside the workspace", () => {
    const resolved = resolveWorkspacePath("runs/abc/file.txt");
    expect(resolved.startsWith(WORKSPACE_ROOT)).toBe(true);
  });

  it("blocks traversal escapes", () => {
    expect(() => resolveWorkspacePath("../../etc/passwd")).toThrow(ToolSecurityError);
    expect(() => resolveWorkspacePath("runs/../../../etc/shadow")).toThrow(ToolSecurityError);
    expect(() => resolveWorkspacePath("/etc/passwd")).not.toThrow(); // leading slash re-rooted inside workspace
    const rooted = resolveWorkspacePath("/etc/passwd");
    expect(rooted.startsWith(WORKSPACE_ROOT)).toBe(true);
  });

  it("rejects empty and oversized paths", () => {
    expect(() => resolveWorkspacePath("")).toThrow();
    expect(() => resolveWorkspacePath("x".repeat(600))).toThrow();
    expect(() => resolveWorkspacePath("a\0b")).toThrow();
  });
});

describe("network guard", () => {
  it("allows public https URLs", () => {
    expect(() => assertUrlAllowed("https://example.com/page?q=1")).not.toThrow();
  });

  it("blocks loopback, private, link-local and metadata targets", () => {
    const blocked = [
      "http://localhost:3000/",
      "http://127.0.0.1/admin",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.9/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://example.local/",
      "http://internal.service.internal/",
    ];
    for (const url of blocked) {
      expect(() => assertUrlAllowed(url), url).toThrow(ToolSecurityError);
    }
  });

  it("blocks non-http(s) schemes and non-standard ports", () => {
    expect(() => assertUrlAllowed("file:///etc/passwd")).toThrow();
    expect(() => assertUrlAllowed("ftp://example.com/x")).toThrow();
    expect(() => assertUrlAllowed("http://example.com:8080/")).toThrow();
  });

  it("rejects garbage input", () => {
    expect(() => assertUrlAllowed("not a url")).toThrow();
  });
});

describe("secret redaction", () => {
  it("scrubs configured secret values and generic tokens", () => {
    process.env.AETHER_AGENT_KEY = "super-secret-value-123";
    const out = redactSecrets(`leak: super-secret-value-123 and Bearer abcdefghijklmnopqrstuvwxyz123`);
    expect(out).not.toContain("super-secret-value-123");
    expect(out).toContain("[redacted]");
    expect(out).toContain("[redacted-token]");
    delete process.env.AETHER_AGENT_KEY;
  });
});

describe("tool failure classification (audit §6.7)", () => {
  it("a policy refusal is reported as kind:'policy', not an upstream failure", async () => {
    const { executeTool } = await import("@/server/tools");
    const r = await executeTool("web.fetch", { url: "http://169.254.169.254/latest/meta-data/" }, "proof");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("policy");
    expect(r.text).toMatch(/policy|denied/i);
  });

  it("a non-standard port is a policy refusal, not an upstream failure", async () => {
    const { executeTool } = await import("@/server/tools");
    const r = await executeTool("web.fetch", { url: "http://127.0.0.1:8080/" }, "proof");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("policy");
  });

  it("an unknown tool is reported as kind:'invalid'", async () => {
    const { executeTool } = await import("@/server/tools");
    const r = await executeTool("no.such.tool", {}, "proof");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("invalid");
  });
});

/* ------------------------------------------------------------------------- */
/* B5: Engine C must be present in every security path, not just A and B.     */
/* ------------------------------------------------------------------------- */
describe("redactSecrets covers all three engine accounts (audit B5)", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("scrubs the A, B and C keys and usernames equally", () => {
    /* Slot C credentials have historically been the ones left out of config and
       redaction paths, so all three are asserted side by side. */
    process.env.KAGGLE_USERNAME = "user-alpha";
    process.env.KAGGLE_KEY = "key-alpha-0001";
    process.env.KAGGLE_USERNAME_B = "user-beta";
    process.env.KAGGLE_KEY_B = "key-beta-0002";
    process.env.KAGGLE_USERNAME_C = "user-gamma";
    process.env.KAGGLE_KEY_C = "key-gamma-0003";
    process.env.ENGINE_OFF_KEY = "off-key-DO-NOT-SHIP";

    const out = redactSecrets(
      "a=user-alpha/key-alpha-0001 b=user-beta/key-beta-0002 c=user-gamma/key-gamma-0003 off=off-key-DO-NOT-SHIP",
    );

    for (const secret of [
      "user-alpha", "key-alpha-0001",
      "user-beta", "key-beta-0002",
      "user-gamma", "key-gamma-0003",
      "off-key-DO-NOT-SHIP",
    ]) {
      expect(out, `expected ${secret} to be scrubbed`).not.toContain(secret);
    }
    expect(out).toContain("[redacted]");
  });

  it("never lets an engine tunnel URL through a tool result", () => {
    const out = redactSecrets("live at https://abc-123.trycloudflare.com/api/chat now");
    expect(out).not.toMatch(/trycloudflare\.com/);
    expect(out).toContain("[engine-url]");
  });
});
