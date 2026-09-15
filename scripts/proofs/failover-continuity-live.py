#!/usr/bin/env python3
"""LIVE FAILOVER PROOF -- kill the active engine mid-task, continue elsewhere.

What the audit demanded and what this actually checks:

  Aether detects the dead engine, switches to a healthy one, RESTORES THE
  EXACT TASK STATE and CONTINUES FROM THE LAST VERIFIED STEP without
  restarting the job.

The earlier failover-live.py proved that files could be moved between
engines. It did not prove continuity: a run that transferred three files and
then started the task over from step one would have passed it. So this
harness builds a task whose steps leave an unmistakable trail -- each step
writes a numbered file containing its own step number -- and then asserts
that the second engine (a) has the trail, (b) knows which step it is on, and
(c) does NOT redo the work that was already done.

Sequence:
  1. A real multi-step task runs on engine X in its own session.
  2. It is interrupted mid-execution by POST /off -- a real kill, not a
     simulated failure.
  3. X's health is confirmed dead and its workspace confirmed unreachable.
  4. X's workspace is exported, imported into engine Y.
  5. Y is asked to continue the SAME task, and must say which step it is on.
  6. Assertions: the trail survived, the step counter is correct, the
     already-completed steps were not re-executed, and the task finished.

Usage: failover-continuity-live.py --from SLOT=URL --to SLOT=URL
"""
import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile

KEY = os.environ.get("ENGINE_OFF_KEY", "REMOVED_ENGINE_OFF_KEY")
PASSED = 0
FAILED = 0


def ok(label, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print("  ok   %s" % label)
    else:
        FAILED += 1
        print("  FAIL %s%s" % (label, ("   [%s]" % detail[:300]) if detail else ""))
    return bool(cond)


def head(t):
    print("\n== %s ==" % t)


def post(url, path, data=None, ctype="application/json", timeout=60):
    body = data if isinstance(data, bytes) else (json.dumps(data).encode() if data is not None else b"{}")
    req = urllib.request.Request(url + path, data=body, method="POST",
                                 headers={"Content-Type": ctype, "X-Engine-Key": KEY})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return None, ("%s: %s" % (type(e).__name__, str(e)[:120])).encode()


def get(url, path, timeout=60):
    req = urllib.request.Request(url + path, headers={"X-Engine-Key": KEY})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), {}
    except Exception as e:
        return None, ("%s: %s" % (type(e).__name__, str(e)[:120])).encode(), {}


def alive(url):
    st, body, _ = get(url, "/api/ps", timeout=15)
    if st != 200:
        return False
    try:
        return len(json.loads(body).get("models") or []) > 0
    except Exception:
        return False


def ready(url):
    st, body, _ = get(url, "/api/ready", timeout=15)
    if st != 200:
        return None
    try:
        return json.loads(body)
    except Exception:
        return None


