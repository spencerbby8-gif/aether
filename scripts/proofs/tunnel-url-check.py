#!/usr/bin/env python3
"""The tunnel URL scan, and why the log has to be truncated on restart.

A quick tunnel dies on its own; the kernel now replaces it. The subtle part is
the log: it still holds the address of the tunnel that just died, so a restart
that appends to the same file would scan the old URL and announce a dead
address as the new one -- the exact failure the supervisor exists to fix.

_read_tunnel_url is lifted from the template, so this tests the shipped parser.

Run from the repo root:  python3 scripts/proofs/tunnel-url-check.py
"""
import json
import os
import sys
import tempfile

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
    s = json.load(open(TPL))['cells'][4]['source']
    i = s.index('def _read_tunnel_url')
    j = s.index('def _start_tunnel')
    body = s[i:j]
    compile(body, 'scan', 'exec')
    import re as _re
    # The lifted default argument evaluates TUNNEL_LOG at exec time.
    ns = {'re': _re, 'TUNNEL_LOG': '/tmp/does-not-matter.log'}
    exec(body, ns)
    scan = ns['_read_tunnel_url']

    d = tempfile.mkdtemp(prefix='aether-tunnel-')
    log = os.path.join(d, 'tunnel.log')

    print('== the tunnel URL scan ==')
    open(log, 'w').write(
        '2024-01-01T00:00:00Z INF +----------------------------+\n'
        '2024-01-01T00:00:01Z INF Your quick Tunnel has been created! '
        'Visit it at\n'
        'https://fresh-engine-live.trycloudflare.com\n')
    chk('a live tunnel URL is found in real cloudflared output',
        scan(log) == 'https://fresh-engine-live.trycloudflare.com', str(scan(log)))

    open(log, 'w').write('')
    chk('an empty log yields nothing', scan(log) is None, str(scan(log)))

    chk('a missing log yields nothing rather than raising',
        scan(os.path.join(d, 'nope.log')) is None, 'None')

    # The hazard the truncation prevents: an untruncated log still carries the
    # dead address, and the first match wins.
    open(log, 'w').write('https://dead-tunnel-gone.trycloudflare.com\n'
                         'https://fresh-engine-live.trycloudflare.com\n')
    chk('an untruncated log returns the DEAD address first',
        scan(log) == 'https://dead-tunnel-gone.trycloudflare.com', str(scan(log)))

    # So the restart must truncate. Asserted on the source because the function
    # itself needs a real cloudflared binary to run.
    k = s.index('def _start_tunnel')
    fn = s[k:s.index('def _tunnel_supervisor')]
    trunc = fn.index("open(TUNNEL_LOG, 'w').close()")
    spawn = fn.index('subprocess.Popen')
    chk('_start_tunnel truncates the log before starting cloudflared',
        0 <= trunc < spawn, 'truncate at %d, spawn at %d' % (trunc, spawn))

    print('\n%d passed, %d failed' % (passed, failed))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
