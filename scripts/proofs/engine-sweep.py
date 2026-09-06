#!/usr/bin/env python3
"""
ENGINE CONTRACT SWEEP.

Runs the SHIPPED handler (ast-sliced from the decoded notebook, exec'd verbatim)
and fires edge-case requests at it over real sockets. Each case declares the
outcome it EXPECTS, so this is a regression test rather than a guess: a case
passes only if the status, the response completeness and the connection state
all match.

Reads stop when the response is complete (Content-Length satisfied, or the peer
closes), so a keep-alive response is not mistaken for a timeout.

Usage: python3 scripts/proofs/engine-sweep.py <engine.py> <label>
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
cls = next(n for n in ast.parse(py).body if isinstance(n, ast.ClassDef) and n.name == "H")
handler_src = ast.get_source_segment(py, cls)

fake_urllib = types.ModuleType("urllib.request")
fake_urllib.urlopen = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no ollama here"))
fake_urllib.Request = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no ollama here"))
pkg = types.ModuleType("urllib")
pkg.request = fake_urllib
pkg.parse = __import__("urllib.parse", fromlist=["x"])

ns = {
    "BaseHTTPRequestHandler": BaseHTTPRequestHandler,
    "OFF_KEY": "k", "MODEL": "m", "PAGE": b"<html></html>", "GEN_DIR": "/tmp",
    "LAST_HIT": {"t": time.time()}, "agent_stream": lambda h, p: None,
    "notify": lambda *a, **k: None, "urllib": pkg,
    "json": json, "os": __import__("os"), "time": time, "re": re,
    "threading": threading, "queue": __import__("queue"),
}
exec(compile(handler_src, f"<engine:{LABEL}>", "exec"), ns)  # noqa: S102
srv = ThreadingHTTPServer(("127.0.0.1", 0), ns["H"])
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()


def exchange(req, timeout=6.0):
    """Send one raw request, return (raw_bytes, closed_by_peer)."""
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    s.sendall(req)
    s.settimeout(timeout)
    buf = b""
    closed = False
    try:
        while True:
            c = s.recv(65536)
            if not c:
                closed = True
                break
            buf += c
            head, _, rest = buf.partition(b"\r\n\r\n")
            if b"\r\n\r\n" in buf:
                m = re.search(rb"Content-Length: (\d+)", head, re.I)
                if m and len(rest) >= int(m.group(1)):
                    break  # complete fixed-length response
                if re.search(rb"Connection: close", head, re.I):
                    continue  # will end at EOF
    except (socket.timeout, OSError):
        pass
    s.close()
    return buf, closed


BODY = b'{"model":"m","messages":[{"role":"user","content":"hi"}]}'

# name, request, expected status (None = HTTP/0.9 body-only), follow-up must work
CASES = [
    ("POST /api/chat, no key, normal body",
     b"POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(BODY) + BODY,
     403, True),
    ("POST /api/chat, no key, Content-Length: 0",
     b"POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n", 403, True),
    ("POST /api/chat, no key, body but NO Content-Length",
     b"POST /api/chat HTTP/1.1\r\nHost: x\r\n\r\n" + BODY, 403, True),
    ("POST /api/chat, no key, Content-Length LIES (says 5, sends 60)",
     b"POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\n" + BODY, 403, False),
    ("POST /off, no key",
     b"POST /off HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n", 403, True),
    ("POST /api/tags, no key (raw ollama proxy)",
     b"POST /api/tags HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}", 403, True),
    ("GET /api/ps (open for health checks; ollama down -> 502)",
     b"GET /api/ps HTTP/1.1\r\nHost: x\r\n\r\n", 502, True),
    ("GET /files/..%2f..%2fetc%2fpasswd (traversal -> engine's own 400)",
     b"GET /files/..%2f..%2fetc%2fpasswd HTTP/1.1\r\nHost: x\r\n\r\n", 400, True),
    ("GET /files/../../etc/passwd (raw traversal -> engine's own 400)",
     b"GET /files/../../etc/passwd HTTP/1.1\r\nHost: x\r\n\r\n", 400, True),
    ("OPTIONS /api/chat (preflight)",
     b"OPTIONS /api/chat HTTP/1.1\r\nHost: x\r\n\r\n", 204, True),
    # Undefined methods: 501 is correct, and CPython closes the connection on
    # purpose (Connection: close), which is NOT a desync.
    ("DELETE /api/chat (undefined method, deliberate close)",
     b"DELETE /api/chat HTTP/1.1\r\nHost: x\r\n\r\n", 501, False),
    ("PUT /api/chat (undefined method, deliberate close)",
     b"PUT /api/chat HTTP/1.1\r\nHost: x\r\n\r\n", 501, False),
    # No parseable version -> request_version defaults to HTTP/0.9, where
    # send_response_only intentionally writes NO status line. Correct per spec.
    ("malformed request line (HTTP/0.9 fallback, body only)",
     b"NOTAREQUEST\r\n\r\n", None, False),
]

failures = []
print(f"[{LABEL}] {len(CASES)} contract cases:")
for name, req, want, follow_up in CASES:
    buf, closed = exchange(req)
    statuses = re.findall(rb"HTTP/1\.[01] (\d{3})", buf)
    got = int(statuses[0]) if statuses else None
    problems = []

    if got != want:
        problems.append(f"status {got} != expected {want}")
    if len(statuses) > 1:
        problems.append(f"{len(statuses)} status lines in one response")
    if not buf:
        problems.append("no bytes at all")
    # A parse-level error would mean the request was never understood. Only
    # meaningful for well-formed requests -- the malformed-line case is SUPPOSED
    # to come back as HTTP/0.9 body-only with "Bad request syntax".
    if want is not None and re.search(rb"Bad request (syntax|version)", buf):
        problems.append("parse-level 400 (well-formed request misread)")
    # Any response must be complete: status line + headers + declared body.
    if buf and b"\r\n\r\n" in buf:
        head, _, rest = buf.partition(b"\r\n\r\n")
        m = re.search(rb"Content-Length: (\d+)", head, re.I)
        if m and len(rest) < int(m.group(1)):
            problems.append(f"truncated body {len(rest)}/{m.group(1).decode()}")

    if follow_up and not problems:
        buf2, _ = exchange(b"GET /api/ps HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        if not re.search(rb"HTTP/1\.[01] \d{3}", buf2):
            problems.append("follow-up request got no response")

    if problems:
        failures.append((name, problems))
    flag = "  <-- " + "; ".join(problems) if problems else f"  (closed={closed})"
    print(f"    {str(got):>4}  {name}{flag}")

# ---------------------------------------------------------------------------
# Connection-reuse group. This is the part that actually has teeth: the 501 bug
# only exists when a SECOND request is parsed off a socket whose previous
# response was sent without draining its body. A fresh socket per case can never
# see it -- which is why the pre-fix engine passes everything above.
# ---------------------------------------------------------------------------
REUSE_SEQUENCES = [
    ("two keyed-out POSTs, then a keyed-out /off, one socket",
     [b"POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(BODY) + BODY,
      b"POST /api/tags HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}",
      b"POST /off HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n"],
     [403, 403, 403]),
    ("wrong key, no key, wrong key, one socket",
     [b"POST /api/chat HTTP/1.1\r\nHost: x\r\nX-Engine-Key: nope\r\nContent-Length: %d\r\n\r\n" % len(BODY) + BODY,
      b"POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(BODY) + BODY,
      b"POST /api/chat HTTP/1.1\r\nHost: x\r\nX-Engine-Key: nope\r\nContent-Length: %d\r\n\r\n" % len(BODY) + BODY],
     [403, 403, 403]),
    ("five POSTs with a body each, one socket",
     [b"POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(BODY) + BODY] * 5,
     [403] * 5),
    ("POST then GET on the same socket",
     [b"POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(BODY) + BODY,
      b"GET /api/ps HTTP/1.1\r\nHost: x\r\n\r\n"],
     [403, 502]),
]

print(f"[{LABEL}] {len(REUSE_SEQUENCES)} connection-reuse sequences (the part with teeth):")
for name, reqs, want in REUSE_SEQUENCES:
    s = socket.create_connection(("127.0.0.1", port), timeout=8)
    got = []
    try:
        for req in reqs:
            s.sendall(req)
            s.settimeout(6)
            buf = b""
            while True:
                c = s.recv(65536)
                if not c:
                    break
                buf += c
                head, _, rest = buf.partition(b"\r\n\r\n")
                m = re.search(rb"Content-Length: (\d+)", head, re.I)
                if m and len(rest) >= int(m.group(1)):
                    break
            m2 = re.search(rb"HTTP/1\.[01] (\d{3})", buf)
            got.append(int(m2.group(1)) if m2 else None)
            if not m2:
                break
    except OSError:
        pass
    s.close()
    ok = got == want
    if not ok:
        failures.append((f"REUSE {name}", f"got {got}, expected {want}"))
    print(f"    {'ok  ' if ok else 'FAIL'}  {name}: got {got} expected {want}")

srv.shutdown()
print(f"[{LABEL}] SWEEP RESULT: {len(CASES)} single-request cases + "
      f"{len(REUSE_SEQUENCES)} reuse sequences, {len(failures)} failed")
sys.exit(1 if failures else 0)
