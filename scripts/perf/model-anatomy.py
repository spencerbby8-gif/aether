#!/usr/bin/env python3
"""Isolate the MODEL from the AGENT LAYER on a live engine.

The kernel proxies any POST that is not exactly /api/chat straight to the
local Ollama, so /api/generate returns real timing counters instead of a
stream:

    prompt_eval_count / prompt_eval_duration_ns  -> prefill
    eval_count / eval_duration_ns                -> decode
    load_duration_ns                             -> model (re)load

That separates "the model is slow" from "our agent loop is slow" with numbers
from the engine itself rather than from wall-clock guesses.

Cloudflare kills responses after ~100 s, so every probe is bounded and the
prompt sizes are kept small.

Usage: python3 -u scripts/perf/model-anatomy.py <tunnel-url> [repeats]
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


def post(base, path, payload, timeout=95):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        base + path, data=body,
        headers={"Content-Type": "application/json", "X-Engine-Key": OFF_KEY})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        raw = r.read().decode("utf-8", "replace")
        code = r.getcode()
    return code, raw, time.time() - t0


def ps(base):
    t0 = time.time()
    with urllib.request.urlopen(base + "/api/ps", timeout=30, context=CTX) as r:
        return json.loads(r.read().decode()), time.time() - t0


def generate(base, prompt, num_predict, num_ctx=None, repeat=1):
    opts = {"num_predict": num_predict, "temperature": 0.1}
    if num_ctx:
        opts["num_ctx"] = num_ctx
    out = []
    for _ in range(repeat):
        try:
            code, raw, wall = post(base, "/api/generate", {
                "model": MODEL, "prompt": prompt, "stream": False,
                "options": opts, "keep_alive": -1})
            d = json.loads(raw)
        except Exception as e:
            out.append({"error": "%s: %s" % (type(e).__name__, str(e)[:90])})
            continue
        pe_n = d.get("prompt_eval_count") or 0
        pe_d = (d.get("prompt_eval_duration") or 0) / 1e9
        ev_n = d.get("eval_count") or 0
        ev_d = (d.get("eval_duration") or 0) / 1e9
        ld = (d.get("load_duration") or 0) / 1e9
        out.append({
            "http": code, "wall": wall,
            "load_s": ld,
            "prefill_tokens": pe_n, "prefill_s": pe_d,
            "prefill_tok_s": (pe_n / pe_d) if pe_d > 0 else None,
            "decode_tokens": ev_n, "decode_s": ev_d,
            "decode_tok_s": (ev_n / ev_d) if ev_d > 0 else None,
            "server_total_s": (d.get("total_duration") or 0) / 1e9,
        })
    return out


def row(label, rs):
    good = [r for r in rs if "error" not in r]
    if not good:
        print("%-28s ERROR %s" % (label, rs[0].get("error")))
        return
    f = lambda k: statistics.median([r[k] for r in good if r.get(k) is not None]) if any(r.get(k) is not None for r in good) else None
    def s(v, u="s"):
        return ("%.2f%s" % (v, u)) if v is not None else "-"
    print("%-28s load=%s prefill=%s (%s tok/s, %d tok) decode=%s (%s tok/s, %d tok) wall=%s" % (
        label, s(f("load_s")), s(f("prefill_s")),
        s(f("prefill_tok_s"), ""), int(f("prefill_tokens") or 0),
        s(f("decode_s")), s(f("decode_tok_s"), ""), int(f("decode_tokens") or 0),
        s(f("wall"))))


def main():
    if len(sys.argv) < 2:
        print("usage: model-anatomy.py <tunnel-url> [repeats]")
        return 2
    base = sys.argv[1].rstrip("/")
    repeats = int(sys.argv[2]) if len(sys.argv) > 2 else 3

    info, ps_ms = ps(base)
    print("engine /api/ps  %.3fs  models=%d" % (ps_ms, len(info.get("models", []))))
    for m in info.get("models", []):
        print("  %s  vram=%.2f GB" % (m.get("name"), (m.get("size_vram") or 0) / 1e9))

    print("\nMODEL ANATOMY (raw Ollama timing, %d repeats each)" % repeats)
    print("-" * 100)

    # 1. Tiny prompt: measures per-request floor (no meaningful prefill).
    row("tiny prompt (5 words)", generate(base, "Say hello in one word.", 16, repeat=repeats))

    # 2. Small prompt, longer decode: isolates pure decode throughput.
    row("short prompt / 128 tok", generate(base, "List the planets of the solar system, one per line.", 128, repeat=repeats))

    # 3. Medium prompt: prefill cost at a realistic chat context.
    medium = "You are a helpful assistant. " + ("The quick brown fox jumps over the lazy dog. " * 60)
    row("~700 tok prompt / 64 tok", generate(base, medium + " Summarise in one sentence.", 64, repeat=repeats))

    # 4. Large prompt: prefill cost at a long-context turn.
    big = "You are a helpful assistant. " + ("The quick brown fox jumps over the lazy dog. " * 400)
    row("~4500 tok prompt / 32 tok", generate(base, big + " Summarise in one sentence.", 32, repeat=2))

    print("-" * 100)
    return 0


if __name__ == "__main__":
    sys.exit(main())
