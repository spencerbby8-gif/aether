#!/usr/bin/env python3
"""Mutation test: break each fix in a throwaway copy and confirm the matching
proof FAILS. A proof that still passes without the fix is not proving anything.
"""
import json
import os
import shutil
import subprocess
import sys

REPO = '/home/user/aether'
TPL_REL = 'android/app/src/main/assets/aether-notebook-template.json'
MUT = '/tmp/mut'


def setup(proof):
    if os.path.exists(MUT):
        shutil.rmtree(MUT)
    os.makedirs(MUT + '/scripts/proofs')
    os.makedirs(os.path.dirname(MUT + '/' + TPL_REL))
    shutil.copy(REPO + '/' + TPL_REL, MUT + '/' + TPL_REL)
    shutil.copy(REPO + '/scripts/proofs/' + proof, MUT + '/scripts/proofs/' + proof)
    return MUT + '/' + TPL_REL


def mutate(path, fn, name=''):
    nb = json.load(open(path))
    src = nb['cells'][4]['source']
    new = fn(src)
    # Name the case: a stale anchor otherwise aborts the whole run with a
    # traceback that does not say which mutation no longer matches.
    assert new != src, "mutation '%s' did not change anything -- stale anchor" % name
    nb['cells'][4]['source'] = new
    open(path, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))


def run(proof):
    p = subprocess.run([sys.executable, MUT + '/scripts/proofs/' + proof],
                       capture_output=True, text=True, timeout=300)
    tail = [l for l in p.stdout.splitlines() if 'passed' in l]
    return p.returncode, (tail[-1] if tail else p.stdout.strip()[-90:] or p.stderr[-90:])


def case(name, proof, fn):
    path = setup(proof)
    mutate(path, fn, name)
    rc, out = run(proof)
    caught = rc != 0
    print("  %-52s %s  %s" % (name, "caught" if caught else "*** NOT CAUGHT ***", out))
    return caught


def baseline(proof):
    setup(proof)
    rc, out = run(proof)
    print("  %-52s %s  %s" % ("baseline (unmutated)", "passes" if rc == 0 else "*** FAILS ***", out))
    return rc == 0


ok = 0
tot = 0

print("== agent-loop-check.py ==")
tot += 1
ok += baseline('agent-loop-check.py')


def drop_repeat_detection(s):
    i = s.index('                _key = name + ')
    j = s.index("                    emit({'message':{'thinking':'\U0001f6e0", i)
    return s[:i] + "                if False:\n                    pass\n                else:\n" + s[j:]


tot += 1
ok += case("repeat detection removed", 'agent-loop-check.py',
           lambda s: s.replace("if repeats and repeats == len(tcs):", "if False and repeats == len(tcs):"))

print("== history-window-check.py ==")
tot += 1
ok += baseline('history-window-check.py')
tot += 1
ok += case("history_window reverted to msgs[-24:]", 'history-window-check.py',
           lambda s: s.replace("    return head + keep + tail\n", "    return msgs[-max_msgs:]\n", 1))

print("== engine-request-check.py ==")
tot += 1
ok += baseline('engine-request-check.py')
tot += 1
ok += case("legacy {prompt} fallback removed", 'engine-request-check.py',
           lambda s: s.replace("        pr = user_payload.get('prompt')", "        pr = None"))
tot += 1
ok += case("has_user_query always returns True", 'engine-request-check.py',
           lambda s: s.replace("    for m in reversed(ms):\n        if m.get('role') != 'user':",
                               "    return True\n    for m in reversed(ms):\n        if m.get('role') != 'user':", 1))

tot += 1
ok += case("num_ctx removed from the model payload", 'agent-loop-check.py',
           lambda s: s.replace("'keep_alive': -1, 'options': {'num_ctx': NUM_CTX}}", "'keep_alive': -1}"))
tot += 1
ok += case("tool-result cap removed", 'agent-loop-check.py',
           lambda s: s.replace("                if len(result) > TOOL_RESULT_MAX:", "                if False:"))

tot += 1
ok += case("media event keyed 'name' instead of 'source'", 'agent-loop-check.py',
           lambda s: s.replace("'source': nm},", "'name': nm},"))
tot += 1
ok += case("media event not emitted at all", 'agent-loop-check.py',
           lambda s: s.replace("                if result.startswith('IMAGE READY: ')",
                               "                if False and result.startswith('IMAGE READY: ')"))
tot += 1
ok += case("reasoning turned off (THINK = False)", 'agent-loop-check.py',
           lambda s: s.replace("THINK = True", "THINK = False"))
tot += 1
ok += case("think flag hardcoded False in the payload", 'agent-loop-check.py',
           lambda s: s.replace("'think': turn_think", "'think': False"))

tot += 1
ok += case("reasoning kept in the history sent back to the model", 'agent-loop-check.py',
           lambda s: s.replace("_am = {k2: v2 for k2, v2 in m.items() if k2 != 'thinking'}",
                               "_am = m"))

tot += 1
ok += case("adaptive reasoning reverted to always-on", 'agent-loop-check.py',
           lambda s: s.replace("turn_think = THINK_ALWAYS or (THINK and needs_reasoning(last_user_text(msgs)))",
                               "turn_think = THINK"))
tot += 1
ok += case("needs_reasoning always False (reasoning never used)", 'agent-loop-check.py',
           lambda s: s.replace("def needs_reasoning(text):", "def needs_reasoning(text):\n    return False"))
tot += 1
ok += case("needs_reasoning always True (reasoning always paid for)", 'agent-loop-check.py',
           lambda s: s.replace("def needs_reasoning(text):", "def needs_reasoning(text):\n    return True"))

tot += 1
ok += case("tool calls forced back to one at a time", 'agent-loop-check.py',
           lambda s: s.replace("max_workers=min(4, len(fresh))", "max_workers=1"))
tot += 1
ok += case("assistant message re-appended per tool call", 'agent-loop-check.py',
           lambda s: s.replace("            msgs.append(_am)\n            msgs.extend(tool_msgs)",
                               "            for _tm in tool_msgs:\n                msgs.append(_am); msgs.append(_tm)"))
tot += 1
ok += case("web_search duckduckgo parse broken again", 'agent-loop-check.py',
           lambda s: s.replace(
               "for m in re.findall(r'<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>', h, re.S)[:8]:",
               "for m in re.finditer(r'<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>', h, re.S)[:0] or re.findall(r'x', h)[:8]:"))

tot += 1
# Stretching the wait past the tool's runtime is equivalent to removing the
# heartbeat, and avoids matching an escape sequence through two layers of
# quoting -- the template stores the six characters "\\u23f3", not the glyph.
ok += case("no heartbeat while a tool runs (wait outlives it)", 'agent-loop-check.py',
           lambda s: s.replace("_cf.wait(_pending, timeout=8)", "_cf.wait(_pending, timeout=600)"))

tot += 1
# The helper source lives inside the template as a string literal, so the
# anchor carries a literal backslash-n rather than a real newline.
ok += case("failed browser launch left un-stopped", 'playwright-launch-check.py',
           lambda s: s.replace("            pw.stop()\\n", "            pass\\n"))

tot += 1
ok += case("crawl_site back to one page at a time", 'agent-loop-check.py',
           lambda s: s.replace("_cf.ThreadPoolExecutor(max_workers=4)",
                               "_cf.ThreadPoolExecutor(max_workers=1)"))

print("\n%d/%d mutation cases behaved correctly" % (ok, tot))
raise SystemExit(0 if ok == tot else 1)
