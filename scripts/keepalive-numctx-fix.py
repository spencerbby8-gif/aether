"""Stop the keep-alive ping from reloading the model every 60 seconds.

Measured on a live engine through the kernel's raw Ollama proxy:

    warm with num_ctx=16384            load 11.33s
    the keep-alive ping (no num_ctx)   load 10.31s   <- changes the context
    next real request, num_ctx=16384   load 11.03s   <- forced to reload again

    real request, num_ctx=16384        load 11.28s
    ping WITH num_ctx=16384            load  0.00s
    next real request, num_ctx=16384   load  0.00s   <- fixed

The cell-5 keep-alive omitted num_ctx, so every 60 seconds it asked Ollama for
a different context size. Ollama answers that by reloading the model, which
also throws away the KV cache. Every chat turn after a tick therefore paid
about 11s of reload plus a cold prefill that measured 23.09s against 5.09s
warm -- roughly 29 seconds lost per minute of conversation, and the reload
window is also when /api/ps reports an empty models[].

Run from the repo root:  python3 scripts/keepalive-numctx-fix.py
"""
import hashlib
import json

P = 'android/app/src/main/assets/aether-notebook-template.json'

OLD = "'prompt': 'ping', 'stream': False, 'options': {'num_predict': 1}, 'keep_alive': -1}"
NEW = ("'prompt': 'ping', 'stream': False, 'options': {'num_predict': 1, "
       "'num_ctx': globals().get('NUM_CTX', 16384)}, 'keep_alive': -1}")


def main():
    nb = json.load(open(P))
    s = nb['cells'][5]['source']
    if "'num_ctx': globals()" in s:
        print('keep-alive ping already matches num_ctx -- nothing to do')
        return
    assert s.count(OLD) == 1, s.count(OLD)
    s = s.replace(OLD, NEW)
    nb['cells'][5]['source'] = s
    open(P, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))
    compile(s, 'cell5', 'exec')
    raw = open(P, 'rb').read()
    print('template %d bytes sha %s (cell 5 compiles)'
          % (len(raw), hashlib.sha256(raw).hexdigest()))


if __name__ == '__main__':
    main()
