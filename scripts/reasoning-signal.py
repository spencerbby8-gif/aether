"""Tell the client when the model is genuinely reasoning.

Reasoning was accumulated into `ths` and attached to the aggregated message,
but never surfaced while it happened -- and the agent loop strips it before it
goes anywhere. So a turn that spent 40s thinking looked exactly like one that
did not: the same "agent step" event, then silence. The UI licensed its
"Thinking" label from the iteration marker, not from reasoning, which means it
said "Thinking" for every turn whether the model thought or not.

This emits a single content-free marker the moment the first reasoning token
arrives. The reasoning text itself is still never forwarded: the standing rule
is that hidden chain of thought is not exposed, and a marker satisfies "show
that it is thinking" without breaking it.

Run from the repo root:  python3 scripts/reasoning-signal.py
"""
import hashlib
import json

P = 'android/app/src/main/assets/aether-notebook-template.json'

OLD_SIG = "def ollama_stream(payload, push, timeout=1200):"
NEW_SIG = "def ollama_stream(payload, push, timeout=1200, on_think=None):"

OLD_TH = """                t = (mm.get('thinking') or mm.get('reasoning_content') or '')
                if t: ths.append(t)"""
NEW_TH = """                t = (mm.get('thinking') or mm.get('reasoning_content') or '')
                if t:
                    ths.append(t)
                    # Say that reasoning is happening, never what it says. The
                    # text stays server side; only this signal travels.
                    if on_think is not None:
                        try: on_think()
                        except Exception: pass"""

OLD_CALL = "        tw = threading.Thread(target=lambda q=q, p=payload, s=push: q.put(ollama_stream(p, s)))"
NEW_CALL = """        _th = {'sent': False}

        def on_think(_th=_th):
            # Once per model call: enough for the client to show that the model
            # is reasoning, cheap enough to leave on every turn.
            if _th['sent']:
                return
            _th['sent'] = True
            emit({'message': {'thinking': '\\U0001f9e0'}, 'done': False})

        tw = threading.Thread(target=lambda q=q, p=payload, s=push, ot=on_think: q.put(ollama_stream(p, s, on_think=ot)))"""


def main():
    nb = json.load(open(P))
    s = nb['cells'][4]['source']
    if 'on_think' in s:
        print('reasoning signal already present -- nothing to do')
        return
    for old, new in ((OLD_SIG, NEW_SIG), (OLD_TH, NEW_TH), (OLD_CALL, NEW_CALL)):
        assert s.count(old) == 1, (s.count(old), old[:60])
        s = s.replace(old, new)
    nb['cells'][4]['source'] = s
    open(P, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))
    compile(s, 'cell4', 'exec')
    raw = open(P, 'rb').read()
    print('template %d bytes sha %s (compiles)'
          % (len(raw), hashlib.sha256(raw).hexdigest()))


if __name__ == '__main__':
    main()
