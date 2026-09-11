#!/usr/bin/env python3
"""
Engine latency benchmark — measures the components separately so the
bottleneck is identified rather than guessed.

  python3 -u scripts/perf/engine-bench.py --engine URL [--reps N] [--quick]

Everything here is a real request against a live engine. Nothing is simulated.

What is measured, and why each one is separate:

  connect        TCP+TLS+HTTP handshake to the tunnel. This is the network
                 path, and it is paid on every request that does not reuse a
                 connection.
  beacon         round trip to the discovery beacon. Aether pays this when it
                 has to find an engine, not when it already knows the URL.
  health         /api/ps round trip. Paid on every status poll.
  ttft           time to the first streamed token. This is prompt eval +
                 queueing, and it is what the user perceives as "is it working".
  decode         steady-state tokens/sec, measured over a long generation so
                 that TTFT does not distort it. This is the model on this GPU.
  prefill        prompt tokens/sec at several context sizes. Shows the cost of
                 carrying a long conversation, which is what makes the 20th
                 message slower than the first.
  toolstart      time from request to the first tool_result event. Orchestration
                 + tool execution, not model decode.
  task           end-to-end wall time for a real multi-step task.

The model's own timings are read from /api/generate, which the kernel proxies
to local Ollama and which returns load_duration, prompt_eval_count/duration and
eval_count/duration. Those numbers come from Ollama itself, so they separate
"the model is slow" from "the network or the wrapper is slow".
"""
import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request

OFF_KEY = "REMOVED_ENGINE_OFF_KEY"
BEACON = "https://ntfy.sh/REMOVED_BEACON_TOPIC/json?poll=1&since=3h"
RESULTS = {}


def post(url, body, timeout=600, key=OFF_KEY, raw=False):
    """POST and return (text, wall_seconds). Streams nothing; used for small calls."""
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", "X-Engine-Key": key},
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        payload = r.read().decode("utf-8", "replace")
    return (payload if raw else json.loads(payload)), time.perf_counter() - t0


def stream_chat(url, messages, timeout=900):
    """Stream /api/chat and return a breakdown of where the time went.

    ttft is measured to the first NON-EMPTY content chunk, because the kernel
    emits thinking/plan events before any visible text and a UI that counts the
    first byte would report a number the user never experiences.
    """
    body = json.dumps({"messages": messages, "stream": True}).encode()
    req = urllib.request.Request(
        url.rstrip("/") + "/api/chat", data=body,
        headers={"Content-Type": "application/json", "X-Engine-Key": OFF_KEY},
    )
    t0 = time.perf_counter()
    ttft = None
    first_byte = None
    content_chars = 0
    chunks = 0
    tool_events = []
    first_tool = None
    plan = False
    verification = None
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for line in r:
            line = line.strip()
            if not line:
                continue
            if first_byte is None:
                first_byte = time.perf_counter() - t0
            try:
                d = json.loads(line.decode("utf-8", "replace"))
            except Exception:
                continue
            chunks += 1
            m = d.get("message") or {}
            c = m.get("content") or ""
            if c:
                if ttft is None:
                    ttft = time.perf_counter() - t0
                content_chars += len(c)
            th = m.get("thinking") or ""
            if "\U0001f6e0" in th:
                name = th.split("(")[0].split()[-1] if th.split("(") else th
                if first_tool is None:
                    first_tool = time.perf_counter() - t0
                tool_events.append(name)
            if "plan" in d:
                plan = True
            if "verification" in d:
                verification = d["verification"]
    wall = time.perf_counter() - t0
    return {
        "wall": wall,
        "first_byte": first_byte,
        "ttft": ttft,
        "chunks": chunks,
        "content_chars": content_chars,
        "tools": tool_events,
        "first_tool": first_tool,
        "plan": plan,
        "verification": verification,
    }


def get(url, timeout=30):
    t0 = time.perf_counter()
    with urllib.request.urlopen(url, timeout=timeout) as r:
        payload = r.read()
    return payload, time.perf_counter() - t0


