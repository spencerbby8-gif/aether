"""Run the browser in its own process and stop latching failures forever.

Playwright's sync API refused to start inside the kernel with "using Playwright
Sync API inside the asyncio loop". That could not be reproduced from a plain
thread, or from a thread spawned inside a running loop, so the notebook context
differs in a way worth not depending on. A separate interpreter has no such
ambiguity: the helper owns Chromium, reads one JSON line per action on stdin
and answers with one JSON line. A crash there kills the helper, not the engine,
and its stderr is captured so a failure says what actually happened.

Also fixed: _b_ensure latched the first error for the life of the process, so
one transient failure -- Chromium still installing -- disabled the browser
until the engine restarted.

Run from the repo root:  python3 scripts/browser-helper-process.py
"""
import hashlib
import json

P = 'android/app/src/main/assets/aether-notebook-template.json'

# Everything from _b_state_path to t_browser touches Playwright objects and
# moves into the helper verbatim. It needs nothing but _BROWSER, _b_ensure,
# GEN_DIR, _safe_name and the tunnel url.
HELPER_PREAMBLE = '''#!/usr/bin/env python3
"""Aether browser helper. One JSON action per stdin line, one JSON reply.

Runs in its own interpreter on purpose: Playwright's sync API is bound to the
thread that started it and refuses to run where an asyncio loop is in play,
which is the situation inside a notebook kernel. Nothing here prints to stdout
except the reply lines.
"""
import os
import re
import sys
import json
import time

# Overridable so the helper can be exercised outside a Kaggle image; the
# defaults are the real ones.
GEN_DIR = os.environ.get('AETHER_GEN_DIR', '/kaggle/working/generated')
BROWSER_DIR = os.environ.get('AETHER_BROWSER_DIR', '/kaggle/working/browser')
url = None            # the engine's tunnel URL, sent with every request


def _safe_name(fn, ext):
    fn = re.sub(r'[^A-Za-z0-9_.-]', '_', str(fn or ''))[:60] or (ext + '_' + str(int(time.time())))
    if not fn.lower().endswith('.' + ext):
        fn += '.' + ext
    return fn


_BROWSER = {'pw': None, 'br': None, 'ctx': {}, 'page': {}, 'ready': False,
            'err': '', 'fails': 0}


def _b_launch():
    from playwright.sync_api import sync_playwright
    pw = sync_playwright().start()
    try:
        br = pw.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'])
    except Exception:
        # This is the bug that looked like an asyncio conflict. A started sync
        # API that is never stopped leaks, and every later launch in the same
        # process then fails with "It looks like you are using Playwright Sync
        # API inside the asyncio loop" -- a message with nothing to do with
        # asyncio, hiding the real cause underneath. Stop it before giving up.
        try:
            pw.stop()
        except Exception:
            pass
        raise
    _BROWSER['pw'] = pw
    _BROWSER['br'] = br
    _BROWSER['ready'] = True
    return br


def _b_ensure():
    if _BROWSER['ready']:
        return _BROWSER['br']
    if _BROWSER['fails'] >= 3:
        raise RuntimeError(_BROWSER['err'] or 'browser failed to start')
    try:
        return _b_launch()
    except Exception as e:
        # A failure is not permanent. The earlier version latched the first
        # error for the life of the process, so one transient failure --
        # Chromium still installing, a library missing at that instant --
        # disabled the browser until the engine restarted.
        _BROWSER['fails'] += 1
        _BROWSER['err'] = '%s: %s' % (e.__class__.__name__, str(e)[:400])
        raise RuntimeError(_BROWSER['err'])


'''

HELPER_FOOTER = '''

def _main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception as e:
            sys.stdout.write(json.dumps({'ok': False, 'err': 'bad request: %s' % e}) + '\\n')
            sys.stdout.flush()
            continue
        global url
        if d.get('tunnel'):
            url = d['tunnel']
        d.pop('tunnel', None)
        try:
            out = _b_do(**d)
            sys.stdout.write(json.dumps({'ok': True, 'out': _b_redact(str(out))}) + '\\n')
        except Exception as e:
            sys.stdout.write(json.dumps(
                {'ok': False,
                 'err': '%s: %s' % (e.__class__.__name__, str(e)[:600])}) + '\\n')
            sys.stdout.flush()
            if not _BROWSER['ready']:
                # The browser never came up. Exit so the kernel starts a clean
                # process next time rather than retrying inside a state that a
                # failed launch may have left unusable.
                sys.exit(1)
            continue
        sys.stdout.flush()


_main()
'''

