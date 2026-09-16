#!/usr/bin/env python3
"""Does the prompt we send keep the engine's KV cache, or throw it away?

Ollama reuses the cached prefix of a prompt. If turn N+1 shares its prefix
with turn N, only the new tail is prefilled and time-to-first-token stays
flat as a conversation grows. If anything near the FRONT of the prompt changes
between turns -- a re-ordered history window, a fresh timestamp, a re-summarised
context block -- the whole prefix is invalidated and the engine re-prefills
everything.

This measures both shapes against a live engine:

  stable   each turn appends to the previous prefix (cache-friendly)
  churn    a varying token is injected near the front (cache-hostile)

Same total tokens per turn in both arms, so the only difference is prefix
stability. That difference IS the cost of context assembly.

Usage: python3 -u scripts/perf/context-cache-probe.py <tunnel-url> [turns]
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
CHUNK = "The quick brown fox jumps over the lazy dog near the riverbank at dawn. "


def gen(base, prompt, num_predict=32, timeout=95):
    body = json.dumps({
        "model": MODEL, "prompt": prompt, "stream": False,
        "options": {"num_predict": num_predict, "temperature": 0.1},
        "keep_alive": -1,
    }).encode()
    req = urllib.request.Request(base + "/api/generate", data=body, headers={
        "Content-Type": "application/json", "X-Engine-Key": OFF_KEY})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        d = json.loads(r.read().decode("utf-8", "replace"))
    wall = time.time() - t0
    pe_n = d.get("prompt_eval_count") or 0
    pe_d = (d.get("prompt_eval_duration") or 0) / 1e9
    return {
        "wall": wall,
        "prefill_tokens": pe_n,
        "prefill_s": pe_d,
        "prefill_tok_s": (pe_n / pe_d) if pe_d > 0 else None,
        "load_s": (d.get("load_duration") or 0) / 1e9,
    }


def arm(base, label, turns, mutate):
    """mutate(prefix, i) -> the prompt for turn i."""
    print("\n%s" % label)
    print("  %-6s %9s %9s %11s %9s" % ("turn", "prefill", "tok", "tok/s", "ttft-ish"))
    rows = []
    prefix = "You are a helpful assistant. Answer briefly.\n\nConversation so far:\n"
    for i in range(turns):
        prompt = mutate(prefix, i)
        try:
            r = gen(base, prompt)
        except Exception as e:
            print("  %-6d ERROR %s: %s" % (i + 1, type(e).__name__, str(e)[:80]))
            return None
        print("  %-6d %8.2fs %9d %11s %8.2fs" % (
            i + 1, r["prefill_s"], r["prefill_tokens"],
            ("%.0f" % r["prefill_tok_s"]) if r["prefill_tok_s"] else "-", r["wall"]))
        rows.append(r)
        # Grow the prefix exactly as a real conversation does.
        prefix += "user: %s\nassistant: Understood, noted.\n" % (CHUNK.strip()[:70])
        sys.stdout.flush()
    later = [r for r in rows[1:] if r["prefill_tokens"]]
    if later:
        print("  -> median prefill from turn 2: %.2fs over %d tokens (%.0f tok/s)" % (
            statistics.median(r["prefill_s"] for r in later),
            int(statistics.median(r["prefill_tokens"] for r in later)),
            statistics.median(r["prefill_tok_s"] for r in later if r["prefill_tok_s"]) or 0))
    return rows


def main():
    if len(sys.argv) < 2:
        print("usage: context-cache-probe.py <tunnel-url> [turns]")
        return 2
    base = sys.argv[1].rstrip("/")
    turns = int(sys.argv[2]) if len(sys.argv) > 2 else 4

    print("CONTEXT / KV-CACHE PROBE against %s" % base)

    # Arm 1: nothing at the front changes -> the cache should hold.
    stable = arm(base, "A. STABLE PREFIX (cache-friendly)", turns,
                 lambda p, i: p + "user: What is %d + %d?\nassistant:" % (i, i))

    # Arm 2: a varying line is injected right after the system prompt, so the
    # shared prefix is broken on every single turn even though the bulk of the
    # conversation is identical.
    churn = arm(base, "B. CHURNED PREFIX (a varying line near the front)", turns,
                lambda p, i: p.replace("Conversation so far:\n",
                                       "Conversation so far:\n[turn %d at %d]\n" % (i, int(time.time())), 1)
                + "user: What is %d + %d?\nassistant:" % (i, i))

    print("\n" + "=" * 78)
    if stable and churn:
        s = statistics.median(r["prefill_s"] for r in stable[1:] if r["prefill_tokens"])
        c = statistics.median(r["prefill_s"] for r in churn[1:] if r["prefill_tokens"])
        print("median prefill (turn 2+)  stable=%.2fs   churn=%.2fs   penalty=%.2fs per turn"
              % (s, c, c - s))
        print("A conversation whose context is re-assembled each turn pays that")
        print("penalty before the first token of EVERY reply.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
