"""Unit-checks history_window() straight out of the kernel template.

Proves the window always keeps the system prompt and the newest real user
query, keeps every tool result of the current turn, honours the character
budget, and never orphans a tool result -- and shows that the old
msgs[-24:] slice loses the question on exactly this shape.

  python3 scripts/proofs/history-window-check.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "..", "..", "android", "app", "src", "main",
                   "assets", "aether-notebook-template.json")
nb = json.load(open(TPL))
src = nb['cells'][4]['source']
i = src.index('def history_window')
j = src.index('def agent_stream')
ns = {}
exec(src[i:j], ns)
hw = ns['history_window']

ok = fail = 0


def chk(w, c, s):
    global ok, fail
    print(("  ok   " if c else "  FAIL ") + w + " -> " + s)
    ok += bool(c)
    fail += (not c)


def realuser(ms):
    return sum(1 for m in ms if m.get('role') == 'user')


def chars(ms):
    return sum(len(str(m.get('content') or '')) for m in ms)


# The user's turn: one request that searches, fetches pictures and runs commands.
ms = [{'role': 'system', 'content': 'You are Aether.'}]
for q in range(3):
    ms.append({'role': 'user', 'content': 'question %d' % q})
    ms.append({'role': 'assistant', 'content': 'answer %d' % q})
ms.append({'role': 'user', 'content': 'Do a live search, fetch pics online and run commands.'})
for t in range(13):
    ms.append({'role': 'assistant', 'content': '',
               'tool_calls': [{'function': {'name': 'web_search', 'arguments': {'query': 'q'}}}]})
    ms.append({'role': 'tool', 'content': 'x' * 900, 'tool_name': 'web_search'})

old = ms[-24:]
new = hw(ms)
print("conversation %d msgs / %d chars -> old window %d msgs, new window %d msgs"
      % (len(ms), chars(ms), len(old), len(new)))

chk("OLD window had no user query (the 500)", realuser(old) == 0, "users = %d" % realuser(old))
chk("NEW window keeps a user query", realuser(new) >= 1, "users = %d" % realuser(new))
chk("NEW window keeps the CURRENT question",
    any('live search' in str(m.get('content')) for m in new), "present")
chk("NEW window keeps all 13 tool results",
    sum(1 for m in new if m['role'] == 'tool') == 13,
    "tool results = %d" % sum(1 for m in new if m['role'] == 'tool'))
chk("NEW window honours the CHAR budget", chars(new) <= 20000, "chars = %d" % chars(new))
chk("NEW window starts with the system prompt", new[0]['role'] == 'system', new[0]['role'])
roles = [m['role'] for m in new]
chk("no orphaned tool result",
    all(roles[k - 1] in ('assistant', 'tool') for k, r in enumerate(roles) if r == 'tool'),
    "".join({'system': 'S', 'user': 'U', 'assistant': 'A', 'tool': 'T'}[r] for r in roles))

# A plain long chat must still shrink.
long_chat = [{'role': 'system', 'content': 's'}]
for i in range(30):
    long_chat.append({'role': 'user', 'content': 'q%d' % i})
    long_chat.append({'role': 'assistant', 'content': 'a%d' % i})
lc = hw(long_chat)
chk("plain long chat still shrinks to the cap", len(lc) <= 24, "len = %d" % len(lc))
chk("plain long chat keeps its newest turn", lc[-1]['content'] == 'a29', lc[-1]['content'])
chk("plain long chat keeps a user query", realuser(lc) >= 1, "users = %d" % realuser(lc))

chk("short history passes through untouched",
    hw([{'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'hi'}])
    == [{'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'hi'}], "len 2")
chk("empty input", hw([]) == [], str(hw([])))

print("\n%d passed, %d failed" % (ok, fail))
raise SystemExit(0 if fail == 0 else 1)
