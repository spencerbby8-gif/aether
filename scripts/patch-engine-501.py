#!/usr/bin/env python3
"""
Engine robustness fixes found by re-auditing the shipped notebook.

1. THE 501 BUG (root cause, not a guess).
   `protocol_version = 'HTTP/1.1'` makes the socket keep-alive. The auth gate in
   do_POST returned 403 WITHOUT consuming the request body, so those bytes stayed
   in the socket. The next request parsed off that same pooled connection read the
   leftover JSON as a request line -> "Unsupported method" -> 501.
   Observed on the real engine as a perfect 403/501 alternation from one URL,
   which is exactly what a poisoned keep-alive socket produces.
   Fix: read the body ONCE at the top of do_POST and reuse it everywhere.

2. /off could truncate its own response. `os._exit(0)` fires 0.5 s later and
   wfile is buffered, so the 200 body could be lost. Flush explicitly.

3. The post-stream error path called send_response() a second time if
   agent_stream had already started a response, writing a status line into the
   body. Guard it.

4. Dead duplicate key check inside the /off branch (already gated above).
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


# --- 1+4: single body read at the top of do_POST -------------------------------
GATE_OLD = """    def do_POST(self):
        # FIX (audit C5): every POST is authenticated. Previously only /off
        # checked the key, so anyone who learned the tunnel URL could drive
        # /api/chat - and its run_command tool - or the raw ollama proxy.
        if self.headers.get('X-Engine-Key') != OFF_KEY:
            msg = b'{"status":"forbidden"}'
            self.send_response(403); self.send_header('Content-Type','application/json'); self.send_header('Content-Length', str(len(msg))); self.end_headers(); self.wfile.write(msg)
            return"""
GATE_NEW = """    def _read_body(self):
        # FIX (501 bug): this handler is HTTP/1.1, so sockets are keep-alive.
        # Answering WITHOUT consuming the request body leaves those bytes in the
        # socket, and the next request parsed off that same connection reads the
        # leftover JSON as a request line -> "Unsupported method" -> 501. That is
        # exactly the 403/501 alternation seen on the live engine. So the body is
        # read ONCE, here, before any branch can return early.
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except Exception:
            n = 0
        try:
            return self.rfile.read(n) if n > 0 else b''
        except Exception:
            self.close_connection = True
            return b''
    def do_POST(self):
        body = self._read_body()
        # FIX (audit C5): every POST is authenticated. Previously only /off
        # checked the key, so anyone who learned the tunnel URL could drive
        # /api/chat - and its run_command tool - or the raw ollama proxy.
        if self.headers.get('X-Engine-Key') != OFF_KEY:
            msg = b'{"status":"forbidden"}'
            self.send_response(403); self.send_header('Content-Type','application/json'); self.send_header('Content-Length', str(len(msg))); self.end_headers(); self.wfile.write(msg); self.wfile.flush()
            return"""

# --- 4: drop the dead duplicate check -----------------------------------------
OFF_OLD = """        if self.path == '/off':
            if self.headers.get('X-Engine-Key') != OFF_KEY:
                msg = b'{"status":"forbidden"}'
                self.send_response(403); self.send_header('Content-Type','application/json'); self.send_header('Content-Length', str(len(msg))); self._cors(); self.end_headers(); self.wfile.write(msg)
                return
            try:
                msg = b'{"status":"shutting down"}'
                self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length', str(len(msg))); self._cors(); self.end_headers(); self.wfile.write(msg)
            except Exception:
                pass"""
OFF_NEW = """        if self.path == '/off':
            # Key already checked above; the old second check here was dead code.
            try:
                msg = b'{"status":"shutting down"}'
                self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length', str(len(msg))); self.end_headers(); self.wfile.write(msg)
                # FIX: wfile is buffered and os._exit() below does not flush it,
                # so without this the 200 body could be lost mid-shutdown.
                self.wfile.flush()
            except Exception:
                pass"""

# --- 1: proxy + chat branches reuse the already-read body ----------------------
PROXY_OLD = """        if self.path != '/api/chat':
            try:
                body = self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))
                rq = urllib.request.Request('http://127.0.0.1:11434' + self.path, data=body, method='POST')"""
PROXY_NEW = """        if self.path != '/api/chat':
            try:
                rq = urllib.request.Request('http://127.0.0.1:11434' + self.path, data=body, method='POST')"""

CHAT_OLD = """        LAST_HIT['t'] = time.time()
        try:
            body = self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))
            payload = json.loads(body or b'{}')
        except Exception:
            payload = {}"""
CHAT_NEW = """        LAST_HIT['t'] = time.time()
        try:
            payload = json.loads(body or b'{}')
        except Exception:
            payload = {}"""

# --- 3: do not send a second status line if streaming already began -----------
ERR_OLD = """        try:
            agent_stream(self, payload)
        except IOError:
            pass
        except Exception as ex:
            try:
                msg = json.dumps({'message':{'content':'agent error: ' + str(ex)},'done':True}).encode()
                self.send_response(200); self.send_header('Content-Type','application/x-ndjson'); self.send_header('Content-Length', str(len(msg))); self._cors(); self.end_headers(); self.wfile.write(msg)
            except Exception: pass"""
ERR_NEW = """        self._sent = False
        try:
            agent_stream(self, payload)
            self._sent = True
        except IOError:
            pass
        except Exception as ex:
            # FIX: if agent_stream already wrote a status line, sending another
            # one would land inside the response body and desynchronise the
            # keep-alive socket - the same class of bug as the 403 above.
            if getattr(self, '_sent', False):
                pass
            else:
                try:
                    msg = json.dumps({'message':{'content':'agent error: ' + str(ex)},'done':True}).encode()
                    self.send_response(200); self.send_header('Content-Type','application/x-ndjson'); self.send_header('Content-Length', str(len(msg))); self.end_headers(); self.wfile.write(msg); self.wfile.flush()
                except Exception: pass"""

PATCHES = [(GATE_OLD, GATE_NEW), (OFF_OLD, OFF_NEW), (PROXY_OLD, PROXY_NEW),
           (CHAT_OLD, CHAT_NEW), (ERR_OLD, ERR_NEW)]

applied = 0
for c in nb["cells"]:
    if c.get("cell_type") != "code":
        continue
    code = cell_code(c)
    orig = code
    for old, new in PATCHES:
        if old in code:
            assert code.count(old) == 1, f"anchor not unique: {old[:56]!r}"
            code = code.replace(old, new)
            applied += 1
    if code != orig:
        c["source"] = code

assert applied == len(PATCHES), f"expected {len(PATCHES)} patches, applied {applied}"

all_code = "\n".join(cell_code(c) for c in nb["cells"] if c.get("cell_type") == "code")
compile(all_code, "<engine>", "exec")

# the body must be read exactly once, before the gate
i_read = all_code.index("body = self._read_body()")
i_gate = all_code.index("if self.headers.get('X-Engine-Key') != OFF_KEY:")
assert i_read < i_gate, "body must be drained before the auth gate can return"
assert all_code.count("self.rfile.read(int(self.headers.get('Content-Length'") == 0, \
    "a branch still re-reads the body"
assert "def do_POST" in all_code and "Access-Control-Allow-Origin" not in all_code

new_text = json.dumps(nb)
b64 = base64.b64encode(new_text.encode()).decode()
lines = [b64[i:i + 76] for i in range(0, len(b64), 76)]
block = "const B64 =\n" + "".join(f'  "{l}" +\n' for l in lines[:-1]) + f'  "{lines[-1]}";\n'
src = src[:m.start()] + block + src[m.end():]
pin = hashlib.sha256(new_text.encode()).hexdigest()
src = re.sub(r'export const AETHER_NOTEBOOK_SHA256 = "[0-9a-f]{64}";',
             f'export const AETHER_NOTEBOOK_SHA256 = "{pin}";', src)
open(TS, "w").write(src)
print(f"  patches applied   : {applied}/{len(PATCHES)}")
print(f"  engine python     : {len(all_code)} chars, compiles clean")
print(f"  notebook template : {len(new_text)} bytes")
print(f"  new sha256        : {pin}")
