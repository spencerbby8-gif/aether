#!/usr/bin/env python3
"""Browser-action latency, measured on real Chromium through the real helper.

The helper is extracted from the SHIPPED notebook asset and run as a persistent
subprocess with one JSON action per stdin line and one JSON reply per stdout
line — exactly how the engine drives it. So these numbers include the real
browser launch, the real navigation and the real page read, not a simulation.

Usage: python3 -u scripts/perf/browser-latency.py
"""
import ast
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSET = ROOT / "android/app/src/main/assets/aether-notebook-template.json"
WORK = Path("/tmp/browser-latency")
GEN = WORK / "gen"
HELPER = WORK / "bhelper.py"
CRLIBS = "/home/user/.cache/crlibs/usr/lib/x86_64-linux-gnu"


def extract_helper() -> str:
    nb = json.loads(ASSET.read_text(encoding="utf-8"))
    for cell in nb["cells"]:
        if cell.get("cell_type") != "code":
            continue
        s = cell["source"] if isinstance(cell["source"], str) else "".join(cell["source"])
        if "_B_HELPER_SRC" not in s:
            continue
        i = s.index("_B_HELPER_SRC")
        q = s.index("'", i)
        end = q + 1
        while end < len(s):
            if s[end] == "\\":
                end += 2
                continue
            if s[end] == "'":
                break
            end += 1
        src = ast.literal_eval(s[q:end + 1])
        ast.parse(src)  # must be valid Python before we trust any timing
        return src
    raise SystemExit("browser helper not found in the notebook asset")


class Helper:
    def __init__(self):
        env = dict(os.environ)
        env["AETHER_GEN_DIR"] = str(GEN)
        env["AETHER_BROWSER_DIR"] = str(WORK / "profile")
        env["LD_LIBRARY_PATH"] = CRLIBS + ":" + env.get("LD_LIBRARY_PATH", "")
        self.p = subprocess.Popen(
            [sys.executable, "-u", str(HELPER)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1, env=env)

    def call(self, **kw):
        t0 = time.time()
        self.p.stdin.write(json.dumps(kw) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        wall = time.time() - t0
        try:
            r = json.loads(line)
        except Exception:
            return wall, "NO REPLY (helper died): %r" % line[:200], False
        out = (r.get("out") or r.get("err") or "")
        # An "unknown action" reply is a bug in this script, not a result: it
        # returns in microseconds and would otherwise look like the fastest
        # browser action ever measured. Treat any non-result as a failure.
        bad = ("NEEDS APPROVAL", "BLOCKED", "ERR", "unknown action", "Error", "Traceback")
        ok = bool(r.get("ok", True)) and not out.startswith(bad)
        return wall, out, ok

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=15)
        except Exception:
            self.p.kill()


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    GEN.mkdir(parents=True, exist_ok=True)
    HELPER.write_text(extract_helper())
    print("helper extracted from the shipped asset: %d bytes" % HELPER.stat().st_size)

    h = Helper()
    steps = [
        ("launch + navigate (cold)", dict(action="navigate", url="https://example.com", session="perf")),
        ("navigate (warm)",          dict(action="navigate", url="https://example.org", session="perf")),
        ("read page",                dict(action="read", session="perf")),
        ("navigate again",           dict(action="navigate", url="https://example.com", session="perf")),
        ("read page",                dict(action="read", session="perf")),
        ("screenshot",               dict(action="screenshot", session="perf")),
    ]
    print("\n  %-26s %9s %6s  %s" % ("action", "wall", "ok", "result"))
    print("  " + "-" * 92)
    rows = []
    for label, payload in steps:
        wall, out, ok = h.call(**payload)
        rows.append((label, wall, ok))
        print("  %-26s %8.2fs %6s  %s" % (label, wall, "yes" if ok else "NO", out[:64].replace("\n", " ")))
    h.close()

    if not all(ok for _, _, ok in rows):
        print("\nBROWSER LATENCY: INCOMPLETE — an action failed, timings are not a benchmark")
        return 1
    cold = rows[0][1]
    warm = [w for l, w, _ in rows[1:]]
    print("\n  cold launch + navigate : %.2fs" % cold)
    print("  warm actions           : median %.2fs  min %.2fs  max %.2fs  (n=%d)"
          % (statistics.median(warm), min(warm), max(warm), len(warm)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
