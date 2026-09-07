import json, sys, urllib.request, re
props = {}
for line in open(sys.argv[1]):
    if '=' in line and not line.startswith('#'):
        k, v = line.split('=', 1); props[k.strip()] = v.strip()
urls = []
with urllib.request.urlopen("https://ntfy.sh/%s/json?poll=1&since=3h" % props['beaconTopic'], timeout=30) as f:
    for raw in f:
        s = raw.decode('utf-8','replace').strip()
        if not s.startswith('{'): continue
        try: m = json.loads(s)
        except Exception: continue
        for u in re.findall(r'https://[A-Za-z0-9\-]+\.trycloudflare\.com', m.get('message','')):
            if u not in urls: urls.append(u)
live = None
for u in urls:
    try:
        with urllib.request.urlopen(u + "/api/ps", timeout=8) as r:
            if json.loads(r.read().decode()).get('models'): live = u; break
    except Exception: pass
if not live: print("NO LIVE ENGINE"); sys.exit(1)

def ask(tag, messages):
    body = json.dumps({"messages": messages, "stream": True}).encode()
    req = urllib.request.Request(live + "/api/chat", data=body,
        headers={"Content-Type":"application/json","X-Engine-Key":props['offKey']})
    got = []
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            for raw in r:
                s = raw.decode('utf-8','replace').strip()
                if not s: continue
                try: d = json.loads(s)
                except Exception: continue
                c = (d.get('message') or {}).get('content') or ''
                if c: got.append(c)
                if d.get('done'): break
    except Exception as e:
        got.append("EXC " + str(e))
    txt = "".join(got)[:230].replace("\n", " ")
    print("%-26s -> %s" % (tag, txt))

# What msgs[-24:] produces once a conversation grows: NO unwrapped user message.
window_no_user = []
for i in range(12):
    window_no_user.append({"role":"assistant","content":"calling a tool",
        "tool_calls":[{"function":{"name":"web_search","arguments":{"query":"q%d"%i}}}]})
    window_no_user.append({"role":"tool","content":"result %d"%i,"tool_name":"web_search"})

print("window length:", len(window_no_user), "| unwrapped user messages:",
      sum(1 for m in window_no_user if m["role"]=="user"))
ask("BROKEN window (no user)", window_no_user)

fixed = [{"role":"system","content":"You are Aether."},
         {"role":"user","content":"Say the single word OK."}] + window_no_user[:8]
print("window length:", len(fixed), "| unwrapped user messages:",
      sum(1 for m in fixed if m["role"]=="user"))
ask("FIXED window (user kept)", fixed)
