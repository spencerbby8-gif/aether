#!/usr/bin/env python3
"""
Fix 2 of the engine robustness pass: make the `_sent` guard actually work.

The previous patch added `_sent` so the post-agent_stream error path could not
emit a second status line. But it set the flag like this:

    self._sent = False
    try:
        agent_stream(self, payload)
        self._sent = True          # <-- only reached on SUCCESS

agent_stream() sends its status line at its very top (send_response(200) +
Transfer-Encoding: chunked + end_headers()). So if it raises part-way through a
generation -- ollama dies, a tool throws, the client vanishes mid-chunk -- _sent
is still False and the except branch writes a SECOND "HTTP/1.1 200 OK" status
line into the middle of the chunked body. Same desync class as the 403 bug.

Fix: set the flag at the moment the headers actually go out, inside
agent_stream, next to end_headers().
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

# ---- locate the agent cell ----------------------------------------------------
idx = next(i for i, c in enumerate(nb["cells"]) if "def agent_stream" in cell_code(c))
text = cell_code(nb["cells"][idx])

ANCHOR = """    handler.close_connection = True
    handler.end_headers()
"""
REPLACEMENT = """    handler.close_connection = True
    handler.end_headers()
    # FIX: mark the response as started THE MOMENT the status line goes out.
    # do_POST's error handler checks this; setting it only after agent_stream()
    # returns meant a mid-generation failure still wrote a second status line
    # into the open chunked body.
    handler._sent = True
"""
assert text.count(ANCHOR) == 1, f"anchor count {text.count(ANCHOR)} != 1"
assert "handler._sent = True" not in text, "already patched"
text = text.replace(ANCHOR, REPLACEMENT)

# do_POST currently sets the flag after the call; make it purely a reset so the
# authoritative set stays inside agent_stream.
OLD_RESET = """        self._sent = False
        try:
            agent_stream(self, payload)
            self._sent = True
"""
NEW_RESET = """        self._sent = False
        try:
            agent_stream(self, payload)
"""
assert text.count(OLD_RESET) == 1, f"reset anchor count {text.count(OLD_RESET)} != 1"
text = text.replace(OLD_RESET, NEW_RESET)

# ---- correct a false claim left in the source by the previous patch -----------
# wbufsize == 0, so wfile is a _SocketWriter and write() calls sendall()
# immediately. Measured: the /off body reaches the client with or without the
# flush. The flush is harmless, but the comment asserting the body "could be
# lost" is not true and must not stay in shipped code.
OLD_COMMENT = """                # FIX: wfile is buffered and os._exit() below does not flush it,
                # so without this the 200 body could be lost mid-shutdown.
                self.wfile.flush()"""
NEW_COMMENT = """                # wbufsize == 0, so wfile writes straight to the socket; this
                # flush is a no-op kept for symmetry. (An earlier comment here
                # claimed the body could be lost without it -- measured false.)
                self.wfile.flush()"""
assert text.count(OLD_COMMENT) == 1, f"comment anchor count {text.count(OLD_COMMENT)} != 1"
text = text.replace(OLD_COMMENT, NEW_COMMENT)

nb["cells"][idx]["source"] = text
compile(text, "<engine>", "exec")

new_nb = json.dumps(nb, separators=(",", ":"))
b64 = base64.b64encode(new_nb.encode()).decode()
lines = [b64[i:i + 76] for i in range(0, len(b64), 76)]
block = "const B64 =\n" + "".join(f'  "{l}" +\n' for l in lines[:-1]) + f'  "{lines[-1]}";\n'
src = src[:m.start()] + block + src[m.end():]

digest = hashlib.sha256(new_nb.encode()).hexdigest()
src = re.sub(r'export const AETHER_NOTEBOOK_SHA256 = "[a-f0-9]{64}";',
             f'export const AETHER_NOTEBOOK_SHA256 = "{digest}";', src, count=1)
open(TS, "w").write(src)

print(f"engine cell python : {len(text)} chars, compile() clean")
print(f"template bytes     : {len(block)}")
print(f"new pin            : {digest}")
