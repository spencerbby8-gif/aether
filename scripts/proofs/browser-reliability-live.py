#!/usr/bin/env python3
"""Browser reliability: reproduce the selector timeouts, then prove the fix.

Runs a fixed set of real workflows against a local site that reproduces the
conditions which break agents (JS-rendered forms, iframes, consent overlays,
redirects, unstable ids, uploads, session persistence) on REAL Chromium, through
the REAL helper extracted from the shipped notebook asset.

Two policies are compared on identical goals:

  guess   what an agent can do today: pick a plausible selector, and when
          Playwright times out, try another. This is the reported failure.
  inspect establish page state first, then act only on what the page reports.

Every number is a wall-clock stamp and a tool-call count taken while a real
browser is in flight.

  python3 -u scripts/proofs/browser-reliability-live.py [--helper PATH] [--policy both]
"""
import argparse
import ast
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "perf"))
import importlib

site_mod = importlib.import_module("browser-site")

ASSET = ROOT / "android/app/src/main/assets/aether-notebook-template.json"
WORK = Path("/tmp/browser-reliability")
GEN = WORK / "gen"
HELPER = WORK / "bhelper.py"
CRLIBS = "/home/user/.cache/crlibs/usr/lib/x86_64-linux-gnu"

PASS, FAIL = 0, 0


def extract_helper():
    nb = json.loads(ASSET.read_text(encoding="utf-8"))
    for cell in nb["cells"]:
        if cell.get("cell_type") != "code":
            continue
        s = cell["source"] if isinstance(cell["source"], str) else "".join(cell["source"])
        if "_B_HELPER_SRC" not in s:
            continue
        i = s.index("_B_HELPER_SRC")
        q = s.index("'", i)
        end = q + 1
        while end < len(s):
            if s[end] == "\\":
                end += 2
                continue
            if s[end] == "'":
                break
            end += 1
        src = ast.literal_eval(s[q:end + 1])
        ast.parse(src)
        return src
    raise SystemExit("browser helper not found in the notebook asset")


