#!/usr/bin/env python3
"""
SOCKET-LEVEL PROOF of the engine 501 bug and its fix.

This does NOT re-implement the handler. It decodes the shipped Kaggle notebook
template (src/server/engine/aether-engine-source.ts), pulls the `class H`
handler source out verbatim with `ast`, and exec()s THAT source in a namespace
where only the engine's own module-level globals are stubbed (OFF_KEY, the
ollama/model plumbing). The handler code that runs is byte-identical to the code
that ships inside the notebook.

It then drives it with a real TCP client that REUSES ONE keep-alive connection
across several POSTs -- exactly what curl / fetch / the Aether app do.

Usage:  python3 scripts/proofs/keepalive-501-proof.py <old.py|new.py> <label>
Exit 0 = no 501 observed. Exit 1 = 501 observed.
"""
import ast
import base64
import http.client
import json
import re
import sys
import threading
import time
from http.server import ThreadingHTTPServer

PY_PATH = sys.argv[1]
LABEL = sys.argv[2]

py = open(PY_PATH).read()
tree = ast.parse(py)

cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "H")
handler_src = ast.get_source_segment(py, cls)
assert handler_src, "could not slice handler source"

# Names the real handler resolves from module scope. These are stubbed; the
# handler BODY is the shipped code, unmodified.
STUB = {
    "OFF_KEY": "test-off-key",
    "MODEL": "test-model",
    "IDLE_LIMIT": 3600.0,
    "LAST_ACTIVITY": [time.time()],
    "ANNOUNCEMENTS": [],
    "STATE": {},
}


def _agent_stream(payload):
    """Minimal stand-in for the real agent_stream generator (not exercised by
    the auth-gate / /off paths this proof targets)."""
    yield {"status": "ok"}


STUB["agent_stream"] = _agent_stream

# The real cell does `from http.server import BaseHTTPRequestHandler` etc. at
# module scope; the sliced class body needs those names in its namespace.
from http.server import BaseHTTPRequestHandler  # noqa: E402

ns = dict(STUB)
ns["BaseHTTPRequestHandler"] = BaseHTTPRequestHandler
ns["json"] = json
ns["os"] = __import__("os")
ns["time"] = time
exec(compile(handler_src, f"<engine:{LABEL}>", "exec"), ns)  # noqa: S102
H = ns["H"]

print(f"[{LABEL}] handler class compiled from shipped source: {len(handler_src)} chars")
print(f"[{LABEL}] protocol_version = {H.protocol_version!r}")
print(f"[{LABEL}] has _read_body: {hasattr(H, '_read_body')}")

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

# ---- drive it over ONE reused keep-alive connection --------------------------
#
# Two modes, because the SAME desync surfaces with two different status codes
# depending on what is sitting in the socket buffer when the server next parses:
#
#   SEQUENTIAL - the client waits for each response. The buffer then holds only
#                the unread JSON body, whose first line has many whitespace
#                tokens -> "Bad request syntax" -> 400.
#
#   PIPELINED  - the client writes the next request before reading the previous
#                response. Same desync, different framing.
#
# NOTE on 400 vs 501: it is NOT the Python version, and not the pipelining. The
# fused line is tokenised by whitespace and words[-1] is always "HTTP/1.1", so
# what decides it is the token COUNT, i.e. how the JSON body is formatted:
#   compact {"model":"m",...}  -> 3 tokens -> method lookup fails -> 501
#   spaced  json.dumps(...)    -> 9 tokens -> "Bad request syntax" -> 400
# Aether sends JSON.stringify output (compact), which is why the LIVE engine
# returned 501. scripts/proofs/engine-sweep.py uses a compact body and reproduces
# the 501 -- including the message text -- exactly.

conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
body = json.dumps({"model": "m", "messages": [{"role": "user", "content": "hi"}]}).encode()


def raw_post(sock, path, key=None):
    hdrs = f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n"
    if key:
        hdrs += f"X-Engine-Key: {key}\r\n"
    sock.sendall((hdrs + "\r\n").encode() + body)


results = []
plan = [
    ("POST /api/chat  (no key)", "/api/chat", None),
    ("POST /api/chat  (no key)", "/api/chat", None),
    ("POST /api/tags  (no key)", "/api/tags", None),
    ("POST /api/chat  (no key)", "/api/chat", None),
    ("POST /api/chat  (no key)", "/api/chat", None),
    ("POST /off       (no key)", "/off", None),
    ("POST /api/chat  (WRONG key)", "/api/chat", "wrong-key"),
    ("POST /api/chat  (no key)", "/api/chat", None),
]

print(f"[{LABEL}] MODE 1 - sequential, one TCP connection, {len(plan)} POSTs:")
for name, path, key in plan:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-Engine-Key"] = key
    try:
        conn.request("POST", path, body=body, headers=headers)
        r = conn.getresponse()
        payload = r.read()
        results.append((f"seq {name}", r.status))
        bad = "  <-- DESYNC" if r.status in (400, 501, 505) else ""
        print(f"    {r.status}  {name}{bad}")
    except Exception as exc:  # a desynced socket can also surface as a parse error
        results.append((f"seq {name}", f"ERR {exc.__class__.__name__}"))
        print(f"    ERR  {name} -> {exc.__class__.__name__}: {exc}")
conn.close()

print(f"[{LABEL}] MODE 2 - pipelined pairs (proxy-style), fresh socket each trial:")
import socket as _socket  # noqa: E402

TRIALS = 5
for t in range(1, TRIALS + 1):
    s = _socket.create_connection(("127.0.0.1", port), timeout=15)
    # Write BOTH requests before reading anything. The server answers #1 with a
    # 403 and never reads its body; those bytes are still in the buffer when it
    # parses the next request line, so they merge with it.
    raw_post(s, "/api/chat")
    raw_post(s, "/api/chat")
    buf = b""
    s.settimeout(8)
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    except (_socket.timeout, OSError):
        pass
    s.close()

    statuses = [int(c) for c in re.findall(rb"HTTP/1\.[01] (\d{3})", buf)]
    results.append((f"pipelined trial {t} req1", statuses[0] if statuses else "no response"))
    results.append((f"pipelined trial {t} req2", statuses[1] if len(statuses) > 1 else "no response"))
    print(f"    trial {t}: statuses={statuses}")
    m = re.search(rb"(?:Unsupported method|Bad request syntax|Bad request version) \([^)]*\)", buf)
    if m:
        print(f"        server said: {m.group(0).decode(errors='replace')[:110]}")

srv.shutdown()

bad = [r for r in results if r[1] in (400, 501, 505) or isinstance(r[1], str)]
n501 = sum(1 for _, s in results if s == 501)
n400 = sum(1 for _, s in results if s == 400)
print(f"[{LABEL}] RESULT: {len(results)} requests, desynced={len(bad)} (501={n501}, 400={n400})")
sys.exit(1 if bad else 0)

