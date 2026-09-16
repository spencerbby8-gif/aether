#!/usr/bin/env python3
"""Does a client that goes away leave the engine usable?

THE BUG. The final-answer path streamed from Ollama through a curl subprocess
and killed it only after the read loop ended normally. A disconnecting client
made emit() raise, the exception left the loop, the kill was skipped, and the
curl kept reading for its full 1200s timeout. Ollama serves one request at a
time, so that orphan blocked everything behind it.

Measured on the unfixed engine (v25) by breaking out of client reads early:

    req  t_offset   TTFT
      2     61.1s     1.1s
      5     87.8s     0.9s
      6    121.6s    25.7s
      8    283.0s   119.6s
      9    416.7s   125.7s

In the app the same thing happens on the Stop button, a dropped mobile
connection, or the process being backgrounded.

THE TEST. Abandon a request part-way through several times, then measure a
normal request each time. On a fixed engine TTFT stays flat; on the broken one
it climbs without bound.

Usage: python3 scripts/proofs/abandon-stream-check.py <tunnel-url>
"""
import os
import json
import sys
import time
import urllib.request

ROUNDS = 5
ABANDON_AFTER_CHARS = 120


def request(url, prompt, abandon_after=None, timeout=300):
    """Returns (ttft_seconds, chars_read, abandoned)."""
    body = json.dumps({
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
        "options": {"num_ctx": 16384},
    }).encode()
    req = urllib.request.Request(
        url + "/api/chat", data=body,
        headers={"Content-Type": "application/json",
                 "X-Engine-Key": os.environ["ENGINE_OFF_KEY"]})
    t0 = time.time()
    first = None
    n = 0
    abandoned = False
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for line in r:
            if not line.strip():
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            c = (d.get("message") or {}).get("content") or ""
            if c and first is None:
                first = time.time() - t0
            n += len(c)
            if abandon_after is not None and n >= abandon_after:
                abandoned = True
                break          # close the socket without reading the rest
    return first if first is not None else -1.0, n, abandoned


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    url = sys.argv[1].rstrip("/")
    prompt = ("Explain in detail how a lithium-ion battery works, covering the "
              "anode, cathode, electrolyte and degradation. Be thorough.")

    ttfts = []
    print("  round  abandoned-after   then a normal request")
    for i in range(1, ROUNDS + 1):
        try:
            _, n, ab = request(url, prompt, abandon_after=ABANDON_AFTER_CHARS)
        except Exception as e:
            print("  round %d: abandon request failed: %s: %s"
                  % (i, type(e).__name__, str(e)[:70]))
            return 1
        # Give the kernel a moment to notice the socket closed.
        time.sleep(3)
        try:
            ttft, _, _ = request(url, "Say hello in three words.")
        except Exception as e:
            print("  round %d: probe failed: %s: %s" % (i, type(e).__name__, str(e)[:70]))
            return 1
        ttfts.append(ttft)
        print("  %5d  %5d chars %-9s TTFT=%6.1fs"
              % (i, n, "yes" if ab else "no", ttft))

    worst = max(ttfts)
    first = ttfts[0]
    print("\n  first=%.1fs  worst=%.1fs  last=%.1fs" % (first, worst, ttfts[-1]))

    # The broken engine went 1s -> 120s. A fixed one stays within noise of its
    # own first measurement. 30s is generous: it is well above the observed
    # warm-request range and well below the 120s the orphan produced.
    ok = worst < 30.0
    print("  %s  worst TTFT after %d abandoned requests is under 30s"
          % ("PASS" if ok else "FAIL", ROUNDS))
    if not ok:
        print("  -> abandoned generations are still holding the engine")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
