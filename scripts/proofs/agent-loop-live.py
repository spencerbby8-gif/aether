#!/usr/bin/env python3
"""Run the PATCHED agent loop for real, with a scripted model.

All three Kaggle engines hit their weekly GPU quota partway through this work,
so no live model was available for an after-measurement. That does not mean the
integration is untested: this drives the actual `agent_stream` extracted from
the shipped asset, with a fake `ollama_stream` underneath, and checks the wire
events it emits.

What this proves: the plan is built and published, tool results are normalized
before they reach the prompt, the budget catches repeats and abandons dead
ends, and the verification gate stops a turn that has not produced its
artifact -- and that it is bounded, so it ends instead of looping.

What this does NOT prove: that a real model chooses well. That needs a live
engine and is reported as such.
"""
import ast
import json
import os
import sys
import io
import re
import threading
import queue
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
ASSET = ROOT / "android/app/src/main/assets/aether-notebook-template.json"
WORK = Path("/tmp/agent-loop")

PASSED = 0
FAILED = 0


def ok(label, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print("  ok   %s" % label)
    else:
        FAILED += 1
        print("  FAIL %s%s" % (label, ("   [%s]" % detail[:260]) if detail else ""))
    return bool(cond)


def head(t):
    print("\n== %s ==" % t)


# --------------------------------------------------------------------------
# Build a namespace that can actually run agent_stream
# --------------------------------------------------------------------------
class FakeWfile(io.BytesIO):
    def __init__(self):
        super().__init__()
        self.events = []

    def write(self, b):
        # Chunked encoding: <hex>\r\n<line>\r\n
        s = b.decode(errors="replace")
        for ln in s.split("\r\n"):
            ln = ln.strip()
            if not ln or re.fullmatch(r"[0-9a-f]+", ln):
                continue
            try:
                self.events.append(json.loads(ln))
            except Exception:
                pass
        return len(b)


class FakeHandler:
    def __init__(self):
        self.wfile = FakeWfile()
        self.status = None
        self.close_connection = False
        self._sent = False

    def send_response(self, c):
        self.status = c

    def send_header(self, *a):
        pass

    def end_headers(self):
        pass

    def events(self):
        return self.wfile.events


def load_cell():
    nb = json.loads(ASSET.read_text())
    src = nb["cells"][4]["source"]
    return "".join(src) if isinstance(src, list) else src


def slice_fns(src, names):
    tree = ast.parse(src)
    keep = [n for n in tree.body
            if isinstance(n, ast.FunctionDef) and n.name in names]
    missing = names - {n.name for n in keep}
    if missing:
        raise SystemExit("could not extract: %s" % sorted(missing))
    return ast.unparse(ast.fix_missing_locations(ast.Module(body=keep, type_ignores=[])))


def build_ns(script):
    """Assemble the kernel namespace, with ollama_stream scripted."""
    src = load_cell()

    # The orchestration boot block, exactly as the kernel runs it.
    boot = src[src.index("# ============ ORCHESTRATION LAYER ============"):
               src.index("def agent_stream(handler, user_payload):")]

    ns = {
        "os": os, "re": re, "json": json, "time": time, "threading": threading,
        "queue": queue, "subprocess": __import__("subprocess"),
        "urllib": __import__("urllib.request", fromlist=["x"]),
        "html": __import__("html"),
        "notify": lambda m: None,
        "GEN_DIR": str(WORK),
        # The per-session workspace binding. agent_stream sets it at the top of
        # every turn and t_run_command reads it; without it the loop died with
        # NameError before the first command ran.
        "_CURRENT": {"ws": str(WORK), "session": "proof"},
        "SESSION_ROOT": str(WORK),
        # The session-id pattern _session_dir validates against. It arrives from
        # a client, so it is checked rather than joined blindly.
        "_SESSION_RE": re.compile(r"^[A-Za-z0-9_-]{1,64}$"),
        # Constants the loop reads. Values match the kernel.
        "MODEL": "test-model", "NUM_CTX": 8192, "NUM_PREDICT": 4096,
        "TOOL_RESULT_MAX": 2500, "THINK": False, "THINK_ALWAYS": False,
        "TOOLS": [],
    }
    exec(compile(boot, "<orch-boot>", "exec"), ns)

    # _session_dir resolves the per-session workspace that agent_stream binds at
    # the top of every turn; _checkpoint_workspace runs after each tool step.
    # Both are kernel functions the loop calls, so they have to come along.
    fns = slice_fns(src, {"agent_stream", "history_window", "has_user_query",
                          "needs_reasoning", "last_user_text",
                          "_session_dir", "_checkpoint_workspace",
                          "_publish_archives"})
    exec(compile(fns, "<kernel-fns>", "exec"), ns)

    ns["SYSMSG"] = "test system prompt"

    # The scripted model. Each entry is one model call's reply.
    ns["_script"] = list(script)
    ns["_calls"] = []

    def ollama_stream(payload, push, timeout=1200, on_think=None):
        msgs = payload.get("messages") or []
        ns["_calls"].append([m.get("role") for m in msgs])
        if not ns["_script"]:
            return {"message": {"role": "assistant",
                                "content": "(script exhausted)"}, "done": True}
        step = ns["_script"].pop(0)
        if on_think:
            on_think()
        content = step.get("content", "")
        if content:
            push(content)
        return {"message": {"role": "assistant", "content": content,
                            "tool_calls": step.get("tool_calls") or []},
                "done": True, "eval_count": 10, "eval_duration": 1,
                "total_duration": 1, "prompt_eval_count": 100}

    ns["ollama_stream"] = ollama_stream

    # The real tools are replaced by ones that behave like the real ones'
    # OUTPUT, which is what the loop under test actually consumes.
    def t_web_search(query, **kw):
        return ("* Result one :: https://example.com/one\n  Some text here.\n"
                "* Result two :: https://example.com/two\n  More text.")

    def t_generate_image(prompt, **kw):
        # Deliberately fails: this is what the verification gate is for.
        return "image generation failed: no file written"

    def t_run_command(command, **kw):
        return "exit=0\nhello"

    ns["EXEC"] = {"web_search": t_web_search, "generate_image": t_generate_image,
                  "run_command": t_run_command,
                  "fetch_page": lambda url, **k: "HTTP-fetched %s\nbody" % url}
    return ns


def run(script, prompt):
    ns = build_ns(script)
    h = FakeHandler()
    t0 = time.time()
    ns["agent_stream"](h, {"messages": [{"role": "user", "content": prompt}],
                           "model": "test-model"})
    return ns, h.events(), time.time() - t0


def kinds(events):
    return [k for k in ("plan", "tool_result", "verification", "media")
            if any(k in e for e in events)]


# --------------------------------------------------------------------------
def test_plan_published():
    head("A. the plan is built from the user's words and published")
    ns, ev, wall = run([{"content": "Here is the news."}],
                       "search the web for the latest python news")
    plans = [e["plan"] for e in ev if "plan" in e]
    ok("a plan event is emitted before any model output", len(plans) == 1,
       "events=%s" % [list(e)[:2] for e in ev][:4])
    if plans:
        p = plans[0]
        ok("the plan carries the goal", "python news" in p["goal"], p["goal"][:60])
        ok("the plan names the capability", "web_search" in p["capabilities"],
           str(p["capabilities"]))
        ok("the plan states the evidence required", len(p["evidence"]) >= 1,
           str(p["evidence"]))
    ok("the answer still reaches the client",
       any("Here is the news" in (e.get("message") or {}).get("content", "")
           for e in ev))


def test_normalize():
    head("B. tool results are normalized before they reach the model")
    noisy = "exit=0\n" + ("Collecting x\n" * 400) + "KeyError: 'boom'"
    ns = build_ns(
        [{"tool_calls": [{"function": {"name": "run_command",
                                       "arguments": {"command": "pip install x"}}}]},
         {"content": "Installed."}])
    # Override BEFORE running: the loop reads EXEC at call time.
    ns["EXEC"]["run_command"] = lambda command, **k: noisy
    h = FakeHandler()
    ns["agent_stream"](h, {"messages": [{"role": "user",
                                         "content": "install the x package "
                                                    "with the shell"}],
                           "model": "m"})
    ev = h.events()
    tr = [e["tool_result"] for e in ev if "tool_result" in e]
    ok("a tool_result event carries the raw for the UI", len(tr) == 1,
       "count=%d" % len(tr))
    if tr:
        ok("the raw output is preserved for inspection",
           tr[0]["raw_chars"] > 2000, "raw_chars=%d" % tr[0]["raw_chars"])
        ok("the brief is much smaller than the raw",
           tr[0]["brief_chars"] < tr[0]["raw_chars"] * 0.4,
           "brief=%d raw=%d" % (tr[0]["brief_chars"], tr[0]["raw_chars"]))
    ok("the model was called again after the tool ran", len(ns["_calls"]) == 2,
       "calls=%d" % len(ns["_calls"]))


def test_budget():
    head("C. the budget catches repeats and abandons dead ends")
    same = {"function": {"name": "web_search", "arguments": {"query": "python news"}}}
    ran = []
    ns = build_ns([{"tool_calls": [same]}, {"tool_calls": [same]},
                   {"tool_calls": [same]}, {"content": "done"}])
    real = ns["EXEC"]["web_search"]

    def counting(query, **kw):
        ran.append(query)
        return real(query, **kw)

    ns["EXEC"]["web_search"] = counting
    h = FakeHandler()
    # The all-repeat break falls through to a raw curl at 127.0.0.1:11434,
    # which does not exist here. That path is pre-existing kernel behaviour
    # and is not what this test is about, so it is bounded rather than run.
    ns["subprocess"] = type("S", (), {
        "PIPE": -1,
        "Popen": staticmethod(
            lambda *a, **k: type("P", (), {"stdout": iter([]),
                                           "kill": lambda s: None})())})
    ns["agent_stream"](h, {"messages": [{"role": "user",
                                         "content": "search for python news"}],
                           "model": "m"})
    ev = h.events()
    ok("the identical search executed exactly once", len(ran) == 1,
       "executions=%d" % len(ran))
    tr = [e["tool_result"] for e in ev if "tool_result" in e]
    ok("only the real execution published a result event", len(tr) == 1,
       "tool_result events=%d" % len(tr))
    ok("the loop stopped issuing tool calls after the repeat",
       len(ran) == 1 and len(ns["_calls"]) <= 3,
       "model calls=%d executions=%d" % (len(ns["_calls"]), len(ran)))


def test_verification_gate():
    head("D. verification: an image that was never written cannot end the turn")
    ns, ev, wall = run(
        [{"tool_calls": [{"function": {"name": "generate_image",
                                       "arguments": {"prompt": "a cube"}}}]},
         {"content": "Here is your image of a cube."},
         {"content": "Here is your image again."},
         {"content": "Here it is a third time."}],
        "generate an image of a cube")
    ver = [e["verification"] for e in ev if "verification" in e]
    ok("a verification event is emitted", len(ver) >= 1, "count=%d" % len(ver))
    if ver:
        ok("the first verification reports the outcome is not met",
           ver[0]["ok"] is False, json.dumps(ver[0])[:200])
        ok("it names what is missing",
           any("image" in u for u in ver[0]["unmet"]), str(ver[0]["unmet"]))
        ok("the budget state is reported with it",
           "calls" in ver[0].get("budget", {}), str(ver[0].get("budget")))
    ok("the turn is bounded -- it ends instead of looping",
       any(e.get("done") for e in ev))
    ok("verification is retried at most twice", len(ver) <= 3,
       "verification events=%d" % len(ver))

    # The nudge must tell the model what is missing.
    nudges = [m for roles in ns["_calls"] for m in roles if m == "user"]
    ok("the model is told to keep working", len(nudges) >= 2,
       "user turns seen=%d" % len(nudges))


def test_happy_path_still_works():
    head("E. a task that really succeeds is not held up")
    p = WORK / "real.png"
    p.parent.mkdir(parents=True, exist_ok=True)

    ns = build_ns([{"tool_calls": [{"function": {"name": "run_command",
                                                 "arguments": {"command": "ls"}}}]},
                   {"content": "Listed."}])
    ns["EXEC"]["run_command"] = lambda command, **k: "exit=0\nfile1\nfile2"
    h = FakeHandler()
    ns["agent_stream"](h, {"messages": [{"role": "user",
                                         "content": "list my files with the shell"}],
                           "model": "m"})
    ev = h.events()
    ver = [e["verification"] for e in ev if "verification" in e]
    ok("a successful command verifies clean",
       ver and ver[-1]["ok"] is True, json.dumps(ver[-1] if ver else {})[:200])
    ok("no verification nudge was needed", len(ver) == 1, "events=%d" % len(ver))
    ok("the answer reached the client",
       any("Listed." in (e.get("message") or {}).get("content", "") for e in ev))


def test_plain_chat_untouched():
    head("F. plain conversation is not dragged through the machinery")
    ns, ev, wall = run([{"content": "Hello! I am well."}], "hello there")
    ok("no tool was called", not ns["_calls"] or
       all("tool" not in r for r in ns["_calls"][0]), str(ns["_calls"][:1]))
    ok("the answer came back", any("I am well" in (e.get("message") or {})
                                  .get("content", "") for e in ev))
    ver = [e["verification"] for e in ev if "verification" in e]
    ok("a chat turn verifies immediately", not ver or ver[-1]["ok"] is True,
       json.dumps(ver[-1] if ver else {})[:160])


def test_consecutive_failure_breaker():
    head("G. a run of failing steps ends the turn instead of grinding to the ceiling")
    # This is the turn that was measured live: the model re-issues the same
    # command with one character changed each time, so `duplicate_of` never
    # matches and every execution looks new. Each one fails. Before the
    # breaker the turn ran to the 24-call ceiling -- n=24, roles
    # SUATAUATATATATATATATATATAT, empty answer.
    calls = []

    def failing(command, **kw):
        calls.append(command)
        return "exit=1\ncommand not found: %s" % command

    # Eight distinct commands, each failing. More than _MAX_CONSEC_FAIL (3),
    # fewer than the budget ceiling (24) -- so only the breaker can stop it.
    script = [{"tool_calls": [{"function": {"name": "run_command",
                                            "arguments": {"command": "probe-%d" % i}}}]}
              for i in range(8)]
    script.append({"content": "all done"})
    ns = build_ns(script)
    ns["EXEC"]["run_command"] = failing
    h = FakeHandler()
    ns["agent_stream"](h, {"messages": [{"role": "user",
                                         "content": "run the probe command until it works"}],
                           "model": "m"})
    ev = h.events()
    text = " ".join((e.get("message") or {}).get("content", "") for e in ev)
    ok("the turn stopped after 3 consecutive failing steps", len(calls) == 3,
       "executions=%d (want 3)" % len(calls))
    ok("it said why it stopped", "steps in a row failed" in text, text[:160])
    ok("it did not burn the whole budget", len(calls) < 8,
       "executions=%d of the 8 offered" % len(calls))
    ok("the model was not called for the remaining steps",
       len(ns["_calls"]) <= 5, "model calls=%d" % len(ns["_calls"]))


def test_a_recovery_resets_the_failure_count():
    head("H. a success in the middle resets the counter -- real work is not cut off")
    ran = []
    seq = ["exit=1\nnope", "exit=1\nnope", "exit=0\nok", "exit=1\nnope",
           "exit=1\nnope", "exit=0\nok"]

    def flaky(command, **kw):
        ran.append(command)
        return seq[len(ran) - 1] if len(ran) <= len(seq) else "exit=0\nok"

    script = [{"tool_calls": [{"function": {"name": "run_command",
                                            "arguments": {"command": "step-%d" % i}}}]}
              for i in range(6)]
    script.append({"content": "finished the work"})
    ns = build_ns(script)
    ns["EXEC"]["run_command"] = flaky
    h = FakeHandler()
    ns["agent_stream"](h, {"messages": [{"role": "user",
                                         "content": "run each step and fix failures"}],
                           "model": "m"})
    text = " ".join((e.get("message") or {}).get("content", "") for e in h.events())
    ok("all six steps ran -- two failures twice is not a run of three",
       len(ran) == 6, "executions=%d (want 6)" % len(ran))
    ok("the turn was never broken off", "steps in a row failed" not in text,
       text[:160])


def test_silent_tool_steps_are_bounded():
    head("I. a turn that runs tools without ever answering is stopped")
    ran = []

    def fine(command, **kw):
        ran.append(command)
        return "exit=0\nok"

    # Every step calls a tool and produces no content, and every step differs,
    # so neither the budget's repeat guard nor the failure breaker applies.
    # This is the shape the live 24-message turn had.
    script = [{"tool_calls": [{"function": {"name": "run_command",
                                            "arguments": {"command": "c-%d" % i}}}]}
              for i in range(20)]
    script.append({"content": "done at last"})
    ns = build_ns(script)
    ns["EXEC"]["run_command"] = fine
    h = FakeHandler()
    ns["agent_stream"](h, {"messages": [{"role": "user",
                                         "content": "keep running commands"}],
                           "model": "m"})
    text = " ".join((e.get("message") or {}).get("content", "") for e in h.events())
    ok("it stopped at 12 silent steps, not 20", len(ran) == 12,
       "executions=%d (want 12)" % len(ran))
    ok("it said the work is saved", "steps in a row ran tools" in text, text[:180])


def test_a_real_multitool_turn_is_not_cut_off():
    head("J. six silent tool steps -- a genuine multi-tool task -- still finish")
    ran = []

    def fine(command, **kw):
        ran.append(command)
        return "exit=0\nok"

    # Measured on a live engine: a real search/fetch/write/package task runs
    # about six tool steps before it answers. Twice that is the limit, so this
    # must complete untouched.
    script = [{"tool_calls": [{"function": {"name": "run_command",
                                            "arguments": {"command": "c-%d" % i}}}]}
              for i in range(6)]
    script.append({"content": "the answer, at last"})
    ns = build_ns(script)
    ns["EXEC"]["run_command"] = fine
    h = FakeHandler()
    ns["agent_stream"](h, {"messages": [{"role": "user",
                                         "content": "run these six commands then answer"}],
                           "model": "m"})
    text = " ".join((e.get("message") or {}).get("content", "") for e in h.events())
    ok("all six steps ran", len(ran) == 6, "executions=%d" % len(ran))
    ok("the final answer reached the client", "the answer, at last" in text,
       text[:160])
    ok("no breaker fired", "I stopped" not in text, text[:160])


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    test_plan_published()
    test_normalize()
    test_budget()
    test_verification_gate()
    test_happy_path_still_works()
    test_plain_chat_untouched()
    test_consecutive_failure_breaker()
    test_a_recovery_resets_the_failure_count()
    test_silent_tool_steps_are_bounded()
    test_a_real_multitool_turn_is_not_cut_off()
    print("\n%d passed, %d failed" % (PASSED, FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
