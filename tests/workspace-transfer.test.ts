import { describe, expect, it, vi } from "vitest";
import { transferWorkspace, type TransferOutcome } from "@/server/engine/workspace-transfer";

const KEY = "test-off-key";

function zip(bytes: number[] = [0x50, 0x4b, 0x03, 0x04]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe("workspace transfer across a failover", () => {
  /* A workspace lives on the engine's own disk. Failover that only swaps the
     URL hands the new engine a task that believes it created files which are
     not there. These tests pin the two hops and the honest failure modes. */

  it("exports from the old engine and restores on the new one", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith(".zip")) {
        return new Response(zip(), { status: 200, headers: { "X-Workspace-Files": "2" } });
      }
      return new Response(JSON.stringify({ status: "restored", files: 2 }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await transferWorkspace("https://old.example", "https://new.example", "sess-1", KEY, fetchImpl);
    expect(out).toEqual({ status: "restored", files: 2 });
    expect(calls[0].url).toBe("https://old.example/workspace/sess-1.zip");
    expect(calls[1].url).toBe("https://new.example/workspace/sess-1");
    /* Both hops must be keyed or the workspace is readable by anyone. */
    expect((calls[0].init?.headers as Record<string, string>)["X-Engine-Key"]).toBe(KEY);
    expect((calls[1].init?.headers as Record<string, string>)["X-Engine-Key"]).toBe(KEY);
    expect(calls[1].init?.method).toBe("POST");
  });

  it("reports nothing-to-transfer when the old engine has no such session", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const out = await transferWorkspace("https://old.example", "https://new.example", "s", KEY, fetchImpl);
    expect(out.status).toBe("nothing-to-transfer");
  });

  it("reports source-gone when the engine being failed away from is dead", async () => {
    /* This is the common case: the engine that broke is the one holding the
       files. The task must still continue, so this is not an error. */
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const out = await transferWorkspace("https://old.example", "https://new.example", "s", KEY, fetchImpl);
    expect(out.status).toBe("source-gone");
  });

  it("reports a failed restore without pretending the files arrived", async () => {
    const fetchImpl = vi.fn(async (input: unknown) =>
      String(input).endsWith(".zip")
        ? new Response(zip(), { status: 200 })
        : new Response("disk full", { status: 500 }),
    ) as unknown as typeof fetch;
    const out = (await transferWorkspace("https://o", "https://n", "s", KEY, fetchImpl)) as
      TransferOutcome & { detail?: string };
    expect(out.status).toBe("failed");
    expect(out.detail).toContain("500");
  });

  it("refuses a session id that could escape the workspace", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    for (const bad of ["../etc", "a/b", "", "x".repeat(65), "a b"]) {
      const out = await transferWorkspace("https://o", "https://n", bad, KEY, fetchImpl);
      expect(out.status, `session id ${JSON.stringify(bad)} should be refused`).toBe("failed");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats an empty export as nothing to transfer", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(0), { status: 200 })) as unknown as typeof fetch;
    const out = await transferWorkspace("https://o", "https://n", "s", KEY, fetchImpl);
    expect(out.status).toBe("nothing-to-transfer");
  });
});
