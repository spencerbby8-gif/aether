#!/usr/bin/env python3
"""Measure engine wake time from the beacon, and wait for all slots to serve.

Wake time is the interval from the push to the first AGENT LIVE LINK, which is
the only externally observable boot milestone. Read from the beacon rather than
assumed, because Kaggle gives no API for "the kernel is now serving".

Usage: wake-audit.py [--since MINUTES] [--wait]
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request

BEACON = "https://ntfy.sh/REMOVED_BEACON_TOPIC/json?poll=1&since=%dm"
LINK_RE = re.compile(
    r"engine=([abcd]) AGENT LIVE LINK: (https://[a-z0-9-]{20,}\.trycloudflare\.com)")
STAGE_RE = re.compile(r"engine=([abcd]) stage: ([^\n]{0,60})")


def fetch(minutes):
    try:
        with urllib.request.urlopen(BEACON % minutes, timeout=30) as r:
            out = []
            for line in r:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line.decode("utf-8", "replace")))
                except Exception:
                    continue
            return out
    except Exception as e:
        print("beacon read failed: %s" % str(e)[:100])
        return []


def health(url, timeout=20):
    try:
        t0 = time.perf_counter()
        with urllib.request.urlopen(url + "/api/ps", timeout=timeout) as r:
            body = r.read()
        return time.perf_counter() - t0, b'"models"' in body and b'"name"' in body
    except Exception:
        return None, False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=30)
    ap.add_argument("--wait", action="store_true")
    a = ap.parse_args()

    msgs = fetch(a.since)
    if not msgs:
        return 2

    # First push-ish stage and first live link per slot.
    first_stage = {}
    first_link = {}
    for d in msgs:
        m = d.get("message", "")
        t = d.get("time", 0)
        sm = STAGE_RE.match(m)
        if sm and sm.group(1) not in first_stage:
            first_stage[sm.group(1)] = (t, sm.group(2))
        lm = LINK_RE.match(m)
        if lm:
            s, u = lm.group(1), lm.group(2)
            if u.startswith("https://api."):
                continue
            if s not in first_link or t < first_link[s][0]:
                first_link[s] = (t, u)

    print("=" * 74)
    print("WAKE AUDIT (from beacon, last %d minutes)" % a.since)
    print("=" * 74)
    for s in "abcd":
        st = first_stage.get(s)
        lk = first_link.get(s)
        if st and lk:
            print("  engine %s: first stage %ds ago -> live link %ds ago  = boot %.0fs"
                  % (s.upper(), int(time.time() - st[0]), int(time.time() - lk[0]),
                     lk[0] - st[0]))
        elif lk:
            print("  engine %s: live link %ds ago (no stage line in window)"
                  % (s.upper(), int(time.time() - lk[0])))
        else:
            print("  engine %s: not announced yet" % s.upper())

    if not a.wait:
        return 0

    print()
    print("waiting for all four to serve...")
    deadline = time.time() + 1500
    live = {}
    while time.time() < deadline:
        msgs = fetch(20)
        cur = {}
        for d in msgs:
            lm = LINK_RE.match(d.get("message", ""))
            if lm and not lm.group(2).startswith("https://api."):
                s, u = lm.group(1), lm.group(2)
                if s not in cur or d.get("time", 0) > cur[s][1]:
                    cur[s] = (u, d.get("time", 0))
        for s, (u, _) in cur.items():
            if s in live:
                continue
            dt, ok = health(u)
            if ok:
                live[s] = u
                print("  engine %s SERVING (%.3fs health) %s" % (s.upper(), dt, u))
        if len(live) == 4:
            break
        time.sleep(20)

    print()
    print("serving: %d of 4" % len(live))
    with open("scripts/perf/output/live-engines.txt", "w") as f:
        for s in sorted(live):
            f.write("%s=%s\n" % (s, live[s]))
    print("wrote scripts/perf/output/live-engines.txt")
    return 0 if len(live) == 4 else 1


if __name__ == "__main__":
    sys.exit(main())
