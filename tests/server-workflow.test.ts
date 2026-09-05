import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executeTool } from "@/server/tools";
import { WORKSPACE_ROOT } from "@/server/tools/security";

const TASK = "workflow-test-run";

afterAll(async () => {
  await fs.rm(path.join(WORKSPACE_ROOT, "runs", TASK), { recursive: true, force: true });
});

/**
 * Local workspace tooling (file + web). Arbitrary command execution is NOT
 * local: it runs on the agent's real execution environment (the engine) via
 * the `run_command` engine tool, so this suite only covers local file/web ops
 * and the execution-boundary guards.
 */
describe("local workspace tool workflow", () => {
  it("inspects, writes, reads, searches and removes a file", async () => {
    /* 1. inspect */
    const listed = await executeTool("fs.list", { path: "." }, TASK);
    expect(listed.ok).toBe(true);

    /* 2. write */
    const wrote = await executeTool("fs.write", { path: "notes.md", content: "# Aether\nlocal workspace file" }, TASK);
    expect(wrote.ok).toBe(true);

    /* 3. read back */
    const read = await executeTool("fs.read", { path: "notes.md" }, TASK);
    expect(read.text).toContain("local workspace file");

    /* 4. search */
    const found = await executeTool("fs.search", { query: "workspace file" }, TASK);
    expect(found.text).toContain("notes.md");

    /* 5. remove */
    const removed = await executeTool("fs.remove", { path: "notes.md" }, TASK);
    expect(removed.ok).toBe(true);
  });

  it("rejects unknown tools with the capability list", async () => {
    const result = await executeTool("no.such.tool", {}, TASK);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Available");
  });

  it("no longer exposes local shell/process/package execution", async () => {
    /* Command execution belongs on the engine (run_command), not this host. */
    for (const name of ["shell.run", "process.start", "package.install"]) {
      const result = await executeTool(name, {}, TASK);
      expect(result.ok).toBe(false);
      expect(result.text).toContain("Unknown tool");
    }
  });

  it("surfaces path-traversal denials as tool failures the model can read", async () => {
    const escape = await executeTool("fs.write", { path: "../../../outside.txt", content: "x" }, TASK);
    expect(escape.ok).toBe(false);
    expect(escape.text).toMatch(/escapes|denied/i);
  });
});
