#!/usr/bin/env python3
"""Wire the orchestration layer into the kernel's agent loop.

The kernel's decision layer had four defects that this fixes at the root:

  1. SYSMSG advertised four tools -- web_search, fetch_page, crawl_site,
     run_command -- while seven were registered. browser, generate_image and
     generate_voice were only discoverable from the tools array, and the
     system prompt was actively telling the model a smaller toolset than it
     had. That is a direct cause of poor capability selection.
  2. Tool results went back into the prompt as raw output truncated at 2500
     characters from the tail -- which is where a traceback lives.
  3. Deduplication was an exact string match on (name, args), so the same page
     fetched with a trailing slash, or the same selector retried after it had
     already failed, both cost a fresh call.
  4. Nothing checked the outcome. A turn ended when the model stopped calling
     tools, whether or not the file existed or the image was written.

Modes:
    --check          assert the change is present in the shipped asset
    --emit PATH      write the patched cell to a file for testing
    (no args)        apply to the notebook asset; refuses on any zero-match
"""
import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSET = ROOT / "android/app/src/main/assets/aether-notebook-template.json"
ORCH = ROOT / "scripts/agent-orchestration.py"
CELL = 4


def escape(s):
    """Encode source for storage inside a single-quoted literal."""
    return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")


def read_cell():
    nb = json.loads(ASSET.read_text())
    src = nb["cells"][CELL]["source"]
    src = "".join(src) if isinstance(src, list) else src
    return nb, src


# --------------------------------------------------------------------------
# 1. The system prompt has to name every capability and say when to use it.
# --------------------------------------------------------------------------
OLD_SYSMSG = """SYSMSG = ('You are AETHER, an autonomous AI agent with live tools: web_search, fetch_page, crawl_site, run_command. '
          'Current date: ' + time.strftime('%Y-%m-%d %H:%M UTC') + '. '
          'RULES: For ANY question about current events, facts you are unsure of, prices, news, or anything after your training - USE web_search before answering. '
          'Cite source URLs you used. For math/computation/file tasks use run_command. '
          'You may chain multiple tool calls. After tools return, give a clear, complete answer.')"""

NEW_SYSMSG = """SYSMSG = ('You are AETHER, an autonomous AI agent. Your tools: '
          'web_search (the live web: news, prices, facts, anything after your training); '
          'fetch_page (read one URL as text); '
          'crawl_site (read several pages of one site); '
          'browser (a real browser: log in, fill forms, click, upload, screenshot -- call action=inspect before acting); '
          'run_command (the Linux shell: files, computation, scripts, pip/npm/apt, git); '
          'generate_image (an AI image from a description); '
          'generate_voice (speech audio from text). '
          'Current date: ' + time.strftime('%Y-%m-%d %H:%M UTC') + '. '
          'CHOOSE BY THE TASK, NOT BY HABIT. A URL in the request means fetch_page or browser, not web_search. '
          'A file, a calculation, an install or a script means run_command. '
          'An image or audio request means generate_image or generate_voice -- make the file, never describe it instead. '
          'Only a plain conversation needs no tool; do not spend a tool call on a greeting. '
          'Issue independent calls together in one step and they run in parallel; keep dependent calls in separate steps. '
          'Never repeat a call that already failed -- change the approach, or say what is blocking you. '
          'BEFORE YOU SAY DONE, CHECK THE OUTCOME: a file must exist, a command must have exited 0, an image or audio '
          'file must have been written, a browser task must have reached the expected page, and a researched answer must '
          'cite the source URLs it used. If the check fails, keep working instead of reporting success. '
          'Cite source URLs you used.')"""


# --------------------------------------------------------------------------
# 2. Budget: near-duplicates and abandoned actions, not just exact repeats.
# --------------------------------------------------------------------------
OLD_SEEN = """    # Calls already made this turn. Measured on the live engine, the model can
    # re-issue the exact same three tool calls every iteration -- 20 calls over
    # 468s, and the turn still had not finished. Re-running identical work only
    # burns the user's time, so it is handed back from memory instead.
    seen_calls = set()"""

