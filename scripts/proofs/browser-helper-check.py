#!/usr/bin/env python3
"""Drive the real browser helper with a real Chromium.

The helper source is lifted out of the notebook template, not restated here, so
this exercises the code that will actually run on an engine. It speaks the same
one-JSON-line-per-action protocol the kernel uses, and asserts on real replies
from a real browser over a real network.

Requires: pip install playwright && python3 -m playwright install chromium

Run from the repo root:  python3 scripts/proofs/browser-helper-check.py
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import time

# Resolved from this file, not the cwd: mutation-check runs a copy of
# this proof out of /tmp/mut against a mutated copy of the template, and a
# cwd-relative path would silently read the unmutated original.
HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, '..', '..', 'android', 'app', 'src', 'main',
                   'assets', 'aether-notebook-template.json')
FORM = ('data:text/html,<form><input id="u" name="email">'
        '<input id="pw" type="password" name="password">'
        '<button id="go">Submit</button></form>')
SECRET = 'hunter2-DO-NOT-LEAK'

passed = failed = 0


def chk(what, ok, seen=''):
    global passed, failed
    print('  %s %s   [%s]' % ('ok  ' if ok else 'FAIL', what, seen))
    if ok:
        passed += 1
    else:
        failed += 1


def helper_source():
    s = json.load(open(TPL))['cells'][4]['source']
    i = s.index('_B_HELPER_SRC = ') + len('_B_HELPER_SRC = ')
    j = s.index('\n', i)
    return eval(s[i:j])


class Helper:
    """Spawned exactly the way _b_rpc spawns it on an engine."""

    def __init__(self, path, env):
        self.p = subprocess.Popen([sys.executable, '-u', path],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1,
                                  env=env)
        self.lines = 0

    def call(self, timeout=90, **kw):
        self.p.stdin.write(json.dumps(kw) + '\n')
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        self.lines += 1
        if not line:
            raise RuntimeError('helper exited: ' + (self.p.stderr.read() or '')[-400:])
        return json.loads(line)

    def out(self, **kw):
        d = self.call(**kw)
        return d.get('out') if d.get('ok') else 'ERR: ' + str(d.get('err'))

    def alive(self):
        return self.p.poll() is None

    def stop(self):
        try:
            self.p.kill()
        except Exception:
            pass


def main():
    src = helper_source()
    compile(src, 'helper', 'exec')
    d = tempfile.mkdtemp(prefix='aether-browser-')
    path = os.path.join(d, '_aether_browser.py')
    open(path, 'w').write(src)
    gen = os.path.join(d, 'generated')
    bdir = os.path.join(d, 'browser')
    env = dict(os.environ, AETHER_GEN_DIR=gen, AETHER_BROWSER_DIR=bdir)
    print('== browser helper, real chromium ==')
    print('helper lifted from template: %d bytes\n' % len(src))

    h = Helper(path, env)
    try:
        r = h.out(action='navigate', url='https://example.com', tunnel='https://tunnel.test')
        if 'TargetClosedError' in r or "Executable doesn" in r:
            # Chromium cannot start in this environment, so there is nothing
            # left here worth asserting -- every remaining check would fail for
            # the same single reason and say nothing about the helper. This
            # happens in a container without the system libraries Chromium
            # links against and no root to install them; on an engine the
            # prewarm runs `playwright install-deps` at boot.
            print('  SKIP  Chromium cannot launch in this environment')
            print('        %s' % r[:110])
            print('\n0 passed, 0 failed  (nothing proven here -- run on an engine)')
            return
        chk('navigate reaches a real site', r.startswith('NAVIGATED')
            and 'example.com' in r, r[:90])
        chk('the real page title comes back', 'Example Domain' in r, r[:90])

        r = h.out(action='read')
        chk('read returns the page text', 'illustrative' in r.lower()
            or 'example domain' in r.lower(), r[:70])

        r = h.out(action='wait', value=300)
        chk('wait works', r.startswith('WAITED'), r[:40])

        r = h.out(action='cookies')
        chk('cookies are reported by name only', r.startswith('COOKIES')
            and 'values withheld' in r, r[:70])

        r = h.out(action='list')
        chk('the open session is listed', 'main' in r, r[:60])

        # --- the security gate, against a real form ---
        h.out(action='navigate', url=FORM)
        r = h.out(action='fill', selector='#u', value='me@example.com')
        chk('a normal field fills without approval', 'NEEDS APPROVAL' not in r, r[:70])
        r = h.out(action='fill', selector='#pw', value=SECRET)
        chk('a credential field refuses without approval',
            r.startswith('NEEDS APPROVAL'), r[:80])
        r = h.out(action='fill', selector='#pw', value=SECRET, user_approved=True)
        chk('with approval it fills', 'NEEDS APPROVAL' not in r, r[:70])
        chk('the secret is never echoed back', SECRET not in r, r[:70])
        r = h.out(action='read')
        chk('the secret is not in the page text either', SECRET not in r, r[:70])

        # --- screenshot: a real file, and a media prefix the client renders ---
        r = h.out(action='screenshot', text='proof', tunnel='https://tunnel.test')
        chk('screenshot reports IMAGE READY with a tunnel URL',
            r.startswith('IMAGE READY: https://tunnel.test/files/'), r[:80])
        shot = os.path.join(gen, 'proof.png')
        sig = open(shot, 'rb').read(4) if os.path.exists(shot) else b''
        chk('the screenshot is a real PNG on disk', sig == b'\x89PNG',
            '%s at %s' % (sig.hex(), shot))

        # --- the session is what lets a task survive a restart ---
        st = os.path.join(bdir, 'main.json')
        chk('session state was saved to disk', os.path.exists(st), st)
        if os.path.exists(st):
            mode = stat.S_IMODE(os.stat(st).st_mode)
            chk('session state is 0600', mode == 0o600, oct(mode))
            chk('session state never carries the secret',
                SECRET not in open(st).read(), 'scanned')

        # --- a named session is a separate browser context ---
        r = h.out(action='new_context', session='work')
        chk('a second named session opens', 'work' in r, r[:50])
        r = h.out(action='list')
        chk('both sessions are listed', 'main' in r and 'work' in r, r[:60])

        # --- failures must not kill the helper ---
        r = h.out(action='navigate', url='https://no-such-host-aether.invalid')
        chk('a failed navigation reports an error', r.startswith('ERR:')
            or 'error' in r.lower() or 'ERR' in r, r[:70])
        chk('the helper is still alive after a failure', h.alive(),
            'poll=%s' % h.p.poll())
        r = h.out(action='navigate', url='https://example.com')
        chk('and it still works afterwards', r.startswith('NAVIGATED'), r[:60])

        r = h.out(action='bogus')
        chk('an unknown action is reported, not raised', 'unknown action' in r, r[:50])

        r = h.out(action='close', session='work')
        chk('close saves and closes the session', r.startswith('BROWSER CLOSED'), r[:60])
        chk('one reply line per request', h.lines == 19, 'lines=%d' % h.lines)
    finally:
        h.stop()

    print('\n%d passed, %d failed' % (passed, failed))
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
