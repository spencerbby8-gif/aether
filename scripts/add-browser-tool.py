"""Insert the browser automation tool into the kernel template.

Run from the repo root:  python3 scripts/add-browser-tool.py
"""
import hashlib
import json

P = 'android/app/src/main/assets/aether-notebook-template.json'

TOOL_SCHEMA = (" {'type':'function','function':{'name':'browser','description':'Drive a real "
               "headless browser: open sites, navigate, click, type, fill forms, select options, "
               "upload files, read pages, screenshot, and keep signed-in sessions across calls. "
               "Set user_approved=true ONLY after the user has explicitly agreed in the "
               "conversation to that specific external action. Never use it to bypass CAPTCHA, "
               "MFA or anti-bot protection.','parameters':{'type':'object','properties':{"
               "'action':{'type':'string','enum':['navigate','click','type','fill','select',"
               "'read','screenshot','wait','back','upload','new_context','close','list','cookies']},"
               "'url':{'type':'string'},'selector':{'type':'string','description':'CSS selector'},"
               "'text':{'type':'string'},'value':{'type':'string'},"
               "'session':{'type':'string','description':'named session, default \\\"main\\\"'},"
               "'path':{'type':'string','description':'local file to upload'},"
               "'timeout':{'type':'integer'},'user_approved':{'type':'boolean'}},"
               "'required':['action']}}},")

