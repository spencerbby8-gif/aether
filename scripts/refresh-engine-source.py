"""Re-embed the notebook template into the engine source and re-pin its hash.

Run from the repo root:  python3 scripts/refresh-engine-source.py
"""
import base64
import hashlib
import re

P = 'src/server/engine/aether-engine-source.ts'
TPL = 'android/app/src/main/assets/aether-notebook-template.json'

raw = open(TPL, 'rb').read()
sha = hashlib.sha256(raw).hexdigest()
b64 = base64.b64encode(raw).decode('ascii')

src = open(P, encoding='utf-8').read()

src, n = re.subn(r'export const AETHER_NOTEBOOK_SHA256 = "[0-9a-f]{64}";',
                 'export const AETHER_NOTEBOOK_SHA256 = "%s";' % sha, src, count=1)
assert n == 1, "sha pin not found"

lines = [b64[i:i + 76] for i in range(0, len(b64), 76)]
body = " +\n".join('  "%s"' % c for c in lines)
block = "const B64 =\n" + body + ";\n"

start = src.index('const B64 =')
m = re.search(r'const B64 =\n(?:  "[^"]*" \+\n)*  "[^"]*";\n', src[start:])
assert m, "could not match the B64 block"
src = src[:start] + block + src[start + m.end():]

open(P, 'w', encoding='utf-8').write(src)
print("pinned sha256:", sha)
print("template bytes: %d | b64 chars: %d | lines: %d" % (len(raw), len(b64), len(lines)))
