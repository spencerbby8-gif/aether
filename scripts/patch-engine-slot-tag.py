#!/usr/bin/env python3
"""
Give every engine a slot identity on the beacon.

WHY. The APK controls engines directly -- it wakes a kernel via the Kaggle API
and then has to find that kernel's tunnel URL, which only ever appears in a
beacon announcement. Until now the engine announced

    AGENT LIVE LINK: https://xxx.trycloudflare.com (tools: ...)

with nothing saying WHICH of the three engines sent it. The server coped because
it wakes engines itself and can correlate by timing; a standalone client cannot,
and with two engines live at once the attribution is simply ambiguous.

resolve.ts already understands an "engine=<slot>" tag (ENGINE_TAG_RE,
slotFromText, and per-slot liveUrlA/B/C in beacon.ts), so the fix is to emit it
at the source rather than teach the client to guess.

Tagging happens inside notify(), so EVERY announcement carries it -- live link,
heartbeats, boot stages and the shutdown line -- not just the one the client
happens to need.
"""
import base64, hashlib, json, re

TS = "src/server/engine/aether-engine-source.ts"
src = open(TS).read()
m = re.search(r"const B64 =\s*\n((?:\s*\"[^\"]*\" \+\n)*)\s*\"([^\"]*)\";\n", src)
assert m, "B64 block not found"
chunks = [c for c in re.findall(r'"([^"]+)"', m.group(0)) if re.fullmatch(r"[A-Za-z0-9+/=]+", c)]
nb = json.loads(base64.b64decode("".join(chunks)).decode())


def cell_code(c):
    s = c.get("source", [])
    return "".join(s) if isinstance(s, list) else (s or "")


# There are two `def notify` definitions: cell1 (the original) and cell4 (a
# redefinition after the model layer comes up). Both must tag, and each needs
# SLOT in scope, so SLOT is defined immediately before each one.
TAGGED = 0
for c in nb["cells"]:
    text = cell_code(c)
    if "def notify(m):" not in text:
        continue
    assert "SLOT = '{{AETHER_SLOT}}'" not in text, "already patched"
    old = "def notify(m):\n"
    new = ("SLOT = '{{AETHER_SLOT}}'\n"
           "def notify(m):\n"
           "    # Every announcement is tagged with this engine's slot so a client\n"
           "    # can attribute a tunnel URL to A, B or C without guessing.\n"
           "    m = 'engine=' + SLOT + ' ' + str(m)\n")
    n = text.count(old)
    assert n == 1, f"expected exactly 1 notify def in this cell, found {n}"
    c["source"] = text.replace(old, new)
    TAGGED += 1

assert TAGGED == 2, f"expected to patch 2 notify definitions, patched {TAGGED}"

for c in nb["cells"]:
    if c.get("cell_type") != "code":
        continue  # markdown cells are not Python
    t = cell_code(c)
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

print(f"notify definitions tagged : {TAGGED}")
print(f"notebook bytes            : {len(new_nb)}")
print(f"new pin                   : {digest}")
