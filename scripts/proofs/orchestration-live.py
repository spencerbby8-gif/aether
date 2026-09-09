#!/usr/bin/env python3
"""Hard evidence for the agent orchestration layer.

Every section here runs for real. Routing is checked against ordinary
language with no model involved. Execution runs the kernel's ACTUAL tool
functions -- extracted from the shipped notebook asset, not reimplemented --
against the live network, the real filesystem and a real Chromium. Recovery,
verification, budgeting and failover are exercised end to end.

What this does NOT prove: that a specific model chooses well. Engines are
behind a Kaggle boot and a weekly GPU quota. Section J runs a real engine when
one is reachable and is reported as skipped when none is, rather than being
faked.

Usage:
    python3 scripts/proofs/orchestration-live.py [--engine URL] [--quick]
"""
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import time
import threading
import concurrent.futures as cf
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
ASSET = ROOT / "android/app/src/main/assets/aether-notebook-template.json"
WORK = Path("/tmp/orchestration")

# Every POST to the kernel is authenticated. Without this the harness gets
# {"status":"forbidden"} in 0.3s, which reads exactly like a model that
# refused to call a tool -- the two are worth telling apart.
ENGINE_KEY = os.environ.get("AETHER_OFF_KEY", "REMOVED_ENGINE_OFF_KEY")

PASSED = 0
FAILED = 0


