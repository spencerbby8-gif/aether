#!/usr/bin/env python3
"""Shutdown must end the Kaggle run, not just kill the process.

Measured on a live engine: POST /off returned 200, the tunnel went to 530, and
kernels/status still said "running" 50 minutes later -- the GPU session was
still held, and the next push was refused with "Maximum batch GPU session count
of 2 reached". Kaggle ends a run when the last cell RETURNS, and the last cell
is blocked in its keep-alive loop.

This walks the AST rather than matching text, so a comment mentioning os._exit
cannot satisfy it.

Run from the repo root:  python3 scripts/proofs/session-release-check.py
"""
import ast
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, '..', '..', 'android', 'app', 'src', 'main',
                   'assets', 'aether-notebook-template.json')

passed = failed = 0


def chk(what, ok, seen=''):
    global passed, failed
    print('  %s %s   [%s]' % ('ok  ' if ok else 'FAIL', what, seen))
    if ok:
        passed += 1
    else:
        failed += 1


def exits(tree):
    """Every os._exit(...) call site, by line."""
    out = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) \
                and n.func.attr == '_exit':
            out.append(n.lineno)
    return out


def breaks_in(tree, fname):
    for n in ast.walk(tree):
        if isinstance(n, ast.FunctionDef) and n.name == fname:
            return sum(1 for x in ast.walk(n) if isinstance(x, ast.Break))
    return None


def main():
    nb = json.load(open(TPL))
    c4, c5 = nb['cells'][4]['source'], nb['cells'][5]['source']
    t4, t5 = ast.parse(c4), ast.parse(c5)

    print('== the off switch ==')
    chk('_halt does not call os._exit', not exits(t4), 'call sites: %s' % exits(t4))
    chk('_halt raises the shutdown flag', "_HALT['on'] = True" in c4, 'flag set')
    chk('_halt drops the tunnel', "pkill', '-f', 'cloudflared" in c4, 'cloudflared killed')
    chk('the tunnel supervisor stands down on that flag',
        "if _HALT['on']:\n            return" in c4, 'supervisor returns')
    chk('the /off route starts _halt on its own thread',
        'threading.Thread(target=_halt' in c4, 'thread started')

    print('\n== the last cell, which owns the Kaggle run ==')
    chk('cell 5 never calls os._exit', not exits(t5), 'call sites: %s' % exits(t5))
    chk('cell 5 breaks out of its loop on the shutdown flag',
        "_HALT.get('on')" in c5 and 'break' in c5, 'flag watched')
    chk('the idle watchdog breaks instead of killing the process',
        "_reason = 'idle for 60 minutes'" in c5, 'idle -> break')
    chk('cell 5 returns, ending the run and releasing the GPU',
        'NOTEBOOK COMPLETE' in c5, 'final print reached')
    # Shutdown latency: the loop must not sleep a whole minute before noticing.
    # Read the actual time.sleep(...) arguments -- an ast.Constant carries no
    # ctx, so filtering on one silently matches nothing.
    sleeps = [a.value for n in ast.walk(t5) if isinstance(n, ast.Call)
              and isinstance(n.func, ast.Attribute) and n.func.attr == 'sleep'
              for a in n.args if isinstance(a, ast.Constant)
              and isinstance(a.value, (int, float))]
    chk('the loop sleeps at all', bool(sleeps), 'sleep args: %s' % sleeps)
    longest = max(sleeps) if sleeps else 999
    chk('the loop notices a shutdown within seconds, not a 60s tick',
        longest <= 10, 'longest sleep slice %ss' % longest)

    print('\n%d passed, %d failed' % (passed, failed))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
