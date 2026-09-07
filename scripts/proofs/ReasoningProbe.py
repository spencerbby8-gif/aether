#!/usr/bin/env python3
"""Does the model actually reason, and what does turning it on cost?

Asks Ollama directly (through the kernel proxy) with think off and on, and
reports latency, reasoning tokens and whether reasoning_content comes back.
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

live = model = None
for u in urls:
    try:
        with urllib.request.urlopen(u + "/api/ps", timeout=8) as r:
            ms = json.loads(r.read().decode()).get("models")
            if ms:
                live, model = u, ms[0]["name"]
    except Exception:
        pass
if not live:
    print("NO LIVE ENGINE")
    sys.exit(1)
print("engine:", live.split("//")[1][:26], "\nmodel:", model)
print("model details (does it advertise thinking?):")
try:
    req = urllib.request.Request(live + "/api/show", data=json.dumps({"name": model}).encode(),
                                 headers={"Content-Type": "application/json",
                                          "X-Engine-Key": props["offKey"]})
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.loads(r.read().decode())
    caps = d.get("capabilities") or []
    fam = (d.get("details") or {}).get("family")
    print("  capabilities:", caps, " family:", fam)
    print("  template mentions enable_thinking:", "enable_thinking" in (d.get("template") or ""))
except Exception as e:
    print("  /api/show failed:", str(e)[:70])

Q = ("A bat and a ball cost 1.10 naira in total. The bat costs 1.00 naira more "
     "than the ball. How much does the ball cost? Answer with just the number.")


def ask(think):
    body = {"model": model, "stream": False, "think": think,
            "messages": [{"role": "user", "content": Q}],
            "options": {"num_ctx": 4096}}
    req = urllib.request.Request(live + "/api/chat?probe=1", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          "X-Engine-Key": props["offKey"]})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            d = json.loads(r.read().decode())
    except Exception as e:
        print("  think=%-5s ERROR %s" % (think, str(e)[:70]))
        return
    el = time.time() - t0
    m = d.get("message") or {}
    rc = m.get("reasoning_content") or m.get("thinking") or ""
    print("\n  think=%s" % think)
    print("    elapsed           %.1fs" % el)
    print("    eval_count        %s tokens" % d.get("eval_count"))
    print("    reasoning chars   %d" % len(rc))
    print("    answer            %r" % (m.get("content") or "")[:90])


print("\nsame question, reasoning off then on:")
ask(False)
ask(True)
