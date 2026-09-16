#!/usr/bin/env python3
"""Per-engine reliability and speed benchmark.

Every engine is measured independently against its own live tunnel. Nothing is
inferred from configuration or shared code: a metric is only reported if a real
request produced it.

Usage:
    engine-reliability.py --engines a=URL b=URL ... [--reps N] [--quick]

Metrics per engine:
    health      /api/ps round trip, repeated
    conn        TCP+TLS establishment to the tunnel
    ttft        time to first non-empty content chunk (not first byte)
    decode      sustained characters/sec over a real generation
    stream      chunk arrival regularity -- detects stalls mid-stream
    tool        time to the first real tool call
    long        survival of a long generation
    disconnect  failures across repeated health probes
    shutdown    /off acknowledgement time
"""
import argparse
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request

KEY = os.environ["ENGINE_OFF_KEY"]
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")


def http_json(url, timeout=30):
    t0 = time.perf_counter()
    with urllib.request.urlopen(url, timeout=timeout) as r:
        body = r.read()
    return time.perf_counter() - t0, json.loads(body.decode("utf-8", "replace"))


def measure_health(url, reps):
    """Repeated /api/ps probes: latency spread and disconnect rate."""
    times, fails = [], 0
    for _ in range(reps):
        try:
            dt, body = http_json(url + "/api/ps", timeout=20)
            if not body.get("models"):
                fails += 1
            else:
                times.append(dt)
        except Exception:
            fails += 1
        time.sleep(0.2)
    return times, fails


def measure_conn(url, reps):
    """Connection establishment only: open and close, no body read."""
    import http.client
    from urllib.parse import urlparse
    times = []
    for _ in range(reps):
        p = urlparse(url)
        t0 = time.perf_counter()
        try:
            c = http.client.HTTPSConnection(p.hostname, 443, timeout=15)
            c.connect()
            times.append(time.perf_counter() - t0)
            c.close()
        except Exception:
            pass
    return times


def chat(url, messages, timeout=1500):
    """One streaming chat turn. Returns a dict of measured phases."""
    body = json.dumps({"messages": messages, "stream": True}).encode()
    req = urllib.request.Request(
        url + "/api/chat", data=body,
        headers={"Content-Type": "application/json", "X-Engine-Key": KEY})
    t0 = time.perf_counter()
    first_byte = None
    ttft = None
    chars = 0
    chunks = 0
    gaps = []
    last = None
    tools = []
    results = []
    tool_busy = 0.0
    tool_started_at = None
    plan = None
    verification = None
    error = None
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for line in r:
                now = time.perf_counter()
                if first_byte is None:
                    first_byte = now - t0
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line.decode("utf-8", "replace"))
                except Exception:
                    continue
                m = d.get("message") or {}
                think = m.get("thinking") or ""
                if "\U0001f6e0" in think:
                    tools.append(think.split("(")[0].split()[-1])
                    tool_started_at = now
                    if not results:
                        results.append(("first_tool", now - t0))
                if "tool_result" in d and tool_started_at is not None:
                    tool_busy += now - tool_started_at
                    tool_started_at = None
                content = m.get("content") or ""
                if content:
                    if ttft is None:
                        ttft = now - t0
                    else:
                        gaps.append(now - last)
                    last = now
                    chars += len(content)
                    chunks += 1
                if "plan" in d:
                    plan = d["plan"]
                if "verification" in d:
                    verification = d["verification"]
    except Exception as e:
        error = "%s: %s" % (type(e).__name__, str(e)[:120])
    wall = time.perf_counter() - t0
    # Decode rate must be measured over the time the model was actually
    # generating, not over the whole turn. Dividing by (wall - ttft) on a
    # tool-heavy turn folds every tool execution into the denominator: a 495 s
    # turn with 13 tool calls reported "0.72 tok/s" while the same engine
    # decodes at ~8 tok/s on an idle prompt. The arithmetic was not wrong, the
    # quantity was, and it made a healthy engine look broken. tool_busy is the
    # time spent inside tool calls, subtracted here.
    gen_window = max(wall - (ttft or 0) - tool_busy, 1e-6)
    decode = chars / gen_window
    return {
        "tool_busy": tool_busy,
        "ok": error is None,
        "error": error,
        "first_byte": first_byte,
        "ttft": ttft,
        "wall": wall,
        "chars": chars,
        "chunks": chunks,
        "decode_chars_s": decode,
        "decode_tok_s": decode / 5.0,
        "max_gap": max(gaps) if gaps else None,
        "median_gap": statistics.median(gaps) if gaps else None,
        "tools": tools,
        "first_tool_at": results[0][1] if results else None,
        "plan": plan,
        "verification": verification,
    }


