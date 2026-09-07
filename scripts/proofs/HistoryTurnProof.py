#!/usr/bin/env python3
"""End-to-end check of the history_window fix against the REAL deployed engine.

Sends the shape of conversation that was failing: prior turns, then one turn
that searches, fetches and runs commands, so the message list blows past 24.
Under the old msgs[-24:] slice this returns HTTP 500 'No user query found in
messages.' part way through. Under history_window() it must complete.
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

history = []
for i in range(4):
    history.append({"role": "user", "content": "Earlier question %d about Nigeria." % i})
    history.append({"role": "assistant", "content": "Earlier answer %d." % i})

messages = history + [{
    "role": "user",
    "content": ("Do a live web search for the top Nigeria news headline today, "
                "then fetch a picture source online, and run a command to show "
                "the current date. Then summarise it all briefly."),
}]
print("sending %d messages (the old code would send only the last 24, losing the question)"
      % len(messages))

body = json.dumps({"messages": messages, "stream": True}).encode()
req = urllib.request.Request(
    live + "/api/chat", data=body,
    headers={"Content-Type": "application/json", "X-Engine-Key": props["offKey"]})

t0 = time.time()
tools = []
errors = []
deltas = 0
first_token = None
done = False
try:
    with urllib.request.urlopen(req, timeout=600) as r:
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
                if first_token is None:
                    first_token = time.time() - t0
                if "engine error" in c:
                    errors.append(c[:200])
            if th.startswith("\U0001f6e0"):
                tools.append(th[:70])
                print("  t+%5.1fs  %s" % (time.time() - t0, th[:70]))
            if d.get("done"):
                done = True
                break
except Exception as e:
    errors.append("EXC " + str(e))

el = time.time() - t0
print("\nelapsed %.1fs | content deltas %d | first token %.1fs | tool events %d"
      % (el, deltas, first_token or -1, len(tools)))
print("reached done:true -> %s" % done)
if errors:
    print("ERRORS:")
    for e in errors:
        print("   " + e)
ok = done and not errors and deltas > 0
print("\nRESULT: %s" % ("PASS - multi-tool turn completed" if ok else "FAIL"))
sys.exit(0 if ok else 1)
