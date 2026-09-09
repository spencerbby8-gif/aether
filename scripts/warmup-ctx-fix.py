#!/usr/bin/env python3
"""Pin the engine's boot warmup to the context window it will actually serve.

MEASURED CAUSE (live engine, 2026-09-09, engine C):
  Ollama reloads the model into VRAM whenever num_ctx differs between
  requests. The boot warmup calls /api/chat with NO options at all, so it pins
  the 15 GB model at Ollama's default window, while every real chat request
  sends num_ctx=16384. The first request after boot therefore pays a full
  reload before it can answer.

  Requests alternating num_ctx : 7 reloads out of 8, 10.8-11.8 s each
  Requests holding num_ctx     : 1 reload out of 10 (the cold one), then
                                 2.14-2.43 s wall, median 2.18 s

The warmup is the only caller in the notebook that omits the window. This
moves the NUM_CTX definition above the warmup and passes it there, so the
model is pinned at the serving context from boot and the user's first message
does not pay for a reload.

It also bounds the warmup generation. It previously had no num_predict, so the
warm-up reply ran to end-of-stream at ~5.5 tok/s purely to prove the model was
loaded; 16 tokens proves the same thing in a fraction of the time.

Usage:  python3 scripts/warmup-ctx-fix.py [--check]
"""
import json
import sys

ASSET = "android/app/src/main/assets/aether-notebook-template.json"

WARM_CURL = (
    "rw = subprocess.run(['curl','-s','-m','1200',"
    "'http://127.0.0.1:11434/api/chat','-d', json.dumps({'model':MODEL,"
    "'messages':[{'role':'user','content':'hi'}],'stream':False,'keep_alive':-1})],"
    " env=e, capture_output=True, text=True)"
)

WARM_CURL_FIXED = (
    "rw = subprocess.run(['curl','-s','-m','1200',"
    "'http://127.0.0.1:11434/api/chat','-d', json.dumps({'model':MODEL,"
    "'messages':[{'role':'user','content':'hi'}],'stream':False,'keep_alive':-1,"
    "'options':{'num_ctx':NUM_CTX,'num_predict':16}})],"
    " env=e, capture_output=True, text=True)"
)

NUM_CTX_BLOCK = """# Ollama's default context window is small. When a prompt exceeds it the
# messages are trimmed FROM THE FRONT, which drops the system prompt and the
# user's question -- and the chat template then raises 'No user query found in
# messages.' with HTTP 500 halfway through a turn. Measured on the live engine:
# the same 14-message tool turn fails at the default window and succeeds at
# 16384 (prompt_eval 5176 and 6262 tokens). So the window is declared here, and
# tool results are capped below, rather than left to chance.
#
# It is declared BEFORE the warmup on purpose. Ollama reloads the model into
# VRAM whenever num_ctx changes between requests (measured: 10.8-11.8 s per
# switch, 7 reloads in 8 alternating requests). Warming at the default window
# and then serving at 16384 made the user's first message pay that reload.
NUM_CTX = 16384
"""

# The original declaration site, which now becomes a reference to the one above.
NUM_CTX_ORIGINAL = """# Ollama's default context window is small. When a prompt exceeds it the
# messages are trimmed FROM THE FRONT, which drops the system prompt and the
# user's question -- and the chat template then raises 'No user query found in
# messages.' with HTTP 500 halfway through a turn. Measured on the live engine:
# the same 14-message tool turn fails at the default window and succeeds at
# 16384 (prompt_eval 5176 and 6262 tokens). So the window is declared here, and
# tool results are capped below, rather than left to chance.
NUM_CTX = 16384
"""

ANCHOR = "notify('warming up ' + MODEL.split(':')[-1] + ' (loading 15GB into VRAM)...')"