def ok(label, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print("  ok   %s" % label)
    else:
        FAILED += 1
        print("  FAIL %s%s" % (label, ("   [%s]" % detail[:200]) if detail else ""))
    return bool(cond)


SKIPPED = []


def skip(label, reason):
    SKIPPED.append(label)
    print("  SKIP %s   (%s)" % (label, reason))


def web_search_live(tools, tries=3):
    """One real search, retried. Returns (text, live).

    DuckDuckGo rate-limits a sandbox that queries it repeatedly, so a bare
    'no results' is often the network refusing rather than the tool failing.
    Reporting that as a failure of the orchestration layer would be a lie in
    the other direction, so the dependent checks are skipped and named.
    """
    for i in range(tries):
        out = tools["t_web_search"](query="python asyncio tutorial %d" % i)
        if out and out.strip() != "no results":
            return out, True
        time.sleep(3)
    return "no results", False


def head(title):
    print("\n== %s ==" % title)


# --------------------------------------------------------------------------
# Load the real modules under test
# --------------------------------------------------------------------------
def load_orch():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "orch", str(ROOT / "scripts/agent-orchestration.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def extract_tools():
    """Pull the kernel's real tool functions out of the shipped asset.

    Sliced by AST so the code under test is byte-identical to what ships. The
    only substitution is the Kaggle working directory, which does not exist
    here; that is a path, not logic.
    """
    nb = json.loads(ASSET.read_text())
    src = nb["cells"][4]["source"]
    src = "".join(src) if isinstance(src, list) else src
    tree = ast.parse(src)
    want_fn = {"t_web_search", "t_fetch_page", "t_crawl_site", "t_run_command",
               "t_generate_image", "t_generate_voice", "_readable", "_safe_name"}
    want_assign = {"BLOCK", "GEN_DIR"}
    keep = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in want_fn:
            keep.append(node)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id in want_assign:
                    keep.append(node)
    missing = want_fn - {n.name for n in keep if isinstance(n, ast.FunctionDef)}
    if missing:
        raise SystemExit("could not extract: %s" % sorted(missing))
    mod = ast.Module(body=keep, type_ignores=[])
    code = ast.unparse(ast.fix_missing_locations(mod))
    code = code.replace("/kaggle/working", str(WORK))
    ns = {}
    # The kernel's tunnel URL. None here, exactly as it is on an engine before
    # its tunnel is up -- which is the branch that returns "SAVED but url
    # unknown" rather than a public link.
    exec(compile("import subprocess, os, json, time, re, html as htmlmod\n"
                 "import urllib.request, urllib.parse\nurl = None\n" + code,
                 "<kernel-tools>", "exec"), ns)
    return ns


# --------------------------------------------------------------------------
# A. Routing: ordinary language -> capabilities. No model involved.
# --------------------------------------------------------------------------
ROUTING_CASES = [
    ("what's the latest news on AI regulation in the EU?", {"web_search"}),
    ("generate an image of a Lagos sunset over the lagoon", {"image"}),
    ("read this out loud: the quick brown fox jumps over the dog", {"audio"}),
    ("log into example.com and fill out the signup form", {"browser"}),
    ("install pandas and numpy then write a script to plot a csv",
     {"package_manager", "code_execution"}),
    ("crawl https://docs.python.org/3/ and summarize every page", {"crawl_site"}),
    ("fetch https://example.com and tell me the title", {"fetch_page"}),
    ("hello, how are you today?", {"chat"}),
    ("thanks, that helps a lot", {"chat"}),
    ("explain what a closure is in javascript", {"chat"}),
    ("run ls -la and tell me the disk space", {"terminal"}),
    ("create a file called notes.txt with three bullet points", {"filesystem"}),
    ("search for the top python web frameworks, then create a file comparing them",
     {"web_search", "filesystem"}),
    ("find the current price of bitcoin and make an image of the chart",
     {"web_search", "image"}),
    ("sign up on news.ycombinator.com and confirm the account was created",
     {"browser"}),
    ("install the latest version of docker", {"package_manager"}),
    ("convert this csv to json and sort it by date", {"code_execution"}),
    ("what year did the Eiffel Tower open?", {"web_search"}),
    ("how much free disk space do I have?", {"terminal"}),
    ("narrate this paragraph as an audio clip", {"audio"}),
]


def test_routing(o):
    head("A. routing: ordinary language picks the capability")
    good = 0
    for text, expect in ROUTING_CASES:
        got = set(o.route(text)["capabilities"])
        if got == expect:
            good += 1
        else:
            print("       %-58s expected %s got %s"
                  % (text[:58], sorted(expect), sorted(got)))
    ok("%d/%d prompts routed to exactly the right capabilities"
       % (good, len(ROUTING_CASES)), good == len(ROUTING_CASES))
    return good, len(ROUTING_CASES)


# --------------------------------------------------------------------------
# B. Planning: dependencies produce waves, not a flat list
# --------------------------------------------------------------------------
def test_planning(o):
    head("B. planning: dependencies become an execution order")

    indep = o.Plan(o.route("search for python news, fetch https://example.com, "
                           "and crawl https://python.org"))
    w = indep.waves()
    ok("three independent research steps land in ONE wave",
       len(w) == 1 and len(w[0]) == 3,
       "waves=%d sizes=%s" % (len(w), [len(x) for x in w]))

    chain = o.Plan(o.route("search for the latest AI news and make an image of it"))
    w2 = chain.waves()
    ok("a back-reference chains the steps into two waves",
       len(w2) == 2, "waves=%d" % len(w2))
    ok("the image step waits on the search",
       len(w2) == 2 and w2[0][0].intent == "web_search"
       and w2[1][0].intent == "image")

    # The router models capabilities, not instances: two searches of the same
    # kind collapse to one web_search step, and running several calls of one
    # capability concurrently is the executor's job -- measured in section C.
    wide = o.Plan(o.route("search for python news, fetch https://example.com, "
                          "crawl https://python.org, and generate an image of it"))
    p = wide.parallelism()
    ok("parallelism is reported for the research wave",
       p["widest"] == 3 and p["serial_cost"] == 4, json.dumps(p))
    ok("the dependent media step sits in a later wave",
       len(wide.waves()) == 2, "waves=%d" % len(wide.waves()))

    # A broken dependency must be reported, not looped on.
    bad = o.Plan({"goal": "x", "steps": [
        {"id": "s1", "intent": "chat", "tool": None, "stage": 0, "deps": ["s2"]},
        {"id": "s2", "intent": "chat", "tool": None, "stage": 0, "deps": ["s1"]},
    ]})
    t0 = time.time()
    got = bad.waves()
    ok("a dependency cycle is reported instead of hanging",
       time.time() - t0 < 2 and any("cycle" in n for n in bad.notes),
       "notes=%s" % bad.notes)


# --------------------------------------------------------------------------
# C. Real execution, parallel vs serial, with the kernel's own tools
# --------------------------------------------------------------------------
def test_parallel_real(o, tools):
    head("C. real execution: parallel beats serial on independent work")

    calls = [
        ("web_search", {"query": "python 3.13 release notes"}),
        ("web_search", {"query": "rust 1.80 changelog"}),
        ("fetch_page", {"url": "https://example.com"}),
    ]

    def one(tool, args):
        t0 = time.time()
        raw = tools["t_" + tool if tool != "fetch_page" else "t_fetch_page"](**args) \
            if tool == "web_search" else tools["t_" + tool](**args)
        return tool, raw, time.time() - t0

    t0 = time.time()
    serial = [one(t, a) for t, a in calls]
    serial_wall = time.time() - t0

    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=len(calls)) as ex:
        par = list(ex.map(lambda c: one(*c), calls))
    par_wall = time.time() - t0

    ok("all three real calls returned data",
       all(len(r) > 60 for _, r, _ in par),
       "lengths=%s" % [len(r) for _, r, _ in par])
    if all(len(r) > 60 for _, r, _ in par):
        ok("parallel wall %.2fs < serial wall %.2fs" % (par_wall, serial_wall),
           par_wall < serial_wall, "%.2f vs %.2f" % (par_wall, serial_wall))
    else:
        skip("parallel < serial timing",
             "a real search came back empty; the comparison would be meaningless")
    print("       per-call: %s"
          % ", ".join("%s %.2fs" % (t, s) for t, _, s in par))
    return {"serial": serial_wall, "parallel": par_wall}


# --------------------------------------------------------------------------
# D. Recovery: a failure is recognised and the plan changes
# --------------------------------------------------------------------------
def test_recovery(o, tools):
    head("D. recovery: a failed step is recognised and re-planned")

    plan = o.Plan(o.route("fetch https://this-domain-does-not-exist-8f2a.invalid/page"))
    step = plan.steps[0]
    plan.record(step.id, status="running")
    raw = tools["t_fetch_page"](url="https://this-domain-does-not-exist-8f2a.invalid/page")
    n = o.normalize("fetch_page", raw)
    plan.record(step.id, brief=n["brief"], result=n["raw"])

    good, unmet = plan.verify()
    ok("a failed fetch is NOT reported as done", not good, "unmet=%s" % unmet)
    ok("the reason names the real problem",
       any("retriev" in u or "empty" in u for u in unmet), str(unmet))
    ok("the step is marked failed", plan.find(step.id).status == "failed")

    # Re-plan: the same goal by a different route.
    retry = o.Plan(o.route("fetch https://example.com"))
    rs = retry.steps[0]
    r2 = o.normalize("fetch_page", tools["t_fetch_page"](url="https://example.com"))
    retry.record(rs.id, brief=r2["brief"], result=r2["raw"])
    ok2, unmet2 = retry.verify()
    ok("the re-planned route verifies", ok2 and not unmet2, str(unmet2))


# --------------------------------------------------------------------------
# E. Verification catches a task that merely returned
# --------------------------------------------------------------------------
def test_verification(o, tools):
    head("E. verification: 'the tool answered' is not 'the outcome happened'")

    # The model says it made an image. It did not.
    lying = o.Plan(o.route("generate an image of a red square"))
    s = lying.steps[0]
    lying.record(s.id, brief="Here is your image!", result="Here is your image!")
    good, unmet = lying.verify()
    ok("a claimed image with no file is rejected", not good, str(unmet))

    # A real command that produced a real file.
    WORK.mkdir(parents=True, exist_ok=True)
    target = WORK / "verify-me.txt"
    if target.exists():
        target.unlink()
    p = o.Plan(o.route("create a file called verify-me.txt"))
    st = p.steps[0]
    raw = tools["t_run_command"](command="printf 'hello\\n' > %s && ls -l %s"
                                 % (target, target))
    n = o.normalize("run_command", raw)
    p.record(st.id, brief=n["brief"], result=n["raw"])
    ok("the command exited 0", "exit=0" in n["brief"], n["brief"][:80])
    ok2, unmet2 = p.verify()
    ok("a file that really exists verifies", ok2, str(unmet2))
    ok("and the file is on disk", target.exists() and target.read_text() == "hello\n")

    # A command that fails must not verify.
    p2 = o.Plan(o.route("run a command"))
    s2 = p2.steps[0]
    r2 = o.normalize("run_command", tools["t_run_command"](command="exit 3"))
    p2.record(s2.id, brief=r2["brief"], result=r2["raw"])
    g3, u3 = p2.verify()
    ok("a non-zero exit is caught", not g3 and "exit" in str(u3), str(u3))
    ok("the brief is not flagged ok", not r2["ok"])


# --------------------------------------------------------------------------
# F. Budget: stop spending calls on work that cannot help
# --------------------------------------------------------------------------
def test_budget(o):
    head("F. budget: duplicates and dead ends stop costing calls")

    b = o.Budget(max_calls=10, max_fails=2)
    b.note("web_search", {"query": "python news"}, "results", True)
    ok("an exact repeat is recognised",
       b.duplicate_of("web_search", {"query": "python news"}) == "results")
    ok("a re-ordered query is recognised as the same search",
       b.duplicate_of("web_search", {"query": "news python"}) == "results")
    ok("a trailing slash does not defeat the match",
       b.duplicate_of("web_search", {"query": "python news "}) == "results")
    ok("a genuinely different query is NOT a duplicate",
       b.duplicate_of("web_search", {"query": "rust news"}) is None)

    b.note("fetch_page", {"url": "https://x.test/a/"}, "page", True)
    ok("a URL differing only by a trailing slash is a duplicate",
       b.duplicate_of("fetch_page", {"url": "https://x.test/a"}) == "page")

    b.note("browser", {"action": "click", "selector": "#Go"}, "CLICK FAILED", False)
    b.note("browser", {"action": "click", "selector": "#go"}, "CLICK FAILED", False)
    ok("a selector that failed twice is abandoned, not retried",
       b.give_up_on("browser", {"action": "click", "selector": "#GO"}))
    ok("a different selector is still allowed",
       not b.give_up_on("browser", {"action": "click", "selector": "#other"}))

    ok("4 of 10 calls spent", b.stats()["calls"] == 4
       and b.stats()["remaining"] == 6, json.dumps(b.stats()))

    small = o.Budget(max_calls=2)
    small.note("a", {}, "r", True)
    small.note("b", {}, "r", True)
    ok("the budget reports exhaustion instead of silently stopping",
       small.exhausted() and small.remaining() == 0)


# --------------------------------------------------------------------------
# G. Normalization: the model gets a brief, the UI keeps the raw
# --------------------------------------------------------------------------
# Shaped like real `pip install` output at the kernel's 6000-char cap: a few
# lines of signal buried in thousands of characters of progress spam. A short
# sample would make the compression ratio look good without earning it.
NOISY = ("exit=0\n" + "\n".join(
    ["WARNING: You are using pip version 21.0; however, version 24.0 is available."] * 6
    + ["Collecting requests", "  Downloading requests-2.31.0-py3-none-any.whl (62 kB)",
       "     |################################| 62.6/62.6 kB 4.1 MB/s eta 0:00:00"] * 26
    + ["\rInstalling collected packages: urllib3, idna, charset-normalizer, requests"] * 14
    + ["  Attempting uninstall: urllib3", "    Found existing installation: urllib3 1.26.5",
       "    Uninstalling urllib3-1.26.5:", "      Successfully uninstalled urllib3-1.26.5"] * 6
    + ["Successfully installed charset-normalizer-3.3.2 idna-3.6 requests-2.31.0 urllib3-2.0.7"]
    + ["Traceback (most recent call last):", '  File "x.py", line 9, in <module>',
       "    cfg['missing']", "KeyError: 'missing'"]))


def test_normalize(o, tools):
    head("G. normalization: concise for the model, complete for the UI")

    n = o.normalize("run_command", NOISY)
    ok("the brief is far smaller than the raw output",
       len(n["brief"]) < len(n["raw"]) * 0.35,
       "brief=%d raw=%d" % (len(n["brief"]), len(n["raw"])))
    ok("the raw output is still available for the UI",
       "Downloading requests" in n["raw"])
    ok("the error at the END survives truncation",
       "KeyError" in n["brief"],
       "tail lost -- brief ends %r" % n["brief"][-60:])
    ok("warning spam is stripped from the brief",
       "however 24.0 is available" not in n["brief"])
    ok("the real result line survives",
       "Successfully installed" in n["brief"])
    ok("the exit code is carried as a fact", "exit=0" in str(n["facts"]))

    real, live = web_search_live(tools)
    if not live:
        skip("search normalization", "DuckDuckGo returned no results after 3 tries")
    else:
        ns = o.normalize("web_search", real)
        ok("search results become numbered title + source",
           re.search(r"^1\. .+ -- https?://", ns["brief"], re.M) is not None,
           ns["brief"][:120])
        ok("source URLs are extracted as facts", len(ns["facts"]) >= 1,
           str(ns["facts"][:2]))
        ok("search brief is compact", len(ns["brief"]) < 900,
           "len=%d" % len(ns["brief"]))

    bad = o.normalize("run_command", "tool error: boom")
    ok("a tool error is flagged not-ok", not bad["ok"])
    blk = o.normalize("browser", "BLOCKED by overlay: #veil is covering #go")
    ok("a browser block is flagged not-ok", not blk["ok"])
    ok("a browser block is typed so the UI can say why",
       blk["kind"] == "browser-blocked")

    return {"raw": len(n["raw"]), "brief": len(n["brief"])}


# --------------------------------------------------------------------------
# H. Failover: the task survives a change of engine
# --------------------------------------------------------------------------
def test_failover(o):
    head("H. failover: another engine continues the same task")

    plan = o.Plan(o.route("search for python news and make an image of it"))
    first = plan.next_action()
    ok("the first wave is the search", len(first) == 1
       and first[0].intent == "web_search")

    plan.record(first[0].id, brief="1. News -- https://x.test",
                result="* News :: https://x.test", status="done")

    blob = plan.checkpoint()
    revived = o.Plan.resume(blob)

    ok("the goal survived the round trip", revived.goal == plan.goal)
    ok("the completed step is still complete",
       revived.find(first[0].id).status == "done")
    ok("its result came back with it",
       "x.test" in (revived.find(first[0].id).result or ""))
    ok("the evidence list survived", revived.evidence == plan.evidence)

    nxt = revived.next_action()
    ok("the revived plan knows the NEXT action is the image",
       nxt is not None and len(nxt) == 1 and nxt[0].intent == "image",
       str([s.intent for s in (nxt or [])]))
    ok("it does not redo the finished search",
       all(s.id != first[0].id for s in (nxt or [])))
    ok("the checkpoint is small enough to send",
       len(blob) < 4000, "%d bytes" % len(blob))

    # Mid-task, with a real artifact on disk. Verification has to survive the
    # failover too, so the resumed engine checks bytes, not a claimed URL.
    probe = Path(o.MEDIA_DIR) / "failover.jpg"
    probe.parent.mkdir(parents=True, exist_ok=True)
    probe.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 64)
    revived.record(nxt[0].id, brief="IMAGE SAVED but tunnel url unknown yet: "
                                   "failover.jpg (68 bytes)",
                   result="IMAGE SAVED but tunnel url unknown yet: "
                          "failover.jpg (68 bytes)", status="done")
    g, u = revived.verify()
    ok("the resumed plan verifies a real artifact", g, str(u))

    # And it must still reject a claim with nothing behind it.
    lying = o.Plan.resume(blob)
    lying.record(nxt[0].id, brief="done", result="IMAGE READY: https://x/y.jpg",
                 status="done")
    g2, u2 = lying.verify()
    ok("the resumed plan still rejects an unbacked claim", not g2, str(u2))


