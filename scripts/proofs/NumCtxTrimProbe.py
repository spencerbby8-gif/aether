#!/usr/bin/env python3
"""Test the num_ctx trimming hypothesis.

If the prompt exceeds the model's context window, Ollama trims messages from
the FRONT -- dropping the system message and the user's question, which makes
the chat template raise 'No user query found in messages.' That would explain
why short probes always pass and real tool-heavy turns fail.

Sends the same 14-message shape with progressively larger tool results and
reports where it starts to fail, then repeats the failing size with a larger
num_ctx to see whether that is what fixes it.
"""
import json
import re
import sys
import urllib.request

props = {}
for line in open(sys.argv[1]):
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        props[k.strip()] = v.strip()

urls = []
with urllib.request.urlopen(
        "https://ntfy.sh/%s/json?poll=1&since=25m" % props["beaconTopic"], timeout=30) as f:
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
print("engine:", live.split("//")[1][:26], "\n")

TOOLS = [{"type": "function", "function": {
    "name": "web_search", "description": "search the web",
    "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}}}]

FILLER = ("Nigeria news summary. " * 400)


def shape(result_chars):
    m = [{"role": "system", "content": "You are AETHER."},
         {"role": "user", "content": "Search six states and summarise briefly."}]
    a = {"role": "assistant", "content": "",
         "tool_calls": [{"function": {"name": "web_search",
                                      "arguments": {"query": "s%d" % i}}} for i in range(6)]}
    for i in range(6):
        m += [a, {"role": "tool", "content": FILLER[:result_chars],
                  "tool_name": "web_search"}]
    return m


def probe(tag, msgs, options=None):
    body = {"model": model, "messages": msgs, "stream": False, "tools": TOOLS,
            "think": False}
    if options:
        body["options"] = options
    total = sum(len(str(x.get("content") or "")) for x in msgs)
    req = urllib.request.Request(
        live + "/api/chat?probe=1", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Engine-Key": props["offKey"]})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            d = json.loads(r.read().decode())
        c = ((d.get("message") or {}).get("content") or "")
        print("  ok    %-38s %6d chars  prompt_eval=%s  -> %s"
              % (tag, total, d.get("prompt_eval_count"), c[:40].replace("\n", " ")))
        return True
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        bad = "No user query" in raw
        print("  FAIL  %-38s %6d chars  HTTP %s  %s"
              % (tag, total, e.code, "No user query found" if bad else raw[:90]))
        return False
    except Exception as e:
        print("  ERR   %-38s %6d chars  %s" % (tag, total, str(e)[:60]))
        return False


for size in (500, 2000, 6000, 12000, 20000):
    probe("%d-char tool results" % size, shape(size))

print("\n-- same failing size with a bigger num_ctx --")
probe("20000-char results, num_ctx 32768", shape(20000), {"num_ctx": 32768})
probe("20000-char results, num_ctx 65536", shape(20000), {"num_ctx": 65536})
