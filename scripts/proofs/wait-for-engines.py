#!/usr/bin/env python3
"""Wait for engines to announce, then prove each one actually answers.

An announcement is not a live engine. This script used to print LIVE the moment
a beacon message arrived, and it did so for a tunnel that this sandbox could not
even resolve -- the label was wrong and cost a wasted round trip. A beacon says
the kernel booted; only /api/ps answering 200 with a model loaded says the
engine can serve a chat.

So: collect announcements, probe each candidate, and report separately what was
announced and what is genuinely serving. Exits 0 only when the requested number
of engines are actually answering.

Usage: python3 scripts/proofs/wait-for-engines.py [how-many]
"""
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.request

TOPIC = os.environ["BEACON_TOPIC"]
OFF_KEY = os.environ["ENGINE_OFF_KEY"]
CTX = ssl.create_default_context()
# Only announcements made after this script started: older ones belong to
# previous engine versions whose quick tunnels are already dead.
SINCE = int(time.time())


def probe(url):
    """/api/ps status and model count. Never raises."""
    try:
        req = urllib.request.Request(url + '/api/ps',
                                     headers={'X-Engine-Key': OFF_KEY})
        with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
            d = json.loads(r.read().decode() or '{}')
        return r.status, len(d.get('models') or [])
    except Exception as e:
        code = getattr(e, 'code', None)
        return (code if code else -1), 0


def main():
    want = int(sys.argv[1] if len(sys.argv) > 1 else 2)
    announced = {}
    live = {}
    t0 = time.time()
    while time.time() - t0 < 1500:
        url = 'https://ntfy.sh/%s/json?poll=1&since=%d' % (TOPIC, SINCE)
        out = subprocess.run(['curl', '-s', '--max-time', '20', url],
                             capture_output=True, text=True).stdout
        for line in out.splitlines():
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get('message', '')
            if 'AGENT LIVE LINK:' not in m:
                continue
            slot = m.split('engine=')[-1][:1].upper() if 'engine=' in m else '?'
            announced[slot] = m.split('AGENT LIVE LINK:')[-1].strip().split(' ')[0]

        for slot, u in sorted(announced.items()):
            if slot in live:
                continue
            status, models = probe(u)
            if status == 200 and models >= 1:
                live[slot] = u
                print('  %s SERVING  %s  (/api/ps 200, %d model(s))'
                      % (slot, u, models), flush=True)
            else:
                print('  %s announced but not serving yet: /api/ps %s models=%d'
                      % (slot, status, models), flush=True)

        print('[%4ds] announced=%s serving=%s'
              % (int(time.time() - t0), sorted(announced), sorted(live)),
              flush=True)
        if len(live) >= want:
            break
        time.sleep(40)

    print('SERVING: ' + json.dumps(live))
    if len(live) < want:
        print('wanted %d engine(s) serving, %d answered /api/ps' % (want, len(live)))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
