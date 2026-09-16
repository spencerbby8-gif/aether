#!/usr/bin/env python3
"""Decompose the wall clock of one engine request into its real parts.

Ollama returns load_duration, prompt_eval_duration and eval_duration. The
engine also returns total_duration. Wall clock minus total_duration is what the
tunnel, the kernel HTTP layer and the network added. Without splitting these
apart, "the engine is slow" and "our transport is slow" look identical.

Every probe repeats the SAME request so the model state is constant; only the
request itself varies.

Usage: python3 -u scripts/perf/request-anatomy.py <tunnel-url> [repeats]
"""
import os
import json
import ssl
import statistics
import sys
import time
import urllib.request

OFF_KEY = os.environ["ENGINE_OFF_KEY"]
CTX = ssl.create_default_context()
MODEL = "hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS"


def one(base, path, payload, timeout=95):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=body, headers={
        "Content-Type": "application/json", "X-Engine-Key": OFF_KEY})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            raw = r.read().decode("utf-8", "replace")
    except Exception as e:
        return {"error": "%s: %s" % (type(e).__name__, str(e)[:90]),
                "wall": time.time() - t0}
    wall = time.time() - t0
    try:
        d = json.loads(raw)
    except Exception:
        return {"error": "non-json", "wall": wall, "raw": raw[:120]}
    return {
        "wall": wall,
        "load": (d.get("load_duration") or 0) / 1e9,
        "prefill": (d.get("prompt_eval_duration") or 0) / 1e9,
        "prefill_tok": d.get("prompt_eval_count") or 0,
        "decode": (d.get("eval_duration") or 0) / 1e9,
        "decode_tok": d.get("eval_count") or 0,
        "server_total": (d.get("total_duration") or 0) / 1e9,
    }


def report(label, rows):
    good = [r for r in rows if "error" not in r]
    if not good:
        print("%-26s %s" % (label, "ERROR " + rows[0].get("error", "?")))
        return
    def med(k):
        vals = [r[k] for r in good if r.get(k) is not None]
        return statistics.median(vals) if vals else 0.0
    wall, load, pre, dec, tot = (med("wall"), med("load"), med("prefill"),
                                 med("decode"), med("server_total"))
    transport = wall - tot
    accounted = load + pre + dec
    print("%-26s wall=%6.2fs | load=%5.2f prefill=%5.2f decode=%5.2f | "
          "server_total=%6.2f | TRANSPORT=%5.2f | unaccounted-in-server=%5.2f"
          % (label, wall, load, pre, dec, tot, transport, tot - accounted))
    walls = sorted(r["wall"] for r in good)
    print("%-26s wall min=%.2f med=%.2f max=%.2f  (spread %.2fs across %d identical requests)"
          % ("", walls[0], walls[len(walls) // 2], walls[-1], walls[-1] - walls[0], len(walls)))


def main():
    if len(sys.argv) < 2:
        print("usage: request-anatomy.py <tunnel-url> [repeats]")
        return 2
    base = sys.argv[1].rstrip("/")
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 5

    print("REQUEST ANATOMY against %s" % base)
    print("-" * 112)

    # Same exact request repeated: isolates variance from anything content-driven.
    rows = []
    for i in range(n):
        rows.append(one(base, "/api/generate", {
            "model": MODEL, "prompt": "Say OK.", "stream": False,
            "options": {"num_predict": 8, "temperature": 0},
            "keep_alive": -1}))
        time.sleep(0.5)
    report("identical x%d (tiny)" % n, rows)

    # A realistic answer length.
    rows = []
    for i in range(n):
        rows.append(one(base, "/api/generate", {
            "model": MODEL,
            "prompt": "Explain in three sentences why streaming matters in a chat app.",
            "stream": False,
            "options": {"num_predict": 96, "temperature": 0},
            "keep_alive": -1}))
    report("identical x%d (96 tok)" % n, rows)

    # How expensive is the health probe the UI polls?
    ps_rows = []
    for i in range(n):
        t0 = time.time()
        try:
            with urllib.request.urlopen(base + "/api/ps", timeout=30, context=CTX) as r:
                r.read()
            ps_rows.append({"wall": time.time() - t0, "load": 0, "prefill": 0,
                            "decode": 0, "server_total": 0})
        except Exception as e:
            ps_rows.append({"error": str(e)[:60], "wall": time.time() - t0})
    good = [r for r in ps_rows if "error" not in r]
    if good:
        w = sorted(r["wall"] for r in good)
        print("%-26s wall min=%.3f med=%.3f max=%.3f  (this is the UI's poll cost)"
              % ("GET /api/ps", w[0], w[len(w) // 2], w[-1]))
    print("-" * 112)
    return 0


if __name__ == "__main__":
    sys.exit(main())
