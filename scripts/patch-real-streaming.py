#!/usr/bin/env python3
"""
Audit §4 item 9 — the engine fakes its stream.

It called ollama with stream:False, waited for the ENTIRE generation, then
replayed the finished answer word by word with time.sleep(0.006). Perceived
latency was the full generation before the first token appeared.

Fix: call ollama with stream:true and forward each content delta the moment it
arrives. Tool-call detection still works because ollama reports tool_calls in
the streamed chunks, so the aggregated response keeps the same shape and the
agent loop needs no other change.
"""
import base64, hashlib, json, re, sys

TS = "src/server/engine/aether-engine-source.ts"
src = open(TS).read()

m = re.search(r"const B64 =\s*\n((?:\s*\"[^\"]*\" \+\n)+)\s*\"([^\"]*)\";\n", src)
if not m:
    m = re.search(r"const B64 =\s*\n((?:\s*\"[^\"]*\" \+\n)*)\s*\"([^\"]*)\";\n", src)
assert m, "could not locate the B64 block"
chunks = re.findall(r'"([^"]+)"', m.group(0))
chunks = [c for c in chunks if re.fullmatch(r"[A-Za-z0-9+/=]+", c)]
nb_text = base64.b64decode("".join(chunks)).decode()
nb = json.loads(nb_text)


def cell_code(c):
    s = c.get("source", [])
    return "".join(s) if isinstance(s, list) else (s or "")


# ---------------------------------------------------------------- patch python
OLLAMA_CHAT = """def ollama_chat(payload, timeout=600):
    r = subprocess.run(['curl','-s','-m',str(timeout),'http://127.0.0.1:11434/api/chat','-d',json.dumps(payload)], capture_output=True, text=True)
    try: return json.loads(r.stdout)
    except Exception: return {'message':{'content':'(model timeout/error)'}, 'done':True}"""

OLLAMA_STREAM = OLLAMA_CHAT + """

def ollama_stream(payload, push, timeout=1200):
    # FIX (audit 4.9): stream:true, forwarding every content delta as it lands
    # instead of buffering the whole answer. Returns the same aggregated shape
    # ollama_chat returned, so the agent loop below is unchanged. push(delta)
    # returns False once the client is gone, which stops the read early.
    p = subprocess.Popen(['curl','-s','-N','-m',str(timeout),'http://127.0.0.1:11434/api/chat','-d',json.dumps(payload)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    agg = {'message': {'role':'assistant','content':''}, 'done': False}
    tcs, ths = [], []
    try:
        for raw in p.stdout:
            raw = raw.strip()
            if not raw: continue
            try: ch = json.loads(raw)
            except Exception: continue
            mm = ch.get('message') or {}
            d = mm.get('content') or ''
            if d:
                agg['message']['content'] += d
                if not push(d): break
            t = (mm.get('thinking') or mm.get('reasoning_content') or '')
            if t: ths.append(t)
            for tc in (mm.get('tool_calls') or []): tcs.append(tc)
            for k in ('eval_count','eval_duration','total_duration','prompt_eval_count','done_reason','model'):
                if k in ch: agg[k] = ch[k]
            if ch.get('done'): agg['done'] = True
    except Exception: pass
    finally:
        try: p.kill()
        except Exception: pass
    if tcs: agg['message']['tool_calls'] = tcs
    if ths: agg['message']['thinking'] = ''.join(ths)
    if not agg['message']['content'] and not tcs:
        agg['message']['content'] = '(model timeout/error)'
        agg['done'] = True
    return agg"""

PAYLOAD_OLD = "'messages': msgs[-24:], 'stream': False, 'tools': TOOLS"
PAYLOAD_NEW = "'messages': msgs[-24:], 'stream': True, 'tools': TOOLS"

THREAD_OLD = """        q = queue.Queue()
        tw = threading.Thread(target=lambda q=q, p=payload: q.put(ollama_chat(p)))
        tw.start()"""
THREAD_NEW = """        q = queue.Queue()
        st = {'gone': False, 'any': False}
        def push(d, st=st):
            if st['gone']: return False
            try:
                emit({'message':{'content': d}, 'done': False})
                st['any'] = True
                return True
            except Exception:
                st['gone'] = True
                return False
        tw = threading.Thread(target=lambda q=q, p=payload, s=push: q.put(ollama_stream(p, s)))
        tw.start()"""

FAKE_OLD = """        content = m.get('content') or ''
        if not content:
            content = '(I hit my tool-step limit before writing the final answer - please say retry)'
        if content:
            for w in content.split(' '):
                emit({'message':{'content': w + ' '}, 'done': False})
                time.sleep(0.006)"""
FAKE_NEW = """        content = m.get('content') or ''
        # FIX (audit 4.9): the answer was already streamed token by token while
        # it was being generated. Re-emitting it here would double it, so this
        # only fires for the fallback text, which was never streamed.
        if not st['any']:
            if not content:
                content = '(I hit my tool-step limit before writing the final answer - please say retry)'
            emit({'message':{'content': content}, 'done': False})"""

patched = 0
for c in nb["cells"]:
    if c.get("cell_type") != "code":
        continue
    code = cell_code(c)
    orig = code
    for old, new in ((OLLAMA_CHAT, OLLAMA_STREAM), (PAYLOAD_OLD, PAYLOAD_NEW),
                     (THREAD_OLD, THREAD_NEW), (FAKE_OLD, FAKE_NEW)):
        if old in code:
            assert code.count(old) == 1, f"anchor not unique: {old[:48]!r}"
            code = code.replace(old, new)
            patched += 1
    if code != orig:
        c["source"] = code

assert patched == 4, f"expected 4 patches, applied {patched}"

all_code = "\n".join(cell_code(c) for c in nb["cells"] if c.get("cell_type") == "code")
compile(all_code, "<engine>", "exec")          # syntax must be valid
assert "time.sleep(0.006" not in all_code, "fake stream survived"
assert "for w in content.split" not in all_code, "word replay survived"
assert "'stream': False, 'tools'" not in all_code, "non-streaming tool loop survived"
assert all_code.count("def ollama_stream") == 1

# ---------------------------------------------------------------- re-encode
new_nb_text = json.dumps(nb)
b64 = base64.b64encode(new_nb_text.encode()).decode()
lines = [b64[i:i + 76] for i in range(0, len(b64), 76)]
block = "const B64 =\n" + "".join(f'  "{l}" +\n' for l in lines[:-1]) + f'  "{lines[-1]}";\n'
start, end = m.span()
src = src[:start] + block + src[end:]

new_pin = hashlib.sha256(new_nb_text.encode()).hexdigest()
src = re.sub(r'export const AETHER_NOTEBOOK_SHA256 = "[0-9a-f]{64}";',
             f'export const AETHER_NOTEBOOK_SHA256 = "{new_pin}";', src)
open(TS, "w").write(src)

print(f"  patches applied   : {patched}/4")
print(f"  engine python     : {len(all_code)} chars, compiles clean")
print(f"  notebook template : {len(new_nb_text)} bytes")
print(f"  new sha256        : {new_pin}")