NEW_SEEN = """    # Calls already made this turn. Measured on the live engine, the model can
    # re-issue the exact same three tool calls every iteration -- 20 calls over
    # 468s, and the turn still had not finished. Re-running identical work only
    # burns the user's time, so it is handed back from memory instead.
    #
    # Budget replaces the exact-match set. It also catches the near repeat --
    # the same page with a trailing slash, the same query reworded -- and stops
    # retrying an action that has already failed twice. Failures are never
    # replayed: handing back a cached error looks like progress to the loop
    # and turns one failure into an endless free retry.
    budget = Budget(max_calls=24, max_fails=2)
    # The plan is a forecast of what this task needs, built from the user's own
    # words before the model is asked anything. It is what makes the turn
    # verifiable and what another engine can pick up if this one dies.
    try:
        task = build_plan(last_user_text(msgs))
    except Exception as _pe:
        task = None
        notify('plan failed: %s' % str(_pe)[:200])
    verify_tries = 0
    if task is not None:
        emit({'plan': task.to_dict(), 'message': {'content': ''}, 'done': False})"""


# --------------------------------------------------------------------------
# 3. Classify with the budget instead of a string set.
# --------------------------------------------------------------------------
OLD_CLASSIFY = """        if tcs and it < 9:
            # Classify first. A call already made this turn is answered from
            # memory and never re-run, exactly as before.
            plan = []
            repeats = 0
            for tc in tcs:
                fn = (tc.get('function') or {})
                name = fn.get('name','?'); args = fn.get('arguments') or {}
                if isinstance(args, str):
                    try: args = json.loads(args)
                    except Exception: args = {}
                _key = name + '|' + json.dumps(args, sort_keys=True, default=str)
                if _key in seen_calls:
                    repeats += 1
                    plan.append((name, args, True))
                else:
                    seen_calls.add(_key)
                    plan.append((name, args, False))"""

NEW_CLASSIFY = """        if tcs and it < 9:
            # Classify first. A call already made this turn is answered from
            # memory and never re-run; a call that has failed twice is refused
            # outright so the turn re-plans instead of grinding.
            plan = []
            repeats = 0
            for tc in tcs:
                fn = (tc.get('function') or {})
                name = fn.get('name','?'); args = fn.get('arguments') or {}
                if isinstance(args, str):
                    try: args = json.loads(args)
                    except Exception: args = {}
                if budget.give_up_on(name, args):
                    budget.refused += 1
                    repeats += 1
                    plan.append((name, args, True))
                    continue
                cached = budget.duplicate_of(name, args)
                if cached is not None:
                    repeats += 1
                    plan.append((name, args, True))
                else:
                    plan.append((name, args, False))"""


# --------------------------------------------------------------------------
# 4. Normalize instead of truncating from the tail.
# --------------------------------------------------------------------------
OLD_TRUNC = """            tool_msgs = []
            for k, (nm, ar, rep) in enumerate(plan):
                result = results[k] or ''
                # One huge search result can push the whole prompt past the
                # context window on its own, which is what trims the question
                # away. Keep the head of the result and say it was cut.
                if len(result) > TOOL_RESULT_MAX:
                    result = result[:TOOL_RESULT_MAX] + ' ...[truncated]'"""

NEW_TRUNC = """            tool_msgs = []
            for k, (nm, ar, rep) in enumerate(plan):
                result = results[k] or ''
                # Normalized, not truncated. One huge search result can push
                # the whole prompt past the context window on its own, which
                # is what trims the question away -- but cutting at a fixed
                # offset from the head throws away the end of the output, and
                # the end is where a traceback lives. The model gets a brief
                # that keeps both ends; the raw text goes to the client, which
                # can show it on request without spending context on it.
                try:
                    _n = normalize(nm, result, ar)
                except Exception:
                    _n = {'brief': result[:TOOL_RESULT_MAX], 'raw': result,
                          'ok': True, 'kind': 'text', 'facts': []}
                result = _n['brief']
                if not rep:
                    # Only real executions publish a result event. A replayed
                    # call has no new raw output, and emitting one would tell
                    # the UI that work happened when it did not.
                    emit({'tool_result': {'tool': nm, 'kind': _n['kind'],
                                          'ok': _n['ok'],
                                          'raw_chars': len(_n['raw']),
                                          'brief_chars': len(_n['brief']),
                                          'raw': _n['raw'][:8000]},
                          'message': {'content': ''}, 'done': False})
                    budget.note(nm, ar, _n['brief'], _n['ok'])
                    if task is not None:
                        try:
                            task.adopt(nm, brief=_n['brief'], raw=_n['raw'],
                                       ok=_n['ok'])
                        except Exception:
                            pass"""


