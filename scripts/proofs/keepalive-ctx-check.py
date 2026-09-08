#!/usr/bin/env python3
"""The keep-alive ping must ask for the same context the chat path uses.

If they differ, Ollama reloads the model on every 60-second tick and drops the
KV cache, so the next real turn pays ~11s of reload plus a cold prefill that
measured 23.09s against 5.09s warm. This asserts the two agree, on the shipped
template, and prints both values.

Run from the repo root:  python3 scripts/proofs/keepalive-ctx-check.py
"""
import json
import os
import re
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


def main():
    nb = json.load(open(TPL))
    c4, c5 = nb['cells'][4]['source'], nb['cells'][5]['source']

    m = re.search(r'^NUM_CTX\s*=\s*(\d+)', c4, re.M)
    chk('the chat path declares NUM_CTX', bool(m), m.group(1) if m else 'absent')
    num_ctx = int(m.group(1)) if m else None

    # What the chat request actually sends.
    chk('the chat request sends options.num_ctx = NUM_CTX',
        "'options': {'num_ctx': NUM_CTX}" in c4, 'found in the payload')

    ping = re.search(r"'prompt': 'ping'.*?'options':\s*\{([^}]*)\}", c5)
    chk('the keep-alive ping sends an options block', bool(ping),
        ping.group(1).strip() if ping else 'absent')
    if ping:
        blk = ping.group(1)
        chk('the ping pins num_ctx', "'num_ctx'" in blk, blk.strip())
        chk('the ping resolves num_ctx to NUM_CTX, not a literal that can drift',
            "globals().get('NUM_CTX'" in blk, blk.strip())
        # Simulate the resolution with NUM_CTX present and absent.
        for env, expect in (({'NUM_CTX': num_ctx}, num_ctx), ({}, 16384)):
            got = eval('{' + blk + '}', dict(env))['num_ctx']
            chk('ping num_ctx resolves to %s when NUM_CTX=%s'
                % (expect, env.get('NUM_CTX')), got == expect, str(got))

    print('\n%d passed, %d failed' % (passed, failed))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
