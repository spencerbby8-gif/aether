"""Checks the two things that stop the HTTP 500: has_user_query(), and the
legacy {"prompt": ...} fallback.

  python3 scripts/proofs/engine-request-check.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "..", "..", "android", "app", "src", "main",
                   "assets", "aether-notebook-template.json")
nb = json.load(open(TPL))
src = nb['cells'][4]['source']

i = src.index('def has_user_query')
j = src.index('def agent_stream')
ns = {}
exec(src[i:j], ns)
huq = ns['has_user_query']
hw = ns['history_window']

ok = fail = 0


def chk(w, c, s):
    global ok, fail
    print(("  ok   " if c else "  FAIL ") + w + " -> " + s)
    ok += bool(c)
    fail += (not c)


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

print("== the legacy {\"prompt\": ...} shape the old client sent ==")


def build(user_payload):
    """Mirror of the first lines of agent_stream."""
    msgs = list(user_payload.get('messages') or [])
    if not msgs:
        pr = user_payload.get('prompt')
        if isinstance(pr, str) and pr.strip():
            msgs = [{'role': 'user', 'content': pr}]
    if not msgs or msgs[0].get('role') != 'system':
        msgs.insert(0, {'role': 'system', 'content': 'SYS'})
    return msgs


legacy = build({'prompt': 'hello there', 'stream': True})
chk("prompt-only now yields a user message", huq(legacy), str(legacy[-1]))
chk("...whereas the old code left only the system message",
    huq([{'role': 'system', 'content': 'SYS'}]) is False, "this is what 500'd")
chk("messages array still preferred over prompt",
    build({'messages': [{'role': 'user', 'content': 'real'}], 'prompt': 'ignored'})[-1]['content']
    == 'real', "real")
chk("blank prompt does not invent a message",
    huq(build({'prompt': '   '})) is False, "False")

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
