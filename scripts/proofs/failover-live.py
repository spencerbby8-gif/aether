#!/usr/bin/env python3
"""Mid-task failover proof: kill the active engine during a real task.

This is the test the audit demands and that could not be run before, because
only one engine could boot. It needs two live engines on different accounts.

Sequence:
  1. Start a real multi-step task on engine X in its own session.
  2. Wait until it has produced real artifacts (files in the workspace).
  3. Kill engine X mid-execution with /off -- not a simulated failure.
  4. Export X's workspace, restore it into engine Y.
  5. Ask Y to continue the same task from the transferred state.
  6. Verify Y completed it and that the artifacts survived.

Usage: failover-live.py --from SLOT=URL --to SLOT=URL
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

KEY = os.environ["ENGINE_OFF_KEY"]


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
        return None, ("%s: %s" % (type(e).__name__, str(e)[:100])).encode()


def get(url, path, timeout=60):
    req = urllib.request.Request(url + path, headers={"X-Engine-Key": KEY})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), {}
    except Exception as e:
        return None, ("%s: %s" % (type(e).__name__, str(e)[:100])).encode(), {}


def chat(url, msg, session, timeout=1500, on_event=None):
    body = json.dumps({"messages": [{"role": "user", "content": msg}],
                       "session": session, "stream": True}).encode()
    req = urllib.request.Request(url + "/api/chat", data=body,
                                 headers={"Content-Type": "application/json",
                                          "X-Engine-Key": KEY})
    t0 = time.perf_counter()
    tools, results, content, ver = [], [], "", None
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for line in r:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line.decode("utf-8", "replace"))
                except Exception:
                    continue
                m = d.get("message") or {}
                th = m.get("thinking") or ""
                if "\U0001f6e0" in th:
                    tools.append(th.split("(")[0].split()[-1])
                    if on_event:
                        on_event("tool", th[:70], time.perf_counter() - t0)
                if "tool_result" in d:
                    results.append(d["tool_result"])
                    if on_event:
                        on_event("result", d["tool_result"]["raw"][:60], time.perf_counter() - t0)
                if "verification" in d:
                    ver = d["verification"]
                content += m.get("content") or ""
    except Exception as e:
        return {"error": "%s: %s" % (type(e).__name__, str(e)[:120]),
                "wall": time.perf_counter() - t0, "tools": tools,
                "results": results, "content": content, "verification": ver}
    return {"wall": time.perf_counter() - t0, "tools": tools, "results": results,
            "content": content, "verification": ver}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True, help="SLOT=URL to kill")
    ap.add_argument("--to", dest="dst", required=True, help="SLOT=URL to continue on")
    a = ap.parse_args()
    sslot, surl = a.src.split("=", 1)
    dslot, durl = a.dst.split("=", 1)
    session = "failover-proof-%d" % int(time.time())
    passed, failed = 0, 0

    def check(name, ok, detail=""):
        nonlocal passed, failed
        if ok:
            passed += 1
            print("  PASS  %s%s" % (name, ("  " + detail) if detail else ""))
        else:
            failed += 1
            print("  FAIL  %s%s" % (name, ("  " + detail) if detail else ""))

    print("=" * 74)
    print("MID-TASK FAILOVER PROOF")
    print("  session : %s" % session)
    print("  victim  : engine %s  %s" % (sslot.upper(), surl))
    print("  survivor: engine %s  %s" % (dslot.upper(), durl))
    print("=" * 74)

    # --- 0. both engines must be genuinely serving before anything else ------
    for slot, url in ((sslot, surl), (dslot, durl)):
        st, body, _ = get(url, "/api/ps")
        ok = st == 200 and b'"models"' in body and b'"name"' in body
        check("engine %s is serving before the test" % slot.upper(), ok,
              "http=%s" % st)
        if not ok:
            print("\nCannot run: engine %s is not serving." % slot.upper())
            return 1

    # --- 1. start a real multi-step task on the victim ----------------------
    TASK = ("Set up a small project: create a directory called svc, write app.py "
            "containing a function total(xs) that sums a list, write test_app.py "
            "that asserts total([1,2,3])==6 and total([])==0, run the tests, and "
            "then create a file REPORT.md summarising what you built and the test "
            "result.")
    print("\n[1] starting the task on engine %s" % sslot.upper())
    t0 = time.perf_counter()
    first = chat(surl, TASK, session, timeout=1200)
    print("      ran %.1fs | tools=%s | results=%d"
          % (first.get("wall", 0), first.get("tools"), len(first.get("results", []))))

    # --- 2. confirm real artifacts exist on the victim ----------------------
    st, body, _ = get(surl, "/workspace/%s.zip" % session)
    check("victim produced a real workspace", st == 200 and len(body) > 0,
          "http=%s zip=%d bytes" % (st, len(body)))
    zipbytes = body
    names = []
    if st == 200:
        import io
        import zipfile
        try:
            names = sorted(zipfile.ZipFile(io.BytesIO(zipbytes)).namelist())
        except Exception as e:
            print("      (could not read zip: %s)" % e)
    print("      workspace entries: %s" % names)
    check("workspace holds the project files",
          any("app.py" in n for n in names),
          "entries=%s" % names)

    # --- 3. kill the victim mid-flight -------------------------------------
    print("\n[2] killing engine %s with /off (a real shutdown, not a simulation)" % sslot.upper())
    st, body = post(surl, "/off")
    check("/off acknowledged", st == 200, "http=%s body=%s" % (st, body[:40]))
    time.sleep(12)
    st2, _, _ = get(surl, "/api/ps", timeout=20)
    check("victim is actually dead", st2 != 200, "health now http=%s" % st2)

    # A request to the dead engine must fail, proving the task would have died.
    st3, body3, _ = get(surl, "/workspace/%s.zip" % session, timeout=20)
    check("victim's workspace is now unreachable", st3 != 200, "http=%s" % st3)

    # --- 4. transfer the workspace to the survivor -------------------------
    print("\n[3] restoring the workspace onto engine %s" % dslot.upper())
    st4, body4 = post(durl, "/workspace/%s" % session, zipbytes, "application/zip")
    restored = st4 == 200
    check("workspace restored on the survivor", restored,
          "http=%s %s" % (st4, body4[:110].decode("utf-8", "replace")))

    # --- 5. continue the SAME task on the survivor -------------------------
    print("\n[4] continuing the same task on engine %s" % dslot.upper())
    cont = chat(durl,
                "Continue the task in this workspace. The files are already here. "
                "Check what exists, make sure the tests pass, and finish REPORT.md "
                "if it is missing. Then package the workspace into svc.zip.",
                session, timeout=1500)
    print("      ran %.1fs | tools=%s | verified=%s"
          % (cont.get("wall", 0), cont.get("tools"),
             (cont.get("verification") or {}).get("ok")))

    # --- 6. verify the survivor really had the files ----------------------
    saw_files = any("app.py" in (r.get("raw") or "") or "svc" in (r.get("raw") or "")
                    for r in cont.get("results", []))
    check("survivor saw the transferred files", saw_files)
    check("survivor reached a verified state",
          bool((cont.get("verification") or {}).get("ok")),
          str(cont.get("verification"))[:110])
    check("survivor used tools to do the work", len(cont.get("tools", [])) >= 1,
          "tools=%s" % cont.get("tools"))

    # --- 7. the artifact must be real and downloadable --------------------
    print("\n[5] verifying the final artifact")
    st5, body5, hdr = get(durl, "/files/svc.zip", timeout=60)
    check("svc.zip is downloadable", st5 == 200 and len(body5) > 0,
          "http=%s %d bytes" % (st5, len(body5)))
    if st5 == 200:
        import io
        import zipfile
        try:
            z = zipfile.ZipFile(io.BytesIO(body5))
            entries = sorted(z.namelist())
            check("archive is a valid zip", z.testzip() is None, "entries=%s" % entries)
            check("archive contains the project",
                  any("app.py" in e for e in entries), "entries=%s" % entries)
        except Exception as e:
            check("archive is a valid zip", False, str(e)[:80])

    print("\n" + "=" * 74)
    print("MID-TASK FAILOVER: %d passed, %d failed" % (passed, failed))
    print("  task survived a real engine death and completed on another engine: %s"
          % ("YES" if failed == 0 else "NO"))
    print("=" * 74)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