# --------------------------------------------------------------------------
# I. One real task combining research, files, commands and media
# --------------------------------------------------------------------------
def test_combined_real(o, tools):
    head("I. real combined task: research + file + command + media")

    if not web_search_live(tools, tries=2)[1]:
        skip("combined task", "DuckDuckGo is returning no results right now; "
                              "the research step cannot be run for real")
        return {"wall": 0, "calls": 0, "verified": None}

    text = ("search for what the Python software foundation does, save a "
            "summary to a file, and generate an image of a python logo")
    plan = o.Plan(o.route(text))
    budget = o.Budget(max_calls=12)
    log = []

    t0 = time.time()
    guard = 0
    while guard < 8:
        guard += 1
        wave = plan.next_action()
        if not wave:
            break

        def run(step):
            tool = step.tool
            args = _args_for(step, plan)
            if budget.give_up_on(tool, args):
                budget.refused += 1
                return step.id, {"brief": "ABANDONED after repeated failure",
                                 "raw": "", "ok": False, "kind": "refused",
                                 "facts": []}, False
            cached = budget.duplicate_of(tool, args)
            if cached is not None:
                budget.replay()
                return step.id, cached, True
            raw = _invoke(tools, tool, args)
            n = o.normalize(tool, raw)
            budget.note(tool, args, n["brief"], n["ok"])
            return step.id, n, False

        # The wave is independent by construction, so it runs concurrently.
        with cf.ThreadPoolExecutor(max_workers=max(1, len(wave))) as ex:
            for sid, n, replayed in ex.map(run, wave):
                if replayed:
                    plan.record(sid, brief=n, result=n, status="done")
                else:
                    plan.record(sid, brief=n["brief"], result=n["raw"],
                                status="done" if n["ok"] else "failed")
                log.append("%s %s%s" % (sid, plan.find(sid).intent,
                                        " (replayed)" if replayed else ""))

        done, unmet = plan.verify()
        if done:
            break
        # Verification failed: keep going on whatever is still open, but stop
        # asking for an action that has already failed twice.
        for s in plan.steps:
            if s.status != "failed":
                continue
            if budget.give_up_on(s.tool, _args_for(s, plan)):
                s.status = "blocked"
                s.error = "abandoned: the same action failed %d times" % s.tries
            elif s.tries < 3:
                s.status = "planned"
    wall = time.time() - t0

    done, unmet = plan.verify()
    print("       %s" % plan.summary())
    print("       order: %s" % " -> ".join(log))
    print("       budget: %s" % json.dumps(budget.stats()))

    ok("the combined task verified", done, str(unmet))
    ok("every capability in the request was used",
       {"web_search", "run_command", "generate_image"}
       <= {s.tool for s in plan.steps if s.status == "verified"},
       str([s.tool for s in plan.steps]))
    ok("it finished inside the budget", not budget.exhausted(),
       json.dumps(budget.stats()))
    ok("no failed action was retried more than twice",
       max([s.tries for s in plan.steps] or [0]) <= 2,
       "tries=%s" % [s.tries for s in plan.steps])
    print("       wall %.2fs" % wall)
    return {"wall": wall, "calls": budget.stats()["calls"], "verified": done}


