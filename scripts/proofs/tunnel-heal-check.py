#!/usr/bin/env python3
"""Kill a live engine's tunnel and prove it comes back on its own.

This is the failure that was observed and could not be recovered from: the
tunnel died, the kernel kept running, Kaggle kept reporting it as running, and
every request failed until the engine was re-pushed. The supervisor is supposed
to replace the tunnel and announce the new address.

So: ask the engine to kill its own cloudflared, then wait for a fresh
announcement and check the new address actually serves.

Usage: python3 scripts/proofs/tunnel-heal-check.py <tunnel-url> <slot>
"""
import os
import json
import ssl
import subprocess
import sys
import time
import urllib.request

CTX = ssl.create_default_context()
KEY = os.environ["ENGINE_OFF_KEY"]
TOPIC = os.environ["BEACON_TOPIC"]

passed = failed = 0


def chk(what, ok, seen=''):
    global passed, failed
    print('  %s %s   [%s]' % ('ok  ' if ok else 'FAIL', what, seen))
    if ok:
        passed += 1
    else:
        failed += 1


def kill_tunnel(url):
    """Ask the engine to kill its own cloudflared. The reply is not expected:
    killing the tunnel drops the connection this request arrived on."""
    body = json.dumps({
        'messages': [{'role': 'user', 'content':
                      'Use run_command to run exactly this and nothing else: '
                      'pkill -f cloudflared'}],
        'stream': True, 'tools': ['run_command']}).encode()
    req = urllib.request.Request(url + '/api/chat', data=body, headers={
        'Content-Type': 'application/json', 'X-Engine-Key': KEY})
    try:
        with urllib.request.urlopen(req, timeout=120, context=CTX) as r:
            for _ in r:
                pass
    except Exception as e:
        print('  (connection dropped as expected: %s)' % str(e)[:70])


def new_url(slot, old, wait=420):
    t0 = time.time()
    while time.time() - t0 < wait:
        out = subprocess.run(
            ['curl', '-s', '--max-time', '20',
             'https://ntfy.sh/%s/json?poll=1&since=%d' % (TOPIC, int(t0) - 5)],
            capture_output=True, text=True).stdout
        for line in out.splitlines():
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get('message', '')
            if 'AGENT LIVE LINK:' not in m or ('engine=%s ' % slot) not in m:
                continue
            u = m.split('AGENT LIVE LINK:')[-1].strip().split(' ')[0]
            if u.startswith('http') and u != old:
                return u
        time.sleep(20)
    return None


def serves(url):
    try:
        req = urllib.request.Request(url + '/api/ps',
                                     headers={'X-Engine-Key': KEY})
        with urllib.request.urlopen(req, timeout=40, context=CTX) as r:
            d = json.loads(r.read().decode() or '{}')
        return r.status, len(d.get('models') or [])
    except Exception as e:
        return str(e)[:60], 0


def main():
    url, slot = sys.argv[1], sys.argv[2].lower()
    print('== tunnel self-heal, engine %s ==' % slot.upper())
    print('  current: %s' % url)
    st, n = serves(url)
    chk('the engine is serving before the kill', st == 200 and n >= 1,
        'status=%s models=%d' % (st, n))

    kill_tunnel(url)
    time.sleep(10)
    st, _ = serves(url)
    chk('the old address is dead after the kill', st != 200, 'status=%s' % st)

    fresh = new_url(slot, url)
    chk('a new tunnel address was announced', bool(fresh), str(fresh))
    if fresh:
        st, n = serves(fresh)
        chk('the new address actually serves the engine', st == 200 and n >= 1,
            'status=%s models=%d' % (st, n))
        chk('it is a different address from the dead one', fresh != url, fresh)

    print('\n%d passed, %d failed' % (passed, failed))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
