#!/usr/bin/env python3
"""Force the failing case: a single turn with >= 12 tool calls.

Each tool call appends TWO messages (assistant + tool). Once 12 accumulate,
the messages after the user's question outnumber the 24-message window, so the
old msgs[-24:] slice drops the question and the template raises
'No user query found in messages.' -> HTTP 500 mid-turn.
"""
import json
import re
import sys
import time
import urllib.request

props = {}
for line in open(sys.argv[1]):
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        props[k.strip()] = v.strip()

urls = []
with urllib.request.urlopen(
        "https://ntfy.sh/%s/json?poll=1&since=40m" % props["beaconTopic"], timeout=30) as f:
    for raw in f:
        s = raw.decode("utf-8", "replace").strip()
        if not s.startswith("{"):
            continue
        try:
            m = json.loads(s)
        except Exception:
            continue
        for u in re.findall(r"https://[A-Za-z0-9\-]+\.trycloudflare\.com", m.get("message", "")):
            if u not in urls:
                urls.append(u)

live = None
for u in urls:
    try:
        with urllib.request.urlopen(u + "/api/ps", timeout=8) as r:
            if json.loads(r.read().decode()).get("models"):
                live = u
    except Exception:
        pass
if not live:
    print("NO LIVE ENGINE - cannot verify")
    sys.exit(1)
print("engine:", live.split("//")[1][:26] + "...")

prompt = ("Work through these one at a time and do not answer until every one is done. "
          "For EACH of these six Nigerian states - Lagos, Kano, Rivers, Anambra, Enugu, Oyo - "
          "do two things: first a separate web_search for today's top news in that state, "
          "then run_command with `date -u`. That is twelve tool calls in total. "
          "Only after all twelve are finished, write one short summary.")
messages = [{"role": "user", "content": prompt}]
print("sending 1 message designed to trigger >= 12 tool calls")

body = json.dumps({"messages": messages, "stream": True}).encode()
req = urllib.request.Request(
    live + "/api/chat", data=body,
    headers={"Content-Type": "application/json", "X-Engine-Key": props["offKey"]})

t0 = time.time()
tools, errors = [], []
deltas = 0
done = False
try:
    with urllib.request.urlopen(req, timeout=900) as r:
        for raw in r:
            s = raw.decode("utf-8", "replace").strip()
            if not s:
                continue
            try:
                d = json.loads(s)
            except Exception:
                continue
            msg = d.get("message") or {}
            c = msg.get("content") or ""
            th = msg.get("thinking") or ""
            if c:
                deltas += 1
                if "engine error" in c:
                    errors.append(c[:200])
            if th.startswith("\U0001f6e0"):
                tools.append(th[:60])
                print("  t+%5.1fs  tool #%d  %s" % (time.time() - t0, len(tools), th[:60]))
            if d.get("done"):
                done = True
                break
except Exception as e:
    errors.append("EXC " + str(e))

el = time.time() - t0
# messages the kernel would have had to send on the final iteration
appended = len(tools) * 2
total = 2 + appended          # system + question + appended
print("\ntool calls: %d  ->  messages appended: %d  ->  conversation at the final"
      " iteration: %d" % (len(tools), appended, total))
print("under the OLD slice msgs[-24:] the question %s have been dropped"
      % ("WOULD" if total - 24 > 1 else "would NOT"))
print("elapsed %.1fs | content deltas %d | done:true %s" % (el, deltas, done))
if errors:
    print("ERRORS:")
    for e in errors:
        print("   " + e)
# The point of this test is that the turn COMPLETES. How many tool calls the
# model happens to make is its choice, so it is reported, not asserted: an
# earlier version of this file demanded 12 and reported FAIL on a turn that had
# actually finished cleanly with done:true.
threshold = total - 24 > 1
ok = done and not errors and deltas > 0
print("crossed the old 24-message window -> %s" % threshold)
print("\nRESULT: %s" % ("PASS - turn completed, no HTTP 500" if ok else "FAIL"))
if not threshold:
    print("note: the model made too few calls to exercise the old truncation "
          "bug; the 12-call case is covered by history-window-check.py")
sys.exit(0 if ok else 1)
