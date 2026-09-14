import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { aetherNotebookTemplate } from "@/server/engine/aether-engine-source";

/**
 * Per-session workspace, list_files and package_files — executed for real.
 *
 * These are kernel-side Python, so the only honest test is to extract the
 * functions from the shipped template and run them. Assertions are on
 * behaviour, not on the presence of a string.
 */

const PY = `
import json, re, os, subprocess, sys, tempfile
nb = json.loads(open(sys.argv[1]).read())
src = nb["cells"][4]["source"]
src = "".join(src) if isinstance(src, list) else src
ns = {"re": re, "os": os, "subprocess": subprocess}
i = src.find("SESSION_ROOT =")
j = src.find("def t_run_command")
exec(src[i:j], ns)

ns["SESSION_ROOT"] = sys.argv[2]
ns["GEN_DIR"] = sys.argv[3]
print(json.dumps({"ok": True, "funcs": sorted(k for k in ns if k.startswith(("_session", "_workspace", "t_")))}))
`;

let tmp: string;
let nbPath: string;
let helper: string;
let sessionRoot: string;
let genDir: string;

function runPython(script: string, args: string[] = []): string {
  const p = path.join(tmp, "case.py");
  writeFileSync(p, script);
  return execFileSync("python3", [p, ...args], { encoding: "utf8", timeout: 60_000 });
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "ws-"));
  nbPath = path.join(tmp, "notebook.json");
  writeFileSync(nbPath, aetherNotebookTemplate());
  sessionRoot = path.join(tmp, "sessions");
  genDir = path.join(tmp, "gen");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("kernel exposes the workspace tools", () => {
  it("registers list_files and package_files in the tool schema and dispatch", () => {
    const nb = aetherNotebookTemplate();
    expect(nb).toContain("'name':'list_files'");
    expect(nb).toContain("'name':'package_files'");
    expect(nb).toContain("'list_files': t_list_files");
    expect(nb).toContain("'package_files': t_package_files");
  });

  it("extracts and loads without error", () => {
    const out = runPython(PY, [nbPath, sessionRoot, genDir]);
    const parsed = JSON.parse(out.trim().split("\n").pop()!);
    expect(parsed.ok).toBe(true);
    expect(parsed.funcs).toContain("_session_dir");
    expect(parsed.funcs).toContain("t_list_files");
    expect(parsed.funcs).toContain("t_package_files");
  });
});

describe("session workspace isolation", () => {
  const CASE = `
import json, re, os, subprocess, sys
nb = json.loads(open(sys.argv[1]).read())
src = nb["cells"][4]["source"]; src = "".join(src) if isinstance(src, list) else src
ns = {"re": re, "os": os, "subprocess": subprocess}
exec(src[src.find("SESSION_ROOT ="):src.find("def t_run_command")], ns)
ns["SESSION_ROOT"] = sys.argv[2]; ns["GEN_DIR"] = sys.argv[3]
sd = ns["_session_dir"]; tree = ns["_workspace_tree"]

a = sd("alpha"); b = sd("beta")
open(a + "/alpha.txt", "w").write("alpha-secret")
open(b + "/beta.txt", "w").write("beta-secret")
print(json.dumps({
  "distinct": a != b,
  "alpha_tree": tree(a),
  "beta_tree": tree(b),
  "alpha_sees_beta": "beta" in tree(a),
  "beta_sees_alpha": "alpha" in tree(b),
}))
`;

  it("gives each session its own directory and hides the others", () => {
    const out = runPython(CASE, [nbPath, sessionRoot, genDir]);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    expect(r.distinct).toBe(true);
    expect(r.alpha_tree).toContain("alpha.txt");
    expect(r.alpha_sees_beta).toBe(false);
    expect(r.beta_sees_alpha).toBe(false);
  });
});

describe("session id validation — a client-supplied path must not escape", () => {
  const CASE = `
import json, re, os, subprocess, sys
nb = json.loads(open(sys.argv[1]).read())
src = nb["cells"][4]["source"]; src = "".join(src) if isinstance(src, list) else src
ns = {"re": re, "os": os, "subprocess": subprocess}
exec(src[src.find("SESSION_ROOT ="):src.find("def t_run_command")], ns)
ns["SESSION_ROOT"] = sys.argv[2]; ns["GEN_DIR"] = sys.argv[3]
sd = ns["_session_dir"]
root = ns["SESSION_ROOT"]
cases = ["abc-123", "task_9", "../etc", "../../root", "a" * 80, "", None, "ok"]
out = {}
for c in cases:
    d = sd(c)
    out[str(c)[:12]] = d == root or d.startswith(root + "/") or d == "/kaggle/working"
print(json.dumps(out))
`;

  it("confines every session id inside the session root", () => {
    const out = runPython(CASE, [nbPath, sessionRoot, genDir]);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    for (const [k, v] of Object.entries(r)) {
      expect(v, `session id ${JSON.stringify(k)} escaped the workspace`).toBe(true);
    }
  });
});

