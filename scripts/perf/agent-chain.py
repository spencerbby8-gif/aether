#!/usr/bin/env python3
"""The agent chain the user actually experiences, measured end to end.

Drives the engine's real /api/chat agent loop (the same path the app uses) and
timestamps every stage as it arrives off the wire:

    first byte -> first activity -> first tool start -> each tool result
    -> first answer token -> final token -> done

Also records the raw stream with inter-event gaps so the client harness can
replay a REAL capture instead of a synthetic one.

  python3 -u scripts/perf/agent-chain.py <tunnel-url> [--turns N] [--capture PATH]
"""
import json
import ssl
import statistics
import sys
import time
import urllib.request

OFF_KEY = "REMOVED_ENGINE_OFF_KEY"
CTX = ssl.create_default_context()
TOOLS = ["web_search", "fetch_page", "crawl_site", "run_command",
         "generate_image", "generate_voice", "browser"]

MARK_TOOL = "\U0001f6e0\ufe0f"
MARK_STEP = "\u2699\ufe0f agent step"
MARK_RET = "\u21b3"
MARK_BEAT = "\u23f3"

PLAIN = "Reply with exactly one short sentence: what is the capital of France?"
SEARCH = ("Use web_search once for 'population of Lagos Nigeria 2024' and give "
          "me the number with its source. Keep the answer under 60 words.")
COMMAND = ("Use run_command to run: echo START && uname -r && echo END. "
           "Then report the output in one line.")


def run(base, prompt, timeout=900, capture=None):
    body = json.dumps({"messages": [{"role": "user", "content": prompt}],
                       "stream": True, "tools": TOOLS}).encode()
    req = urllib.request.Request(base + "/api/chat", data=body, headers={
        "Content-Type": "application/json", "X-Engine-Key": OFF_KEY})
    r = {"t0": time.time(), "first_byte": None, "first_activity": None,
         "first_token": None, "first_tool": None, "total": None, "tools": [],
         "tool_secs": [], "deltas": 0, "beats": 0, "reasoning": 0,
         "done": False, "error": None, "answer": "", "events": []}
    pending = {}
    cap = []
    last = r["t0"]
    try:
        resp = urllib.request.urlopen(req, timeout=timeout, context=CTX)
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            now = time.time()
            cap.append({"gapMs": int(round((now - last) * 1000)), "line": line})
            last = now
            t = now - r["t0"]
            if r["first_byte"] is None:
                r["first_byte"] = t
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("media"):
                r["events"].append(("media", t))
                continue
            m = d.get("message") or {}
            th = m.get("thinking") or ""
            if th:
                if r["first_activity"] is None:
                    r["first_activity"] = t
                if th == MARK_BEAT:
                    r["beats"] += 1
                elif th.startswith(MARK_TOOL):
                    nm = th[2:].split("(")[0].strip()
                    r["tools"].append(nm)
                    pending[nm] = t
                    r["events"].append(("tool-start:" + nm, t))
                    if r["first_tool"] is None:
                        r["first_tool"] = t
                elif th.startswith(MARK_RET):
                    nm = th[2:].split(" returned")[0].strip()
                    if nm in pending:
                        secs = t - pending.pop(nm)
                        r["tool_secs"].append((nm, round(secs, 1)))
                        r["events"].append(("tool-done:" + nm, t))
                elif not th.startswith(MARK_STEP):
                    r["reasoning"] += len(th)
            c = m.get("content") or ""
            if c:
                if r["first_token"] is None:
                    r["first_token"] = t
                r["deltas"] += 1
                r["answer"] += c
            if d.get("done"):
                r["done"] = True
                break
    except Exception as e:
        r["error"] = "%s: %s" % (type(e).__name__, str(e)[:120])
    r["total"] = time.time() - r["t0"]
    if capture:
        with open(capture, "w") as f:
            for e in cap:
                f.write(json.dumps(e) + "\n")
    return r


def fmt(v):
    return ("%.1fs" % v) if v is not None else "-"


def main():
    if len(sys.argv) < 2:
        print("usage: agent-chain.py <tunnel-url> [--turns N] [--capture PATH]")
        return 2
    base = sys.argv[1].rstrip("/")
    turns = 3
    capture = None
    if "--turns" in sys.argv:
        turns = int(sys.argv[sys.argv.index("--turns") + 1])
    if "--capture" in sys.argv:
        capture = sys.argv[sys.argv.index("--capture") + 1]

    print("AGENT CHAIN against %s" % base)
    print("=" * 108)

    print("\nA. PLAIN TEXT (no tools) x%d" % turns)
    print("  %-4s %8s %8s %9s %8s %7s %6s %s" % (
        "#", "byte", "actv", "1st-tok", "total", "deltas", "beats", "answer"))
    plain = []
    for i in range(turns):
        r = run(base, PLAIN, capture=capture if i == 0 else None)
        plain.append(r)
        print("  %-4d %8s %8s %9s %8s %7d %6d %r" % (
            i + 1, fmt(r["first_byte"]), fmt(r["first_activity"]),
            fmt(r["first_token"]), fmt(r["total"]), r["deltas"], r["beats"],
            r["answer"][:44].replace("\n", " ")))
        if r["error"]:
            print("       ERROR %s" % r["error"])
        sys.stdout.flush()

    ok = [r for r in plain if r["done"] and r["first_token"]]
    if ok:
        rates = [r["deltas"] / max(0.1, r["total"] - r["first_token"]) for r in ok
                 if r["total"] > r["first_token"]]
        print("  -> median first-token %.1fs | median total %.1fs | decode %s" % (
            statistics.median([r["first_token"] for r in ok]),
            statistics.median([r["total"] for r in ok]),
            ("%.1f tok/s" % statistics.median(rates)) if rates else "-"))

    for label, prompt in (("B. WEB SEARCH", SEARCH), ("C. RUN COMMAND", COMMAND)):
        print("\n%s" % label)
        print("  %-4s %8s %8s %9s %9s %8s %6s %s" % (
            "#", "byte", "actv", "1st-tool", "1st-tok", "total", "deltas", "per-tool"))
        for i in range(2):
            r = run(base, prompt, capture=capture if (label.startswith("B") and i == 0) else None)
            per = ",".join("%s=%ss" % (n, s) for n, s in r["tool_secs"]) or "-"
            print("  %-4d %8s %8s %9s %9s %8s %6d %s" % (
                i + 1, fmt(r["first_byte"]), fmt(r["first_activity"]),
                fmt(r["first_tool"]), fmt(r["first_token"]), fmt(r["total"]),
                r["deltas"], per))
            if r["error"]:
                print("       ERROR %s" % r["error"])
            if not r["done"]:
                print("       NO done:true")
            print("       answer: %r" % r["answer"][:110].replace("\n", " "))
            sys.stdout.flush()

    print("\n" + "=" * 108)
    return 0


if __name__ == "__main__":
    sys.exit(main())
