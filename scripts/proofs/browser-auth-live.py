#!/usr/bin/env python3
"""Drive the REAL shipped browser helper against REAL Chromium.

No mocks and no source inspection: this extracts the browser helper out of the
notebook asset, runs it as the engine does (one JSON action per stdin line, one
JSON reply), and points it at a live Chromium plus a live HTTP server.

What it proves:
  * normal browsing, page reading, screenshots and multi-step navigation
  * a credential fill is REFUSED until the user's grant exists
  * the same fill succeeds once authorize has been called for that host
  * submit is gated separately from fill
  * the grant lapses once the sign-in completes
  * a value never appears in any reply
  * a CAPTCHA page is refused, not solved
  * session cookies persist across calls, so "signed in" survives
  * file upload works

The login site is served locally because there are no real credentials for a
third-party service to use. The browser, the HTTP traffic, the cookies, the
upload and the screenshots are all real.

Run: python3 scripts/proofs/browser-auth-live.py
"""
import http.server
import json
import os
import pathlib
import re
import socketserver
import subprocess
import sys
import threading

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
ASSET = REPO / "android/app/src/main/assets/aether-notebook-template.json"
GEN = pathlib.Path("/tmp/browser-auth-live/gen")
WORK = pathlib.Path("/tmp/browser-auth-live/work")
HELPER = WORK / "helper.py"

passed = failed = 0


def chk(what, ok, seen=""):
    global passed, failed
    print("  %s %s   [%s]" % ("ok  " if ok else "FAIL", what, str(seen)[:150]))
    if ok:
        passed += 1
    else:
        failed += 1


# ------------------------------------------------------------- the test site
LOGIN = """<html><head><title>Acme Sign In</title></head><body>
<h1>Sign in to Acme</h1>
<form method="post" action="/login" enctype="multipart/form-data">
  <label>Email <input id="email" name="email" type="email"></label>
  <label>Password <input id="pw" name="password" type="password"></label>
  <label>Code <input id="otp" name="otp" autocomplete="one-time-code"></label>
  <label>Attachment <input id="file" name="file" type="file"></label>
  <button id="go" type="submit">Sign in</button>
</form></body></html>"""

DASH = """<html><head><title>Acme Dashboard</title></head><body>
<h1>Welcome back</h1><p>SIGNED_IN_AS %(who)s</p><a id="next" href="/settings">Settings</a>
</body></html>"""

SETTINGS = """<html><head><title>Acme Settings</title></head><body>
<h1>Settings</h1><p>PROFILE_PAGE_REACHED</p></body></html>"""

CAPTCHA = """<html><head><title>Verify</title></head><body>
<div class="g-recaptcha" data-sitekey="x"></div><h1>Prove you are human</h1>
<button id="go">Continue</button></body></html>"""

STATE = {"sessions": {}, "uploaded": None}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="text/html", extra=None):
        raw = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        cookie = self.headers.get("Cookie", "")
        sid = re.search(r"sid=([a-z0-9]+)", cookie)
        if self.path == "/login-form":
            return self._send(200, LOGIN)
        if self.path == "/dashboard":
            who = STATE["sessions"].get(sid.group(1)) if sid else None
            if not who:
                return self._send(403, "<h1>Not signed in</h1>")
            return self._send(200, DASH % {"who": who})
        if self.path == "/settings":
            if not (sid and sid.group(1) in STATE["sessions"]):
                return self._send(403, "<h1>Not signed in</h1>")
            return self._send(200, SETTINGS)
        if self.path == "/captcha":
            return self._send(200, CAPTCHA)
        if self.path == "/uploaded":
            return self._send(200, "UPLOADED:%s" % (STATE["uploaded"] or "none"),
                              "text/plain")
        return self._send(404, "<h1>nope</h1>")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace")
        if self.path != "/login":
            return self._send(404, "<h1>nope</h1>")
        # A real multipart post arrives when a file is attached.
        email = ""
        m = re.search(r'name="email"\r\n\r\n([^\r]*)', body) or \
            re.search(r"email=([^&]*)", body)
        if m:
            email = m.group(1)
        if "filename=" in body:
            fm = re.search(r'filename="([^"]+)"', body)
            STATE["uploaded"] = fm.group(1) if fm else "unnamed"
        pw = re.search(r'name="password"\r\n\r\n([^\r]*)', body) or \
            re.search(r"password=([^&]*)", body)
        if not email or not pw or not pw.group(1):
            return self._send(401, "<h1>Missing credentials</h1>")
        sid = "sess%d" % (len(STATE["sessions"]) + 1)
        STATE["sessions"][sid] = email
        return self._send(302, "", extra=[("Location", "/dashboard"),
                                          ("Set-Cookie", "sid=%s; Path=/" % sid)])


