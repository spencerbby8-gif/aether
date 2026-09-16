#!/usr/bin/env python3
"""Live capability proof against a running engine.

The user asked for evidence that the tools actually work -- that the model can
pull and execute real commands, fetch real pages, download real files, and
produce images and voice that arrive as saveable media. This drives the
deployed kernel over its real HTTPS tunnel and records what came back, with
timings, rather than inferring anything from source.

Nothing here is mocked. If a capability does not work, this prints FAIL and
exits non-zero.

Usage: python3 -u scripts/proofs/CapabilityProof.py <tunnel-url>
"""
import os
import json
import ssl
import sys
import time
import urllib.request

OFF_KEY = os.environ["ENGINE_OFF_KEY"]
CTX = ssl.create_default_context()

# Lines the kernel emits for operational progress. Anything else in the
# thinking channel is the model's own reasoning, which is how we can tell
# whether think=True actually reached Ollama.
MARKERS = ("\u2699\ufe0f agent step", "\u23f3", "\U0001f6e0\ufe0f", "\u21b3")

pass_n = 0
fail_n = 0


def check(name, ok, detail=""):
    global pass_n, fail_n
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", name,
                          ("" if ok else "   [" + detail + "]")))
    if ok:
        pass_n += 1
    else:
        fail_n += 1
    sys.stdout.flush()


def section(t):
    print("\n== " + t)
    sys.stdout.flush()


def turn(base, prompt, timeout=900):
    """One real /api/chat turn. Returns everything observed."""
    body = json.dumps({
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
        "tools": ["web_search", "fetch_page", "crawl_site", "run_command",
                  "generate_image", "generate_voice"],
    }).encode()
    req = urllib.request.Request(
        base + "/api/chat", data=body,
        headers={"Content-Type": "application/json", "X-Engine-Key": OFF_KEY})

    out = {"answer": [], "thinking": [], "tools": [], "media": [],
           "reasoning": [], "done": False, "done_reason": None,
           "t0": time.time(), "first_byte": None, "first_token": None,
           "http": None, "error": None, "lines": 0}
    try:
        r = urllib.request.urlopen(req, timeout=timeout, context=CTX)
        out["http"] = r.getcode()
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            out["lines"] += 1
            if out["first_byte"] is None:
                out["first_byte"] = time.time() - out["t0"]
            try:
                d = json.loads(line)
            except Exception:
                continue

            md = d.get("media")
            if isinstance(md, dict) and md.get("url"):
                out["media"].append(md)
                continue

            m = d.get("message") or {}
            txt = m.get("content") or ""
            if txt:
                if out["first_token"] is None:
                    out["first_token"] = time.time() - out["t0"]
                out["answer"].append(txt)
            th = m.get("thinking") or ""
            if th:
                out["thinking"].append(th)
                if not th.startswith(MARKERS):
                    out["reasoning"].append(th)
            if th.startswith("\U0001f6e0\ufe0f"):
                out["tools"].append(th[2:].strip())

            if d.get("done"):
                out["done"] = True
                out["done_reason"] = d.get("done_reason")
                break
    except Exception as e:
        out["error"] = "%s: %s" % (type(e).__name__, e)
    out["total"] = time.time() - out["t0"]
    out["text"] = "".join(out["answer"])
    out["think_text"] = "".join(out["thinking"])
    return out


