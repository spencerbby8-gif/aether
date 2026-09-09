"""A local site that reproduces the conditions real pages throw at a browser agent.

Each route isolates one failure mode so a fix can be attributed instead of
guessed at. Nothing here is exotic: these are the ordinary things that make an
agent's selector time out.

    /dynamic    form fields rendered by JS 1.2s after load (SPA shape)
    /iframe     the login form lives inside a same-origin iframe
    /overlay    a cookie-consent banner covers the submit button
    /redirect   sends the browser elsewhere after 400ms
    /login      a real sign-in form: stable labels/names/roles, unstable ids
    /upload     a multipart file input
    /renamed    the same form, but every id and placeholder changes per load
    /dashboard  where a successful login lands; echoes the signed-in user
    /uploaded   echoes what the server received
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs

GEN = "/tmp/browser-reliability/gen"

_HEAD = "<!doctype html><meta charset=utf-8><title>%s</title>"

_CSS = """
<style>
 body{font:14px system-ui;margin:24px}
 label{display:block;margin:10px 0 2px}
 input,select,button{padding:6px;font:inherit}
 #banner{position:fixed;inset:auto 0 0 0;background:#222;color:#fff;padding:14px;
         display:flex;gap:12px;align-items:center;z-index:9999}
 #veil{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9998}
 .hidden{display:none}
</style>
"""


def _form(action="/dashboard", idprefix="f", stable_ids=True):
    """A sign-in form. With stable_ids=False the ids and placeholders are
    regenerated, so only the label text, name attributes and roles survive."""
    import random
    r = random.Random()
    suf = "%06x" % r.randrange(1 << 24) if not stable_ids else "1"
    return """
<form id="signin-%(s)s" action="%(action)s" method="post">
  <label for="email-%(s)s">Email address</label>
  <input id="email-%(s)s" name="email" type="email" autocomplete="username"
         placeholder="you%(s)s@example.com" required>
  <label for="pw-%(s)s">Password</label>
  <input id="pw-%(s)s" name="password" type="password" autocomplete="current-password" required>
  <label for="role-%(s)s">Account type</label>
  <select id="role-%(s)s" name="role">
    <option value="personal">Personal</option>
    <option value="team">Team</option>
  </select>
  <button id="go-%(s)s" type="submit" name="signin">Sign in</button>
</form>
""" % {"s": suf, "action": action}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, code=200, ctype="text/html; charset=utf-8", extra=None):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    # ---- GET -------------------------------------------------------------
    def do_GET(self):
        p = self.path.split("?")[0]

        if p == "/":
            return self._send(_HEAD % "Index" + _CSS + "<h1>Test site</h1>"
                              "<a href='/login'>login</a>")

        if p == "/dynamic":
            # Fields do not exist at domcontentloaded. An agent that acts
            # immediately targets elements that are not in the DOM yet.
            return self._send(_HEAD % "Dynamic" + _CSS + """
<h1>Create account</h1><div id="slot">Loading form...</div>
<script>
setTimeout(function(){
  document.getElementById('slot').innerHTML = `
    <form action="/dashboard" method="post">
      <label for="fullname">Full name</label>
      <input id="fullname" name="fullname" autocomplete="name" required>
      <label for="newpw">Choose a password</label>
      <input id="newpw" name="password" type="password"
             autocomplete="new-password" required>
      <button type="submit" name="create">Create account</button>
    </form>`;
}, 1200);
</script>""")

        if p == "/iframe":
            # The real form is inside a frame. A main-frame selector can never
            # reach it, and Playwright will wait out the full timeout.
            return self._send(_HEAD % "Framed" + _CSS + """
<h1>Partner sign in</h1>
<iframe id="partner" src="/login?framed=1" style="width:600px;height:420px;border:1px solid #ccc"></iframe>
""")

        if p == "/overlay":
            # A consent banner plus a full-page veil sit above the button.
            # Playwright's actionability check waits for them to go away and
            # then times out without ever saying why.
            return self._send(_HEAD % "Overlay" + _CSS + """
