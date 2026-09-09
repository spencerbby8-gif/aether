#!/usr/bin/env python3
"""Cap how much the agent layer will generate in one request.

WHY. The agent's own requests to Ollama set num_ctx but never num_predict, so a
request could generate until the 16384-token context was exhausted. Measured on
a live engine: a degenerate prompt (8000 characters of "X ") put the model into
repetition and it held Ollama's single slot for the rest of the session. Every
request behind it queued -- time to first token went from ~1s to 87-103s for a
25-character prompt, and a raw /api/generate asking for 8 tokens hit Cloudflare's
524 at 125s. The engine looked broken; it was busy.

The keep-alive ping already had num_predict: 1. The requests that matter did not.

WHAT. A single NUM_PREDICT constant beside NUM_CTX, applied to both the tool turn
and the final answer. 4096 tokens is roughly 16 KB of prose -- far beyond any
real answer, so a legitimate long turn is never truncated, while the worst case a
runaway can hold the slot drops from ~45 minutes to ~11.

Idempotent: running it twice changes nothing.
"""
import io
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(
    REPO, "android", "app", "src", "main", "assets", "aether-notebook-template.json")

CELL = 4
ANCHOR_CTX = "NUM_CTX = 16384"
CONSTANT = (
    "NUM_CTX = 16384\n"
    "# Bound a single generation. Without this a request runs until the context\n"
    "# is exhausted, and Ollama serves one request at a time -- so one runaway\n"
    "# makes the whole engine look dead. 4096 tokens is ~16KB of prose, well\n"
    "# beyond any real answer, so long turns are never cut short.\n"
    "NUM_PREDICT = 4096"
)
OPTIONS_OLD = "'options': {'num_ctx': NUM_CTX}"
OPTIONS_NEW = "'options': {'num_ctx': NUM_CTX, 'num_predict': NUM_PREDICT}"


def main() -> int:
    with io.open(TEMPLATE, encoding="utf-8") as fh:
        nb = json.load(fh)

    src = "".join(nb["cells"][CELL].get("source", []))
    changed = []

    if "NUM_PREDICT" in src:
        print("already patched -- nothing to do")
    else:
        if src.count(ANCHOR_CTX) != 1:
            print("FAIL: expected exactly one %r, found %d"
                  % (ANCHOR_CTX, src.count(ANCHOR_CTX)))
            return 1
        src = src.replace(ANCHOR_CTX, CONSTANT)
        changed.append("constant")

        n = src.count(OPTIONS_OLD)
        if n != 2:
            print("FAIL: expected 2 request payloads, found %d" % n)
            return 1
        src = src.replace(OPTIONS_OLD, OPTIONS_NEW)
        changed.append("%d payloads" % n)

        # This template stores each cell's source as one string, not a list of
        # lines. Writing a list back would reformat the whole file and bury the
        # real change in a thousand lines of diff.
        nb["cells"][CELL]["source"] = src
        # This file is committed as one compact line of ASCII-escaped JSON with
        # no trailing newline. Writing it any other way reformats all 84 KB and
        # buries a three-line change in a thousand lines of diff.
        with io.open(TEMPLATE, "w", encoding="utf-8", newline="") as fh:
            fh.write(json.dumps(nb, ensure_ascii=True, separators=(",", ":")))

    # Verify from disk, not from memory of what we just wrote.
    with io.open(TEMPLATE, encoding="utf-8") as fh:
        back = "".join(json.load(fh)["cells"][CELL].get("source", []))
    ok = back.count("NUM_PREDICT") >= 3 and back.count(OPTIONS_NEW) == 2
    print("verify: NUM_PREDICT occurrences=%d, capped payloads=%d -> %s"
          % (back.count("NUM_PREDICT"), back.count(OPTIONS_NEW),
             "OK" if ok else "FAIL"))
    if changed:
        print("applied: " + ", ".join(changed))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