def report(o):
    print("     http=%s lines=%d first_byte=%s first_token=%s total=%.1fs "
          "done=%s reason=%s" % (
              o["http"], o["lines"],
              "%.2fs" % o["first_byte"] if o["first_byte"] else "n/a",
              "%.2fs" % o["first_token"] if o["first_token"] else "n/a",
              o["total"], o["done"], o["done_reason"]))
    if o["error"]:
        print("     error: " + o["error"])
    if o["tools"]:
        print("     tools: " + " | ".join(t[:70] for t in o["tools"][:6]))
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        print("usage: CapabilityProof.py <tunnel-url>")
        return 2
    base = sys.argv[1].rstrip("/")

    section("engine is really serving")
    try:
        with urllib.request.urlopen(base + "/api/ps", timeout=60, context=CTX) as r:
            ps = json.loads(r.read().decode())
            models = [m.get("name", "") for m in ps.get("models", [])]
        check("/api/ps returns 200", True)
        check("a model is loaded", len(models) > 0, str(models))
        print("     models: " + ", ".join(models))
    except Exception as e:
        check("/api/ps reachable", False, str(e))
        return 1

    # ------------------------------------------------------------ reasoning
    section("reasoning is actually on")
    o = turn(base, "A shop sells pens at 3 for $2. I buy 7 pens and pay with "
                   "$10. Think it through, then give the change. Show only the "
                   "final amount after your reasoning.", timeout=600)
    report(o)
    check("turn completed", o["done"], o["error"] or "no done")
    check("model produced reasoning text",
          len("".join(o["reasoning"])) > 40,
          "reasoning chars=%d" % len("".join(o["reasoning"])))
    # 7 pens at 3 for $2 cost $4.67, so the change from $10 is $5.33. This was
    # first written expecting $0.67, which is the price of one pen, not the
    # change -- the model was right and the assertion was wrong.
    check("the answer is the correct change ($5.33, not the pen price)",
          "5.33" in o["text"],
          "answer=[%s]" % o["text"][:120])
    check("the answer is not a dump of the reasoning",
          len(o["text"]) < 600, "answer chars=%d" % len(o["text"]))

    # --------------------------------------------------------- run_command
    section("real command execution on the engine host")
    o = turn(base, "Use the run_command tool to run exactly this and report the "
                   "raw output with no commentary: echo AETHER_CMD_OK && uname -sr "
                   "&& python3 -c \"print(6*7)\" && pwd", timeout=600)
    report(o)
    check("turn completed", o["done"], o["error"] or "no done")
    check("run_command was invoked",
          any("run_command" in t for t in o["tools"]), str(o["tools"][:3]))
    joined = o["text"] + o["think_text"]
    check("the real echo marker came back", "AETHER_CMD_OK" in joined,
          "answer=[%s]" % o["text"][:200])
    check("python really executed", "42" in joined, "answer=[%s]" % o["text"][:200])
    check("cwd reported", "/kaggle/working" in joined, "answer=[%s]" % o["text"][:200])

    # ---------------------------------------------------------- fetch_page
    section("fetching a real page")
    o = turn(base, "Use the fetch_page tool on https://example.com and tell me "
                   "the exact page title and the first sentence of body text.",
             timeout=600)
    report(o)
    check("turn completed", o["done"], o["error"] or "no done")
    check("fetch_page was invoked",
          any("fetch_page" in t for t in o["tools"]), str(o["tools"][:3]))
    joined = (o["text"] + o["think_text"]).lower()
    check("real page content came back",
          "example domain" in joined or "example.com" in joined,
          "answer=[%s]" % o["text"][:200])

    # ------------------------------------------------------------ download
    section("downloading a real file to engine storage")
    o = turn(base, "Use run_command to download this file and verify it: "
                   "curl -sL -o /kaggle/working/aether-dl.bin "
                   "\"https://speed.cloudflare.com/__down?bytes=250000\" && "
                   "stat -c '%s bytes' /kaggle/working/aether-dl.bin && "
                   "file /kaggle/working/aether-dl.bin. Report the exact size.",
             timeout=900)
    report(o)
    check("turn completed", o["done"], o["error"] or "no done")
    check("run_command was invoked",
          any("run_command" in t for t in o["tools"]), str(o["tools"][:3]))
    joined = o["text"] + o["think_text"]
    check("the downloaded file has the expected size",
          "250000" in joined, "answer=[%s]" % o["text"][:250])

    # --------------------------------------------------------------- image
    section("generating an image, delivered as media")
    o = turn(base, "Use the generate_image tool to create a picture of a red fox "
                   "in snow. Generate it; do not describe it.", timeout=900)
    report(o)
    check("turn completed", o["done"], o["error"] or "no done")
    check("a media event arrived", len(o["media"]) >= 1,
          "media=%d tools=%s" % (len(o["media"]), o["tools"][:2]))
    if o["media"]:
        m0 = o["media"][0]
        check("media kind is image", m0.get("kind") == "image", str(m0)[:160])
        check("media carries a real https url",
              str(m0.get("url", "")).startswith("https://"), str(m0)[:160])
        check("media names the producing tool",
              m0.get("source") == "generate_image", str(m0)[:160])
        # The whole point of the media event: the file must be fetchable by the
        # phone, not merely named in the transcript.
        try:
            with urllib.request.urlopen(m0["url"], timeout=120, context=CTX) as r:
                data = r.read()
            check("the image is downloadable (%d bytes)" % len(data),
                  len(data) > 1000, "bytes=%d" % len(data))
            check("the bytes are a real image",
                  data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n",
                  "magic=%r" % data[:8])
        except Exception as e:
            check("the image is downloadable", False, str(e))

    # --------------------------------------------------------------- voice
    section("generating voice, delivered as media")
    o = turn(base, "Use the generate_voice tool to say: Hello from Aether. "
                   "Generate the audio; do not transcribe it.", timeout=900)
    report(o)
    check("turn completed", o["done"], o["error"] or "no done")
    check("a media event arrived", len(o["media"]) >= 1,
          "media=%d tools=%s" % (len(o["media"]), o["tools"][:2]))
    if o["media"]:
        m0 = o["media"][0]
        check("media kind is audio", m0.get("kind") == "audio", str(m0)[:160])
        check("media names the producing tool",
              m0.get("source") == "generate_voice", str(m0)[:160])
        try:
            with urllib.request.urlopen(m0["url"], timeout=120, context=CTX) as r:
                data = r.read()
            check("the audio is downloadable (%d bytes)" % len(data),
                  len(data) > 1000, "bytes=%d" % len(data))
            check("the bytes are a real WAV file",
                  data[:4] == b"RIFF" and data[8:12] == b"WAVE",
                  "head=%r" % data[:12])
        except Exception as e:
            check("the audio is downloadable", False, str(e))

    print()
    print("CAPABILITY PROOF  %d passed, %d failed" % (pass_n, fail_n))
    return 0 if fail_n == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