KERNEL = '''# ---- browser automation ------------------------------------------------
# Chromium runs in a separate process. Playwright's sync API is bound to the
# thread that started it and refuses to run where an asyncio loop is in play --
# which is the situation inside a notebook kernel, and not one worth depending
# on the details of. The helper owns the browser and speaks one JSON line per
# action; a crash there kills the helper, not the engine.
_B_HELPER = '/kaggle/working/_aether_browser.py'
_B_HELPER_SRC = __HELPER_SRC__
_BPROC = {'p': None}
_BPROC_LOCK = threading.Lock()
_B_HELPER_BUDGET = 1200      # a page action, not an install
_B_RPC_TIMEOUT = 240


def _b_redact(text):
    return re.sub(r'(?i)(password|passwd|pwd|secret|token|otp|cvv)(["\\']?\\s*[:=]\\s*)(\\S+)',
                  r'\\1\\2[redacted]', text or '')


def _b_helper_path():
    # Rewritten whenever its content changes, so a new engine version cannot
    # find itself driving a stale helper left on disk from an old one.
    try:
        want = hashlib.sha256(_B_HELPER_SRC.encode()).hexdigest()
        cur = open(_B_HELPER).read() if os.path.exists(_B_HELPER) else ''
        if hashlib.sha256(cur.encode()).hexdigest() != want:
            open(_B_HELPER, 'w').write(_B_HELPER_SRC)
            os.chmod(_B_HELPER, 0o600)
    except Exception:
        pass
    return _B_HELPER


def _b_spawn():
    p = subprocess.Popen([sys.executable, '-u', _b_helper_path()],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, bufsize=1)
    _BPROC['p'] = p
    return p


def _b_kill(p):
    try:
        p.kill()
    except Exception:
        pass
    if _BPROC['p'] is p:
        _BPROC['p'] = None


def _b_rpc(payload, timeout=_B_RPC_TIMEOUT):
    with _BPROC_LOCK:
        p = _BPROC['p']
        if p is None or p.poll() is not None:
            p = _b_spawn()
        payload['tunnel'] = url
        try:
            p.stdin.write(json.dumps(payload) + '\\n')
            p.stdin.flush()
        except Exception:
            _b_kill(p)
            raise RuntimeError('browser helper is not accepting input')
        # Never block forever on a helper that died part way through.
        import select
        if not select.select([p.stdout], [], [], timeout)[0]:
            _b_kill(p)
            raise RuntimeError('browser action timed out after %ss' % timeout)
        line = p.stdout.readline()
        if not line:
            err = ''
            try:
                err = (p.stderr.read() or '')[-500:]
            except Exception:
                pass
            _b_kill(p)
            raise RuntimeError('browser helper exited' + (': ' + err.strip()[-400:] if err.strip() else ''))
        d = json.loads(line)
        if not d.get('ok'):
            raise RuntimeError(d.get('err') or 'unknown browser error')
        return d.get('out')


# The browser is installed in the background as soon as the engine is up, so
# the first browser action is not a ten-minute download.
_BROWSER_LOCK = threading.Lock()


def _b_prewarm():
    try:
        with _BROWSER_LOCK:
            try:
                import playwright  # noqa: F401
            except Exception:
                subprocess.run(['pip', 'install', '-q', 'playwright'],
                               capture_output=True, timeout=900)
            subprocess.run(['python3', '-m', 'playwright', 'install', 'chromium'],
                           capture_output=True, timeout=1200)
            # Chromium links against system libraries a bare Kaggle image does
            # not ship. Without them the binary starts and dies immediately --
            # Playwright reports "Target page, context or browser has been
            # closed" with no hint that the cause is a missing .so.
            subprocess.run(['python3', '-m', 'playwright', 'install-deps', 'chromium'],
                           capture_output=True, timeout=1200)
    except Exception:
        pass


threading.Thread(target=_b_prewarm, daemon=True).start()


'''

NEW_T_BROWSER_HEAD = '''def t_browser(user_approved=False, **kw):
    # Sensitive external actions need the user's explicit agreement. The tool
    # cannot verify that on its own -- it trusts the flag -- so the model is
    # told in the schema that it may only set it after a real yes, and the
    # refusal path below makes an unapproved credential step stop cold.
    try:
        kw['user_approved'] = bool(user_approved)
        return _b_redact(str(_b_rpc(dict(kw), timeout=_B_HELPER_BUDGET)))'''


def main():
    nb = json.load(open(P))
    s = nb['cells'][4]['source']

    if '_B_HELPER_SRC' in s:
        print('helper process already in place -- nothing to do')
        return

    a = s.index('_BROWSER = {')
    b = s.index('def _b_state_path')
    c = s.index('def t_browser')

    keep = s[b:c]                     # Playwright-touching code, moved verbatim
    helper = HELPER_PREAMBLE + keep + HELPER_FOOTER
    compile(helper, 'browser_helper', 'exec')

    # Replace the old in-process plumbing with the RPC side.
    old_tb_tail_start = s.index('    try:\n        out = _b_call(_b_do,', c)
    old_tb_tail_end = s.index('\n', s.index("return _b_redact(str(out))", old_tb_tail_start))
    # Not %-formatting: KERNEL is full of %s of its own.
    s = (s[:a] + KERNEL.replace('__HELPER_SRC__', repr(helper))
         + NEW_T_BROWSER_HEAD + s[old_tb_tail_end:])

    assert '_b_call' not in s, 'leftover _b_call reference'
    assert '_BQ' not in s, 'leftover _BQ reference'
    nb['cells'][4]['source'] = s
    open(P, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))
    compile(s, 'cell4', 'exec')
    raw = open(P, 'rb').read()
    print('helper program %d bytes' % len(helper))
    print('template %d bytes sha %s (compiles)'
          % (len(raw), hashlib.sha256(raw).hexdigest()))


if __name__ == '__main__':
    main()