def _args_for(step, plan):
    i = step.intent
    if i == "web_search":
        q = re.sub(r'[^A-Za-z0-9 ]', ' ', plan.goal)
        return {"query": " ".join(q.split()[2:8]) or "python"}
    if i == "run_command":
        p = WORK / "psf-summary.txt"
        return {"command": "printf 'PSF: coordinates Python development.\\n' > %s"
                           " && wc -c %s" % (p, p)}
    if i == "image":
        return {"prompt": "python programming language logo, flat vector",
                "filename": "psf-logo.jpg"}
    if i == "audio":
        return {"text": "The Python Software Foundation coordinates development."}
    if i == "fetch_page":
        return {"url": (plan.urls or ["https://example.com"])[0]}
    if i == "crawl_site":
        return {"url": (plan.urls or ["https://example.com"])[0], "max_pages": 2}
    if i == "browser":
        return {"action": "inspect"}
    return {}


def _invoke(tools, tool, args):
    fn = {"web_search": "t_web_search", "fetch_page": "t_fetch_page",
          "crawl_site": "t_crawl_site", "run_command": "t_run_command",
          "generate_image": "t_generate_image",
          "generate_voice": "t_generate_voice"}.get(tool)
    if fn is None:
        return "no such tool: %s" % tool
    try:
        return tools[fn](**args)
    except Exception as e:
        return "tool error: %s: %s" % (e.__class__.__name__, str(e)[:200])