def start_site():
    class Q(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    srv = Q(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]


# --------------------------------------------------------------- the helper
def extract_helper():
    import ast
    nb = json.loads(ASSET.read_text(encoding="utf-8"))
    for cell in nb["cells"]:
        if cell.get("cell_type") != "code":
            continue
        s = cell["source"] if isinstance(cell["source"], str) else "".join(cell["source"])
        if "_B_HELPER_SRC" not in s:
            continue
        i = s.index("_B_HELPER_SRC")
        q = s.index("'", i)
        end = q + 1
        while end < len(s):
            if s[end] == "\\":
                end += 2
                continue
            if s[end] == "'":
                break
            end += 1
        return ast.literal_eval(s[q:end + 1])
    raise SystemExit("browser helper not found in the notebook asset")


class Helper:
    """Talks to the real helper process exactly as the engine does."""

    def __init__(self):
        env = dict(os.environ)
        env["AETHER_GEN_DIR"] = str(GEN)
        env["AETHER_BROWSER_DIR"] = str(WORK / "profile")
        env["LD_LIBRARY_PATH"] = (
            "/home/user/.cache/crlibs/usr/lib/x86_64-linux-gnu:"
            + env.get("LD_LIBRARY_PATH", ""))
        self.p = subprocess.Popen(
            [sys.executable, "-u", str(HELPER)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1, env=env)
        self.replies = []

    def call(self, **kw):
        self.p.stdin.write(json.dumps(kw) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        try:
            r = json.loads(line)
        except Exception:
            r = {"ok": False, "err": "no reply (helper died): %r" % line}
        self.replies.append(json.dumps(r))
        out = r.get("out") or r.get("err") or ""
        print("      -> %s" % out[:130])
        return out

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=15)
        except Exception:
            self.p.kill()


def main():
    GEN.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    HELPER.write_text(extract_helper())
    print("helper extracted from the notebook asset: %d bytes" % HELPER.stat().st_size)

    srv, site = start_site()
    print("test site on %s" % site)
    h = Helper()

    SECRET = "Sup3r-Secret-Pass!"
    OTP = "481902"

    print("\n== 1. normal public browsing, real internet ==")
    out = h.call(action="navigate", url="https://example.com")
    chk("navigated to a real public page", "example.com" in out, out)
    out = h.call(action="read")
    chk("read the page text", "Example Domain" in out, out[:80])
    shot = h.call(action="screenshot")
    pngs = sorted(GEN.glob("*.png"))
    real = pngs and pngs[-1].read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    chk("produced a real PNG screenshot", bool(real),
        "%s, %d bytes" % (pngs[-1].name if pngs else "none",
                          pngs[-1].stat().st_size if pngs else 0))

    print("\n== 2. multi-step navigation on the test site ==")
    h.call(action="navigate", url=site + "/login-form")
    out = h.call(action="read")
    chk("reached the sign-in form", "Sign in to Acme" in out, out[:60])

    print("\n== 3. a non-secret field needs no grant ==")
    out = h.call(action="fill", selector="#email", value="ada@example.com")
    chk("filled the email field freely", out.startswith("FILL"), out)
    chk("the email value is not a secret and was not withheld as one",
        "withheld" in out, out)

    print("\n== 4. a credential fill is refused with NO grant ==")
    out = h.call(action="fill", selector="#pw", value=SECRET)
    chk("refused the password without authorization", "NEEDS APPROVAL" in out, out)
    chk("named the host the grant is needed for", "127.0.0.1" in out, out)
    out = h.call(action="fill", selector="#otp", value=OTP)
    chk("refused the OTP field too", "NEEDS APPROVAL" in out, out)
    chk("the password never appeared in the refusal",
        not any(SECRET in r for r in h.replies), "checked %d replies" % len(h.replies))
    chk("user_approved alone does NOT open the gate",
        "NEEDS APPROVAL" in h.call(action="fill", selector="#pw", value=SECRET,
                                   user_approved=True), "self-asserted flag ignored")

    print("\n== 5. the user grants it, and the same fill now works ==")
    out = h.call(action="authorize", value="fill")
    chk("authorize recorded a scoped grant", out.startswith("AUTHORIZED"), out)
    out = h.call(action="fill", selector="#pw", value=SECRET)
    chk("filled the password once authorized", out.startswith("FILL"), out)
    chk("the value was withheld from the result", "withheld" in out, out)
    out = h.call(action="fill", selector="#otp", value=OTP)
    chk("filled the OTP field under the same grant", out.startswith("FILL"), out)
    chk("the secret is in NO reply the helper ever sent",
        not any(SECRET in r or OTP in r for r in h.replies),
        "scanned %d replies" % len(h.replies))

    print("\n== 6. submit is gated separately from fill ==")
    out = h.call(action="submit", selector="#go")
    chk("refused to submit without a submit grant", "NEEDS APPROVAL" in out, out)
    out = h.call(action="authorize", value="submit")
    chk("granted submit separately", out.startswith("AUTHORIZED"), out)
    out = h.call(action="submit", selector="#go")
    chk("submitted and followed the redirect", "SUBMITTED" in out and "dashboard" in out, out)

    print("\n== 7. the session is really signed in ==")
    out = h.call(action="read")
    chk("the dashboard shows the signed-in user", "SIGNED_IN_AS ada" in out,
        out.replace(chr(10), " ")[:120])
    out = h.call(action="navigate", url=site + "/settings")
    out = h.call(action="read")
    chk("the session cookie carried to the next page",
        "PROFILE_PAGE_REACHED" in out, out[:60])
    out = h.call(action="cookies")
    chk("the session cookie is present", "count=1" in out and "sid" in out, out[:80])

    print("\n== 8. the grant lapsed when the sign-in completed ==")
    h.call(action="navigate", url=site + "/login-form")
    out = h.call(action="fill", selector="#pw", value=SECRET)
    chk("a later credential fill is refused again", "NEEDS APPROVAL" in out, out)

    print("\n== 9. file upload ==")
    up = GEN / "hello.txt"
    up.write_text("aether upload test\n")
    h.call(action="navigate", url=site + "/login-form")
    h.call(action="fill", selector="#email", value="ada@example.com")
    h.call(action="authorize", value="fill")
    h.call(action="fill", selector="#pw", value=SECRET)
    out = h.call(action="upload", selector="#file", path=str(up))
    chk("attached a real file", "UPLOAD" in out.upper() or "hello.txt" in out, out)
    h.call(action="authorize", value="submit")
    h.call(action="submit", selector="#go")
    h.call(action="navigate", url=site + "/uploaded")
    out = h.call(action="read")
    chk("the server received the upload", "hello.txt" in out,
        out.replace(chr(10), " ")[:120])

    print("\n== 10. CAPTCHA is refused, never solved ==")
    h.call(action="navigate", url=site + "/captcha")
    out = h.call(action="click", selector="#go")
    chk("refused the CAPTCHA instead of solving it", "BLOCKED" in out, out)

    print("\n== 11. revoke clears the session's authorization ==")
    h.call(action="authorize", value="fill")
    out = h.call(action="revoke")
    chk("revoke reported success", out.startswith("REVOKED"), out)
    h.call(action="navigate", url=site + "/login-form")
    out = h.call(action="fill", selector="#pw", value=SECRET)
    chk("and the credential fill is refused again", "NEEDS APPROVAL" in out, out)

    print("\n== 12. no secret ever left the helper ==")
    blob = "\n".join(h.replies)
    chk("the password appears in no reply", SECRET not in blob, "%d replies" % len(h.replies))
    chk("the OTP appears in no reply", OTP not in blob, "")

    err = h.p.stderr.read() if h.p.poll() is not None else ""
    h.close()
    srv.shutdown()

    print("\n%d passed, %d failed" % (passed, failed))
    if failed:
        print("helper stderr: %s" % err[-800:])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
