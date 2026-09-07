#!/usr/bin/env python3
"""Send the app's exact payload shape to EVERY live tunnel, not just one.

Kaggle keeps previous kernel versions running after a push, and each announces
its own tunnel. If a stale instance is still up it still has the old
msgs[-24:] slice, so the app can route to it and keep failing.
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
        "https://ntfy.sh/%s/json?poll=1&since=3h" % props["beaconTopic"], timeout=30) as f:
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

print("%d announced tunnels in the last 3h\n" % len(urls))
live = []
for u in urls:
    try:
        with urllib.request.urlopen(u + "/api/ps", timeout=8) as r:
            if json.loads(r.read().decode()).get("models"):
                live.append(u)
                print("LIVE  %s" % u.split("//")[1])
    except Exception as e:
        print("dead  %-46s %s" % (u.split("//")[1][:44], str(e)[:34]))

if not live:
    print("\nno live engine")
    sys.exit(1)

SYSTEM = ("You are Aether, a helpful assistant. Keep answers short and plain. "
          "No emoji.")
PROMPT = sys.argv[2] if len(sys.argv) > 2 else "Say hello in one short sentence."

for u in live:
    # exactly what EngineCore.chatStream builds: system as a LEADING USER
    # message, then history, then the prompt. No "model" field.
    msgs = [{"role": "user", "content": SYSTEM},
            {"role": "user", "content": PROMPT}]
    body = json.dumps({"messages": msgs, "stream": True}).encode()
    req = urllib.request.Request(
        u + "/api/chat", data=body,
        headers={"Content-Type": "application/json", "X-Engine-Key": props["offKey"]})
    t0 = time.time()
    got, err, done = [], False, False
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            for raw in r:
                s = raw.decode("utf-8", "replace").strip()
                if not s:
                    continue
                try:
                    d = json.loads(s)
                except Exception:
                    continue
                c = (d.get("message") or {}).get("content") or ""
                if c:
                    got.append(c)
                    if "engine error" in c:
                        err = True
                if d.get("done"):
                    done = True
                    break
    except Exception as e:
        got.append("EXC " + str(e))
        err = True
    txt = "".join(got)[:150].replace("\n", " ")
    print("\n%-46s %5.1fs done=%s err=%s\n   %s"
          % (u.split("//")[1][:44], time.time() - t0, done, err, txt))
