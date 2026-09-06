#!/usr/bin/env python3
"""
Proves (or disproves) the double-status-line bug in do_POST's error path.

BOTH pieces of code under test are the SHIPPED source, sliced out of the decoded
notebook with ast and exec'd verbatim:

  * class H  -> do_POST and its error handler
  * def agent_stream -> the streaming generator, including the header sequence

agent_stream is NOT stubbed. It is made to fail mid-generation the way a real
failure happens: after it has emitted its status line and first chunk it calls
`q = queue.Queue()` to bridge ollama's thread. This harness injects a `queue`
module whose Queue raises, so the real generator raises a non-IOError exception
after its headers are already on the wire -- exactly the case do_POST must not
answer with a second status line.

Verdict: PASS = exactly one status line on the wire. FAIL = two.

Usage: python3 scripts/proofs/double-status-proof.py <engine.py> <label>
"""
import ast
import json
import re
import socket
import sys
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PY_PATH, LABEL = sys.argv[1], sys.argv[2]
py = open(PY_PATH).read()
tree = ast.parse(py)

cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "H")
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "agent_stream")
src = "\n".join(filter(None, [ast.get_source_segment(py, fn), ast.get_source_segment(py, cls)]))
assert src, "could not slice agent_stream + handler"

# A `queue` module whose Queue() raises -- the real agent_stream calls it AFTER
# end_headers(), so this is a faithful mid-generation failure.
fake_queue = types.ModuleType("queue")


def _boom(*a, **k):
    raise RuntimeError("injected mid-generation failure (ollama thread died)")


fake_queue.Queue = _boom
fake_queue.Empty = Exception


class _NoOllama:
    @staticmethod
    def urlopen(*a, **k):
        raise RuntimeError("no ollama in this sandbox")

    @staticmethod
    def Request(*a, **k):
        raise RuntimeError("no ollama in this sandbox")


fake_urllib = types.ModuleType("urllib.request")
fake_urllib.urlopen = _NoOllama.urlopen
fake_urllib.Request = _NoOllama.Request
fake_urllib_pkg = types.ModuleType("urllib")
fake_urllib_pkg.request = fake_urllib
fake_urllib_pkg.parse = __import__("urllib.parse", fromlist=["x"])

ns = {
    "BaseHTTPRequestHandler": BaseHTTPRequestHandler,
    "OFF_KEY": "test-off-key", "MODEL": "m", "PAGE": b"<html></html>", "GEN_DIR": "/tmp",
    "LAST_HIT": {"t": time.time()}, "SYSMSG": "you are aether", "TOOLS": [],
    "EXEC": {}, "notify": lambda *a, **k: None,
    "urllib": fake_urllib_pkg, "json": json, "os": __import__("os"), "time": time,
    "re": re, "threading": threading, "queue": fake_queue,
}
exec(compile(src, f"<engine:{LABEL}>", "exec"), ns)  # noqa: S102
H = ns["H"]
print(f"[{LABEL}] exec'd shipped source: agent_stream={len(ast.get_source_segment(py, fn))}c, "
      f"handler={len(ast.get_source_segment(py, cls))}c")

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

s = socket.create_connection(("127.0.0.1", port), timeout=20)
body = b'{"model":"m","messages":[{"role":"user","content":"hi"}]}'
s.sendall(
    f"POST /api/chat HTTP/1.1\r\nHost: x\r\nX-Engine-Key: test-off-key\r\n"
    f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body
)
s.settimeout(10)
buf = b""
try:
    while True:
        c = s.recv(65536)
        if not c:
            break
        buf += c
except (socket.timeout, OSError):
    pass
s.close()
srv.shutdown()

n_status = len(re.findall(rb"HTTP/1\.[01] \d{3}", buf))
print(f"[{LABEL}] status lines seen on the wire: {n_status}")
for mm in re.finditer(rb"HTTP/1\.[01] \d{3}[^\r\n]*", buf):
    print(f"    {mm.group(0).decode(errors='replace')}")
tail = buf.split(b"\r\n\r\n", 1)[-1]
print(f"[{LABEL}] body: {tail[:200].decode(errors='replace')!r}")
ok = n_status == 1
print(f"[{LABEL}] VERDICT: {'PASS - one status line' if ok else 'FAIL - SECOND status line written into the open body'}")
sys.exit(0 if ok else 1)
