#!/usr/bin/env python3
"""Runs the REAL agent_stream from the kernel template against a scripted fake
model, so the loop logic is tested without a nine-minute Kaggle boot.

Nothing about the loop is reimplemented here: the function source is lifted
verbatim out of the notebook and only its dependencies are stubbed.

  python3 scripts/proofs/agent-loop-check.py
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

i = src.index('def agent_stream(handler, user_payload):')
# agent_stream is the last function before the page markup begins
j = src.index('PAGE_HTML = r"""', i)
func_src = src[i:j]

# also need the two helpers it calls
h_i = src.index('def has_user_query')
h_j = src.index('def agent_stream')
helpers = src[h_i:h_j]

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
    def __init__(self):
        self.wfile = FakeW()
        self._sent = False

    def send_response(self, *a):
        pass

    def send_header(self, *a):
        pass

    def end_headers(self):
        pass

    close_connection = False


class FakeProc:
    def __init__(self, lines):
        self.stdout = lines

    def kill(self):
        pass


class FakeSubprocess:
    """Stands in for the curl call the final-answer path makes."""

    PIPE = -1

    def __init__(self, lines):
        self.lines = lines

    def Popen(self, *a, **k):
        return FakeProc(self.lines)


TOOL_CALLS_SEEN = []
PAYLOADS = []


def make_env(script):
    """script: list of model responses, one per iteration."""
    calls = {'n': 0}

    def ollama_stream(payload, push):
        k = calls['n']
        calls['n'] += 1
        PAYLOADS.append(json.loads(json.dumps(payload)))
        TOOL_CALLS_SEEN.append([tc['function']['name']
                                for tc in (script[k].get('message', {}).get('tool_calls') or [])])
        m = dict(script[k].get('message', {}))
        if m.get('content'):
            push(m['content'])
        return {'message': m, 'done': True, 'eval_count': 1}

    def run_command(command=None, **k):
        return "Mon Sep 7 15:00:00 UTC 2026"

    def big_tool(**k):
        return "x" * 9000

    def gen_image(**k):
        return ("IMAGE READY: https://tunnel.example/files/pic.jpg (48213 bytes) "
                "- give the user this URL and they can view it in the browser.")

    def gen_voice(**k):
        return ("AUDIO READY: https://tunnel.example/files/say.wav (90112 bytes) "
                "- give the user this URL so they can play it.")

    def plain_tool(**k):
        return "nothing generated here"

    def web_search(query=None, **k):
        return "result for " + str(query)

    ns = {
        'json': json, 'queue': queue, 'threading': threading, 'time': time,
        'SYSMSG': 'You are AETHER.', 'MODEL': 'test-model',
        'NUM_CTX': 16384, 'TOOL_RESULT_MAX': 2500,
        'EXEC': {'web_search': web_search, 'run_command': run_command,
                 'big_tool': big_tool, 'generate_image': gen_image,
                 'generate_voice': gen_voice, 'plain_tool': plain_tool},
        'TOOLS': [{"type": "function", "function": {"name": "web_search"}},
                  {"type": "function", "function": {"name": "run_command"}}],
        'ollama_stream': ollama_stream,
        # the post-loop final answer call shells out; give it a canned reply
        'subprocess': FakeSubprocess([
            json.dumps({'message': {'content': 'FINAL ANSWER'}, 'done': False}).encode(),
            json.dumps({'message': {'content': ''}, 'done': True}).encode(),
        ]),
        'LAST_HIT': {'t': 0},
    }
    exec(helpers, ns)
    exec(func_src, ns)
    return ns, calls


def tc(name, **args):
    return {"function": {"name": name, "arguments": args}}


def step_tools(*calls):
    return {'message': {'content': '', 'tool_calls': list(calls)}, 'done': True}


def step_text(text):
    return {'message': {'content': text}, 'done': True}


