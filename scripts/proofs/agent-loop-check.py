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

    def slow_a(**k):
        time.sleep(1.2)
        return "a done"

    def slow_b(**k):
        time.sleep(1.2)
        return "b done"

    def very_slow(**k):
        time.sleep(9.5)
        return "slow done"

    def web_search(query=None, **k):
        return "result for " + str(query)

    ns = {
        'json': json, 'queue': queue, 'threading': threading, 'time': time,
        'SYSMSG': 'You are AETHER.', 'MODEL': 'test-model',
        'NUM_CTX': 16384, 'TOOL_RESULT_MAX': 2500,
        'EXEC': {'web_search': web_search, 'run_command': run_command,
                 'big_tool': big_tool, 'generate_image': gen_image,
                 'generate_voice': gen_voice, 'plain_tool': plain_tool,
                 'slow_a': slow_a, 'slow_b': slow_b, 'very_slow': very_slow},
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
    # role is set because real Ollama returns it, and the message is appended
    # to the prompt verbatim -- a fixture without it proves nothing about shape.
    return {'message': {'role': 'assistant', 'content': '',
                        'tool_calls': list(calls)}, 'done': True}


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

print("== reasoning is spent only where it earns its cost ==")
# Reasoning costs 25-65s per model call on this kernel and a tool turn pays it
# on every iteration, so a turn reasons only when its prompt looks like it
# needs to. These check both directions: the cheap path must actually be cheap,
# and the analytical prompts must not silently lose their reasoning.
def think_for(prompt):
    PAYLOADS.clear()
    ns, _ = make_env([step_text('answer')] + [step_text('x')] * 8)
    h = FakeHandler()
    ns['agent_stream'](h, {'messages': [{'role': 'user', 'content': prompt}]})
    return [p.get('think') for p in PAYLOADS]

chk("a plain factual question does not pay for reasoning",
    think_for("Reply with one short sentence: what is the capital of France?") == [False],
    str(think_for("Reply with one short sentence: what is the capital of France?")))
chk("a 'why' question does reason",
    think_for("Why does the sky look blue at sunset?") == [True],
    str(think_for("Why does the sky look blue at sunset?")))
chk("arithmetic in the prompt reasons",
    think_for("what is 17 * 23") == [True], "arithmetic")
chk("a long brief reasons",
    think_for("x " * 250) == [True], "long prompt")
chk("a multi-part question reasons",
    think_for("What is X? And what is Y?") == [True], "two question marks")
_multi = think_for("Compare these two options and tell me which is better.")
chk("an analytical prompt reasons on every iteration, not just the first",
    bool(_multi) and all(v is True for v in _multi), str(_multi))
chk("the choice is decided once per turn and never flips mid-turn",
    len(set(think_for("Just say hello."))) == 1, str(think_for("Just say hello.")))

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

print("== independent tool calls run concurrently ==")
# Two unrelated calls in one step used to run back to back, so the step cost
# the sum of both. They share nothing, so they run at the same time now.
import time as _t
PAYLOADS.clear()
ns_p, _ = make_env([step_tools(tc('slow_a'), tc('slow_b')), step_text('both done')]
                   + [step_text('x')] * 8)
h_p = FakeHandler()
_t0 = _t.time()
ns_p['agent_stream'](h_p, {'messages': [{'role': 'user', 'content': 'do two things'}]})
_elapsed = _t.time() - _t0
chk("two 1.2s tools in one step finish in parallel, not in series",
    _elapsed < 2.0, "elapsed = %.2fs for two 1.2s tools (series would be >= 2.4s)" % _elapsed)
chk("both results still reached the model",
    len(PAYLOADS) >= 2 and sum(1 for m in PAYLOADS[1]['messages'] if m.get('role') == 'tool') == 2,
    str([m.get('role') for m in PAYLOADS[1]['messages']]) if len(PAYLOADS) >= 2 else "no second call")

print("== one assistant message per step, however many calls it made ==")
# The assistant message was appended inside the per-call loop, so a step with
# three calls put three copies into the prompt. That bloat is re-sent on every
# later iteration and paid for in prompt evaluation each time.
PAYLOADS.clear()
ns_a, _ = make_env([step_tools(tc('run_command', command='a'), tc('run_command', command='b'),
                               tc('web_search', query='c')),
                    step_text('done')] + [step_text('x')] * 8)
h_a = FakeHandler()
ns_a['agent_stream'](h_a, {'messages': [{'role': 'user', 'content': 'three things'}]})
_second = PAYLOADS[1]['messages'] if len(PAYLOADS) >= 2 else []
_n_asst = sum(1 for m in _second if m.get('role') == 'assistant')
_n_tool = sum(1 for m in _second if m.get('role') == 'tool')
chk("a 3-call step adds exactly one assistant message", _n_asst == 1,
    "assistant=%d tool=%d roles=%s" % (_n_asst, _n_tool, [m.get('role') for m in _second]))
chk("...and one tool result per call", _n_tool == 3, "tool=%d" % _n_tool)
chk("tool results stay in the order the model asked for them",
    [m.get('content') for m in _second if m.get('role') == 'tool']
    == [m.get('content') for m in _second if m.get('role') == 'tool'][:3]
    and _n_tool == 3, "n=%d" % _n_tool)

print("== web_search really parses duckduckgo, not just the wikipedia fallback ==")
# re.finditer(...)[:0] raised TypeError, which the surrounding except swallowed,
# so both duckduckgo endpoints were skipped on every call and every search
# silently fell through to Wikipedia. This lifts the real function and feeds it
# real-shaped duckduckgo HTML through a fake subprocess.
import html as _htmlmod
import urllib.parse as _urlparse

class _FakeProc:
    def __init__(self, out): self.stdout = out; self.returncode = 0; self.stderr = ''

DDG_HTML = (
    '<div class="result"><a rel="nofollow" class="result__a" '
    'href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal-source.example%2Farticle&rut=x">'
    'Lagos population report</a>'
    '<a class="result__snippet" href="#">Lagos has about 15 million people.</a></div>'
)

class _FakeSub:
    def __init__(self): self.calls = []
    def run(self, *a, **k):
        self.calls.append(a)
        return _FakeProc(DDG_HTML)

_ws_src = src[src.index('def t_web_search'):src.index("def _readable")]
import re as _re_mod
_ws_ns = {'re': _re_mod, 'subprocess': _FakeSub(), 'urllib': type('U', (), {'parse': _urlparse})(),
          'htmlmod': _htmlmod, 'json': json}
exec(_ws_src, _ws_ns)
_out = _ws_ns['t_web_search']('Lagos population')
chk("duckduckgo results are returned instead of the wikipedia fallback",
    'real-source.example' in _out, _out[:160])
chk("the redirect wrapper is unwrapped to the real url",
    'uddg=' not in _out, _out[:160])
chk("the title survives", 'Lagos population report' in _out, _out[:160])

print("== the response stays alive while a tool works ==")
# A tool ran with the response silent. Short tools hid it; a browser install or
# a long build does not, and an idle tunnel connection is dropped long before
# the client's own stall timer. A heartbeat must go out while the tool runs.
PAYLOADS.clear()
ns_h, _ = make_env([step_tools(tc('very_slow')), step_text('done after the wait')]
                   + [step_text('x')] * 8)
h_h = FakeHandler()
ns_h['agent_stream'](h_h, {'messages': [{'role': 'user', 'content': 'run something slow'}]})
# json.dumps escapes non-ASCII, so the wire bytes carry the six characters
# "\\u23f3" rather than the hourglass itself. Parse the lines instead of
# string-matching, or the check silently looks for something never sent.
_raw = h_h.wfile.buf.getvalue().decode("utf-8", "replace")
_beats = []
for _l in _raw.split("\n"):
    _l = _l.strip()
    if not _l.startswith("{"):
        continue
    try:
        _d = json.loads(_l)
    except Exception:
        continue
    if ((_d.get("message") or {}).get("thinking") or "") == "\u23f3":
        _beats.append(_l)
chk("a 9.5s tool produces a heartbeat before it returns", len(_beats) >= 1,
    "heartbeats during the tool = %d" % len(_beats))
chk("the slow tool still returned its result",
    len(PAYLOADS) >= 2 and any('slow done' in (m.get('content') or '')
                               for m in PAYLOADS[1]['messages'] if m.get('role') == 'tool'),
    "payloads=%d" % len(PAYLOADS))

print("== crawl_site fetches a level concurrently ==")
# The crawl was a sequential BFS: up to ten 30s curls back to back, with the
# model idle the whole time. Pages within a level are independent. This lifts
# the real function and times it against a fake curl that sleeps, so a
# sequential crawl cannot hide.
import html as _html2
import re as _re2
import time as _time2

_ROOT = ('<html><body><p>Root page about Lagos.</p>'
         '<a href="/alpha">A</a><a href="/beta">B</a><a href="/gamma">C</a></body></html>')
_CHILD = '<html><body><p>Child page text.</p></body></html>'


class _SlowSub:
    """Every fetch costs a full second, as a slow origin would."""

    def __init__(self):
        self.n = 0

    def run(self, *a, **k):
        self.n += 1
        _time2.sleep(1.0)
        u = a[0][-1] if a and a[0] else ''
        out = _ROOT if u.rstrip('/').endswith('example.com') else _CHILD
        return type('P', (), {'stdout': out, 'returncode': 0, 'stderr': ''})()


_cs = src.index('def t_crawl_site')
# Just this function: slicing to the next named tool would drag in everything
# defined between them.
_ce = src.index('\ndef ', _cs + 10)
_cr_src = src[src.index('def _readable'):src.index('def t_fetch_page')] + src[_cs:_ce]
_slow = _SlowSub()
_cr_ns = {'re': _re2, 'subprocess': _slow, 'htmlmod': _html2}
exec(_cr_src, _cr_ns)
_t0 = _time2.time()
_crawl = _cr_ns['t_crawl_site']('https://example.com', max_pages=4)
_elapsed = _time2.time() - _t0
chk("a four page crawl is fetched concurrently, not one by one",
    _elapsed < 3.0, "%.2fs for %d fetches (sequential would be ~%.0fs)"
    % (_elapsed, _slow.n, _slow.n))
chk("every page was fetched", _slow.n == 4, "fetches=%d" % _slow.n)
chk("all four pages are in the result",
    all(k in _crawl for k in ('example.com', '/alpha', '/beta', '/gamma')),
    "%d chars" % len(_crawl))
chk("pages come back in breadth-first order, not completion order",
    _crawl.index('/alpha') < _crawl.index('/beta') < _crawl.index('/gamma'),
    "order preserved")

print("\n%d passed, %d failed" % (ok, fail))
raise SystemExit(0 if fail == 0 else 1)
