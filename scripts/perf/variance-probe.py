#!/usr/bin/env python3
"""Where does the variance come from?

Five identical requests to the same idle engine were measured at 1.39 s and
13.19 s wall clock. server_total did not move, so the model was not the cause.
This logs every request individually with the full Ollama breakdown so the
stall can be attributed instead of guessed at:

  load_duration      > 0   -> the model was (re)loaded into VRAM for this call
  wall - server_total       -> tunnel + kernel HTTP + network
  wall >> server_total with load ~ 0 -> the request QUEUED behind another one

Requests are spaced evenly so a periodic stall (a keep-alive ping, a tunnel
supervisor tick) shows up as a pattern in the timestamps.

Usage: python3 -u scripts/perf/variance-probe.py <tunnel-url> [count] [gap_s]
"""
import json
import ssl
import statistics
import sys
import time
import urllib.request

OFF_KEY = "REMOVED_ENGINE_OFF_KEY"
CTX = ssl.create_default_context()
MODEL = "hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS"


def gen(base, prompt, num_predict, timeout=120):
    body = json.dumps({
        "model": MODEL, "prompt": prompt, "stream": False,
        "options": {"num_predict": num_predict, "temperature": 0},
        "keep_alive": -1}).encode()
    req = urllib.request.Request(base + "/api/generate", data=body, headers={
        "Content-Type": "application/json", "X-Engine-Key": OFF_KEY})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        d = json.loads(r.read().decode("utf-8", "replace"))
    wall = time.time() - t0
    return {
        "wall": wall,
        "load": (d.get("load_duration") or 0) / 1e9,
        "prefill": (d.get("prompt_eval_duration") or 0) / 1e9,
        "decode": (d.get("eval_duration") or 0) / 1e9,
        "total": (d.get("total_duration") or 0) / 1e9,
        "ev": d.get("eval_count") or 0,
    }


def main():
    if len(sys.argv) < 2:
        print("usage: variance-probe.py <tunnel-url> [count] [gap_s]")
        return 2
    base = sys.argv[1].rstrip("/")
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 12
    gap = float(sys.argv[3]) if len(sys.argv) > 3 else 4.0

    print("VARIANCE PROBE  %d identical requests, %.1fs apart  ->  %s" % (n, gap, base))
    print("  %-4s %8s %8s %8s %8s %8s %9s %9s" % (
        "#", "t+sec", "wall", "load", "prefill", "decode", "srv_total", "wall-srv"))
    print("  " + "-" * 76)
    rows = []
    t_start = time.time()
    for i in range(n):
        target = t_start + i * gap
        wait = target - time.time()
        if wait > 0:
            time.sleep(wait)
        try:
            r = gen(base, "Say OK.", 8)
        except Exception as e:
            print("  %-4d ERROR %s" % (i + 1, str(e)[:70]))
            continue
        rows.append(r)
        print("  %-4d %8.1f %8.2f %8.2f %8.2f %8.2f %9.2f %9.2f %s" % (
            i + 1, time.time() - t_start, r["wall"], r["load"], r["prefill"],
            r["decode"], r["total"], r["wall"] - r["total"],
            "<-- RELOAD" if r["load"] > 1 else ""))
        sys.stdout.flush()

    if rows:
        w = sorted(r["wall"] for r in rows)
        loads = [r for r in rows if r["load"] > 1]
        print("  " + "-" * 76)
        print("  wall   min=%.2f  median=%.2f  max=%.2f   (spread %.2fs)" % (
            w[0], w[len(w) // 2], w[-1], w[-1] - w[0]))
        print("  requests that reloaded the model into VRAM: %d / %d" % (len(loads), len(rows)))
        if loads:
            print("  reload cost: %s" % ", ".join("%.1fs" % r["load"] for r in loads))
        queued = [r for r in rows if r["load"] <= 1 and (r["wall"] - r["total"]) > 1]
        print("  requests that queued (no reload, but wall-srv_total > 1s): %d" % len(queued))
        if queued:
            print("  queue stall: %s" % ", ".join("%.1fs" % (r["wall"] - r["total"]) for r in queued))
        clean = [r for r in rows if r["load"] <= 1 and (r["wall"] - r["total"]) <= 1]
        if clean:
            print("  clean requests: %d, median wall %.2fs" % (
                len(clean), statistics.median(r["wall"] for r in clean)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