print("== a model that loops on identical calls must be stopped ==")
script = [step_tools(tc('web_search', query='news'), tc('run_command', command='date -u'))] * 10
script += [step_text('final answer')]
ns, calls = make_env(script)
TOOL_CALLS_SEEN.clear()
h = FakeHandler()
ns['agent_stream'](h, {'messages': [{'role': 'user', 'content': 'search and run a command'}]})
body = h.wfile.buf.getvalue().decode('utf-8', 'replace')
chk("looping model does not use all 10 iterations", calls['n'] < 10,
    "model calls = %d" % calls['n'])
chk("the identical step was executed once, not repeatedly",
    TOOL_CALLS_SEEN.count(['web_search', 'run_command']) <= 2,
    "identical steps seen = %d" % TOOL_CALLS_SEEN.count(['web_search', 'run_command']))
chk("the turn still ends with done:true", '"done": true' in body,
    "done present = %s" % ('"done": true' in body))

print("== distinct calls are still allowed to run ==")
script2 = [step_tools(tc('web_search', query='lagos')),
           step_tools(tc('web_search', query='kano')),
           step_tools(tc('run_command', command='date -u')),
           step_text('done')]
script2 += [step_text('extra')] * 8
ns2, calls2 = make_env(script2)
TOOL_CALLS_SEEN.clear()
h2 = FakeHandler()
ns2['agent_stream'](h2, {'messages': [{'role': 'user', 'content': 'three different things'}]})
chk("three distinct tool calls all ran", calls2['n'] == 4,
    "model calls = %d (3 tool steps + 1 answer)" % calls2['n'])

print("== a partially repeated step keeps going, it is not a full loop ==")
script3 = [step_tools(tc('web_search', query='lagos')),
           step_tools(tc('web_search', query='lagos'), tc('web_search', query='kano')),
           step_text('done')]
script3 += [step_text('extra')] * 8
ns3, calls3 = make_env(script3)
h3 = FakeHandler()
ns3['agent_stream'](h3, {'messages': [{'role': 'user', 'content': 'two states'}]})
chk("a mixed step is not treated as a loop", calls3['n'] == 3,
    "model calls = %d" % calls3['n'])

print("== the model is always given a declared context window ==")
PAYLOADS.clear()
ns4, calls4 = make_env([step_tools(tc('big_tool')), step_text('done')] + [step_text('x')] * 8)
h4 = FakeHandler()
ns4['agent_stream'](h4, {'messages': [{'role': 'user', 'content': 'q'}]})
chk("every model call declares num_ctx",
    all((p.get('options') or {}).get('num_ctx') == 16384 for p in PAYLOADS) and PAYLOADS,
    "num_ctx = %s over %d calls" % ([(p.get('options') or {}).get('num_ctx') for p in PAYLOADS],
                                    len(PAYLOADS)))
last_tools = [m for p in PAYLOADS for m in p['messages'] if m.get('role') == 'tool']
chk("an oversized tool result is capped before it is resent",
    bool(last_tools) and all(len(str(m.get('content'))) <= 2600 for m in last_tools),
    "tool result lengths = %s" % [len(str(m.get('content'))) for m in last_tools])

print("== generated media is reported as a structured event ==")


def media_events(handler):
    out = []
    for line in handler.wfile.buf.getvalue().decode("utf-8", "replace").split("\n"):
        line = line.strip()
        if line.startswith("{") and '"media"' in line:
            try:
                d = json.loads(line)
                if d.get("media"):
                    out.append(d["media"])
            except Exception:
                pass
    return out


PAYLOADS.clear()
ns5, _ = make_env([step_tools(tc('generate_image', prompt='a sunset')),
                   step_text('here is your image')] + [step_text('x')] * 8)
h5 = FakeHandler()
ns5['agent_stream'](h5, {'messages': [{'role': 'user', 'content': 'draw a sunset'}]})
me = media_events(h5)
chk("an image produces exactly one media event", len(me) == 1, "events = %d" % len(me))
chk("the media event carries kind and the real url",
    bool(me) and me[0].get('kind') == 'image'
    and me[0].get('url') == 'https://tunnel.example/files/pic.jpg', str(me[:1]))

