#!/usr/bin/env python3
"""GAP 6 -- REAL TASK COMPLETION, live, and again while killing the engine.

The audit demand, in full:

  A genuine long task requiring web search/crawl + file processing +
  commands + workspace edits + verification + final artifact. Must actually
  finish and return the result. Then repeat it while deliberately killing the
  active engine mid-run.

What "actually finish" is judged by here -- never by the model's prose:

  * the workspace zip exported from the engine contains every file the task
    was told to produce, each non-empty;
  * summary.md mentions all three countries (it had to READ the three data
    files to do that, which is the file-processing step);
  * the final artifact archive really exists: the package_files tool result
    carries a /files/... URL and this harness fetches that URL and checks it
    is a ZIP with the four members. A model claiming "archive created" over
    an archive that was never served has failed this test before (see
    fb0dbfa), so the bytes are the judge, not the sentence.

Phase 2 kills the engine with POST /off from a watchdog thread the moment the
Nth tool call finishes -- while the turn is still streaming, i.e. genuinely
mid-run, not between turns. The workspace snapshot is taken through the live
tunnel BEFORE the kill (after the kill the engine serves nothing), restored
into the survivor, and the survivor is told to continue the SAME task. Files
that existed at the kill point must survive byte-identical: if the survivor
redid them, the contents would differ. That equality is the proof that
finished work is carried over instead of restarted.

Usage:
  real-task-live.py --run URL
  real-task-live.py --kill SLOT=URL --survivor SLOT=URL [--kill-after N]
"""
import argparse
import io
import json
import os
import sys
import threading
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
    print("\n== %s ==" % t, flush=True)


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


def get(url, path, timeout=60, key=True):
    h = {"X-Engine-Key": KEY} if key else {}
    req = urllib.request.Request(url + path, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return None, ("%s: %s" % (type(e).__name__, str(e)[:120])).encode()


def alive(url):
    st, body = get(url, "/api/ps", timeout=15)
    if st != 200:
        return False
    try:
        return len(json.loads(body).get("models") or []) > 0
    except Exception:
        return False


def ready(url):
    st, body = get(url, "/api/ready", timeout=15)
    try:
        return json.loads(body).get("ready") if st == 200 else False
    except Exception:
        return False


TASK = (
    "Build a research package about renewable energy access in three "
    "countries. Work through the steps in order; every file goes in the "
    "workspace root. Use exactly one web_search and at most one fetch_page "
    "per country -- do not browse further.\n"
    "step 1: web_search for Nigeria rural electricity access statistics, "
    "optionally fetch_page one result, then write at least 3 sourced "
    "bullet-point facts into nigeria.txt using run_command.\n"
    "step 2: web_search for Kenya rural electricity access statistics, "
    "then write at least 3 sourced bullet-point facts into kenya.txt.\n"
    "step 3: web_search for Morocco renewable energy share statistics, "
    "then write at least 3 sourced bullet-point facts into morocco.txt.\n"
    "step 4: read nigeria.txt, kenya.txt and morocco.txt, then write "
    "summary.md containing a markdown comparison table of the three "
    "countries and one concluding paragraph that cites numbers from all "
    "three files.\n"
    "step 5: call package_files with name energy-pack.zip to bundle "
    "nigeria.txt, kenya.txt, morocco.txt and summary.md.\n"
    "When the archive is created, answer with exactly this line and "
    "nothing else: RESEARCH COMPLETE energy-pack.zip"
)

FILES = ["nigeria.txt", "kenya.txt", "morocco.txt", "summary.md"]
COUNTRIES = ["nigeria", "kenya", "morocco"]


def stream_task(url, session, on_tool=None, timeout=900, prompt=None):
    """Run the task turn. on_tool(index, result) is called after each tool
    result so a watchdog can act mid-turn. Returns collected evidence."""
    body = json.dumps({"session": session, "tools": True,
                       "messages": [{"role": "user",
                                     "content": prompt or TASK}]}).encode()
    req = urllib.request.Request(url + "/api/chat", data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "X-Engine-Key": KEY})
    t0 = time.time()
    tools, text, files_urls = [], [], []
    n = 0
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
                c = (ev.get("message") or {}).get("content")
                if c:
                    text.append(c)
                tr = ev.get("tool_result")
                if tr:
                    n += 1
                    rawtxt = (tr.get("raw") or "")
                    tools.append({"tool": tr.get("tool"), "ok": tr.get("ok"),
                                  "raw": rawtxt})
                    for m in __import__("re").finditer(r"/files/[A-Za-z0-9_.-]+\.zip", rawtxt):
                        files_urls.append(m.group(0))
                    print("      tool %-14s ok=%-5s %6d chars" %
                          (tr.get("tool"), tr.get("ok"), len(rawtxt)), flush=True)
                    if on_tool:
                        on_tool(n, tr)
    except Exception as e:
        print("      (stream ended: %s)" % str(e)[:110], flush=True)
    return {"wall": time.time() - t0, "tools": tools,
            "text": "".join(text), "archives": files_urls}