describe("package_files must not swallow the previous archive", () => {
  /* Measured live: a re-run packed the old svc.zip inside the new one, so the
     archive listed itself as an entry and grew every time. */
  const CASE = `
import json, re, os, subprocess, sys, zipfile
nb = json.loads(open(sys.argv[1]).read())
src = nb["cells"][4]["source"]; src = "".join(src) if isinstance(src, list) else src
ns = {"re": re, "os": os, "subprocess": subprocess}
exec(src[src.find("SESSION_ROOT ="):src.find("def t_run_command")], ns)
ns["SESSION_ROOT"] = sys.argv[2]; ns["GEN_DIR"] = sys.argv[3]
sd = ns["_session_dir"]; pkg = ns["t_package_files"]
ws = sd("repack"); ns["_CURRENT"] = {"ws": ws, "session": "repack"}
os.makedirs(ws + "/svc")
open(ws + "/svc/app.py", "w").write("x = 1")
open(ws + "/svc/REPORT.md", "w").write("report")
open(ws + "/svc.zip", "wb").write(b"PK\x03\x04oldarchive")
msg = pkg(name="svc.zip")
zp = os.path.join(ns["GEN_DIR"], "svc.zip")
z = zipfile.ZipFile(zp)
print(json.dumps({"entries": sorted(z.namelist()), "msg": msg}))
`;

  it("excludes a root-level .zip left over from a previous run", () => {
    const out = runPython(CASE, [nbPath, sessionRoot, genDir]);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    expect(r.entries).toEqual(["svc/REPORT.md", "svc/app.py"]);
    expect(r.entries).not.toContain("svc.zip");
    expect(r.msg).toContain("2 file(s)");
  });
});

describe("package_files", () => {
  const CASE = `
import json, re, os, subprocess, sys, zipfile, hashlib
nb = json.loads(open(sys.argv[1]).read())
src = nb["cells"][4]["source"]; src = "".join(src) if isinstance(src, list) else src
ns = {"re": re, "os": os, "subprocess": subprocess}
exec(src[src.find("SESSION_ROOT ="):src.find("def t_run_command")], ns)
ns["SESSION_ROOT"] = sys.argv[2]; ns["GEN_DIR"] = sys.argv[3]
sd = ns["_session_dir"]; pkg = ns["t_package_files"]

ws = sd("packer"); ns["_CURRENT"] = {"ws": ws, "session": "packer"}
open(ws + "/a.py", "w").write("print(1)")
os.makedirs(ws + "/sub"); open(ws + "/sub/b.txt", "w").write("hello")
os.makedirs(ws + "/__pycache__"); open(ws + "/__pycache__/junk.pyc", "w").write("x")

whole = pkg()
zips = [f for f in os.listdir(ns["GEN_DIR"]) if f.endswith(".zip")]
zp = os.path.join(ns["GEN_DIR"], zips[0])
data = open(zp, "rb").read()
z = zipfile.ZipFile(zp)
res = {
  "whole_msg": whole,
  "entries": sorted(z.namelist()),
  "magic_ok": data[:2] == b"PK",
  "sha_in_msg": hashlib.sha256(data).hexdigest()[:16] in whole,
  "size_in_msg": str(len(data)) in whole,
  "one_file": pkg(paths=["a.py"]),
  "missing": pkg(paths=["nope.py"]),
}
ns["_CURRENT"] = {"ws": sd("empty"), "session": "empty"}
res["empty"] = pkg()
print(json.dumps(res))
`;

  it("zips the workspace, excludes build noise, and reports verifiable integrity", () => {
    const out = runPython(CASE, [nbPath, sessionRoot, genDir]);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    expect(r.magic_ok).toBe(true);
    expect(r.entries).toEqual(["a.py", "sub/b.txt"]);
    /* The reported size and checksum must match the bytes actually written,
       or "packaged successfully" is an unverifiable claim. */
    expect(r.size_in_msg).toBe(true);
    expect(r.sha_in_msg).toBe(true);
    expect(r.one_file).toContain("1 file(s)");
    expect(r.missing).toContain("nothing to package");
    expect(r.empty).toContain("nothing to package");
  });
});

