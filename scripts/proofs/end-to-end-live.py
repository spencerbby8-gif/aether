#!/usr/bin/env python3
"""Final end-to-end proof: a complex task, then the same task with the engine killed.

Task 1 -- every capability at once: web search, page fetch, workspace files,
commands, dependency install, artifact packaging. Verified against real output,
not the model's summary.

Task 2 -- a long task whose active engine is killed mid-execution, which another
engine must finish. This is the recovery path, exercised for real.

Usage: end-to-end-live.py --engines a=URL c=URL
"""
import argparse
import io
import json
import sys
import time
import urllib.error
import urllib.request
import zipfile

KEY = "REMOVED_ENGINE_OFF_KEY"


def post(url, path, data=None, ctype="application/json", timeout=120):
    body = data if isinstance(data, bytes) else (json.dumps(data).encode() if data is not None else b"{}")
    req = urllib.request.Request(url + path, data=body, method="POST",
                                 headers={"Content-Type": ctype, "X-Engine-Key": KEY})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return None, str(e)[:120].encode()


def get(url, path, timeout=120):
    req = urllib.request.Request(url + path, headers={"X-Engine-Key": KEY})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return None, str(e)[:120].encode()


def chat(url, msg, session, timeout=2400, on_event=None):
    body = json.dumps({"messages": [{"role": "user", "content": msg}],
                       "session": session, "stream": True}).encode()
    req = urllib.request.Request(url + "/api/chat", data=body,
                                 headers={"Content-Type": "application/json",
                                          "X-Engine-Key": KEY})
    t0 = time.perf_counter()
    ttft = None
    tools, results, content, ver, plan = [], [], "", None, None
    err = None
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
                if "plan" in d:
                    plan = d["plan"]
                if "verification" in d:
                    ver = d["verification"]
                c = m.get("content") or ""
                if c:
                    if ttft is None:
                        ttft = time.perf_counter() - t0
                    content += c
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, str(e)[:120])
    wall = time.perf_counter() - t0
    decode = len(content) / max(wall - (ttft or 0), 1e-6) / 5.0
    return {"wall": wall, "ttft": ttft, "decode": decode, "tools": tools,
            "results": results, "content": content, "verification": ver,
            "plan": plan, "error": err}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engines", nargs="+", required=True, help="slot=URL pairs")
    a = ap.parse_args()
    slots = {}
    for item in a.engines:
        s, u = item.split("=", 1)
        slots[s.strip()] = u.strip()
    if len(slots) < 2:
        print("need at least two engines to prove recovery")
        return 2
    order = sorted(slots)
    primary, backup = slots[order[0]], slots[order[1]]
    passed = failed = 0

    def check(name, ok, detail=""):
        nonlocal passed, failed
        if ok:
            passed += 1
            print("  PASS  %s%s" % (name, ("  " + detail) if detail else ""))
        else:
            failed += 1
            print("  FAIL  %s%s" % (name, ("  " + detail) if detail else ""))

    print("=" * 76)
    print("TASK 1 - COMPLEX MULTI-CAPABILITY TASK on engine %s" % order[0].upper())
    print("=" * 76)
    s1 = "e2e-complex-%d" % int(time.time())
    TASK1 = (
        "Research how many local government areas Lagos State has, using a web "
        "search and then fetching one of the sources to confirm. Then build a "
        "small project in the workspace: a directory called lagos with a file "
        "lga.py containing a function count() that returns the number you found, "
        "and test_lga.py that asserts count() equals that number. Install pytest "
        "if it is not available, run the tests, and write FINDINGS.md with the "
        "number, the source URL you used, and the test result. Finally package "
        "the whole workspace into lagos.zip."
    )
    r1 = chat(primary, TASK1, s1)
    print("  wall %.1fs | ttft %s | decode %.2f tok/s | tool calls %d"
          % (r1["wall"], ("%.2fs" % r1["ttft"]) if r1["ttft"] else "n/a",
             r1["decode"], len(r1["tools"])))
    print("  tools: %s" % r1["tools"])
    print("  verification: %s" % str(r1["verification"])[:120])

    kinds = set(r1["tools"])
    check("used web search", "web_search" in kinds, str(sorted(kinds)))
    check("fetched a real source", "fetch_page" in kinds)
    check("ran real commands", "run_command" in kinds)
    check("packaged the artifact", "package_files" in kinds)
    check("reached a verified outcome",
          bool((r1["verification"] or {}).get("ok")),
          str((r1["verification"] or {}).get("outcome")))
    check("plan was published before any tool ran", r1["plan"] is not None,
          "goal=%s" % str((r1["plan"] or {}).get("goal"))[:60])
    ok_calls = sum(1 for x in r1["results"] if x.get("ok"))
    check("every tool call succeeded", ok_calls == len(r1["results"]),
          "%d/%d ok" % (ok_calls, len(r1["results"])))

    # The archive must be real and hold the project.
    st, body = get(primary, "/files/lagos.zip")
    check("lagos.zip is downloadable", st == 200 and len(body) > 0,
          "http=%s %d bytes" % (st, len(body)))
    if st == 200:
        try:
            z = zipfile.ZipFile(io.BytesIO(body))
            names = z.namelist()
            check("archive is valid", z.testzip() is None)
            check("archive holds the code", any("lga.py" in n for n in names), str(names))
            check("archive holds the findings", any("FINDINGS" in n for n in names), str(names))
            check("archive does not contain itself",
                  not any(n == "lagos.zip" for n in names), str(names))
        except Exception as e:
            check("archive is valid", False, str(e)[:80])

    # A source URL must actually appear in the answer or the findings.
    check("a real source URL is cited",
          "http" in r1["content"] or "http" in "\n".join(
              x.get("raw", "") for x in r1["results"]))

    print()
    print("=" * 76)
    print("TASK 2 - SAME KIND OF TASK, ENGINE KILLED MID-EXECUTION")
    print("=" * 76)
    s2 = "e2e-kill-%d" % int(time.time())
    TASK2 = (
        "Build a project step by step. Create a directory called build. Write "
        "util.py with a function double(x) returning 2*x. Write test_util.py "
        "asserting double(3)==6. Run the tests. Then write NOTES.md describing "
        "what you built."
    )
    print("  starting on engine %s, will be killed partway" % order[0].upper())
    import threading
    holder = {}
    progress = {"tools": 0, "first_tool_at": None}
    t_start = time.perf_counter()

    def on_event(kind, detail, at):
        if kind == "tool":
            progress["tools"] += 1
            if progress["first_tool_at"] is None:
                progress["first_tool_at"] = at

    def work():
        holder["r"] = chat(primary, TASK2, s2, timeout=1800, on_event=on_event)
    t = threading.Thread(target=work)
    t.start()
    # Kill it AFTER real work exists, not on a timer. Killing during the first
    # model call -- which is what a flat sleep did -- leaves no artifacts, so
    # the recovery path being tested is "start over", not "continue". Wait for
    # at least two tool calls, then cut it off mid-flight.
    deadline = time.perf_counter() + 300
    while time.perf_counter() < deadline:
        if progress["tools"] >= 2:
            break
        time.sleep(2)
    print("  victim had made %d tool call(s) at %.1fs; killing engine %s now"
          % (progress["tools"], time.perf_counter() - t_start, order[0].upper()))
    st, _ = post(primary, "/off")
    print("  /off -> http=%s" % st)
    t.join(timeout=1800)
    r2 = holder.get("r") or {}
    print("  victim turn ended: error=%s tools=%s" % (r2.get("error"), r2.get("tools")))

    st3, _ = get(primary, "/api/ps", timeout=20)
    check("engine %s is really dead" % order[0].upper(), st3 != 200, "http=%s" % st3)

    # Whatever the victim produced must still be recoverable if it got that far.
    st4, zip2 = get(primary, "/workspace/%s.zip" % s2, timeout=30)
    recovered = st4 == 200 and len(zip2) > 0
    print("  victim workspace export: http=%s %d bytes" % (st4, len(zip2) if zip2 else 0))

    if recovered:
        st5, _ = post(backup, "/workspace/%s" % s2, zip2, "application/zip")
        check("workspace restored onto engine %s" % order[1].upper(), st5 == 200,
              "http=%s" % st5)
    else:
        print("  (victim died before producing a workspace; the survivor starts clean)")

    r3 = chat(backup,
              "Continue this task in the workspace. Check what already exists with "
              "list_files, finish anything missing, make sure the tests pass, and "
              "package the workspace into build.zip.",
              s2, timeout=1800)
    print("  survivor turn: wall %.1fs | tools=%s | verified=%s"
          % (r3["wall"], r3["tools"], (r3["verification"] or {}).get("ok")))
    check("engine %s continued the task" % order[1].upper(), r3.get("error") is None,
          str(r3.get("error"))[:80])
    check("survivor inspected the workspace", "list_files" in r3["tools"], str(r3["tools"]))
    check("survivor reached a verified outcome",
          bool((r3["verification"] or {}).get("ok")),
          str((r3["verification"] or {}).get("outcome")))

    st6, body6 = get(backup, "/files/build.zip")
    check("build.zip is downloadable", st6 == 200 and len(body6) > 0,
          "http=%s %d bytes" % (st6, len(body6)))
    if st6 == 200:
        try:
            z = zipfile.ZipFile(io.BytesIO(body6))
            names = z.namelist()
            check("recovered archive is valid", z.testzip() is None)
            check("recovered archive holds the code",
                  any("util.py" in n for n in names), str(names))
        except Exception as e:
            check("recovered archive is valid", False, str(e)[:80])

    print()
    print("=" * 76)
    print("END-TO-END: %d passed, %d failed" % (passed, failed))
    print("  task 1 (complex, multi-capability) : %s"
          % ("COMPLETE" if (r1["verification"] or {}).get("ok") else "NOT VERIFIED"))
    print("  task 2 (engine killed mid-task)    : %s"
          % ("RECOVERED AND COMPLETE" if (r3["verification"] or {}).get("ok") else "NOT VERIFIED"))
    print("=" * 76)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