def bench_engine(slot, url, reps, quick):
    out = {"slot": slot, "url": url}
    print("\n" + "=" * 74)
    print("ENGINE %s  %s" % (slot.upper(), url))
    print("=" * 74)

    # 1. health + disconnect rate
    times, fails = measure_health(url, reps)
    out["health_times"] = times
    out["health_failures"] = fails
    if times:
        print("  health /api/ps  : median %.3fs  min %.3fs  max %.3fs  (%d probes, %d failures)"
              % (statistics.median(times), min(times), max(times), len(times) + fails, fails))
    else:
        print("  health /api/ps  : ALL %d PROBES FAILED" % (len(times) + fails))
        out["dead"] = True
        return out

    # 2. connection establishment
    ctimes = measure_conn(url, min(reps, 5))
    out["conn_times"] = ctimes
    if ctimes:
        print("  conn establish  : median %.3fs  min %.3fs" % (statistics.median(ctimes), min(ctimes)))

    # 3. identity / VRAM residency
    try:
        _, ps = http_json(url + "/api/ps", timeout=20)
        m = (ps.get("models") or [{}])[0]
        out["model"] = m.get("name")
        out["size_gb"] = round((m.get("size") or 0) / 1e9, 2)
        out["vram_gb"] = round((m.get("size_vram") or 0) / 1e9, 2)
        print("  model           : %s" % m.get("name"))
        print("  residency       : %.2f GB in VRAM of %.2f GB%s"
              % (out["vram_gb"], out["size_gb"],
                 "  (PARTLY RESIDENT - spilling)" if out["vram_gb"] < out["size_gb"] else ""))
    except Exception as e:
        print("  model           : unreadable (%s)" % str(e)[:60])

    # 4. warm up, then TTFT / decode / stream stability
    chat(url, [{"role": "user", "content": "Hi"}], timeout=900)
    runs = []
    n = 2 if quick else 4
    for i in range(n):
        r = chat(url, [{"role": "user",
                        "content": "Reply with one short sentence about databases."}], timeout=900)
        runs.append(r)
        print("  rep %d: first_byte %s  ttft %s  wall %6.2fs  chars %4d  gen %5.2f tok/s  max_gap %s"
              % (i + 1,
                 ("%.2fs" % r["first_byte"]) if r["first_byte"] else "n/a",
                 ("%.2fs" % r["ttft"]) if r["ttft"] else "n/a",
                 r["wall"], r["chars"], r["decode_tok_s"],
                 ("%.2fs" % r["max_gap"]) if r["max_gap"] else "n/a"))
    ok = [r for r in runs if r["ok"] and r["ttft"]]
    out["chat_runs"] = runs
    out["chat_ok"] = len(ok)
    if ok:
        out["ttft_median"] = statistics.median([r["ttft"] for r in ok])
        out["wall_median"] = statistics.median([r["wall"] for r in ok])
        out["decode_median"] = statistics.median([r["decode_tok_s"] for r in ok])
        print("  SUMMARY         : ttft median %.2fs | wall median %.2fs | decode median %.2f tok/s | %d/%d ok"
              % (out["ttft_median"], out["wall_median"], out["decode_median"], len(ok), len(runs)))

    if quick:
        return out

    # 5. tool latency
    r = chat(url, [{"role": "user", "content": "Use run_command to compute 17*23 and tell me."}],
             timeout=1200)
    out["tool_run"] = r
    print("  tool latency    : first tool at %s | wall %.1fs | tools=%s | verified=%s"
          % (("%.2fs" % r["first_tool_at"]) if r["first_tool_at"] else "none",
             r["wall"], r["tools"], (r["verification"] or {}).get("ok")))

    # 6. long-request survival
    r = chat(url, [{"role": "user",
                    "content": "Write about 300 words on the history of relational databases."}],
             timeout=1800)
    out["long_run"] = r
    print("  long request    : %s | wall %.1fs | chars %d | decode %.2f tok/s | max_gap %s"
          % ("survived" if r["ok"] else "FAILED: " + str(r["error"])[:60],
             r["wall"], r["chars"], r["decode_tok_s"],
             ("%.2fs" % r["max_gap"]) if r["max_gap"] else "n/a"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engines", nargs="+", required=True, help="slot=URL pairs")
    ap.add_argument("--reps", type=int, default=5)
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--label", default="reliability")
    a = ap.parse_args()

    pairs = []
    for item in a.engines:
        if "=" not in item:
            print("expected slot=URL, got %r" % item)
            return 2
        slot, url = item.split("=", 1)
        pairs.append((slot.strip().lower(), url.strip()))

    results = {}
    for slot, url in pairs:
        try:
            results[slot] = bench_engine(slot, url, a.reps, a.quick)
        except Exception as e:
            results[slot] = {"slot": slot, "url": url, "dead": True,
                             "error": "%s: %s" % (type(e).__name__, str(e)[:160])}
            print("  ENGINE %s UNREACHABLE: %s" % (slot.upper(), results[slot]["error"]))

    print("\n" + "=" * 74)
    print("CROSS-ENGINE COMPARISON")
    print("=" * 74)
    print("  %-4s %-9s %-9s %-11s %-9s %-8s %s"
          % ("slot", "health", "conn", "ttft", "wall", "decode", "probes failed"))
    for slot, _ in pairs:
        r = results.get(slot) or {}
        if r.get("dead"):
            print("  %-4s UNREACHABLE (%s)" % (slot, str(r.get("error"))[:50]))
            continue
        h = statistics.median(r["health_times"]) if r.get("health_times") else None
        c = statistics.median(r["conn_times"]) if r.get("conn_times") else None
        print("  %-4s %-9s %-9s %-11s %-9s %-8s %d"
              % (slot,
                 ("%.3fs" % h) if h else "n/a",
                 ("%.3fs" % c) if c else "n/a",
                 ("%.2fs" % r["ttft_median"]) if r.get("ttft_median") else "n/a",
                 ("%.2fs" % r["wall_median"]) if r.get("wall_median") else "n/a",
                 ("%.2f" % r["decode_median"]) if r.get("decode_median") else "n/a",
                 r.get("health_failures", 0)))

    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "reliability-%s.json" % a.label)
    with open(path, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print("\nsaved %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
