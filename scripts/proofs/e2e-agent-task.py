#!/usr/bin/env python3
"""Run a real multi-capability task against a live engine and check the outcome.

This is the evidence the Phase 2 spec asks for: not "the agent has a planner" but
"a natural-language goal went in, real tools ran, and the requested result came
out". Every claim below is read from the wire -- tool events, timings and the
final text -- never inferred from the code.

The goal deliberately needs several capabilities at once: searching more than one
source, reading at least one page, comparing figures, and producing a report that
cites where the numbers came from.

Usage: python3 scripts/proofs/e2e-agent-task.py <tunnel-url> [goal]
"""
import json
import re
import sys
import time
import urllib.request

OFF_KEY = "REMOVED_ENGINE_OFF_KEY"

DEFAULT_GOAL = (
    "Research the current population of Lagos, Nigeria. Check at least two "
    "different sources, compare the figures they give, say which one is the most "
    "recent and why, and finish with a short report listing each source and the "
    "number it gave."
)

# What the answer has to contain for the task to count as done. Checked against
# the real text, so an answer that merely talks about the topic does not pass.
REQUIREMENTS = [
    ("names Lagos", re.compile(r"lagos", re.I)),
    ("gives at least two numeric figures", None),   # handled separately
    ("mentions more than one source", None),         # handled separately
    ("compares or judges them", re.compile(
        r"more recent|newer|latest|most recent|higher|lower|compare|differs|"
        r"disagree|estimate", re.I)),
]

SOURCE_HINTS = re.compile(
    r"worldometer|un\.org|united nations|macrotrends|wikipedia|statista|"
    r"worldpopulationreview|britannica|nigerian|nbs|citypopulation|http", re.I)


def run(url, goal, timeout=1800):
    body = json.dumps({
        "messages": [{"role": "user", "content": goal}],
        "stream": True,
        "options": {"num_ctx": 16384},
    }).encode()
    req = urllib.request.Request(
        url.rstrip("/") + "/api/chat", data=body,
        headers={"Content-Type": "application/json", "X-Engine-Key": OFF_KEY})

    t0 = time.time()
    first_token = None
    answer = []
    tools = []          # (name, started_at, chars_or_None)
    open_tool = None
    done = False
    media = []

    with urllib.request.urlopen(req, timeout=timeout) as r:
        for line in r:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            msg = d.get("message") or {}
            th = msg.get("thinking") or ""
            if th:
                # "🛠️ name({...})" opens a tool, "↳ name returned N chars" closes it.
                m = re.search(r"\U0001f6e0\ufe0f?\s*([a-z_]+)\(", th)
                if m:
                    open_tool = [m.group(1), time.time() - t0, None]
                    tools.append(open_tool)
                    continue
                m = re.search(r"([a-z_]+) returned (\d+) chars", th)
                if m and open_tool and open_tool[0] == m.group(1):
                    open_tool[2] = int(m.group(2))
                    open_tool = None
                    continue
            if d.get("media"):
                media.append(d["media"])
            c = msg.get("content") or ""
            if c:
                if first_token is None:
                    first_token = time.time() - t0
                answer.append(c)
            if d.get("done"):
                done = True

    return {
        "text": "".join(answer),
        "tools": tools,
        "media": media,
        "done": done,
        "first_token": first_token,
        "total": time.time() - t0,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    url = sys.argv[1]
    goal = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_GOAL

    print("GOAL")
    print("  " + goal)
    print("\nRUNNING against %s" % url)
    r = run(url, goal)

    print("\nTOOL ACTIVITY (from the wire, not inferred)")
    if not r["tools"]:
        print("  none -- the model answered without using a tool")
    for name, at, chars in r["tools"]:
        print("  %-14s started +%6.1fs  %s"
              % (name, at, ("%d chars returned" % chars) if chars else "NO RESULT"))

    print("\nTIMING")
    print("  first token : %s"
          % ("%.1fs" % r["first_token"] if r["first_token"] else "never"))
    print("  total       : %.1fs" % r["total"])
    print("  tool calls  : %d" % len(r["tools"]))
    print("  answer      : %d chars" % len(r["text"]))

    text = r["text"]
    print("\nANSWER (first 900 chars)")
    print("  " + re.sub(r"\s+", " ", text)[:900])

    print("\nVERIFICATION against the original request")
    ok = True

    def chk(what, good, seen):
        nonlocal ok
        print("  %s %s   [%s]" % ("ok  " if good else "FAIL", what, seen))
        if not good:
            ok = False

    chk("the engine reported done:true", r["done"], str(r["done"]))
    chk("a real answer arrived", len(text.strip()) > 300, "%d chars" % len(text))

    chk("it actually used tools rather than guessing", len(r["tools"]) >= 2,
        "%d tool call(s)" % len(r["tools"]))
    chk("every tool it started returned a result",
        all(c is not None for _, _, c in r["tools"]) if r["tools"] else False,
        "%d of %d returned" % (sum(1 for _, _, c in r["tools"] if c is not None),
                               len(r["tools"])))

    distinct = {n for n, _, _ in r["tools"]}
    chk("it searched the web", "web_search" in distinct or "crawl_site" in distinct,
        ",".join(sorted(distinct)) or "none")

    for label, rx in REQUIREMENTS:
        if rx is None:
            continue
        chk(label, bool(rx.search(text)), "matched" if rx.search(text) else "absent")

    figures = re.findall(r"\b\d{1,3}(?:[,.]\d{3}){1,3}\b|\b\d{1,2}\.\d+\s*million\b", text)
    chk("gives at least two numeric figures", len(figures) >= 2,
        "%d found: %s" % (len(figures), ", ".join(figures[:5])))
    chk("cites more than one source", len(set(SOURCE_HINTS.findall(text))) >= 2,
        "%d distinct" % len(set(SOURCE_HINTS.findall(text))))

    print("\n%s" % ("PASS -- the requested outcome is in the answer"
                    if ok else "FAIL -- the answer does not satisfy the request"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
