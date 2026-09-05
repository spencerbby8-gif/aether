import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fsList, fsRead, fsRemove, fsSearch, fsWrite } from "@/server/tools/fs";
import { WORKSPACE_ROOT } from "@/server/tools/security";

const TASK = "fs-test-run";

afterAll(async () => {
  await fs.rm(path.join(WORKSPACE_ROOT, "runs", TASK), { recursive: true, force: true });
});

describe("FsProvider (real filesystem)", () => {
  it("writes, reads, lists and searches files inside the task workspace", async () => {
    const wrote = await fsWrite({ path: "app.js", content: "console.log('aether-was-here');\n" }, TASK);
    expect(wrote.ok).toBe(true);

    const read = await fsRead({ path: "app.js" }, TASK);
    expect(read.ok).toBe(true);
    expect(read.text).toContain("aether-was-here");

    const list = await fsList({ path: "." }, TASK);
    expect(list.text).toContain("app.js");

    const found = await fsSearch({ query: "aether-was-here" }, TASK);
    expect(found.text).toContain("app.js");

    const missing = await fsSearch({ query: "definitely-not-present" }, TASK);
    expect(missing.text).toContain("No matches");
  });

  it("writes nested paths and refuses workspace escapes", async () => {
    const nested = await fsWrite({ path: "sub/dir/deep.txt", content: "nested" }, TASK);
    expect(nested.ok).toBe(true);
    const read = await fsRead({ path: "sub/dir/deep.txt" }, TASK);
    expect(read.text).toContain("nested");

    await expect(fsWrite({ path: "../../escape.txt", content: "x" }, TASK)).rejects.toThrow(/escapes/);
    await expect(fsRead({ path: "../../../package.json" }, TASK)).rejects.toThrow(/escapes/);
  });

  it("deletes files but protects the run directory itself", async () => {
    await fsWrite({ path: "trash.txt", content: "bye" }, TASK);
    const removed = await fsRemove({ path: "trash.txt" }, TASK);
    expect(removed.ok).toBe(true);
    await expect(fsRead({ path: "trash.txt" }, TASK)).rejects.toThrow();
    await expect(fsRemove({ path: "." }, TASK)).rejects.toThrow(/Refusing/);
  });

  it("reports missing files as tool failures", async () => {
    await expect(fsRead({ path: "does-not-exist.txt" }, TASK)).rejects.toThrow();
  });
});
