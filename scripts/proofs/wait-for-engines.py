#!/usr/bin/env python3
"""Poll ntfy for engine tunnel announcements and print the live URLs.

Usage: python3 scripts/proofs/wait-for-engines.py [how-many]
"""
import json
import subprocess
import sys
import time

TOPIC = 'REMOVED_BEACON_TOPIC'
# Only announcements made after this script started: older ones belong to
# previous engine versions whose quick tunnels are already dead.
SINCE = int(time.time())
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
        if 'AGENT LIVE LINK:' in m:
            slot = m.split('engine=')[-1][:1].upper() if 'engine=' in m else '?'
            live[slot] = m.split('AGENT LIVE LINK:')[-1].strip()
    print('[%4ds] live=%s' % (int(time.time() - t0), sorted(live)), flush=True)
    if len(live) >= int(sys.argv[1] if len(sys.argv) > 1 else 2):
        break
    time.sleep(40)
print('LIVE: ' + json.dumps(live))