# --------------------------------------------------------------------------
# J. A real engine, when one is reachable. Never faked.
# --------------------------------------------------------------------------
def test_live_engine(o, url):
    head("J. live engine: the model itself picks the tool")
    if not url:
        skip("live engine", "no engine URL given (--engine URL)")
        return None
    probe = subprocess.run(["curl", "-s", "-m", "20", url.rstrip("/") + "/api/ps"],
                           capture_output=True, text=True)
    if '"models"' not in (probe.stdout or ""):
        skip("live engine", "engine not answering /api/ps")
        return None
    print("  engine answers /api/ps")

    prompts = [
        ("search the web for today's top python news", "web_search"),
        ("generate an image of a blue cube", "generate_image"),
        ("what is 17 * 23? use the shell", "run_command"),
        ("hello, how are you?", None),   # must NOT spend a tool call
        # Two capabilities in one sentence. This is the case a four-tool
        # system prompt and no planner are most likely to half-answer.
        ("search for the current population of Lagos, then generate an image "
         "of the Lagos skyline", "web_search+generate_image"),
    ]
    results = []
    for prompt, expect in prompts:
        t0 = time.time()
        r = subprocess.run(
            ["curl", "-s", "-N", "-m", "420", "-H", "Content-Type: application/json",
             "-H", "X-Engine-Key: " + ENGINE_KEY,
             "-d", json.dumps({"messages": [{"role": "user", "content": prompt}],
                               "stream": True}),
             url.rstrip("/") + "/api/chat"],
            capture_output=True, text=True)
        wall = time.time() - t0
        names, answer = [], ""
        for line in (r.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get("message") or {}
            th = m.get("thinking") or ""
            # The kernel announces each tool call as "🛠 name({...})".
            for nm in re.findall(r"\U0001f6e0\ufe0f ([a-z_]+)\(", th):
                if nm not in names:
                    names.append(nm)
            answer += m.get("content") or ""
        results.append({"prompt": prompt, "expect": expect, "tools": names,
                        "wall": round(wall, 1), "answer_chars": len(answer),
                        "answer": answer})
        print("       %-42s -> %-28s %5.1fs %d chars"
              % (prompt[:42], (",".join(names) or "(none)"), wall, len(answer)))

    want = [x for x in results if x["expect"] and "+" not in x["expect"]]
    ok("every single-capability prompt called the right tool",
       all(x["expect"] in x["tools"] for x in want),
       str([(x["prompt"][:24], x["expect"], x["tools"]) for x in want]))

    multi = [x for x in results if x["expect"] and "+" in x["expect"]]
    for x in multi:
        need = x["expect"].split("+")
        ok("a two-capability request used BOTH tools",
           all(t in x["tools"] for t in need),
           "wanted %s got %s" % (need, x["tools"]))

    chat = [x for x in results if x["expect"] is None]
    ok("a greeting spends no tool call",
       all(not x["tools"] for x in chat),
       str([(x["prompt"][:20], x["tools"]) for x in chat]))
    ok("every prompt reached a terminal state with content",
       all(x["answer_chars"] > 0 for x in results),
       str([(x["prompt"][:20], x["answer_chars"]) for x in results]))

    # ---- external verification of the outcome -------------------------
    # The model saying it made an image is not evidence. Download what it
    # handed back and look at the bytes.
    img = [x for x in results if "generate_image" in x["tools"]]
    checked = 0
    for x in img:
        for u in re.findall(r'https?://\S+\.(?:jpg|jpeg|png)', x.get("answer", "")):
            u = u.rstrip('.,)')
            r = subprocess.run(["curl", "-sL", "-m", "90", "-o",
                                str(WORK / "live-check.bin"), u],
                               capture_output=True)
            magic = (WORK / "live-check.bin").read_bytes()[:4]
            checked += 1
            ok("the image it handed back is a real JPEG/PNG (%s)" % u[-34:],
               magic[:2] in (b"\xff\xd8", b"\x89P"), "header=%r" % magic)
            break
    if img and not checked:
        skip("image bytes check", "no media URL in the answer to download")

    # A researched answer has to cite something that actually resolves.
    res = [x for x in results if "web_search" in x["tools"]]
    cited = 0
    for x in res[:1]:
        for u in re.findall(r'https?://[^\s)\]]+', x.get("answer", ""))[:3]:
            u = u.rstrip('.,)')
            code = subprocess.run(["curl", "-s", "-o", "/dev/null", "-m", "30",
                                   "-w", "%{http_code}", "-L", u],
                                  capture_output=True, text=True).stdout
            cited += 1
            ok("a cited source actually resolves (%s -> %s)" % (u[-38:], code),
               code.isdigit() and int(code) < 400, "http %s" % code)
            break
    if res and not cited:
        skip("source citation check", "the answer cited no URL")

    return results


def main():
    args = sys.argv[1:]
    engine = args[args.index("--engine") + 1] if "--engine" in args else None

    WORK.mkdir(parents=True, exist_ok=True)
    o = load_orch()
    tools = extract_tools()
    # The kernel sets this to its GEN_DIR at boot; the verifier needs it to
    # find media the tool reported by bare filename.
    o.MEDIA_DIR = str(tools.get("GEN_DIR") or WORK)
    print("kernel tools extracted from %s" % ASSET.name)

    r_good, r_total = test_routing(o)
    test_planning(o)
    if "--quick" not in args:
        test_parallel_real(o, tools)
    test_recovery(o, tools)
    test_verification(o, tools)
    test_budget(o)
    test_normalize(o, tools)
    test_failover(o)
    if "--quick" not in args:
        test_combined_real(o, tools)
    test_live_engine(o, engine)

    print("\n%d passed, %d failed" % (PASSED, FAILED))
    print("routing accuracy: %d/%d" % (r_good, r_total))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
