import json, sys, time, urllib.request, re

"""Capture the engine's REAL agent events to a fixture file.

Nothing here is invented: every line written is a byte-for-byte NDJSON line the
kernel streamed, tagged with the wall-clock offset at which it arrived. The
fixture is what AgentActivityCheck replays, so the activity labels are proven
against runtime output rather than against a guess about the wire format.

  python3 scripts/proofs/capture-agent-events.py <credentials.properties> <out.ndjson> "<prompt>"
"""

props = {}
for line in open(sys.argv[1]):
    if '=' in line and not line.startswith('#'):
        k, v = line.split('=', 1)
        props[k.strip()] = v.strip()
out, prompt = sys.argv[2], sys.argv[3]

urls = []
with urllib.request.urlopen("https://ntfy.sh/%s/json?poll=1&since=3h" % props['beaconTopic'],
                            timeout=30) as f:
    for raw in f:
        s = raw.decode('utf-8', 'replace').strip()
        if not s.startswith('{'):
            continue
        try:
            m = json.loads(s)
        except Exception:
            continue
        for u in re.findall(r'https://[A-Za-z0-9\-]+\.trycloudflare\.com', m.get('message', '')):
            if u not in urls:
                urls.append(u)

live = None
for u in urls:
    try:
        with urllib.request.urlopen(u + "/api/ps", timeout=8) as r:
            if json.loads(r.read().decode()).get('models'):
                live = u
    except Exception:
        pass
if not live:
    print("no live engine to capture from")
    sys.exit(1)
print("capturing from", live.replace('https://', '').split('.')[0] + '.***')

# No "model" field, exactly like the Android client. Sending one makes the
# kernel forward it to Ollama, and a wrong name comes back as HTTP 404
# "model 'x' not found" -- which is what this harness did for a while, and
# which looked exactly like a broken engine.
body = json.dumps({"stream": True,
                   "messages": [{"role": "user", "content": prompt}]}).encode()
req = urllib.request.Request(live + "/api/chat", data=body, headers={
    "Content-Type": "application/json",
    "Accept": "application/x-ndjson",
    "X-Engine-Key": props['offKey']})

t0 = time.time()
n = 0
with open(out, 'w') as fh, urllib.request.urlopen(req, timeout=900) as r:
    for raw in r:
        line = raw.decode('utf-8', 'replace').rstrip('\n')
        if not line.strip():
            continue
        n += 1
        fh.write("%.3f %s\n" % (time.time() - t0, line))
        if n <= 12 or '"done": true' in line or '"done":true' in line:
            print("  t+%7.0fms  %s" % ((time.time() - t0) * 1000, line[:150]))
        if '"done": true' in line or '"done":true' in line:
            break
print("wrote %d real event lines to %s" % (n, out))
