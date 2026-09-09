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
    # Assert the INTENT -- that both agent-layer requests pin num_ctx to the
    # constant -- rather than one exact dict literal. It used to match
    # "'options': {'num_ctx': NUM_CTX}" verbatim, which broke the moment the
    # payload gained a second option, even though the invariant still held.
    n_ctx = c4.count("'num_ctx': NUM_CTX")
    chk('both agent-layer requests pin num_ctx to NUM_CTX', n_ctx == 2,
        '%d of 2 payloads' % n_ctx)
    chk('num_ctx is never hard-coded to a literal in the request payloads',
        "'num_ctx': 16384" not in c4 and "'num_ctx': 8192" not in c4,
        'no literal num_ctx')

    # The output bound added after a degenerate prompt was measured holding
    # Ollama's single slot for 65s on a one-token request.
    m_pred = re.search(r'^NUM_PREDICT\s*=\s*(\d+)', c4, re.M)
    chk('the chat path declares NUM_PREDICT', bool(m_pred),
        m_pred.group(1) if m_pred else 'absent')
    n_pred = c4.count("'num_predict': NUM_PREDICT")
    chk('both agent-layer requests cap their output at NUM_PREDICT', n_pred == 2,
        '%d of 2 payloads' % n_pred)

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
