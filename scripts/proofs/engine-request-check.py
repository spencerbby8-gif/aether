#!/usr/bin/env python3
"""Checks the two things that stop the HTTP 500: has_user_query(), and the
legacy {"prompt": ...} fallback.

Everything here runs code lifted VERBATIM out of the kernel template. An
earlier version of this file mirrored agent_stream's first lines in a local
build() function, which meant deleting the real fallback changed nothing -- a
mutation test caught that. It now drives the real agent_stream and asserts on
the payload the model is actually handed.

  python3 scripts/proofs/engine-request-check.py
"""
import io
import json
import os
import queue
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "..", "..", "android", "app", "src", "main",
                   "assets", "aether-notebook-template.json")
src = json.load(open(TPL))['cells'][4]['source']

helpers = src[src.index('def has_user_query'):src.index('def agent_stream')]
agent_src = src[src.index('def agent_stream(handler, user_payload):'):
                src.index('PAGE_HTML = r"""')]

ok = fail = 0


def chk(w, c, s):
    global ok, fail
    print(("  ok   " if c else "  FAIL ") + w + " -> " + s)
    ok += bool(c)
    fail += (not c)


class FakeW:
    def __init__(self):
        self.buf = io.BytesIO()

    def write(self, b):
        return self.buf.write(b)

    def flush(self):
        pass


class FakeHandler:
    close_connection = False

    def __init__(self):
        self.wfile = FakeW()
        self._sent = False

    def send_response(self, *a):
        pass

    def send_header(self, *a):
        pass

    def end_headers(self):
        pass


class FakeProc:
    def __init__(self, lines):
        self.stdout = lines

    def kill(self):
        pass


class FakeSubprocess:
    PIPE = -1

    def Popen(self, *a, **k):
        return FakeProc([
            json.dumps({'message': {'content': 'FINAL'}, 'done': False}).encode(),
            json.dumps({'message': {'content': ''}, 'done': True}).encode(),
        ])


def run_agent(payload):
    """Run the REAL agent_stream. Returns (payloads the model saw, client text)."""
    seen = []

    def ollama_stream(p, push):
        seen.append(json.loads(json.dumps(p)))
        m = {'content': 'ok'}
        push(m['content'])
        return {'message': m, 'done': True}

    ns = {
        'json': json, 'queue': queue, 'threading': threading, 'time': time,
        'SYSMSG': 'You are AETHER.', 'MODEL': 'test-model',
        'NUM_CTX': 16384, 'TOOL_RESULT_MAX': 2500,
        'TOOLS': [{"type": "function", "function": {"name": "web_search"}}],
        'EXEC': {'web_search': lambda **k: 'r'},
        'ollama_stream': ollama_stream,
        'subprocess': FakeSubprocess(),
        'LAST_HIT': {'t': 0},
    }
    exec(helpers, ns)
    exec(agent_src, ns)
    h = FakeHandler()
    ns['agent_stream'](h, payload)
    text = h.wfile.buf.getvalue().decode('utf-8', 'replace')
    chunks = []
    for line in text.split('\n'):
        line = line.strip()
        if line.startswith('{'):
            try:
                chunks.append((json.loads(line).get('message') or {}).get('content') or '')
            except Exception:
                pass
    return seen, ''.join(chunks)


ns0 = {}
exec(helpers, ns0)
huq = ns0['has_user_query']
exec(src[src.index('def history_window'):src.index('def has_user_query')], ns0)
hw = ns0['history_window']

print("== has_user_query: the exact condition the template enforces ==")
chk("plain user message", huq([{'role': 'user', 'content': 'hi'}]) is True, "True")
chk("empty content still counts (template only rejects the wrapper)",
    huq([{'role': 'user', 'content': ''}]) is True, "True")
chk("system only -> rejected", huq([{'role': 'system', 'content': 's'}]) is False, "False")
chk("tool results alone -> rejected",
    huq([{'role': 'user', 'content': '<tool_response>x</tool_response>'}]) is False, "False")
chk("assistant + tool only -> rejected",
    huq([{'role': 'assistant', 'content': 'a'},
         {'role': 'tool', 'content': 't'}]) is False, "False")
chk("user BEFORE tool traffic -> accepted",
    huq([{'role': 'user', 'content': 'q'},
         {'role': 'assistant', 'content': 'a'},
         {'role': 'tool', 'content': 't'}]) is True, "True")
chk("multimodal content list", huq([{'role': 'user',
                                     'content': [{'type': 'text', 'text': 'hi'}]}]) is True, "True")
chk("empty list", huq([]) is False, "False")

print("== the legacy {\"prompt\": ...} shape, through the REAL agent_stream ==")
seen, _ = run_agent({'prompt': 'hello there', 'stream': True})
msgs = seen[0]['messages'] if seen else []
chk("prompt-only reaches the model at all", len(seen) == 1, "model calls = %d" % len(seen))
chk("...with the prompt as a user message",
    bool(msgs) and msgs[-1].get('role') == 'user' and msgs[-1].get('content') == 'hello there',
    str(msgs[-1]) if msgs else "no messages")
chk("...and a system message in front",
    bool(msgs) and msgs[0].get('role') == 'system', msgs[0].get('role') if msgs else "none")
chk("the model would accept that window", huq(msgs), "has_user_query = %s" % huq(msgs))

seen2, _ = run_agent({'messages': [{'role': 'user', 'content': 'real'}], 'prompt': 'ignored'})
m2 = seen2[0]['messages'] if seen2 else []
chk("messages array wins over prompt",
    any(x.get('content') == 'real' for x in m2)
    and not any(x.get('content') == 'ignored' for x in m2), str(m2))

seen3, out3 = run_agent({'stream': True})
chk("empty request never calls the model", len(seen3) == 0, "model calls = %d" % len(seen3))
chk("empty request returns one clear line instead of a 500",
    'no user message in it' in out3, out3[:70])

seen4, _ = run_agent({'prompt': '   ', 'stream': True})
chk("blank prompt does not invent a message", len(seen4) == 0,
    "model calls = %d" % len(seen4))

print("== guard + window together on the failing shapes ==")
storm = [{'role': 'system', 'content': 'SYS'},
         {'role': 'user', 'content': 'search, fetch and run commands'}]
for t in range(13):
    storm.append({'role': 'assistant', 'content': '',
                  'tool_calls': [{'function': {'name': 'w', 'arguments': {}}}]})
    storm.append({'role': 'tool', 'content': 'x' * 800, 'tool_name': 'w'})
chk("12+ tool-call turn still carries the question", huq(hw(storm)), "accepted")
chk("the old slice would have been rejected", huq(storm[-24:]) is False,
    "msgs[-24:] -> rejected (this was the 500)")

print("\n%d passed, %d failed" % (ok, fail))
raise SystemExit(0 if fail == 0 else 1)