class Helper:
    """Talks to the real helper process exactly as the engine does."""

    def __init__(self):
        env = dict(os.environ)
        env["AETHER_GEN_DIR"] = str(GEN)
        env["AETHER_BROWSER_DIR"] = str(WORK / "profile")
        env["LD_LIBRARY_PATH"] = CRLIBS + ":" + env.get("LD_LIBRARY_PATH", "")
        self.p = subprocess.Popen(
            [sys.executable, "-u", str(HELPER)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1, env=env)
        self.calls = 0
        self.seconds = 0.0

    def call(self, **kw):
        self.calls += 1
        t0 = time.time()
        self.p.stdin.write(json.dumps(kw) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        dt = time.time() - t0
        self.seconds += dt
        try:
            r = json.loads(line)
        except Exception:
            r = {"ok": False, "err": "NO REPLY (helper died): %r" % line[:300]}
        out = (r.get("out") or r.get("err") or "")
        return out, dt

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=15)
        except Exception:
            self.p.kill()


def ok(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
    print("  %s %s%s" % ("ok  " if cond else "FAIL", name,
                         ("" if cond or not detail else "   [%s]" % detail[:160])))
    return cond


# --------------------------------------------------------------------------
# The workflows. `guesses` are the selectors an agent would plausibly try when
# it cannot see the page; they are realistic, not strawmen.
# --------------------------------------------------------------------------

def wf_dynamic(h, site, policy):
    """A form that does not exist yet at domcontentloaded."""
    print("\n== dynamic form: fields render 1.2s after load ==")
    if policy == "guess":
        h.call(action="navigate", url=site + "/dynamic", timeout=20)
        # The user has authorized this sign-up, as in the inspect arm.
        h.call(action="authorize", url=site + "/dynamic", value="fill")
        # Acts immediately, as an agent with no way to see the page would.
        a, _ = h.call(action="fill", selector="#fullname", value="Ada Lovelace")
        print("      -> %s" % a[:110])
        b, _ = h.call(action="fill", selector="#newpw", value="correct-horse-battery")
        print("      -> %s" % b[:110])
        c, _ = h.call(action="click", selector="button[name=create]", timeout=8)
        print("      -> %s" % c[:110])
        d, _ = h.call(action="read", timeout=10)
        return d
    # inspect first, then act on what the page actually reports. navigate is
    # told what to wait for, which is the deterministic alternative to sleeping.
    r, _ = h.call(action="navigate", url=site + "/dynamic", value="dom",
                  selector="form", timeout=20)
    print("      -> %s" % r[:120])
    snap, _ = h.call(action="inspect", timeout=15)
    print("      -> %s" % snap[:170].replace("\n", " | "))
    fields = parse_fields(snap)
    # The user has authorized this sign-up: filling AND submitting.
    h.call(action="authorize", url=site + "/dynamic", value="fill")
    h.call(action="authorize", url=site + "/dynamic", value="submit")
    for label, sel in fields.items():
        val = "Ada Lovelace" if "name" in label.lower() else "correct-horse-battery"
        r, _ = h.call(action="fill", selector=sel, value=val, timeout=10)
        print("      -> %s" % r[:110])
    btn = parse_button(snap)
    r, _ = h.call(action="submit", selector=btn, timeout=10)
    print("      -> %s" % r[:110])
    d, _ = h.call(action="read", timeout=10)
    return d


def wf_iframe(h, site, policy):
    print("\n== iframe: the login form lives inside a frame ==")
    if policy == "guess":
        h.call(action="navigate", url=site + "/iframe", timeout=20)
        h.call(action="authorize", url=site + "/iframe", value="fill")
        # No timeout: the tool's own default is what an agent actually pays.
        a, _ = h.call(action="fill", selector="input[name=email]", value="ada@example.com")
        print("      -> %s" % a[:110])
        return a
    h.call(action="navigate", url=site + "/iframe", timeout=20)
    snap, _ = h.call(action="inspect", timeout=15)
    print("      -> %s" % snap[:170].replace("\n", " | "))
    ok("inspect reports the frame", "frame" in snap.lower(), snap[:120])
    fields = parse_fields(snap)
    email = next((s for l, s in fields.items() if "email" in l.lower()), None)
    if not email:
        return "no email field found"
    h.call(action="authorize", url=site + "/iframe", value="fill")
    r, _ = h.call(action="fill", selector=email, value="ada@example.com", timeout=10)
    print("      -> %s" % r[:110])
    return r


def wf_overlay(h, site, policy):
    print("\n== overlay: a consent banner and veil cover the submit button ==")
    if policy == "guess":
        h.call(action="navigate", url=site + "/overlay", timeout=20)
        h.call(action="fill", selector="#sub-email", value="ada@example.com")
        a, _ = h.call(action="click", selector="#subscribe")
        print("      -> %s" % a[:110])
        return a
    h.call(action="navigate", url=site + "/overlay", timeout=20)
    snap, _ = h.call(action="inspect", timeout=15)
    print("      -> %s" % snap[:200].replace("\n", " | "))
    blocked = "overlay" in snap.lower() or "banner" in snap.lower()
    ok("inspect reports the overlay instead of letting the click time out", blocked, snap[:150])
    if blocked:
        acc = parse_button(snap, prefer="accept")
        r, _ = h.call(action="click", selector=acc, timeout=10)
        print("      -> %s" % r[:110])
    snap2, _ = h.call(action="inspect", timeout=15)
    fields = parse_fields(snap2)
    email = next((s for l, s in fields.items() if "email" in l.lower()), None)
    h.call(action="fill", selector=email, value="ada@example.com", timeout=10)
    btn = parse_button(snap2, prefer="subscribe")
    r, _ = h.call(action="submit", selector=btn, timeout=10)
    print("      -> %s" % r[:110])
    return r


def wf_renamed(h, site, policy):
    print("\n== unstable ids: only labels, names and roles survive a reload ==")
    if policy == "guess":
        h.call(action="navigate", url=site + "/renamed", timeout=20)
        h.call(action="authorize", url=site + "/renamed", value="fill")
        # An id captured from a previous visit is now wrong.
        a, _ = h.call(action="fill", selector="#email-1", value="ada@example.com")
        print("      -> %s" % a[:110])
        if a.startswith("FILL"):
            b, _ = h.call(action="fill", selector="#pw-1", value="hunter2-hunter2")
            print("      -> %s" % b[:110])
            return b
        return a
    h.call(action="navigate", url=site + "/renamed", timeout=20)
    snap, _ = h.call(action="inspect", timeout=15)
    print("      -> %s" % snap[:200].replace("\n", " | "))
    fields = parse_fields(snap)
    email = next((s for l, s in fields.items() if "email" in l.lower()), None)
    h.call(action="authorize", url=site + "/renamed", value="fill")
    r, _ = h.call(action="fill", selector=email, value="ada@example.com", timeout=10)
    print("      -> %s" % r[:110])
    return r


def wf_upload(h, site, policy):
    print("\n== file upload ==")
    p = str(GEN / "hello.txt")
    os.makedirs(GEN, exist_ok=True)
    open(p, "w").write("aether browser upload\n")
    h.call(action="navigate", url=site + "/upload", timeout=20)
    if policy == "inspect":
        snap, _ = h.call(action="inspect", timeout=15)
        sel = parse_first(snap, "file") or "#doc"
    else:
        sel = "#doc"
    r, _ = h.call(action="upload", selector=sel, path=p, timeout=10)
    print("      -> %s" % r[:110])
    if policy == "inspect":
        snap, _ = h.call(action="inspect", timeout=15)
        btn = parse_button(snap, prefer="send")
        h.call(action="submit", selector=btn, timeout=10)
    else:
        h.call(action="click", selector="button[name=send]")
    d, _ = h.call(action="read", timeout=10)
    return d


def wf_session(h, site, policy):
    print("\n== session persistence across pages ==")
    h.call(action="navigate", url=site + "/dashboard", timeout=20)
    r, _ = h.call(action="navigate", url=site + "/settings", timeout=20)
    d, _ = h.call(action="read", timeout=10)
    return d




def wf_redirect(h, site, policy):
    print("\n== redirect: the page moves before the agent acts ==")
    h.call(action="navigate", url=site + "/redirect", timeout=20)
    if policy == "inspect":
        r, _ = h.call(action="wait", value="url:/login", timeout=15)
        print("      -> %s" % r[:110])
        ok("a deterministic URL wait replaces a sleep", "WAITED for url" in r, r[:110])
        snap, _ = h.call(action="inspect", timeout=15)
        return snap
    h.call(action="wait", value="1500")
    d, _ = h.call(action="read", timeout=10)
    return d


def wf_login(h, site, policy):
    print("\n== full authorized sign-in ==")
    if policy == "guess":
        h.call(action="navigate", url=site + "/login", timeout=20)
        h.call(action="authorize", url=site + "/login", value="fill")
        h.call(action="fill", selector="input[name=email]", value="ada@example.com")
        h.call(action="fill", selector="input[name=password]", value="hunter2-hunter2")
        h.call(action="authorize", url=site + "/login", value="submit")
        r, _ = h.call(action="submit", selector="button[name=signin]")
        print("      -> %s" % r[:110])
        d, _ = h.call(action="read", timeout=10)
        return d
    h.call(action="navigate", url=site + "/login", timeout=20)
    snap, _ = h.call(action="inspect", timeout=15)
    fields = parse_fields(snap)
    email = next((s for l, s in fields.items() if "email" in l.lower()), None)
    pw = next((s for l, s in fields.items() if "password" in l.lower()), None)
    ok("inspect found the fields by label", bool(email and pw),
       "email=%r pw=%r" % (email, pw))
    # A fill without a grant must still be refused.
    refused, _ = h.call(action="fill", selector=pw, value="hunter2-hunter2")
    ok("credential fill is still refused without a grant",
       "NEEDS APPROVAL" in refused, refused[:110])
    h.call(action="authorize", url=site + "/login", value="fill")
    h.call(action="fill", selector=email, value="ada@example.com")
    h.call(action="fill", selector=pw, value="hunter2-hunter2")
    h.call(action="authorize", url=site + "/login", value="submit")
    btn = parse_button(snap, prefer="sign in")
    r, _ = h.call(action="submit", selector=btn)
    print("      -> %s" % r[:110])
    d, _ = h.call(action="read", timeout=10)
    return d


def wf_blocked_explains(h, site, policy):
    print("\n== a control that cannot be used says why ==")
    h.call(action="navigate", url=site + "/overlay", timeout=20)
    r, _ = h.call(action="click", selector="#subscribe", timeout=6)
    print("      -> %s" % r[:130])
    ok("the blocker is named instead of a bare timeout",
       "BLOCKED" in r or "overlay" in r.lower(), r[:130])
    return r


def wf_captcha(h, site, policy):
    print("\n== CAPTCHA is refused, never solved ==")
    h.call(action="navigate", url=site + "/captcha", timeout=20)
    r, _ = h.call(action="click", selector="button[name=go]", timeout=6)
    print("      -> %s" % r[:130])
    ok("refused the CAPTCHA", "BLOCKED" in r and "CAPTCHA" in r.upper(), r[:130])
    return r


def wf_batch(h, site, policy):
    print("\n== batch: several independent reads in one call ==")
    h.call(action="navigate", url=site + "/login", timeout=20)
    steps = json.dumps([
        {"action": "read"},
        {"action": "cookies"},
        {"action": "list"},
    ])
    r, _ = h.call(action="batch", text=steps, timeout=20)
    print("      -> %s" % r[:150].replace("\n", " | "))
    ok("one call returned three results", r.count("\n") >= 3 or "BATCH" in r, r[:150])
    return r


# --------------------------------------------------------------- snapshot ---
def parse_fields(snap):
    """Pull `label -> selector` pairs out of an inspect snapshot."""
    out = {}
    try:
        data = json.loads(snap[snap.index("{"):])
    except Exception:
        return out
    for f in data.get("fields", []):
        out[(f.get("label") or f.get("name") or "").strip()] = f.get("selector")
    return out


def parse_button(snap, prefer=None):
    try:
        data = json.loads(snap[snap.index("{"):])
    except Exception:
        return None
    btns = data.get("buttons", [])
    if prefer:
        for b in btns:
            if prefer in (b.get("text") or "").lower() or prefer in (b.get("name") or "").lower():
                return b.get("selector")
    for b in btns:
        if b.get("type") == "submit":
            return b.get("selector")
    return btns[0].get("selector") if btns else None


def parse_first(snap, kind):
    try:
        data = json.loads(snap[snap.index("{"):])
    except Exception:
        return None
    for f in data.get("fields", []):
        if f.get("type") == kind:
            return f.get("selector")
    return None


WORKFLOWS = [
    ("dynamic form", wf_dynamic, "SIGNED_IN_AS Ada Lovelace"),
    ("iframe form", wf_iframe, "FILL"),
    ("overlay", wf_overlay, "SUBMITTED"),
    ("unstable ids", wf_renamed, "FILL"),
    ("file upload", wf_upload, "UPLOADED:hello.txt"),
    ("session", wf_session, "SESSION_KEPT"),
    ("redirect", wf_redirect, "Sign in"),
    ("full sign-in", wf_login, "SIGNED_IN_AS ada@example.com"),
    ("blocked control", wf_blocked_explains, "BLOCKED"),
    ("captcha", wf_captcha, "CAPTCHA"),
    ("batch", wf_batch, "BATCH"),
]


def run_policy(policy):
    h = Helper()
    print("\n" + "=" * 78)
    print("POLICY: %s" % policy.upper())
    print("=" * 78)
    results = []
    srv, site = site_mod.start()
    try:
        for name, fn, expect in WORKFLOWS:
            before_calls, before_secs = h.calls, h.seconds
            t0 = time.time()
            try:
                out = fn(h, site, policy)
            except Exception as e:
                out = "EXCEPTION %s: %s" % (type(e).__name__, str(e)[:120])
            wall = time.time() - t0
            got = expect in (out or "")
            results.append({
                "name": name, "ok": got,
                "calls": h.calls - before_calls,
                "seconds": h.seconds - before_secs,
                "wall": wall,
            })
            print("  %-16s %-4s  %d calls  %6.1fs helper  %6.1fs wall" % (
                name, "PASS" if got else "FAIL",
                h.calls - before_calls, h.seconds - before_secs, wall))
            if not got:
                print("                 expected %r, got %r" % (expect, (out or "")[:150]))
            # a fresh session per workflow so one failure cannot mask another
            h.call(action="close", session="main")
            # A grant is 15 min of consent for a host. Revoke it explicitly:
            # with the old helper `close` kept it alive, so the "refused
            # without a grant" assertion measured a leftover, not the gate.
            for _kind in ("fill", "submit", "upload"):
                try:
                    h.call(action="revoke", session="main", kind=_kind)
                except Exception:
                    pass
    finally:
        h.close()
        srv.shutdown()
    total_calls = sum(r["calls"] for r in results)
    total_wall = sum(r["wall"] for r in results)
    passed = sum(1 for r in results if r["ok"])
    print("\n  %s total: %d/%d workflows, %d tool calls, %.1fs wall"
          % (policy.upper(), passed, len(results), total_calls, total_wall))
    return {"policy": policy, "results": results,
            "calls": total_calls, "wall": total_wall, "passed": passed}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--helper", help="use this helper source instead of the asset")
    ap.add_argument("--policy", default="both", choices=["guess", "inspect", "both"])
    a = ap.parse_args()

    WORK.mkdir(parents=True, exist_ok=True)
    GEN.mkdir(parents=True, exist_ok=True)
    src = Path(a.helper).read_text() if a.helper else extract_helper()
    ast.parse(src)
    HELPER.write_text(src)
    print("helper under test: %d bytes (%s)" % (
        len(src), a.helper or "extracted from the shipped notebook asset"))

    policies = ["guess", "inspect"] if a.policy == "both" else [a.policy]
    runs = [run_policy(p) for p in policies]

    if len(runs) == 2:
        print("\n" + "=" * 78)
        print("COMPARISON")
        print("=" * 78)
        g, i = runs
        print("  %-18s %10s %10s" % ("", "guess", "inspect"))
        print("  %-18s %10d %10d" % ("workflows passed", g["passed"], i["passed"]))
        print("  %-18s %10d %10d" % ("tool calls", g["calls"], i["calls"]))
        print("  %-18s %9.1fs %9.1fs" % ("wall", g["wall"], i["wall"]))
        if g["calls"]:
            print("  tool-call reduction: %.0f%%" % (100 * (1 - i["calls"] / g["calls"])))
        if g["wall"]:
            print("  wall reduction     : %.0f%%" % (100 * (1 - i["wall"] / g["wall"])))
    wf_pass = sum(r["passed"] for r in runs)
    wf_total = sum(len(r["results"]) for r in runs)
    print("\nassertions        : %d passed, %d failed" % (PASS, FAIL))
    print("workflows completed: %d / %d" % (wf_pass, wf_total))
    return 0 if FAIL == 0 and all(
        r["passed"] == len(r["results"]) for r in runs) else 1


if __name__ == "__main__":
    sys.exit(main())