def export_ws(url, session):
    st, body = get(url, "/workspace/%s.zip" % session, timeout=90)
    if st != 200 or body[:2] != b"PK":
        return None
    out = {}
    try:
        zf = zipfile.ZipFile(io.BytesIO(body))
        for n_ in zf.namelist():
            out[n_] = zf.read(n_)
    except Exception as e:
        print("      (zip read error: %s)" % str(e)[:100])
        return None
    return out


def check_final(url, session, run, label):
    """The completion assertions. run is the stream_task() result."""
    head("%s: completion checks" % label)
    tool_names = [t["tool"] for t in run["tools"]]
    ok("web_search was really used", "web_search" in tool_names, str(tool_names))
    ok("commands were really run", "run_command" in tool_names)
    ws = export_ws(url, session)
    if ws is None:
        ok("workspace exportable for verification", False)
        return
    ok("workspace exportable for verification", True)
    missing = [f for f in FILES if f not in ws]
    ok("all four task files exist in the workspace", not missing,
       "missing=%s have=%s" % (missing, sorted(ws)))
    empty = [f for f in FILES if f in ws and len(ws[f].strip()) == 0]
    ok("none of the task files is empty", not empty, str(empty))
    summ = ws.get("summary.md", b"").decode("utf-8", "replace").lower()
    notcited = [c for c in COUNTRIES if c not in summ]
    ok("summary.md cites all three countries (it had to read the files)",
       bool(summ) and not notcited, "missing=%s len=%d" % (notcited, len(summ)))
    # The artifact: package_files writes GEN_DIR/<name>.zip, which the tunnel
    # serves at /files/<name>.zip -- but its tool text reports only "ARCHIVE
    # READY ... sha256 ...", no URL, so the URL is constructed from the task's
    # required name, with any .zip name seen in tool output as a fallback.
    ok("package_files ran", "package_files" in tool_names, str(tool_names))
    candidates = ["/files/energy-pack.zip"]
    for t in run["tools"]:
        for m in __import__("re").finditer(r"([A-Za-z0-9_.-]+\.zip)", t["raw"] or ""):
            c = "/files/" + m.group(1)
            if c not in candidates:
                candidates.append(c)
    served = None
    for u in candidates:
        st, body = get(url, u, timeout=60, key=False)
        if st == 200 and body[:2] == b"PK":
            names = zipfile.ZipFile(io.BytesIO(body)).namelist()
            served = (u, body, names)
            break
    if ok("the final artifact archive is really served (bytes fetched)",
          served is not None, "tried=%s" % candidates[:4]):
        u, body, names = served
        print("      artifact %s  %d bytes  members=%s" % (u, len(body), names))
        miss = [f for f in FILES if f not in names]
        ok("the artifact contains all four task files", not miss,
           "missing=%s members=%s" % (miss, names))
        # GEN_DIR is shared across sessions, so a stale archive from an
        # earlier run can sit at the same URL -- measured live: a killed
        # continuation "passed" on the previous session's energy-pack.zip.
        # The archive is only this run's artifact if its members are the
        # bytes this session's workspace actually holds.
        zf = zipfile.ZipFile(io.BytesIO(body))
        mismatched = [f for f in FILES
                      if f in names and zf.read(f) != ws.get(f)]
        ok("the artifact was built from THIS run's files (bytes match)",
           not mismatched, "members differing from workspace: %s" % mismatched)
    ok("the run ended with the exact completion line",
       "RESEARCH COMPLETE energy-pack.zip" in run["text"],
       "final text=%r" % run["text"][-160:])


def phase1(url):
    session = "realtask-%d" % int(time.time())
    head("1. engine really ready before starting")
    if not ok("engine answers /api/ps with a model", alive(url)):
        return 2
    if not ok("engine reports ready=true", ready(url)):
        print("  waiting up to 6 min for readiness...")
        t0 = time.time()
        while time.time() - t0 < 360 and not ready(url):
            time.sleep(10)
        if not ok("engine became ready", ready(url)):
            return 2
    head("2. the real task runs to completion (session %s)" % session)
    run = stream_task(url, session)
    print("  turn: %.1fs, %d tool calls" % (run["wall"], len(run["tools"])))
    ok("the task used tools at all", len(run["tools"]) >= 4,
       "tools=%d" % len(run["tools"]))
    check_final(url, session, run, "3")
    print("\n%d passed, %d failed" % (PASSED, FAILED))
    return 1 if FAILED else 0


def wait_ready(url, label, limit=420):
    t0 = time.time()
    while time.time() - t0 < limit:
        if ready(url):
            print("      %s ready after %.0fs" % (label, time.time() - t0))
            return True
        time.sleep(10)
    return False