# The client stores this as MediaItem.source and shows it as provenance. The
# key name must match what EngineCore reads ("source"); an event keyed "name"
# parses fine and lands as an empty string, which is why this is asserted.
chk("the media event names the tool that made it, under the key the client reads",
    bool(me) and me[0].get('source') == 'generate_image', str(me[:1]))

ns6, _ = make_env([step_tools(tc('generate_voice', text='hello')),
                   step_text('here you go')] + [step_text('x')] * 8)
h6 = FakeHandler()
ns6['agent_stream'](h6, {'messages': [{'role': 'user', 'content': 'say hello'}]})
me6 = media_events(h6)
chk("audio produces a media event with kind audio",
    len(me6) == 1 and me6[0].get('kind') == 'audio'
    and me6[0].get('url') == 'https://tunnel.example/files/say.wav', str(me6[:1]))
chk("audio names its tool too",
    len(me6) == 1 and me6[0].get('source') == 'generate_voice', str(me6[:1]))

ns7, _ = make_env([step_tools(tc('plain_tool')), step_text('done')] + [step_text('x')] * 8)
h7 = FakeHandler()
ns7['agent_stream'](h7, {'messages': [{'role': 'user', 'content': 'q'}]})
chk("a tool that generates nothing emits no media event",
    len(media_events(h7)) == 0, "events = %d" % len(media_events(h7)))

chk("reasoning is requested from the model",
    all(p.get('think') is True for p in PAYLOADS) if PAYLOADS else False,
    "think = %s" % [p.get('think') for p in PAYLOADS])

print("== reasoning must not be re-sent as history ==")
# With think=True the model returns a 'thinking' field on every assistant
# message. agent_stream appends that message to msgs for the next tool
# iteration, so unless the reasoning is stripped it is re-sent on every pass.
# Several thousand reasoning tokens times ten iterations is exactly the kind of
# growth that pushes the prompt past num_ctx, and Ollama trims from the front
# -- which is what produced the original 'No user query found' HTTP 500.
def step_tools_think(*calls):
    # role is set because real Ollama returns it; the message is appended to
    # history verbatim, so the fixture has to look like the real thing.
    return {'message': {'role': 'assistant', 'content': '', 'thinking': 'R' * 3000,
                        'tool_calls': list(calls)}, 'done': True}

# Distinct commands each time, otherwise the repeat cap correctly stops the
# loop after two calls and there is no history growth to measure.
_cmds = ['date -u', 'date +%s', 'pwd', 'whoami']
script_th = [step_tools_think(tc('run_command', command=c)) for c in _cmds]
script_th += [step_text('all done')]
PAYLOADS.clear()
ns_th, _ = make_env(script_th)
h_th = FakeHandler()
ns_th['agent_stream'](h_th, {'messages': [{'role': 'user', 'content': 'run date a few times'}]})

leaked = [len(m.get('thinking') or '')
          for p in PAYLOADS for m in p['messages'] if m.get('thinking')]
chk("no reasoning text is sent back to the model as history",
    not leaked, "%d history messages carry reasoning, up to %d chars"
    % (len(leaked), max(leaked) if leaked else 0))
chk("the history still grows with real turns",
    len(PAYLOADS) >= 4 and len(PAYLOADS[-1]['messages']) > len(PAYLOADS[0]['messages']),
    "payloads=%d msgs=%d->%d" % (len(PAYLOADS), len(PAYLOADS[0]['messages']),
                                 len(PAYLOADS[-1]['messages'])))
chk("tool results are still in the history",
    any(m.get('role') == 'tool' for m in PAYLOADS[-1]['messages']),
    str([m.get('role') for m in PAYLOADS[-1]['messages']]))

print("\n%d passed, %d failed" % (ok, fail))
raise SystemExit(0 if fail == 0 else 1)