def fmt(x, unit="s", nd=2):
    return "n/a" if x is None else ("%." + str(nd) + "f%s") % (x, unit)


def pct(v):
    return "%.1f%%" % (100.0 * v) if v is not None else "n/a"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--label", default="")
    args = ap.parse_args()
    url = args.engine.rstrip("/")
    reps = 1 if args.quick else args.reps

    label = args.label or url.split("//")[1].split(".")[0]
    print("=" * 78)
    print("ENGINE BENCHMARK: %s" % label)
    print("  url   : %s" % url)
    print("  reps  : %d" % reps)
    print("=" * 78)

    # ---- 1. connection / health -------------------------------------------------
    print("\n[1] connection and health")
    conns = []
    for _ in range(reps):
        try:
            _, dt = get(url + "/api/ps")
            conns.append(dt)
        except Exception as e:
            print("  health FAILED: %s" % str(e)[:90])
            return 1
    RESULTS["health"] = conns
    print("  /api/ps round trip : min %s  median %s  max %s"
          % (fmt(min(conns), "s", 3), fmt(statistics.median(conns), "s", 3),
             fmt(max(conns), "s", 3)))

    # model identity — is the same model actually loaded on this engine?
    _, _ = get(url + "/api/ps")
    payload, _ = get(url + "/api/ps")
    try:
        ps = json.loads(payload)
        ms = ps.get("models") or []
        if ms:
            m0 = ms[0]
            RESULTS["model"] = m0.get("name")
            RESULTS["model_bytes"] = m0.get("size")
            RESULTS["vram_bytes"] = m0.get("size_vram")
            print("  model              : %s" % m0.get("name"))
            print("  size               : %.2f GB, in VRAM %.2f GB (%s resident)"
                  % ((m0.get("size") or 0) / 1e9, (m0.get("size_vram") or 0) / 1e9,
                     "fully" if m0.get("size_vram") == m0.get("size") else "partly"))
    except Exception as e:
        print("  model probe failed : %s" % str(e)[:80])

    # ---- 2. beacon --------------------------------------------------------------
    print("\n[2] discovery beacon")
    try:
        _, dt = get(BEACON)
        RESULTS["beacon"] = dt
        print("  beacon round trip  : %s" % fmt(dt, "s", 3))
    except Exception as e:
        print("  beacon unreachable : %s" % str(e)[:80])

    # ---- 3. Ollama's own timings ------------------------------------------------
    print("\n[3] model internals via /api/generate (Ollama's own numbers)")
    # Warm first: a cold request pays model load, which would swamp everything.
    try:
        post(url + "/api/generate",
             {"prompt": "Hi", "stream": False, "options": {"num_predict": 8, "num_ctx": 16384}},
             timeout=600)
    except Exception as e:
        print("  warmup failed      : %s" % str(e)[:90])

    for ctx in (16384, 4096, 2048):
        try:
            r, wall = post(
                url + "/api/generate",
                {"prompt": "Write a detailed paragraph about databases. " * 20,
                 "stream": False,
                 "options": {"num_predict": 128, "num_ctx": ctx}},
                timeout=900)
            pe_c = r.get("prompt_eval_count") or 0
            pe_d = (r.get("prompt_eval_duration") or 0) / 1e9
            ev_c = r.get("eval_count") or 0
            ev_d = (r.get("eval_duration") or 0) / 1e9
            ld = (r.get("load_duration") or 0) / 1e9
            print("  ctx %-6d prefill %5.1f tok/s (%d tok / %.2fs) | decode %5.2f tok/s "
                  "(%d tok / %.2fs) | load %.2fs | wall %.2fs"
                  % (ctx, (pe_c / pe_d) if pe_d else 0, pe_c, pe_d,
                     (ev_c / ev_d) if ev_d else 0, ev_c, ev_d, ld, wall))
            RESULTS.setdefault("ctx", {})[ctx] = {
                "prefill_tok_s": (pe_c / pe_d) if pe_d else None,
                "decode_tok_s": (ev_c / ev_d) if ev_d else None,
                "load_s": ld, "wall_s": wall,
                "prompt_tokens": pe_c, "gen_tokens": ev_c,
            }
        except Exception as e:
            print("  ctx %-6d FAILED: %s" % (ctx, str(e)[:90]))

    # ---- 4. repeated chat TTFT --------------------------------------------------
    print("\n[4] chat TTFT and streaming (repeated, identical prompt)")
    ttfts, walls, rates = [], [], []
    for i in range(reps):
        try:
            r = stream_chat(url, [{"role": "user",
                                   "content": "Explain in one short paragraph what a database index does."}])
            ttfts.append(r["ttft"])
            walls.append(r["wall"])
            if r["ttft"] and r["wall"] > r["ttft"] and r["content_chars"]:
                # rough chars/sec of the visible stream
                rates.append(r["content_chars"] / max(r["wall"] - r["ttft"], 1e-6))
            print("  rep %d: first_byte %s  ttft %s  wall %s  chars %d  chunks %d"
                  % (i + 1, fmt(r["first_byte"], "s"), fmt(r["ttft"], "s"),
                     fmt(r["wall"], "s"), r["content_chars"], r["chunks"]))
        except Exception as e:
            print("  rep %d FAILED: %s" % (i + 1, str(e)[:90]))
    if ttfts:
        ttfts = [t for t in ttfts if t is not None]
        RESULTS["ttft_median"] = statistics.median(ttfts) if ttfts else None
        RESULTS["wall_median"] = statistics.median(walls)
        print("  ttft   median %s  min %s  max %s"
              % (fmt(RESULTS["ttft_median"]), fmt(min(ttfts)), fmt(max(ttfts))))
        print("  wall   median %s" % fmt(RESULTS["wall_median"]))
        if rates:
            print("  stream %.0f chars/sec median" % statistics.median(rates))

    # ---- 5. tool start latency --------------------------------------------------
    print("\n[5] tool-start latency (real tool call)")
    try:
        r = stream_chat(url, [{"role": "user",
                               "content": "Run a shell command to print the current directory listing."}])
        RESULTS["tool_start"] = r["first_tool"]
        RESULTS["tool_task_wall"] = r["wall"]
        RESULTS["tool_names"] = r["tools"]
        print("  tools called       : %s" % (", ".join(r["tools"]) or "(none)"))
        print("  time to first tool : %s" % fmt(r["first_tool"]))
        print("  task wall          : %s" % fmt(r["wall"]))
        print("  plan published     : %s" % r["plan"])
        print("  verification       : %s" % (r["verification"] or {}).get("ok"))
    except Exception as e:
        print("  tool task FAILED: %s" % str(e)[:90])

    # ---- 6. web search latency --------------------------------------------------
    print("\n[6] web search latency (real search)")
    try:
        r = stream_chat(url, [{"role": "user",
                               "content": "Search the web for the capital of Portugal and tell me."}])
        RESULTS["search_wall"] = r["wall"]
        RESULTS["search_tools"] = r["tools"]
        print("  tools              : %s" % (", ".join(r["tools"]) or "(none)"))
        print("  time to first tool : %s" % fmt(r["first_tool"]))
        print("  task wall          : %s" % fmt(r["wall"]))
    except Exception as e:
        print("  search task FAILED: %s" % str(e)[:90])

    # ---- 7. browser latency -----------------------------------------------------
    if not args.quick:
        print("\n[7] browser latency (real Chromium)")
        try:
            r = stream_chat(url, [{"role": "user",
                                   "content": "Open https://example.com in the browser and tell me the page title."}],
                            timeout=900)
            RESULTS["browser_wall"] = r["wall"]
            RESULTS["browser_tools"] = r["tools"]
            print("  tools              : %s" % (", ".join(r["tools"]) or "(none)"))
            print("  task wall          : %s" % fmt(r["wall"]))
        except Exception as e:
            print("  browser task FAILED: %s" % str(e)[:90])

    print("\n" + "=" * 78)
    out = "/home/user/aether/scripts/perf/output/bench-%s.json" % label
    import os
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(RESULTS, f, indent=2)
    print("saved %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
