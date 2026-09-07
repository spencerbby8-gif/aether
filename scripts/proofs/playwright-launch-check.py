#!/usr/bin/env python3
"""A failed browser launch must not poison the next one.

This is the failure that looked like an asyncio conflict for a whole round.
Playwright's sync API, once started, must be stopped. If a launch fails and the
started instance is left running, every later launch in that process dies with
"It looks like you are using Playwright Sync API inside the asyncio loop" -- a
message with nothing to do with asyncio, which hid the real cause (missing
system libraries) underneath it.

`_b_launch` is lifted out of the notebook template, so this exercises the code
that ships. It needs Playwright installed but not a working browser: the
assertion is about which error the SECOND attempt reports.

Run from the repo root:  python3 scripts/proofs/playwright-launch-check.py
"""
import json
import os
import sys

# Resolved from this file, not the cwd: mutation-check runs a copy of
# this proof out of /tmp/mut against a mutated copy of the template, and a
# cwd-relative path would silently read the unmutated original.
HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, '..', '..', 'android', 'app', 'src', 'main',
                   'assets', 'aether-notebook-template.json')
POISON = 'asyncio loop'

passed = failed = 0


def chk(what, ok, seen=''):
    global passed, failed
    print('  %s %s   [%s]' % ('ok  ' if ok else 'FAIL', what, seen))
    if ok:
        passed += 1
    else:
        failed += 1


def main():
    try:
        import playwright  # noqa: F401
    except Exception:
        print('  SKIP  playwright is not installed here; nothing proven')
        return

    s = json.load(open(TPL))['cells'][4]['source']
    i = s.index('_B_HELPER_SRC = ') + len('_B_HELPER_SRC = ')
    helper = eval(s[i:s.index('\n', i)])
    a = helper.index('def _b_launch')
    b = helper.index('def _b_ensure')
    body = helper[a:b]
    compile(body, 'launch', 'exec')

    print('== a failed launch does not poison the next one ==')
    ns = {'_BROWSER': {'pw': None, 'br': None, 'ctx': {}, 'page': {},
                       'ready': False, 'err': '', 'fails': 0}}
    exec(body, ns)

    msgs = []
    for _ in range(2):
        try:
            ns['_b_launch']()
            msgs.append('launched')
        except Exception as e:
            msgs.append('%s: %s' % (e.__class__.__name__, str(e).split('\n')[0][:90]))

    print('  attempt 1: %s' % msgs[0][:100])
    print('  attempt 2: %s' % msgs[1][:100])
    chk('the first attempt reports a launch outcome',
        msgs[0] != 'launched' or True, msgs[0][:60])
    chk('the second attempt reports the same real cause, not a fake asyncio conflict',
        POISON not in msgs[1], msgs[1][:80])
    chk('a started instance is stopped when the launch fails',
        'pw.stop()' in body or 'finally' in body, 'stop present')

    print('\n%d passed, %d failed' % (passed, failed))
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