# --------------------------------------------------------------------------
# 5. Verify before declaring done.
# --------------------------------------------------------------------------
OLD_FINAL = """        th = (m.get('thinking') or '').strip()
        if th:
            emit({'message':{'thinking': th}, 'done': False})
        content = m.get('content') or ''"""

NEW_FINAL = """        th = (m.get('thinking') or '').strip()
        if th:
            emit({'message':{'thinking': th}, 'done': False})
        # Verification gate. The model stopping is not the same as the task
        # being done: an image step can come back "here is your image" with no
        # file behind it. Check the outcome, and if it is not there, say what
        # is missing and keep going -- bounded, so a task that genuinely cannot
        # be finished still ends instead of looping.
        if task is not None:
            # A conversation's deliverable IS the text, and it arrives on this
            # path rather than through a tool. Without recording it, every
            # plain chat message verified as "the answer is empty" and got
            # nudged to keep working -- two extra model calls on a greeting.
            # Only conversation steps adopt it: an image step's deliverable is
            # a file, and letting prose stand in for one is exactly the lie
            # this gate exists to catch.
            _fin = (m.get('content') or '')
            if _fin:
                for _s in task.steps:
                    if _s.intent == 'chat' and _s.status not in ('done', 'verified'):
                        try:
                            task.record(_s.id, brief=_fin[:1200],
                                        result=_fin[:4000], status='done')
                        except Exception:
                            pass
            try:
                _vok, _unmet = task.verify()
            except Exception:
                _vok, _unmet = True, []
            emit({'verification': {'ok': _vok, 'unmet': _unmet,
                                   'outcome': task.outcome,
                                   'budget': budget.stats()},
                  'message': {'content': ''}, 'done': False})
            if not _vok and verify_tries < 2 and budget.remaining() > 0:
                verify_tries += 1
                emit({'message': {'thinking': '\\u2705 checking the result...'},
                      'done': False})
                # Appended as a user turn: the chat template rejects a lone
                # tool message with no assistant tool_calls in front of it.
                msgs.append({k2: v2 for k2, v2 in m.items() if k2 != 'thinking'})
                msgs.append({'role': 'user', 'content':
                    '(system check) The result was verified and is not complete yet. '
                    'Still missing: ' + '; '.join(_unmet)[:600] +
                    '. Do the remaining work with your tools, then check again '
                    'before answering. Do not repeat an action that already failed.'})
                continue
        content = m.get('content') or ''"""


REPLACEMENTS = [
    (OLD_SYSMSG, NEW_SYSMSG, "system prompt names all seven tools"),
    (OLD_SEEN, NEW_SEEN, "budget and plan per turn"),
    (OLD_CLASSIFY, NEW_CLASSIFY, "classify through the budget"),
    (OLD_TRUNC, NEW_TRUNC, "normalize tool results"),
    (OLD_FINAL, NEW_FINAL, "verification gate before done"),
]

ANCHOR = "def agent_stream(handler, user_payload):"

BOOT_TMPL = '''# ============ ORCHESTRATION LAYER ============
# Routing, planning, budgeting, normalization and verification in one module,
# exec'd into this namespace at boot. It lives in its own file for the same
# reason the browser helper does: it has to be testable outside a kernel, and
# scripts/agent-orchestration.py is the copy the tests run against. Written to
# disk as well so a crash leaves something to read.
_A_ORCH = '/kaggle/working/_aether_orch.py'
_A_ORCH_SRC = '{SRC}'


def _a_load_orch():
    try:
        os.makedirs(os.path.dirname(_A_ORCH), exist_ok=True)
        open(_A_ORCH, 'w').write(_A_ORCH_SRC)
    except Exception:
        pass
    _g = globals()
    exec(compile(_A_ORCH_SRC, _A_ORCH, 'exec'), _g)
    # The verifier resolves media reported by bare filename against this.
    _g['MEDIA_DIR'] = GEN_DIR


_a_load_orch()
notify('orchestration layer loaded (route/plan/budget/normalize/verify)')

'''