def check_applied(nb):
    """Verify the POST-state directly.

    Counting the pre-state and reporting it as "applied" is inverted: it says
    OK precisely when nothing has been done. So look for the fixed form being
    present and the old form being gone, across all cells.
    """
    fixed_curl = ctx_early = old_curl = old_decl = 0
    for cell in nb["cells"]:
        src = "".join(cell.get("source", [])) if isinstance(cell.get("source"), list) else (cell.get("source") or "")
        fixed_curl += src.count(WARM_CURL_FIXED)
        old_curl += src.count(WARM_CURL)
        if ANCHOR in src and "NUM_CTX = 16384" in src.split(ANCHOR)[0]:
            ctx_early += 1
        old_decl += src.count(NUM_CTX_ORIGINAL)
    print("  %-24s %d (expected 2)" % ("warmup pinned", fixed_curl))
    print("  %-24s %d (expected 0)" % ("warmup still unpatched", old_curl))
    print("  %-24s %d (expected 1)" % ("NUM_CTX before warmup", ctx_early))
    print("  %-24s %d (expected 0)" % ("duplicate NUM_CTX sites", old_decl))
    bad = (fixed_curl != 2 or old_curl != 0 or ctx_early != 1 or old_decl != 0)
    print("warmup-ctx-fix: " + ("NOT APPLIED" if bad else "OK, every change is present"))
    return 1 if bad else 0


def main():
    check = "--check" in sys.argv
    nb = json.loads(open(ASSET, encoding="utf-8").read())

    if check:
        return check_applied(nb)

    # Track each patch across ALL cells, never per cell: a patch that iterates
    # cells and counts misses will report every unrelated cell as a failure.
    results = {"warmup-pinned": 0, "ctx-declared-early": 0, "old-site-removed": 0}
    missing = []

    for cell in nb["cells"]:
        raw_src = cell.get("source")
        src = raw_src if isinstance(raw_src, str) else "".join(raw_src or [])
        if not src:
            continue
        new = src

        # 1. Warmup calls carry the serving window and a bounded generation.
        n = new.count(WARM_CURL)
        if n:
            new = new.replace(WARM_CURL, WARM_CURL_FIXED)
            results["warmup-pinned"] += n

        # 2. Declare NUM_CTX before the warmup.
        if ANCHOR in new and "NUM_CTX = 16384" not in new.split(ANCHOR)[0]:
            new = new.replace(ANCHOR, NUM_CTX_BLOCK + ANCHOR, 1)
            results["ctx-declared-early"] += 1

        # 3. The later duplicate declaration goes away so there is one source
        #    of truth; the comment there is folded into the early one.
        if NUM_CTX_ORIGINAL in new and results["ctx-declared-early"]:
            new = new.replace(NUM_CTX_ORIGINAL, "", 1)
            results["old-site-removed"] += 1

        if new != src and not check:
            # The asset stores each cell's source as a single STRING, not the
            # list-of-lines form Jupyter usually uses. Writing a list here
            # would silently change the file's canonical shape.
            cell["source"] = new

    for k, want in (("warmup-pinned", 2), ("ctx-declared-early", 1), ("old-site-removed", 1)):
        if results[k] != want:
            missing.append("%s (found %d, expected %d)" % (k, results[k], want))

    if missing:
        print("warmup-ctx-fix: REFUSING to write an incomplete patch: " + "; ".join(missing))
        return 1

    # Verify the result parses as Python before writing anything.
    import ast
    for i, cell in enumerate(nb["cells"]):
        raw_src = cell.get("source")
        src = raw_src if isinstance(raw_src, str) else "".join(raw_src or [])
        if cell.get("cell_type") == "code" and src.strip():
            try:
                ast.parse(src)
            except SyntaxError as ex:
                print("warmup-ctx-fix: cell %d would not parse: %s" % (i, ex))
                return 1

    with open(ASSET, "w", encoding="utf-8") as f:
        # Byte-exact round trip: compact separators and ASCII escapes, which is
        # how this asset is committed. Anything else changes every \u escape in
        # the file and breaks the template pins for no reason.
        f.write(json.dumps(nb, separators=(",", ":"), ensure_ascii=True))
    print("warmup-ctx-fix: applied and re-parsed every code cell")
    for k, v in results.items():
        print("  %-22s %d" % (k, v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
