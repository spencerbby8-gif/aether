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

    const out = (await transferWorkspace("https://old.example", "https://new.example", "sess-1", KEY, fetchImpl)) as
      TransferOutcome & { fromCheckpoint?: boolean };
    expect(out.status).toBe("restored");
    if (out.status === "restored") {
      expect(out.files).toBe(2);
      /* Came from the live workspace, so it must not be marked as a checkpoint. */
      expect(out.fromCheckpoint).toBe(false);
    }
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

describe("a dead engine is still recoverable from its last checkpoint", () => {
  /* Measured: an engine killed mid-task could not be asked for its workspace --
     /off had already taken the kernel down, so the export returned 530 and the
     task's files were gone for good. The engine now writes a checkpoint after
     every tool step, and the transfer falls back to it. */

  it("recovers from a client-held checkpoint when the engine is gone entirely", async () => {
    /* The engine writes its checkpoint to its OWN disk behind its OWN tunnel,
       so a dead kernel serves neither /workspace nor /checkpoint -- both are
       530. The copy that survives is the one the client pulled while the engine
       was still alive. That is the only path that recovers a dead engine's
       work, and this test pins it. */
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://dead")) {
        return new Response("origin unreachable", { status: 530 });
      }
      return new Response(JSON.stringify({ status: "restored", files: 3 }), { status: 200 });
    }) as unknown as typeof fetch;

    const held = zip();
    const out = (await transferWorkspace(
      "https://dead", "https://live", "s1", KEY, fetchImpl, held,
    )) as TransferOutcome & { fromCheckpoint?: boolean };
    expect(out.status).toBe("restored");
    if (out.status === "restored") {
      expect(out.files).toBe(3);
      expect(out.fromCheckpoint).toBe(true);
    }
    expect(calls[0]).toContain("/workspace/s1.zip");
    expect(calls[1]).toContain("/checkpoint/s1.zip");
  });

  it("reads a checkpoint off a LIVE engine so the client can hold it", async () => {
    const { fetchCheckpoint } = await import("@/server/engine/workspace-transfer");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(zip(), { status: 200 });
    }) as unknown as typeof fetch;
    const buf = await fetchCheckpoint("https://live", "s1", KEY, fetchImpl);
    expect(buf).not.toBeNull();
    expect(buf!.byteLength).toBeGreaterThan(0);
    expect(calls[0].url).toBe("https://live/checkpoint/s1.zip");
    expect((calls[0].init?.headers as Record<string, string>)["X-Engine-Key"]).toBe(KEY);
  });

  it("a checkpoint read off a dead engine yields null, not a thrown error", async () => {
    const { fetchCheckpoint } = await import("@/server/engine/workspace-transfer");
    const fetchImpl = vi.fn(async () => new Response("gone", { status: 530 })) as unknown as typeof fetch;
    expect(await fetchCheckpoint("https://dead", "s1", KEY, fetchImpl)).toBeNull();
  });

  it("prefers the live workspace when the engine is still up", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/workspace/") && url.endsWith(".zip")) {
        return new Response(zip(), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "restored", files: 2 }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = (await transferWorkspace("https://up", "https://live", "s1", KEY, fetchImpl)) as
      TransferOutcome & { fromCheckpoint?: boolean };
    expect(out.status).toBe("restored");
    expect(out.fromCheckpoint).toBe(false);
    /* The checkpoint must not even be requested. */
    expect(calls.filter((c) => c.includes("/checkpoint/")).length).toBe(0);
  });

  it("reports nothing-to-transfer when neither exists", async () => {
    const fetchImpl = vi.fn(async (input: unknown) =>
      String(input).endsWith(".zip")
        ? new Response(null, { status: 404 })
        : new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const out = await transferWorkspace("https://x", "https://y", "s1", KEY, fetchImpl);
    expect(out.status).toBe("nothing-to-transfer");
  });
});
