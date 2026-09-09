#!/usr/bin/env python3
"""Kill the upstream generation when the client goes away.

MEASURED. On a live engine, a raw Ollama call that generated ONE token reported:

    load_duration        0.00s
    prompt_eval_duration 0.74s   (53 tokens)
    total_duration      65.19s

Sixty-four seconds that were not loading, not prefilling and not decoding. The
request was waiting for Ollama's single slot, because something else was still
generating into a socket nobody was reading.

CAUSE. The final-answer path streams from Ollama through a curl subprocess:

    p = subprocess.Popen(['curl','-s','-N','-m','1200', ...])
    for raw in p.stdout:
        emit(json.loads(raw))
    try: p.kill()
    except Exception: pass

p.kill() is only reached when the loop ends on its own. When the client
disconnects, emit() raises, the exception leaves the loop, and the curl is never
killed -- it keeps reading from Ollama for its full 1200 second timeout. Ollama
serves one request at a time, so every later request queues behind a generation
nobody wants. Reproduced here by breaking out of a client read early: time to
first token climbed 1s -> 25s -> 120s over seven minutes.

In the app this is the Stop button, a dropped mobile connection, or the process
being backgrounded. Any of them froze the engine for up to twenty minutes.

The tool-turn path already had this right: ollama_stream() breaks when push()
returns False and closes the connection in a finally block.

FIX. try/finally around the read, so the subprocess dies on every exit path.

Run from the repo root:  python3 scripts/orphan-stream-fix.py
"""
import io
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = os.path.join(REPO, "android", "app", "src", "main", "assets",
                 "aether-notebook-template.json")
CELL = 4

OLD = """    p = subprocess.Popen(['curl','-s','-N','-m','1200','http://127.0.0.1:11434/api/chat','-d',json.dumps(final)], stdout=subprocess.PIPE)
    for raw in p.stdout:
        emit(json.loads(raw))
    try: p.kill()
    except Exception: pass
"""

NEW = """    p = subprocess.Popen(['curl','-s','-N','-m','1200','http://127.0.0.1:11434/api/chat','-d',json.dumps(final)], stdout=subprocess.PIPE)
    # try/finally, not a bare kill after the loop. A client that goes away makes
    # emit() raise, the exception leaves the loop, and without this the curl
    # keeps reading from Ollama for its whole 1200s timeout. Ollama serves one
    # request at a time, so that orphaned generation blocks every later request
    # -- measured as a one-token call waiting 65s for a free slot.
    try:
        for raw in p.stdout:
            emit(json.loads(raw))
    finally:
        try: p.kill()
        except Exception: pass
"""


def main() -> int:
    nb = json.load(io.open(P, encoding="utf-8"))
    src = nb["cells"][CELL]["source"]
    if isinstance(src, list):
        src = "".join(src)

    if "try/finally, not a bare kill after the loop" in src:
        print("already patched -- nothing to do")
    else:
        n = src.count(OLD)
        if n != 1:
            print("FAIL: expected exactly one match of the unguarded stream, found %d" % n)
            return 1
        src = src.replace(OLD, NEW)
        # This template stores each cell's source as one compact string.
        nb["cells"][CELL]["source"] = src
        with io.open(P, "w", encoding="utf-8", newline="") as fh:
            fh.write(json.dumps(nb, ensure_ascii=True, separators=(",", ":")))
        print("applied: the upstream curl is now killed on every exit path")

    back = json.load(io.open(P, encoding="utf-8"))["cells"][CELL]["source"]
    back = "".join(back) if isinstance(back, list) else back
    ok = "try/finally, not a bare kill after the loop" in back and back.count(NEW.strip()) == 1
    print("verify: guarded stream present -> %s" % ("OK" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
