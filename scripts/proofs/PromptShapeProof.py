#!/usr/bin/env python3
"""The 'normal text' failure, reproduced and then shown fixed.

Sends a plain prompt with NO messages array -- the shape an older client sent.
The kernel read user_payload.get('messages'), got nothing, inserted only its
system message, and the chat template raised 'No user query found in
messages.' -> HTTP 500 on every message, tools or no tools.
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
print("engine:", live.split("//")[1][:28] + "...\n")


def ask(tag, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        live + "/api/chat", data=body,
        headers={"Content-Type": "application/json", "X-Engine-Key": props["offKey"]})
    t0 = time.time()
    got, err, done, deltas = [], False, False, 0
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
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
                    deltas += 1
                    got.append(c)
                    if "engine error" in c:
                        err = True
                if d.get("done"):
                    done = True
                    break
    except Exception as e:
        got.append("EXC " + str(e))
        err = True
    txt = "".join(got)[:170].replace("\n", " ")
    print("%-34s %5.1fs done=%-5s err=%-5s deltas=%d\n   %s\n"
          % (tag, time.time() - t0, done, err, deltas, txt))
    return done and not err and deltas > 0


a = ask("legacy {prompt} only",
        {"prompt": "Say hello in one short sentence.", "stream": True})
b = ask("messages array (current app)",
        {"messages": [{"role": "user", "content": "Say hello in one short sentence."}],
         "stream": True})
c = ask("empty request (guard path)", {"stream": True})

print("legacy prompt shape answers      ->", a)
print("messages array answers           ->", b)
print("empty request gives a clear line ->", c)
ok = a and b
print("\nRESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
