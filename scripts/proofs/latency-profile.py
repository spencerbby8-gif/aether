#!/usr/bin/env python3
"""End-to-end latency profile against a live engine.

Measures the things the user actually waits for, from the outside, over the
real HTTPS tunnel: connection and first byte, first engine activity, first
answer token, first tool start, per-tool turnarounds, and total completion.

Nothing is simulated. Every number is a wall-clock stamp taken while a real
request is in flight. Run the same command before and after a change and diff
the tables -- that is the only evidence this script is meant to produce.

Usage: python3 -u scripts/proofs/latency-profile.py <tunnel-url> [label]
"""
import json
import ssl
import sys
import time
import urllib.request

OFF_KEY = "REMOVED_ENGINE_OFF_KEY"
CTX = ssl.create_default_context()

TOOLS = ["web_search", "fetch_page", "crawl_site", "run_command",
         "generate_image", "generate_voice"]

SCENARIOS = [
    ("text",
     "Reply with one short sentence: what is the capital of France?"),
    ("web-search",
     "Use web_search once for 'current population of Lagos Nigeria' and give "
     "me the number with its source."),
    ("fetch-page",
     "Use fetch_page on https://example.com and tell me the page title."),
    ("command",
     "Use run_command to run: echo START && date -u +%s%N && python3 -c "
     "\"print(sum(range(1000000)))\" && echo END. Report the output."),
    ("file-ops",
     "Use run_command to create a file: printf 'aether\\n' > /kaggle/working/p.txt "
     "&& wc -c /kaggle/working/p.txt && cat /kaggle/working/p.txt"),
    ("parallel-tools",
     "Use run_command twice IN THE SAME STEP to get (1) date -u and (2) uname -r. "
     "Issue both tool calls together, then report both outputs."),
    ("image",
     "Use generate_image to make a picture of a blue boat. Just generate it."),
    ("voice",
     "Use generate_voice to say: Speed test. Just generate it."),
]

MARK_TOOL = "\U0001f6e0\ufe0f"
MARK_STEP = "\u2699\ufe0f agent step"
MARK_RET = "\u21b3"
MARK_BEAT = "\u23f3"


def one(base, prompt, timeout=900):
    body = json.dumps({"messages": [{"role": "user", "content": prompt}],
                       "stream": True, "tools": TOOLS}).encode()
    req = urllib.request.Request(
        base + "/api/chat", data=body,
        headers={"Content-Type": "application/json", "X-Engine-Key": OFF_KEY})

    r = {"t0": time.time(), "first_byte": None, "first_activity": None,
         "first_token": None, "first_tool": None, "total": None,
         "tools": [], "tool_secs": [], "deltas": 0, "beats": 0,
         "reasoning": 0, "done": False, "http": None, "error": None,
         "answer": ""}
    pending = {}
    try:
        resp = urllib.request.urlopen(req, timeout=timeout, context=CTX)
        r["http"] = resp.getcode()
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            now = time.time() - r["t0"]
            if r["first_byte"] is None:
                r["first_byte"] = now
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("media"):
                continue
            m = d.get("message") or {}
            th = m.get("thinking") or ""
            if th:
                if r["first_activity"] is None:
                    r["first_activity"] = now
                if th == MARK_BEAT:
                    r["beats"] += 1
                elif th.startswith(MARK_TOOL):
                    nm = th[2:].split("(")[0].strip()
                    r["tools"].append(nm)
                    pending[nm] = now
                    if r["first_tool"] is None:
                        r["first_tool"] = now
                elif th.startswith(MARK_RET):
                    nm = th[2:].split(" returned")[0].strip()
                    if nm in pending:
                        r["tool_secs"].append((nm, round(now - pending.pop(nm), 1)))
                elif not th.startswith(MARK_STEP):
                    r["reasoning"] += len(th)
            c = m.get("content") or ""
            if c:
                if r["first_token"] is None:
                    r["first_token"] = now
                r["deltas"] += 1
                r["answer"] += c
            if d.get("done"):
                r["done"] = True
                break
    except Exception as e:
        r["error"] = "%s: %s" % (type(e).__name__, str(e)[:120])
    r["total"] = time.time() - r["t0"]
    return r


def fmt(v, unit="s"):
    return ("%." + ("1f" if unit == "s" else "0f") + unit) % v if v is not None else "-"


def main():
    if len(sys.argv) < 2:
        print("usage: latency-profile.py <tunnel-url> [label]")
        return 2
    base = sys.argv[1].rstrip("/")
    label = sys.argv[2] if len(sys.argv) > 2 else "run"

    t0 = time.time()
    try:
        with urllib.request.urlopen(base + "/api/ps", timeout=30, context=CTX) as resp:
            ps_latency = time.time() - t0
            models = len(json.loads(resp.read().decode()).get("models", []))
        print("engine /api/ps  %.3fs  models=%d" % (ps_latency, models))
    except Exception as e:
        print("engine unreachable: %s" % e)
        return 1

    print()
    print("PROFILE: %s" % label)
    print("%-15s %7s %7s %8s %8s %8s %6s %6s %6s %s" % (
        "scenario", "byte", "actv", "1st-tok", "1st-tool", "total",
        "dlt", "beat", "tools", "per-tool"))
    print("-" * 104)

    rows = []
    for name, prompt in SCENARIOS:
        r = one(base, prompt)
        per = ",".join("%s=%ss" % (n, s) for n, s in r["tool_secs"]) or "-"
        print("%-15s %7s %7s %8s %8s %8s %6d %6d %6d %s" % (
            name, fmt(r["first_byte"]), fmt(r["first_activity"]),
            fmt(r["first_token"]), fmt(r["first_tool"]), fmt(r["total"]),
            r["deltas"], r["beats"], len(r["tools"]), per))
        if r["error"]:
            print("%-15s ERROR %s" % ("", r["error"]))
        if not r["done"]:
            print("%-15s NO done:true" % "")
        rows.append((name, r))
        sys.stdout.flush()

    print("-" * 104)
    # rows is a list of (name, result); ok is just the results.
    ok = [r for _, r in rows if r["done"] and not r["error"]]
    ttft = sorted(r["first_token"] for r in ok if r["first_token"])
    tots = sorted(r["total"] for r in ok)
    tool_start = sorted(r["first_tool"] for r in ok if r["first_tool"])
    print("completed %d/%d" % (len(ok), len(rows)))
    print("  median first-token   %s" % (fmt(ttft[len(ttft) // 2]) if ttft else "-"))
    print("  median first-tool    %s" % (fmt(tool_start[len(tool_start) // 2]) if tool_start else "-"))
    print("  median total         %s" % (fmt(tots[len(tots) // 2]) if tots else "-"))
    waits = [r["first_token"] - r["first_activity"] for r in ok
             if r["first_token"] and r["first_activity"]]
    print("  median silent gap between first activity and first answer token  %s"
          % (fmt(sorted(waits)[len(waits) // 2]) if waits else "-"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
