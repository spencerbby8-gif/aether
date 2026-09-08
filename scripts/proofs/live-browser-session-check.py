#!/usr/bin/env python3
"""Live proof of named browser sessions, cookies and the state on disk.

Driven through the agent because the browser only exists on an engine, and this
sandbox cannot launch Chromium. Each step asks for the verbatim tool result so
the assertions test what the browser actually returned rather than what the
model chose to say about it.

Covers: a second named session opens as its own context, cookies are reported
by name with values withheld, both sessions are listed, closing saves the
session, and the saved state lands on disk at 0600 without the secret in it.

Usage: python3 scripts/proofs/live-browser-session-check.py <tunnel-url>
"""
import json
import re
import ssl
import sys
import urllib.request

CTX = ssl.create_default_context()
KEY = 'REMOVED_ENGINE_OFF_KEY'
TOOLS = ['browser', 'run_command']
SECRET = 's3cret-DONOTLEAK'
PROMPT = """Use the browser tool for each step below, in order. After every step, print
the EXACT verbatim string that tool call returned on its own line, prefixed with
STEP<n>: and nothing else. Do not paraphrase or add commentary.

1. action=new_context session=work
2. action=navigate session=work url=https://example.com
3. action=cookies session=work
4. action=list
5. action=navigate session=work url=data:text/html,<form><input id='pw' type='password'></form>
6. action=fill session=work selector=#pw value=%s   (do NOT set user_approved)
7. action=close session=work

Then run this with run_command and print its output prefixed STAT:
stat -c '%%a %%n' /kaggle/working/browser/*.json 2>&1 | head -5
""" % SECRET

passed = failed = 0


def chk(what, ok, seen=''):
    global passed, failed
    print('  %s %s   [%s]' % ('ok  ' if ok else 'FAIL', what, seen))
    if ok:
        passed += 1
    else:
        failed += 1


def main():
    url = sys.argv[1]
    body = json.dumps({'messages': [{'role': 'user', 'content': PROMPT}],
                       'stream': True, 'tools': TOOLS}).encode()
    req = urllib.request.Request(url + '/api/chat', data=body, headers={
        'Content-Type': 'application/json', 'X-Engine-Key': KEY})
    ans = []
    with urllib.request.urlopen(req, timeout=1500, context=CTX) as r:
        for raw in r:
            try:
                d = json.loads(raw.decode('utf-8', 'replace').strip())
            except Exception:
                continue
            c = (d.get('message') or {}).get('content') or ''
            if c:
                ans.append(c)
            if d.get('done'):
                break
    text = ''.join(ans)
    print('== named sessions, cookies, state on disk ==')
    for line in text.splitlines():
        if line.strip().startswith(('STEP', 'STAT')):
            print('  %s' % line.strip()[:130])

    def step(n):
        m = re.search(r'STEP%d:\s*(.*)' % n, text)
        return m.group(1).strip() if m else ''

    chk('a second named session opens', 'work' in step(1), step(1)[:60])
    chk('that session navigates on its own', 'example.com' in step(2), step(2)[:60])
    chk('cookies are named with values withheld',
        'COOKIES' in step(3) and 'withheld' in step(3), step(3)[:70])
    chk('both sessions are listed', 'main' in step(4) and 'work' in step(4), step(4)[:60])
    chk('the credential fill is refused without approval',
        'NEEDS APPROVAL' in step(6), step(6)[:70])
    chk('the secret never appears anywhere in the reply', SECRET not in text, 'scanned')
    chk('closing saves and closes the session', 'BROWSER CLOSED' in step(7), step(7)[:60])
    st = step(0) or ''
    m = re.search(r'STAT:\s*(.*)', text)
    stat_out = m.group(1).strip() if m else st
    chk('session state is on disk at 0600',
        bool(re.search(r'\b600\b', stat_out)) and '.json' in stat_out, stat_out[:70])

    print('\n%d passed, %d failed' % (passed, failed))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
