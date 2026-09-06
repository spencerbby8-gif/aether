#!/usr/bin/env python3
"""
Tag the keep-alive heartbeat with the engine's slot too.

The AGENT LIVE LINK line goes through notify(), which now prefixes engine=<slot>.
The idle heartbeat does NOT -- it calls _ntfy() directly:

    _ntfy('alive: ' + link + ' (idle N min)')

So the most RECENT announcement for a live engine is an untagged one. A client
that takes the newest sighting per URL therefore loses the attribution for
exactly the engines that are up and healthy, which is the worst possible time to
lose it. Proven live: the probe found 2 links on the topic and 0 of them tagged,
even though the AGENT LIVE LINK lines both carried engine=a.
"""
import base64, hashlib, json, re

TS = "src/server/engine/aether-engine-source.ts"
src = open(TS).read()
m = re.search(r"const B64 =\s*\n((?:\s*\"[^\"]*\" \+\n)*)\s*\"([^\"]*)\";\n", src)
chunks = [c for c in re.findall(r'"([^"]+)"', m.group(0)) if re.fullmatch(r"[A-Za-z0-9+/=]+", c)]
nb = json.loads(base64.b64decode("".join(chunks)).decode())

PATCHED = 0
for c in nb["cells"]:
    s = c.get("source", [])
    text = "".join(s) if isinstance(s, list) else (s or "")
    old = "_ntfy('alive: ' + link + ' (idle '"
    if old not in text:
        continue
    new = "_ntfy('engine=' + SLOT + ' alive: ' + link + ' (idle '"
    assert text.count(old) == 1
    c["source"] = text.replace(old, new)
    PATCHED += 1

assert PATCHED == 1, f"expected 1 heartbeat call, patched {PATCHED}"

for c in nb["cells"]:
    if c.get("cell_type") != "code":
        continue
    s = c.get("source", [])
    t = "".join(s) if isinstance(s, list) else (s or "")
    if t.strip():
        compile(t, "<engine>", "exec")

new_nb = json.dumps(nb, separators=(",", ":"))
b64 = base64.b64encode(new_nb.encode()).decode()
lines = [b64[i:i + 76] for i in range(0, len(b64), 76)]
block = "const B64 =\n" + "".join(f'  "{l}" +\n' for l in lines[:-1]) + f'  "{lines[-1]}";\n'
src = src[:m.start()] + block + src[m.end():]
digest = hashlib.sha256(new_nb.encode()).hexdigest()
src = re.sub(r'export const AETHER_NOTEBOOK_SHA256 = "[a-f0-9]{64}";',
             f'export const AETHER_NOTEBOOK_SHA256 = "{digest}";', src, count=1)
open(TS, "w").write(src)
print(f"heartbeat calls tagged : {PATCHED}")
print(f"notebook bytes         : {len(new_nb)}")
print(f"new pin                : {digest}")