<h1>Newsletter</h1>
<div id="veil"></div>
<div id="banner"><span>We use cookies.</span>
  <button id="accept" type="button">Accept all</button></div>
<form action="/dashboard" method="post">
  <label for="sub-email">Email address</label>
  <input id="sub-email" name="email" type="email" autocomplete="email">
  <button id="subscribe" type="submit" name="subscribe">Subscribe</button>
</form>
<script>
document.getElementById('accept').addEventListener('click', function(){
  document.getElementById('banner').remove();
  document.getElementById('veil').remove();
});
</script>""")

        if p == "/redirect":
            return self._send(_HEAD % "Redirecting" + _CSS + """
<h1>Moving you on...</h1>
<script>setTimeout(function(){ location.href = '/login?via=redirect'; }, 400);</script>""")

        if p == "/renamed":
            # Same form, unstable ids AND unstable placeholders. Only labels,
            # name attributes and roles survive a reload.
            return self._send(_HEAD % "Renamed" + _CSS
                              + "<h1>Sign in</h1>" + _form(stable_ids=False))

        if p == "/login":
            return self._send(_HEAD % "Sign in" + _CSS
                              + "<h1>Sign in</h1>" + _form())

        if p == "/upload":
            return self._send(_HEAD % "Upload" + _CSS + """
<h1>Attach a file</h1>
<form action="/uploaded" method="post" enctype="multipart/form-data">
  <label for="doc">Document</label>
  <input id="doc" name="doc" type="file">
  <button type="submit" name="send">Send</button>
</form>""")

        if p == "/captcha":
            return self._send(_HEAD % "Verify" + _CSS + """
<h1>Are you human?</h1>
<div class="g-recaptcha" data-sitekey="fake"></div>
<form action="/dashboard" method="post">
  <label for="c-user">Username</label><input id="c-user" name="user">
  <button type="submit" name="go">Continue</button>
</form>""")

        if p == "/uploaded":
            got = self.server.received
            return self._send(_HEAD % "Uploaded" + _CSS
                              + "<h1>Received</h1><pre>UPLOADED:%s</pre>" % got)

        if p == "/dashboard":
            user = self.server.user or "(none)"
            return self._send(_HEAD % "Dashboard" + _CSS
                              + "<h1>Dashboard</h1><p id='who'>SIGNED_IN_AS %s</p>" % user,
                              extra={"Set-Cookie": "sid=abc123; Path=/"})

        if p == "/settings":
            # Proves the session cookie survived: only /dashboard sets it.
            cookie = self.headers.get("Cookie") or ""
            ok = "sid=abc123" in cookie
            return self._send(_HEAD % "Settings" + _CSS
                              + "<h1>Settings</h1><p>SESSION_%s</p>"
                                % ("KEPT" if ok else "LOST"))

        return self._send(_HEAD % "Not found" + "<h1>404</h1>", code=404)

    # ---- POST ------------------------------------------------------------
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        ctype = self.headers.get("Content-Type") or ""
        if "multipart/form-data" in ctype:
            name = None
            for line in raw.split(b"\r\n"):
                if b'filename="' in line and not line.endswith(b'filename=""'):
                    name = line.split(b'filename="')[1].split(b'"')[0].decode()
            self.server.received = name or "(none)"
            return self._send(_HEAD % "Uploaded" + _CSS
                              + "<h1>Received</h1><pre>UPLOADED:%s</pre>" % self.server.received)
        fields = {k: v[0] for k, v in parse_qs(raw.decode("utf-8", "replace")).items()}
        self.server.user = fields.get("email") or fields.get("fullname") or "(none)"
        return self._send(_HEAD % "Dashboard" + _CSS
                          + "<h1>Dashboard</h1><p id='who'>SIGNED_IN_AS %s</p>" % self.server.user,
                          extra={"Set-Cookie": "sid=abc123; Path=/"})


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    user = None
    received = None


def start():
    os.makedirs(GEN, exist_ok=True)
    srv = Server(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]


if __name__ == "__main__":
    s, url = start()
    print("site on %s" % url)
    import time
    while True:
        time.sleep(3600)