def phase2(kill_url, kill_slot, surv_url, surv_slot, kill_after):
    session = "realtask-%d" % int(time.time())
    head("1. both engines really ready")
    # /api/ps 200 only means the weights are on disk; a turn sent during the
    # VRAM load is held by the warm gate and would burn the kill window on
    # heartbeats instead of real work. Wait for real readiness.
    for lbl, u in ((kill_slot, kill_url), (surv_slot, surv_url)):
        if not ready(u):
            print("      waiting for %s readiness..." % lbl.upper())
            if not wait_ready(u, lbl.upper()):
                ok("engine %s ready" % lbl.upper(), False, "not ready after 420s")
                return 2
    if not (ok("engine %s ready" % kill_slot.upper(), ready(kill_url))
            and ok("engine %s ready" % surv_slot.upper(), ready(surv_url))):
        return 2

    head("2. the same real task starts on %s and the engine is killed mid-run"
         % kill_slot.upper())
    state = {"snapshot": None, "killed": False, "killed_at": None}

    def watchdog(n, tr):
        if state["killed"] or n < kill_after:
            return
        # Snapshot the workspace through the LIVE tunnel first: after /off
        # there is nothing left to export. And only kill once the snapshot
        # holds real files -- killing before the task has written anything
        # would prove nothing about carrying work over, so the first run of
        # this harness (kill after a web_search and a fetch_page) correctly
        # refused to continue from an empty set.
        snap = export_ws(kill_url, session)
        if not snap:
            print("      [watchdog] after tool %d the workspace is still "
                  "empty - waiting for real work" % n, flush=True)
            return
        state["snapshot"] = snap
        print("      [watchdog] snapshot taken after tool %d: %s"
              % (n, sorted(snap)), flush=True)
        st, body = post(kill_url, "/off", timeout=30)
        state["killed"] = True
        state["killed_at"] = n
        print("      [watchdog] POST /off -> http=%s  (engine %s killed "
              "mid-run)" % (st, kill_slot.upper()), flush=True)

    run = stream_task(kill_url, session, on_tool=watchdog)
    ok("the engine was killed while the run was still going",
       state["killed"] and state["killed_at"] is not None,
       "killed=%s at_tool=%s stream_wall=%.1fs"
       % (state["killed"], state["killed_at"], run["wall"]))
    time.sleep(10)
    ok("the killed engine no longer answers", not alive(kill_url))
    if not ok("a workspace snapshot exists from before the kill",
              bool(state["snapshot"])):
        print("\n%d passed, %d failed" % (PASSED, FAILED))
        return 1

    head("3. the snapshot is restored into %s and the SAME task continues"
         % surv_slot.upper())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in state["snapshot"].items():
            z.writestr(name, data)
    rst, rbody = post(surv_url, "/workspace/%s" % session, buf.getvalue(),
                      ctype="application/zip", timeout=120)
    ok("the restore was accepted", rst == 200, "http=%s %r" % (rst, rbody[:120]))
    try:
        restored_n = json.loads(rbody).get("files")
    except Exception:
        restored_n = None
    ok("the restore wrote every snapshot file",
       restored_n == len(state["snapshot"]),
       "snapshot=%d restored=%r" % (len(state["snapshot"]), restored_n))

    # The survivor must be told it is CONTINUING. Sent the raw TASK, a live
    # run treated it as new work, re-searched everything, wrote nothing and
    # eventually tripped the 180s stall watchdog -- the engine was fine, the
    # instruction was wrong. This mirrors what the real client does: the
    # session carries the task, the workspace carries the state.
    have = sorted(state["snapshot"])
    cont_prompt = (
        "You are taking over a task interrupted on another engine. Its "
        "workspace was restored here and already contains: %s. Do NOT redo "
        "those files -- they are finished. Inspect them if you need their "
        "contents, then complete ONLY the remaining steps of this task:\n\n"
        "%s" % (", ".join(have), TASK))
    cont = stream_task(surv_url, session, prompt=cont_prompt)
    print("  continuation turn: %.1fs, %d tool calls"
          % (cont["wall"], len(cont["tools"])))

    head("4. continuity: finished work carried over, task still finishes")
    final = export_ws(surv_url, session)
    ok("final workspace exportable", final is not None)
    if final is None:
        print("\n%d passed, %d failed" % (PASSED, FAILED))
        return 1
    redone = [n_ for n_, data in state["snapshot"].items()
              if n_ in final and final[n_] != data]
    ok("every file that existed at the kill is byte-identical afterwards "
       "(nothing redone)", not redone, "changed=%s" % redone)
    check_final(surv_url, session, cont, "5")
    print("\n%d passed, %d failed" % (PASSED, FAILED))
    return 1 if FAILED else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", help="URL: run the real task to completion")
    ap.add_argument("--kill", help="SLOT=URL: engine to kill mid-run")
    ap.add_argument("--survivor", help="SLOT=URL: engine to continue on")
    ap.add_argument("--kill-after", type=int, default=2,
                    help="kill once this many tool calls have finished")
    a = ap.parse_args()
    if a.run:
        return phase1(a.run.rstrip("/"))
    if a.kill and a.survivor:
        ks, ku = a.kill.split("=", 1)
        ss, su = a.survivor.split("=", 1)
        return phase2(ku.rstrip("/"), ks, su.rstrip("/"), ss, a.kill_after)
    ap.error("need --run URL or (--kill SLOT=URL --survivor SLOT=URL)")


if __name__ == "__main__":
    sys.exit(main())