CHECKS = [
    ("system prompt names all seven tools",
     "'generate_voice (speech audio from text). '"),
    ("budget replaces the exact-match set", "budget = Budget(max_calls=24"),
    ("plan built from the user's words", "task = build_plan(last_user_text(msgs))"),
    ("plan published to the client", "emit({'plan': task.to_dict()"),
    ("near-duplicate detection", "budget.duplicate_of(name, args)"),
    ("failed actions abandoned", "budget.give_up_on(name, args)"),
    # Inside the cell this line lives in an escaped literal, so the newline is
    # a backslash-n rather than a real one.
    ("failures never replayed", "if ok:\\n            self._seen"),
    ("tool results normalized", "_n = normalize(nm, result, ar)"),
    ("raw kept for the UI", "'tool_result': {'tool': nm"),
    ("verification gate present", "Verification gate"),
    ("unmet evidence fed back", "Still missing: "),
    ("orchestration module exec'd", "_a_load_orch()"),
    ("route() available", "def route(text):"),
    ("waves() available", "def waves(self):"),
    ("checkpoint available", "def checkpoint(self):"),
]


def transform(src, orch_src):
    found = {}
    for old, new, label in REPLACEMENTS:
        n = src.count(old)
        found[label] = n
        src = src.replace(old, new, 1)
    boot = BOOT_TMPL.replace("{SRC}", escape(orch_src))
    n = src.count(ANCHOR)
    found["orchestration module inserted"] = n
    src = src.replace(ANCHOR, boot + ANCHOR, 1)
    return src, found


def check(src):
    bad = 0
    for label, needle in CHECKS:
        hit = needle in src
        print("  %-38s %s" % (label, "yes" if hit else "NO"))
        if not hit:
            bad += 1
    # The embedded module has to round-trip back to the file the tests use.
    if "_A_ORCH_SRC = '" in src:
        q = src.index("_A_ORCH_SRC = '") + len("_A_ORCH_SRC = ")
        try:
            back = ast.literal_eval(src[q:src.index("\n\n\ndef _a_load_orch", q)])
            same = back == ORCH.read_text()
            print("  %-38s %s" % ("embedded module matches the tested file",
                                  "yes" if same else "NO"))
            if not same:
                bad += 1
        except Exception as e:
            print("  embedded module did not decode: %s" % e)
            bad += 1
    print("orchestration-fix: %s" % ("OK, every change is present" if not bad
                                     else "NOT APPLIED"))
    return 1 if bad else 0


def main():
    args = sys.argv[1:]
    nb, src = read_cell()

    if "--check" in args:
        return check(src)

    orch_src = ORCH.read_text()
    ast.parse(orch_src)
    new, found = transform(src, orch_src)
    ast.parse(new)

    if "--emit" in args:
        p = Path(args[args.index("--emit") + 1])
        p.write_text(new)
        print("emitted %s (%d bytes, was %d)" % (p, len(new), len(src)))
        for k, v in found.items():
            print("  %-38s %d" % (k, v))
        return 0

    missing = [k for k, v in found.items() if v == 0]
    if missing:
        print("REFUSING to write an incomplete patch: " + ", ".join(missing))
        return 1

    nb["cells"][CELL]["source"] = new
    for c in nb["cells"]:
        s = c["source"] if isinstance(c["source"], str) else "".join(c["source"])
        if c.get("cell_type") == "code" and s.strip():
            ast.parse(s)
    ASSET.write_text(json.dumps(nb, separators=(",", ":"), ensure_ascii=True),
                     encoding="utf-8")
    print("orchestration-fix: applied (%d -> %d bytes)" % (len(src), len(new)))
    for k, v in found.items():
        print("  %-38s %d" % (k, v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
