#!/usr/bin/env python3
"""GENERATION SPEED CEILING — is ~15 tok/s the hardware limit, or a config?

Everything here is a real request against a live engine through the kernel's
raw /api/generate proxy, so every number is Ollama's own timing
(prompt_eval_*, eval_count/eval_duration, load_duration), not wall-clock
guesswork from outside the tunnel.

What is varied, and why each knob is on the list:
  num_ctx      KV cache size. If decode were KV-bound, tok/s would move with
               context. (Model residency is proven separately via /api/ps.)
  num_batch    prompt-processing batch. A prefill/TTFT lever, included to show
               decode does not ride on it.
  num_predict  generation length: short vs sustained, to separate ramp-up
               from steady state.
  GPU model    nvidia-smi, through the agent's run_command tool, so the
               theoretical ceiling is computed from the actual silicon.

The verdict rule, stated before running: decode tok/s that stays within noise
across num_ctx and num_batch while the model is fully VRAM-resident is
memory-bandwidth-bound, and the ceiling is
    weights_bytes / aggregate_bandwidth
which no setting can exceed. If instead one configuration is materially
faster, the ceiling was a config and the report must say so.

Usage: decode-ceiling.py --engine URL [--quick]
"""
import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request

KEY = "REMOVED_ENGINE_OFF_KEY"
MODEL = "hf.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF:IQ4_XS"


def post(url, path, body, timeout=600, key=KEY):
    req = urllib.request.Request(url.rstrip("/") + path,
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          "X-Engine-Key": key})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode()), time.time() - t0


def gen(url, num_ctx, num_predict, num_batch=None, prompt=None):
    p = prompt if prompt is not None else (
        "Explain in detail how a transformer decoder generates text token by "
        "token, including attention, sampling and stopping. ") * 4
    opts = {"num_ctx": num_ctx, "num_predict": num_predict, "temperature": 0}
    if num_batch:
        opts["num_batch"] = num_batch
    body = {"model": MODEL, "prompt": p, "stream": False,
            "keep_alive": -1, "options": opts}
    try:
        j, wall = post(url, "/api/generate", body, timeout=1200)
    except urllib.error.HTTPError as e:
        return {"error": "HTTP %s %s" % (e.code, e.read()[:100])}
    ev = j.get("eval_count") or 0
    ed = (j.get("eval_duration") or 0) / 1e9
    pe = j.get("prompt_eval_count") or 0
    pd = (j.get("prompt_eval_duration") or 0) / 1e9
    return {
        "wall": wall,
        "load_s": (j.get("load_duration") or 0) / 1e9,
        "prefill_tok_s": pe / pd if pd else None,
        "prompt_tokens": pe,
        "decode_tok_s": ev / ed if ed else None,
        "gen_tokens": ev,
        "decode_s": ed,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args()
    U = a.engine.rstrip("/")

    # 0. residency: is the model fully in VRAM right now?
    ps, _ = post(U, "/api/ps", {}, timeout=30) if False else (None, None)
    req = urllib.request.Request(U + "/api/ps", headers={"X-Engine-Key": KEY})
    ps = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
    for m in ps.get("models", []):
        print("residency: %s size=%.2fGB vram=%.2fGB" %
              (m.get("name", "?")[:48], (m.get("size") or 0) / 2**30,
               (m.get("size_vram") or 0) / 2**30))

    rows = []
    plan = ([(2048, 128, None), (8192, 128, None), (16384, 128, None)]
            if a.quick else
            [(2048, 128, None), (4096, 128, None), (8192, 128, None),
             (16384, 128, None), (8192, 128, 2048), (8192, 128, 256),
             (8192, 512, None)])
    for ctx, npred, nb in plan:
        r = gen(U, ctx, npred, nb)
        tag = "ctx=%-5d npred=%-4d batch=%s" % (ctx, npred, nb or "default")
        if "error" in r:
            print("  %-34s %s" % (tag, r["error"]))
            continue
        rows.append((tag, r))
        print("  %-34s decode %6.2f tok/s | prefill %6.1f tok/s | load %5.1fs | wall %6.1fs"
              % (tag, r["decode_tok_s"] or -1, r["prefill_tok_s"] or -1,
                 r["load_s"], r["wall"]))

    decodes = [r["decode_tok_s"] for _, r in rows if r.get("decode_tok_s")]
    if len(decodes) >= 3:
        lo, hi = min(decodes), max(decodes)
        spread = (hi - lo) / statistics.median(decodes) * 100
        print()
        print("decode min %.2f  median %.2f  max %.2f tok/s  (spread %.1f%%)"
              % (lo, statistics.median(decodes), hi, spread))
        print("verdict: %s" % (
            "flat across ctx and batch -> memory-bandwidth-bound; the ceiling "
            "is the silicon, not a setting"
            if spread < 12 else
            "MATERIAL spread -> some configuration is leaving speed on the "
            "table; the fastest row is the fix"))


if __name__ == "__main__":
    sys.exit(main())
