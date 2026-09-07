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


def mutate(path, fn):
    nb = json.load(open(path))
    src = nb['cells'][4]['source']
    new = fn(src)
    assert new != src, "mutation did not change anything"
    nb['cells'][4]['source'] = new
    open(path, 'w').write(json.dumps(nb, ensure_ascii=True, separators=(',', ':')))


def run(proof):
    p = subprocess.run([sys.executable, MUT + '/scripts/proofs/' + proof],
                       capture_output=True, text=True, timeout=300)
    tail = [l for l in p.stdout.splitlines() if 'passed' in l]
    return p.returncode, (tail[-1] if tail else p.stdout.strip()[-90:] or p.stderr[-90:])


def case(name, proof, fn):
    path = setup(proof)
    mutate(path, fn)
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

print("\n%d/%d mutation cases behaved correctly" % (ok, tot))
raise SystemExit(0 if ok == tot else 1)
