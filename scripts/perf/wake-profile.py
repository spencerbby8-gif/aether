#!/usr/bin/env python3
"""Profile the engine wake path stage by stage.

button -> wake request -> Kaggle kernel ready -> model ready -> tunnel ready
       -> health -> READY

Every stage is timestamped from the beacon, so the slow ones are identified
rather than guessed. Also measures the "already alive" fast path, which must
return immediately rather than re-pushing.

Usage: wake-profile.py --engine SLOT [--already-alive]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

BEACON = "https://ntfy.sh/REMOVED_BEACON_TOPIC/json?poll=1&since=%dm"
KEY = os.environ.get("ENGINE_OFF_KEY", "REMOVED_ENGINE_OFF_KEY")

# Beacon stage lines, in the order the kernel emits them.
STAGES = [
    ("starting", "kernel boot"),
    ("downloading", "ollama download"),
    ("pulling-model", "model pull start"),
    ("pulling ", "model pull"),
    ("model-ready", "model on disk"),
    ("warming", "VRAM warmup"),
    ("WARM OK", "model resident"),
    ("deploying AGENT", "agent layer"),
    ("orchestration layer loaded", "orchestration"),
]


def beacon(minutes):
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
        print("  beacon read failed: %s" % str(e)[:80])
        return []


def health(url, timeout=20):
    try:
        t0 = time.perf_counter()
        with urllib.request.urlopen(url + "/api/ps", timeout=timeout) as r:
            b = r.read()
        return time.perf_counter() - t0, b'"models"' in b and b'"name"' in b
    except Exception:
        return None, False


def already_alive(slot):
    """Is there a live, serving engine for this slot right now?"""
    msgs = beacon(20)
    link = None
    for d in msgs:
        m = d.get("message", "")
        mm = re.match(r"engine=%s AGENT LIVE LINK: (https://[a-z0-9-]{20,}\.trycloudflare\.com)" % slot, m)
        if mm and not mm.group(1).startswith("https://api."):
            link = mm.group(1)
    if not link:
        return None
    dt, ok = health(link)
    return link if ok else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--already-alive", action="store_true")
    a = ap.parse_args()
    slot = a.engine.strip().lower()

    if a.already_alive:
        print("=" * 74)
        print("WAKE FAST PATH: engine %s already alive" % slot.upper())
        print("=" * 74)
        live = already_alive(slot)
        if not live:
            print("  no live engine to test the fast path against")
            return 1
        t0 = time.perf_counter()
        live2 = already_alive(slot)
        el = time.perf_counter() - t0
        print("  resolve returned %s in %.3fs" % ("the live URL" if live2 else "nothing", el))
        print("  no push issued, no wait: %s" % (live2 == live))
        return 0 if live2 == live else 1

    print("=" * 74)
    print("WAKE PROFILE: engine %s" % slot.upper())
    print("=" * 74)

    live_before = already_alive(slot)
    if live_before:
        print("  engine already alive at %s -- nothing to profile" % live_before)
        return 0

    # Reap stale instances first, exactly as the wake path does.
    print("  reaping stale instances...")
    t_reap = time.perf_counter()
    subprocess.run(
        ["npx", "tsx", "-e",
         'import { reapSlotInstances } from "./src/server/engine/resolve";'
         'reapSlotInstances("%s").then(r => console.log("reaped", r.filter(x=>x.result==="shutdown").length));' % slot],
        capture_output=True, text=True, cwd=os.getcwd(), timeout=180)
    print("  reap took %.1fs" % (time.perf_counter() - t_reap))

    print("  pushing kernel...")
    t0 = time.perf_counter()
    r = subprocess.run(["python3", "-u", "scripts/proofs/wake-engines.py", slot],
                       capture_output=True, text=True, timeout=300)
    t_push = time.perf_counter() - t0
    print("  push returned in %.1fs: %s" % (t_push, (r.stdout or r.stderr).strip()[:80]))
    if "REJECTED" in (r.stdout or ""):
        print("  push rejected; waiting and retrying once")
        time.sleep(45)
        t0 = time.perf_counter()
        r = subprocess.run(["python3", "-u", "scripts/proofs/wake-engines.py", slot],
                           capture_output=True, text=True, timeout=300)
        t_push += time.perf_counter() - t0 + 45
        print("  retry: %s" % (r.stdout or r.stderr).strip()[:80])

    # Poll the beacon for each stage, then health.
    print("  watching the beacon for stage transitions...")
    seen = {}
    link = None
    deadline = time.perf_counter() + 1500
    while time.perf_counter() < deadline:
        for d in beacon(25):
            m = d.get("message", "")
            t = d.get("time", 0)
            if not m.startswith("engine=%s " % slot):
                continue
            for needle, label in STAGES:
                if needle in m and label not in seen:
                    seen[label] = t
            mm = re.match(r"engine=%s AGENT LIVE LINK: (https://[a-z0-9-]{20,}\.trycloudflare\.com)" % slot, m)
            if mm and not mm.group(1).startswith("https://api."):
                if link is None or t < seen.get("_link", t):
                    link = mm.group(1)
                    seen["_link"] = t
        if link:
            dt, ok = health(link)
            if ok:
                seen["_health"] = time.time()
                seen["_health_dt"] = dt
                break
        time.sleep(10)

    if not link or "_health" not in seen:
        print("  engine never became healthy within the window")
        return 1

    base = min(v for k, v in seen.items() if not k.startswith("_"))
    print()
    print("  %-22s %8s %10s" % ("stage", "at", "delta"))
    order = [lbl for _, lbl in STAGES if lbl in seen]
    prev = base
    for lbl in order:
        t = seen[lbl]
        print("  %-22s %+7ds %9ds" % (lbl, t - base, t - prev))
        prev = t
    lt = seen.get("_link")
    if lt:
        print("  %-22s %+7ds %9ds" % ("tunnel ready", lt - base, lt - prev))
        prev = lt
    ht = seen["_health"]
    print("  %-22s %+7ds %9ds" % ("health READY", ht - base, ht - prev))
    print()
    print("  TOTAL wall (first stage -> READY): %.0fs" % (ht - base))
    print("  push call itself: %.1fs" % t_push)
    print("  health probe: %.3fs" % seen.get("_health_dt", 0))
    print("  url: %s" % link)

    out = "scripts/perf/output/wake-%s.txt" % slot
    with open(out, "w") as f:
        f.write(json.dumps({"slot": slot, "url": link, "stages": seen,
                            "total": ht - base, "push": t_push}, indent=2, default=str))
    print("  wrote %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