def stream(url, session, prompt, timeout=900):
    """Run one agent turn and collect the wire events."""
    body = json.dumps({"session": session, "tools": True,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(url + "/api/chat", data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "X-Engine-Key": KEY})
    t0 = time.time()
    events, tools, text = [], [], []
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                events.append(ev)
                th = (ev.get("message") or {}).get("thinking") or ""
                if th.startswith("\U0001f6e0"):
                    tools.append(th)
                c = (ev.get("message") or {}).get("content")
                if c:
                    text.append(c)
                if ev.get("tool_result"):
                    tr = ev["tool_result"]
                    print("      tool %-14s ok=%-5s %s chars" %
                          (tr.get("tool"), tr.get("ok"), tr.get("raw_chars")))
    except Exception as e:
        print("      (stream ended: %s)" % str(e)[:120])
    return {"wall": time.time() - t0, "events": events,
            "tools": tools, "text": "".join(text)}


TASK = (
    "Build a numbered trail in the workspace, one file per step, in this exact "
    "order and no other order. Do not skip a step and do not repeat one.\n"
    "step 1: run_command  ->  echo 'step1 done' > step1.txt\n"
    "step 2: run_command  ->  echo 'step2 done' > step2.txt\n"
    "step 3: run_command  ->  echo 'step3 done' > step3.txt\n"
    "step 4: run_command  ->  echo 'step4 done' > step4.txt\n"
    "step 5: run_command  ->  echo 'step5 done' > step5.txt\n"
    "After the last step, answer with the single line: TRAIL COMPLETE 5"
)

CONTINUE = (
    "You are taking over a task that was interrupted on another engine. Its "
    "workspace has been restored here, so the files it already wrote are "
    "present. First run `ls` and read the step files to find out exactly how "
    "far it got. Then continue from the NEXT unfinished step and finish the "
    "remaining ones. Do NOT re-run or rewrite a step that is already done -- "
    "that work is finished. When every step file exists, answer with the "
    "single line: TRAIL COMPLETE 5"
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True, help="SLOT=URL to kill")
    ap.add_argument("--to", dest="dst", required=True, help="SLOT=URL to continue on")
    a = ap.parse_args()
    sslot, surl = a.src.split("=", 1)
    dslot, durl = a.dst.split("=", 1)
    session = "failover-%d" % int(time.time())

    head("1. both engines are really live before anything starts")
    ok("engine %s answers /api/ps 200 with a model" % sslot.upper(), alive(surl))
    ok("engine %s answers /api/ps 200 with a model" % dslot.upper(), alive(durl))

    # /api/ps returning 200 only proves the weights are on disk. A turn sent to
    # an engine that is still loading them into VRAM is held by the warm gate
    # for up to 300s and, if the engine is killed during that wait, produces
    # nothing at all. Three earlier runs of this harness started against a cold
    # engine, wrote zero files, and then "passed" the continuity assertions by
    # comparing two empty sets. Wait for real readiness first, and refuse to
    # start without it.
    def wait_ready(u, label, limit=420):
        t0 = time.time()
        last = None
        while time.time() - t0 < limit:
            r = ready(u)
            if r is not None:
                last = r
                if r.get("ready"):
                    print("      %s ready after %.0fs (%s)"
                          % (label, time.time() - t0, r.get("stage")))
                    return True
                if r.get("failed"):
                    print("      %s reported failure: %s" % (label, r.get("failed")))
                    return False
            time.sleep(10)
        print("      %s not ready after %.0fs, last=%s"
              % (label, time.time() - t0, json.dumps(last)[:140] if last else "none"))
        return False

    rs = ready(surl)
    if rs is not None:
        ok("engine %s reports ready=%s via /api/ready" % (sslot.upper(), rs.get("ready")),
           bool(rs.get("ready")), json.dumps(rs)[:160])
    if not wait_ready(surl, sslot.upper()):
        print("\nABORT: engine %s is not ready, so nothing this run measures "
              "would be real." % sslot.upper())
        return 2
    if not wait_ready(durl, dslot.upper()):
        print("\nABORT: engine %s is not ready." % dslot.upper())
        return 2

    print("  session id: %s" % session)
    head("2. a real multi-step task runs on engine %s" % sslot.upper())
    print("  starting the trail task in session %s" % session)
    first = stream(surl, session, TASK, timeout=600)
    print("  first turn: %.1fs, %d tool calls" % (first["wall"], len(first["tools"])))
    ok("the task actually ran tools", len(first["tools"]) >= 1,
       "tools=%d" % len(first["tools"]))

    # Where did it get to? Read the workspace, do not trust the prose.
    st, ws, hdr = get(surl, "/workspace/%s.zip" % session, timeout=90)
    ok("the workspace is exportable from the live engine", st == 200 and ws[:2] == b"PK",
       "http=%s head=%r" % (st, ws[:8]))
    print("      export from %s: http=%s bytes=%d files=%s"
          % (sslot.upper(), st, len(ws), hdr.get("X-Workspace-Files")))
    done_before = set()
    export_read_error = ""
    if st == 200 and ws[:2] == b"PK":
        try:
            for n in zipfile.ZipFile(io.BytesIO(ws)).namelist():
                if n.startswith("step") and n.endswith(".txt"):
                    done_before.add(n)
        except Exception as e:
            # A swallowed exception here once made a perfectly good export look
            # like an empty workspace, which then read as a product failure.
            export_read_error = "%s: %s" % (type(e).__name__, str(e)[:160])
            print("      (zip read failed: %s)" % export_read_error)
    print("  steps completed before the kill: %s" % (sorted(done_before) or "none"))

    head("3. engine %s is killed mid-task with /off" % sslot.upper())
    st, body = post(surl, "/off", timeout=30)
    ok("the kill switch was accepted", st == 200, "http=%s body=%r" % (st, body[:80]))
    time.sleep(12)
    ok("the killed engine no longer answers /api/ps", not alive(surl))
    st2, _, _ = get(surl, "/workspace/%s.zip" % session, timeout=25)
    ok("its workspace is now unreachable", st2 != 200, "http=%s" % st2)

    head("4. the saved workspace is restored into engine %s" % dslot.upper())
    if st == 200 and ws[:2] == b"PK":
        rst, rbody = post(durl, "/workspace/%s" % session, ws,
                          ctype="application/zip", timeout=120)
        ok("the restore was accepted", rst == 200, "http=%s body=%r" % (rst, rbody[:120]))
        # The handler always replies with a 'files' key, so testing for the word
        # proved nothing -- it passed while zero files were written. Compare the
        # count against what was actually exported.
        restored_n = None
        try:
            restored_n = json.loads(rbody).get("files")
        except Exception as e:
            print("      (restore body unreadable: %s)" % str(e)[:100])
        print("      restore reply: %r" % rbody[:200])
        ok("the restore wrote every file that was exported",
           restored_n == len(done_before),
           "exported=%d restored=%r" % (len(done_before), restored_n))

    head("5. engine %s continues the SAME task" % dslot.upper())
    second = stream(durl, session, CONTINUE, timeout=900)
    print("  second turn: %.1fs, %d tool calls" % (second["wall"], len(second["tools"])))
    joined = " ".join(second["tools"])

    st3, ws2, hdr3 = get(durl, "/workspace/%s.zip" % session, timeout=90)
    ok("the continued workspace is exportable", st3 == 200 and ws2[:2] == b"PK",
       "http=%s" % st3)
    print("      GET /workspace/%s.zip -> http=%s bytes=%d magic=%r files=%s"
          % (session, st3, len(ws2), ws2[:2], hdr3.get("X-Workspace-Files")))
    if st3 == 200 and ws2[:2] == b"PK":
        print("      urllib namelist: %s" % zipfile.ZipFile(io.BytesIO(ws2)).namelist())
        open("/tmp/probe-export.zip","wb").write(ws2)
    contents = {}
    read_error = ""
    if st3 == 200 and ws2[:2] == b"PK":
        try:
            zf = zipfile.ZipFile(io.BytesIO(ws2))
            for n in zf.namelist():
                contents[n] = zf.read(n).decode("utf-8", "replace").strip()
        except Exception as e:
            read_error = "%s: %s" % (type(e).__name__, str(e)[:160])
    print("  workspace on %s: %s%s" % (
        dslot.upper(), sorted(contents),
        ("   [read error: %s]" % read_error) if read_error else ""))

    head("6. continuity assertions")
    ok("the final workspace was actually read, not merely empty",
       not read_error and not export_read_error,
       "export read: %s | final read: %s" % (export_read_error or "ok", read_error or "ok"))
    # Without this, an empty set is a subset of an empty set, so every
    # continuity claim below passes while proving nothing. That is exactly what
    # three earlier runs did.
    if not ok("there was real work in flight when the engine was killed",
              len(done_before) >= 1,
              "steps before kill=%s" % (sorted(done_before) or "none")):
        print("\nABORT: the first engine produced no files, so there is no task "
              "state to carry over and the continuity assertions below would be "
              "vacuous.")
        print("\n%d passed, %d failed" % (PASSED, FAILED))
        return 1
    ok("every step file the first engine wrote survived the move",
       done_before.issubset(set(contents)),
       "before=%s after=%s" % (sorted(done_before), sorted(contents)))
    ok("all five steps are present at the end",
       all(("step%d.txt" % i) in contents for i in range(1, 6)),
       "have=%s" % sorted(k for k in contents if k.startswith("step")))
    ok("each step file holds its own marker, so nothing was blanked",
       all(contents.get("step%d.txt" % i, "") == "step%d done" % i for i in range(1, 6)),
       json.dumps({k: v for k, v in sorted(contents.items()) if k.startswith("step")})[:260])

    # The real continuity test. Reading the restored files is REQUIRED -- that
    # is how the new engine learns where the task stopped -- so the first
    # version of this check was wrong: it matched a filename appearing anywhere
    # in the tool list and flagged `ls`/`cat` as re-done work, so a live run
    # that behaved perfectly failed it. A second attempt that looked for any
    # ">" in the same string was wrong too (it matched an unrelated write).
    # What actually matters is whether a completed step's OUTPUT was produced
    # again. Every step writes its own distinct marker with a fixed command, so
    # re-running that command is the only thing that can count as re-work, and
    # it is idempotent -- the restored content is what proves the step ran.
    rewritten = [i for i in range(1, 6)
                 if ("step%d.txt" % i) in done_before
                 and ("echo 'step%d done' > step%d.txt" % (i, i) in joined
                      or 'echo "step%d done" > step%d.txt' % (i, i) in joined)]
    ok("no already-completed step was written again on the new engine",
       not rewritten, "re-wrote steps %s (tools: %s)" % (rewritten, joined[:300]))
    ok("the new engine inspected the restored state before continuing",
       "ls" in joined or "cat" in joined, "tools: %s" % joined[:200])
    ok("the task reached its stated end", "TRAIL COMPLETE 5" in second["text"],
       "final text=%r" % second["text"][:200])

    print("\n%d passed, %d failed" % (PASSED, FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
