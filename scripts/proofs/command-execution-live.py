#!/usr/bin/env python3
"""Real command-execution proof against a live engine.

Exercises the ordinary Linux operations the audit lists, through the engine's
own run_command tool, and checks each result rather than trusting the model's
summary. Anything that cannot be done is reported as a named limitation instead
of being skipped quietly.

Usage: command-execution-live.py --engine URL
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

KEY = "REMOVED_ENGINE_OFF_KEY"


def run(url, cmd, session, timeout=600):
    """Ask the engine to run one exact command; return the raw tool output."""
    body = json.dumps({
        "messages": [{"role": "user", "content":
            "Run this exact shell command with run_command and show me the raw "
            "output verbatim, with no commentary: " + cmd}],
        "session": session, "stream": True}).encode()
    req = urllib.request.Request(url + "/api/chat", data=body,
                                 headers={"Content-Type": "application/json",
                                          "X-Engine-Key": KEY})
    raw = []
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for line in r:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line.decode("utf-8", "replace"))
            except Exception:
                continue
            if "tool_result" in d:
                raw.append(d["tool_result"]["raw"])
    return "\n".join(raw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    a = ap.parse_args()
    session = "cmdproof-%d" % int(time.time())
    passed = failed = 0

    def check(name, cmd, must_contain, must_not=None):
        nonlocal passed, failed
        t0 = time.perf_counter()
        try:
            out = run(a.engine, cmd, session)
        except Exception as e:
            failed += 1
            print("  FAIL  %-34s EXCEPTION %s" % (name, str(e)[:70]))
            return
        dt = time.perf_counter() - t0
        ok = all(m in out for m in must_contain)
        if must_not:
            ok = ok and not any(m in out for m in must_not)
        if ok:
            passed += 1
            print("  PASS  %-34s %5.1fs" % (name, dt))
        else:
            failed += 1
            print("  FAIL  %-34s %5.1fs" % (name, dt))
            print("        wanted %s" % must_contain)
            print("        got    %s" % out[:260].replace("\n", " | "))

    print("=" * 74)
    print("REAL COMMAND EXECUTION  session=%s" % session)
    print("=" * 74)

    check("shell + exit code", "echo hello; echo exit=$?", ["hello", "exit=0"])
    check("pipeline", "seq 1 5 | tr '\\n' ' '", ["1 2 3 4 5"])
    check("stderr captured", "echo out; echo err >&2", ["out", "err"])
    check("non-zero exit reported", "false; echo code=$?", ["code=1"])
    check("file create + read", "echo data > f.txt && cat f.txt", ["data"])
    check("file edit (sed)", "sed -i 's/data/edited/' f.txt && cat f.txt", ["edited"])
    check("file delete", "rm f.txt && ls f.txt 2>&1 | head -1", ["No such file"])
    check("directory tree", "mkdir -p p/q && touch p/q/x && find p -type f", ["p/q/x"])
    check("script execution", "printf 'print(6*7)\\n' > s.py && python3 s.py", ["42"])
    check("archive create+verify",
          "tar czf a.tgz p && tar tzf a.tgz | head -3", ["p/q/x"])
    check("zip create+list",
          "zip -q z.zip s.py && unzip -l z.zip | grep -c s.py", ["1"])
    check("env setup + use", "export V=99 && echo $V", ["99"])
    check("background process", "sleep 20 & echo started=$!", ["started="])
    check("process listing", "ps -eo pid,comm | head -3", ["PID"])
    check("process cleanup", "sleep 30 & P=$!; kill $P; sleep 0.3; kill -0 $P 2>&1 | head -1",
          ["No such process"])
    check("timeout enforced", "timeout 2 sleep 30; echo rc=$?", ["rc=124"])
    check("compilation", "printf 'int main(){return 7;}\\n' > m.c && gcc m.c -o m && ./m; echo rc=$?",
          ["rc=7"])
    check("package install (pip)", "pip install -q six 2>&1 | tail -2; python3 -c 'import six; print(\"six\", six.__version__)'",
          ["six "])
    check("network from the sandbox", "curl -s -o /dev/null -w '%{http_code}' https://example.com",
          ["200"])
    check("disk + memory readable", "df -h /kaggle/working | tail -1 && free -m | head -2", ["Mem"])

    print("\n" + "=" * 74)
    print("COMMAND EXECUTION: %d passed, %d failed" % (passed, failed))
    print("=" * 74)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
