#!/usr/bin/env python3
"""Ask Ollama directly (through the kernel's proxy) for the FULL error.

The kernel intercepts only the exact path /api/chat. /api/chat?probe=1 falls
through to Ollama's own endpoint, so the template error comes back complete
instead of truncated to 200 characters by the agent's error formatter.
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
print("engine:", live.split("//")[1][:28] + "  model:", model[:40] + "\n")


def probe(tag, msgs, tools=True):
    body = {"model": model, "messages": msgs, "stream": False}
    if tools:
        body["tools"] = [{"type": "function", "function": {
            "name": "web_search", "description": "search",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}}}]
    req = urllib.request.Request(
        live + "/api/chat?probe=1", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Engine-Key": props["offKey"]})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.loads(r.read().decode())
        c = (d.get("message") or {}).get("content") or ""
        print("  ok    %-42s -> %s" % (tag, c[:60].replace("\n", " ")))
        return True
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        print("  HTTP %s %-38s\n        %s\n" % (e.code, tag, raw[:600].replace("\\n", "\n        ")))
        return False
    except Exception as e:
        print("  ERR   %-42s %s" % (tag, str(e)[:80]))
        return False


def tc(n="web_search", args=None):
    return {"role": "assistant", "content": "",
            "tool_calls": [{"function": {"name": n, "arguments": args if args is not None
                                         else {"query": "q"}}}]}


def tool(n="web_search"):
    return {"role": "tool", "content": "result text", "tool_name": n}


SYS = {"role": "system", "content": "You are Aether."}
probe("plain user message", [SYS, {"role": "user", "content": "hi"}])

m = [SYS, {"role": "user", "content": "hi"}]
for _ in range(6):
    m += [tc(), tool()]
probe("6 tool calls, dict arguments", m)

m = [SYS, {"role": "user", "content": "hi"}, tc(args='{"query": "q"}'), tool()]
probe("arguments as a JSON STRING", m)

a = {"role": "assistant", "content": "",
     "tool_calls": [{"function": {"name": "web_search", "arguments": {"query": "a"}}},
                    {"function": {"name": "web_search", "arguments": {"query": "b"}}}]}
m = [SYS, {"role": "user", "content": "hi"}, a, tool(), a, tool()]
probe("same assistant msg appended twice", m)

m = [SYS, {"role": "user", "content": "hi"}, tc(), {"role": "tool", "content": "r"}]
probe("tool result with no tool_name", m)

m = [SYS, {"role": "user", "content": "hi"},
     {"role": "assistant", "content": "", "tool_calls": []}, tool()]
probe("assistant with EMPTY tool_calls list", m)

m = [SYS, {"role": "user", "content": "hi"}, tc(), tool(), tool()]
probe("two tool results in a row", m)