BROWSER_CODE = r'''
# ============ BROWSER AUTOMATION ============
# A real headless Chromium driven through Playwright. Sessions persist to disk
# so a task can be picked up after the engine restarts, and nothing that looks
# like a credential is ever returned to the model or written to a log.
BROWSER_DIR = '/kaggle/working/browser'
_BROWSER = {'pw': None, 'br': None, 'ctx': {}, 'page': {}, 'ready': False, 'err': ''}
# Playwright's sync API is bound to the thread that started it, and tools now
# run in a pool. Every action therefore goes through one dedicated worker.
_BQ = queue.Queue()


def _b_worker():
    while True:
        fn, args, kw, out = _BQ.get()
        try:
            out.append(('ok', fn(*args, **kw)))
        except Exception as e:
            out.append(('err', '%s: %s' % (e.__class__.__name__, str(e)[:400])))
        finally:
            _BQ.task_done()


threading.Thread(target=_b_worker, daemon=True).start()


def _b_call(fn, *a, **k):
    out = []
    _BQ.put((fn, a, k, out))
    while not out:
        time.sleep(0.02)
    kind, val = out[0]
    if kind == 'err':
        raise RuntimeError(val)
    return val


def _b_ensure():
    if _BROWSER['ready']:
        return _BROWSER['br']
    if _BROWSER['err']:
        raise RuntimeError(_BROWSER['err'])
    try:
        import playwright  # noqa: F401
    except Exception:
        subprocess.run(['pip', 'install', '-q', 'playwright'],
                       capture_output=True, timeout=900)
        subprocess.run(['python3', '-m', 'playwright', 'install', 'chromium'],
                       capture_output=True, timeout=1200)
    from playwright.sync_api import sync_playwright
    _BROWSER['pw'] = sync_playwright().start()
    _BROWSER['br'] = _BROWSER['pw'].chromium.launch(
        headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    _BROWSER['ready'] = True
    os.makedirs(BROWSER_DIR, exist_ok=True)
    return _BROWSER['br']


def _b_state_path(session):
    return BROWSER_DIR + '/' + re.sub(r'[^A-Za-z0-9_.-]', '_', str(session or 'main'))[:40] + '.json'


def _b_page(session):
    br = _b_ensure()
    s = str(session or 'main')
    if s not in _BROWSER['ctx']:
        sp = _b_state_path(s)
        kw = {}
        # A saved session is what lets a task continue after a restart. It is
        # stored 0600 and its contents are never returned to the model.
        if os.path.exists(sp):
            kw['storage_state'] = sp
        _BROWSER['ctx'][s] = br.new_context(**kw)
        _BROWSER['page'][s] = _BROWSER['ctx'][s].new_page()
    return _BROWSER['ctx'][s], _BROWSER['page'][s]


def _b_save(session):
    try:
        sp = _b_state_path(session)
        _BROWSER['ctx'][str(session or 'main')].storage_state(path=sp)
        try:
            os.chmod(sp, 0o600)
        except Exception:
            pass
    except Exception:
        pass


# Anything matching these is a credential. Values are never returned.
_SECRET_SEL = ('input[type=password]', 'input[name*=pass]', 'input[name*=pwd]',
               'input[name*=secret]', 'input[name*=token]', 'input[name*=otp]',
               'input[name*=cvv]', 'input[autocomplete*=password]')


def _b_is_secret(sel):
    s = (sel or '').lower()
    return any(h in s for h in ('password', 'passwd', 'pwd', 'secret', 'token',
                                'otp', 'cvv', 'card'))


def _b_redact(text):
    return re.sub(r'(?i)(password|passwd|pwd|secret|token|otp|cvv)(["\']?\s*[:=]\s*)(\S+)',
                  r'\1\2[redacted]', text or '')


def _b_do(action='navigate', url=None, selector=None, text=None, value=None,
          session=None, path=None, timeout=30, user_approved=False, **kw):
    session = str(session or 'main')
    to = min(max(int(timeout or 30), 1), 120) * 1000

    if action == 'new_context':
        _b_page(session)
        return 'BROWSER READY session=%s' % session

    if action == 'list':
        return 'BROWSER SESSIONS: ' + (', '.join(sorted(_BROWSER['page'])) or 'none open')

    if action == 'close':
        if session in _BROWSER['ctx']:
            _b_save(session)
            _BROWSER['ctx'][session].close()
            _BROWSER['ctx'].pop(session, None)
            _BROWSER['page'].pop(session, None)
        return 'BROWSER CLOSED session=%s (session saved)' % session

    if action == 'cookies':
        # Names only. Cookie values are credentials and never leave the host.
        ck = _b_page(session)[0].cookies()
        return ('COOKIES session=%s count=%d names=%s (values withheld)'
                % (session, len(ck), ', '.join(c.get('name', '') for c in ck)[:600]))

    ctx, page = _b_page(session)

    if action == 'navigate':
        if not url:
            return 'browser: navigate needs a url'
        page.goto(url, timeout=to, wait_until='domcontentloaded')
        _b_save(session)
        return 'NAVIGATED %s | title=%s' % (page.url[:300], (page.title() or '')[:160])

    if action == 'back':
        page.go_back(timeout=to)
        return 'NAVIGATED BACK | now %s' % page.url[:300]

    if action == 'wait':
        if selector:
            page.wait_for_selector(selector, timeout=to)
            return 'WAITED for %s' % selector
        page.wait_for_timeout(min(int(value or 1000), 10000))
        return 'WAITED %sms' % value

    if action == 'click':
        if not selector:
            return 'browser: click needs a selector'
        # Anti-bot gates are reported, never worked around.
        low = (page.content() or '')[:20000].lower()
        if 'captcha' in low or 'g-recaptcha' in low or 'hcaptcha' in low:
            return ('BLOCKED: this page presents a CAPTCHA. I will not attempt to '
                    'solve or bypass it. Tell the user this step needs them.')
        page.click(selector, timeout=to)
        page.wait_for_load_state('domcontentloaded', timeout=to)
        _b_save(session)
        return 'CLICKED %s | now %s' % (selector, page.url[:300])

    if action in ('type', 'fill'):
        if not selector:
            return 'browser: %s needs a selector' % action
        if _b_is_secret(selector):
            if not user_approved:
                return ('NEEDS APPROVAL: %s targets a credential field. Ask the user '
                        'to confirm this exact step first; the value is never shown.'
                        % selector)
        if action == 'type':
            page.type(selector, value or text or '', timeout=to)
        else:
            page.fill(selector, value or text or '', timeout=to)
        # The value is not echoed back: it may be a password or a token.
        return '%s into %s (%d chars, value withheld)' % (
            action.upper(), selector, len(value or text or ''))

    if action == 'select':
        if not selector:
            return 'browser: select needs a selector'
        page.select_option(selector, value or text or '', timeout=to)
        return 'SELECTED %r in %s' % (value or text, selector)

    if action == 'upload':
        if not selector or not path:
            return 'browser: upload needs a selector and a path'
        if not os.path.exists(path):
            return 'browser: no such file to upload: %s' % path
        page.set_input_files(selector, path, timeout=to)
        return 'UPLOADED %s (%d bytes) into %s' % (path, os.path.getsize(path), selector)

    if action == 'read':
        body = _readable(page.content() or '')
        # Never let a value that was typed into a secret field come back.
        body = _b_redact(body)
        return 'PAGE %s | title=%s\n%s' % (page.url[:200], (page.title() or '')[:160],
                                           body[:9000])

    if action == 'screenshot':
        name = _safe_name(text or ('shot_%d' % int(time.time())), 'png')
        p = GEN_DIR + '/' + name
        os.makedirs(GEN_DIR, exist_ok=True)
        page.screenshot(path=p, full_page=bool(kw.get('full')))
        n = os.path.getsize(p)
        if not url:
            return 'SCREENSHOT SAVED but tunnel url unknown yet: %s (%d bytes)' % (name, n)
        return 'IMAGE READY: ' + url + '/files/' + name + ' (%d bytes)' % n

    return 'browser: unknown action %r' % action


def t_browser(user_approved=False, **kw):
    # Sensitive external actions need the user's explicit agreement. The tool
    # cannot verify that on its own -- it trusts the flag -- so the model is
    # told in the schema that it may only set it after a real yes, and the
    # refusal path below makes an unapproved credential step stop cold.
    try:
        out = _b_call(_b_do, user_approved=bool(user_approved), **kw)
        return _b_redact(str(out))
    except Exception as e:
        msg = str(e)
        if 'Executable doesn' in msg or 'playwright' in msg.lower():
            return ('browser unavailable: the headless browser is not installed on this '
                    'engine yet (%s). Ask the user to retry in a minute.' % msg[:200])
        return 'browser error: ' + msg[:400]

'''


def main():
    nb = json.load(open(P))
    s = nb['cells'][4]['source']

    if 'def t_browser' in s:
        print('browser tool already present -- nothing to do')
        return

    # 1. schema, appended to TOOLS
    anchor = " {'type':'function','function':{'name':'generate_voice'"
    i = s.index(anchor)
    j = s.index('\n]', i)
    # The last entry in TOOLS carries no trailing comma, so one has to be added
    # before appending or the list stops parsing.
    tail = s[:j].rstrip()
    if not tail.endswith(','):
        tail += ','
    s = tail + '\n' + TOOL_SCHEMA.rstrip().rstrip(',') + s[j:]

    # 2. implementation, just before the EXEC dispatch table
    k = s.index('EXEC = {')
    s = s[:k] + BROWSER_CODE + '\n' + s[k:]

    # 3. dispatch entry
    old = "'generate_voice': t_generate_voice}"
    assert s.count(old) == 1, s.count(old)
    s = s.replace(old, "'generate_voice': t_generate_voice, 'browser': t_browser}")

    nb['cells'][4]['source'] = s
    open(P, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))
    b = open(P, 'rb').read()
    print('template %d bytes sha %s' % (len(b), hashlib.sha256(b).hexdigest()))


if __name__ == '__main__':
    main()