describe("an oversized user message is trimmed, not rejected", () => {
  /* Reproduced live: a 48,087-character paste returned
     HTTP 400 {"error":"request (8334 tokens) exceeds the available context
     size (8192 tokens)"} -- a raw engine error and no answer. history_window
     trimmed history and tool results but never a single large user message, so
     one long paste was fatal. Pasting a lot of text must not be an error. */
  const CASE = `
import json, re, sys
nb = json.loads(open(sys.argv[1]).read())
src = nb["cells"][4]["source"]; src = "".join(src) if isinstance(src, list) else src
ns = {"re": re, "NUM_CTX": 8192, "NUM_PREDICT": 4096}
i = src.find("def history_window")
j = src.find("\\n\\n# Bound a single generation")
exec(src[i:j], ns)
hw = ns["history_window"]
SYS = {"role": "system", "content": "S" * 1400}

def size(ms):
    return sum(len(str(m.get("content") or "")) for m in ms)

out = {}

# A normal turn must be untouched.
small = hw([SYS, {"role": "user", "content": "hi"}])
out["small_untouched"] = small[-1]["content"] == "hi"

# A 48k paste must come back inside the budget, question intact.
big = "Background context. " * 4000 + "\\n\\nQUESTION: what word starts this message?"
r = hw([SYS, {"role": "user", "content": big}])
out["big_within_budget"] = size(r) <= 14000
out["big_question_kept"] = "QUESTION: what word starts this message?" in r[-1]["content"]
out["big_notice_present"] = "characters omitted from the middle" in r[-1]["content"]

# A question at the very END of a huge paste must survive -- that is where
# users put it, and losing it would silently change what was asked.
huge = "X" * 60000 + "\\n\\nFINAL QUESTION HERE"
r2 = hw([SYS, {"role": "user", "content": huge}])
out["huge_question_at_end_kept"] = "FINAL QUESTION HERE" in r2[-1]["content"]
out["huge_head_kept"] = r2[-1]["content"].startswith("X")
out["huge_within_budget"] = size(r2) <= 14000

# The system prompt must survive too, or the agent loses its instructions.
out["system_kept"] = r2[0]["role"] == "system"

print(json.dumps(out))
`;

  it("keeps the question, the head and the system prompt inside the budget", () => {
    const out = runPython(CASE, [nbPath, sessionRoot, genDir]);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    for (const [k, v] of Object.entries(r)) {
      expect(v, `${k} should hold`).toBe(true);
    }
  });
});

describe("an archive the model builds in the workspace gets published", () => {
  /* Measured live: told to "package the workspace into build.zip", the model ran
     `zip -r build.zip build` through run_command instead of package_files. The
     archive was real -- 557 bytes, confirmed on disk -- but it sat in the
     session workspace while GEN_DIR is what the tunnel serves, so
     /files/build.zip returned 404 and the user was told it was packaged. */
  const CASE = `
import json, re, os, subprocess, sys, time, zipfile
nb = json.loads(open(sys.argv[1]).read())
src = nb["cells"][4]["source"]; src = "".join(src) if isinstance(src, list) else src
ns = {"re": re, "os": os, "subprocess": subprocess, "time": time}
exec(src[src.find("SESSION_ROOT ="):src.find("def t_run_command")], ns)
# Both kernel paths must point at the temp directories before any helper runs,
# or the code tries to create /kaggle/working/... and the test dies on a
# permission error that has nothing to do with the behaviour under test.
ns["GEN_DIR"] = sys.argv[3]
ns["SESSION_ROOT"] = sys.argv[2]
sd = ns["_session_dir"]; pub = ns["_publish_archives"]
ws = sd("pubcase"); ns["_CURRENT"] = {"ws": ws, "session": "pubcase"}
os.makedirs(ws + "/build")
open(ws + "/build/util.py", "w").write("def double(x): return 2*x\\n")
subprocess.run(["zip", "-qr", "build.zip", "build"], cwd=ws, capture_output=True)
gen = ns["GEN_DIR"]
before = sorted(os.listdir(gen))
pub()
after = sorted(os.listdir(gen))
pub()
again = sorted(os.listdir(gen))
z = zipfile.ZipFile(os.path.join(gen, "build.zip"))
print(json.dumps({
  "shell_built_it": os.path.exists(ws + "/build.zip"),
  "before": before,
  "after": after,
  "idempotent": again == after,
  "entries": sorted(z.namelist()),
  "valid": z.testzip() is None,
}))
`;

  it("copies a shell-built zip into the served directory", () => {
    const out = runPython(CASE, [nbPath, sessionRoot, genDir]);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    expect(r.shell_built_it).toBe(true);
    expect(r.before).not.toContain("build.zip");
    expect(r.after).toContain("build.zip");
    expect(r.idempotent).toBe(true);
    expect(r.entries).toContain("build/util.py");
    expect(r.valid).toBe(true);
  });
});
