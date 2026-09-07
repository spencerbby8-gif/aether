#!/usr/bin/env python3
"""Break each media fix and confirm MediaStreamProof notices.

A proof that passes is only evidence if removing the fix makes it fail. That
lesson cost hours on the Python side (engine-request-check mirrored the logic
locally and kept passing with the fix deleted), so the Java changes get the
same treatment before anyone trusts them.

Mutations that must be caught:
  1. the media event is no longer parsed out of the NDJSON stream
  2. ChatMessage stops writing media to storage
  3. ChatMessage stops reading media back from storage
  4. ChatListener.onMedia stops being a default method

Run: python3 scripts/proofs/java-mutation-check.py
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORK = "/tmp/jmut"

TOOLCHAIN = os.path.expanduser("~/.cache/toolchain")
JARS = os.path.join(TOOLCHAIN, "jars", "json-20240303.jar")

SOURCES = [
    "android/app/src/main/java/com/aether/app/EngineCore.java",
    "android/app/src/main/java/com/aether/app/core/ChatMessage.java",
    "android/app/src/main/java/com/aether/app/core/MediaItem.java",
    "android/app/src/main/java/com/aether/app/core/Attachment.java",
    "scripts/proofs/MediaStreamProof.java",
]

MUTATIONS = [
    (
        "media event no longer parsed from the stream",
        "EngineCore.java",
        'JSONObject media = o.optJSONObject("media");',
        'JSONObject media = null;',
    ),
    (
        "ChatMessage stops saving media",
        "ChatMessage.java",
        'o.put("media", MediaItem.arrayToJson(media));',
        '/* removed */',
    ),
    (
        "ChatMessage stops restoring media",
        "ChatMessage.java",
        'm.media = MediaItem.arrayFromJson(o.optJSONArray("media"));',
        '/* removed */',
    ),
    (
        "onMedia is no longer a default method",
        "EngineCore.java",
        "default void onMedia(String kind, String url, String source) { }",
        "void onMedia(String kind, String url, String source);",
    ),
]


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def build_tree():
    if os.path.exists(WORK):
        shutil.rmtree(WORK)
    src = os.path.join(WORK, "src")
    out = os.path.join(WORK, "out")
    os.makedirs(src)
    os.makedirs(out)
    for rel in SOURCES:
        dst = os.path.join(src, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(ROOT, rel), dst)
    return src, out


def run_proof(src, out):
    """Compile and run. Returns (compiled, passed, output)."""
    files = []
    for rel in SOURCES:
        files.append(os.path.join(src, rel))
    env = dict(os.environ)
    env["JAVA_HOME"] = os.path.join(TOOLCHAIN, "jdk")
    env["PATH"] = os.path.join(TOOLCHAIN, "jdk", "bin") + ":" + env["PATH"]

    javac = subprocess.run(
        [os.path.join(TOOLCHAIN, "jdk", "bin", "javac"), "-encoding", "UTF-8",
         "-nowarn", "-cp", JARS, "-d", out] + files,
        capture_output=True, text=True, env=env)
    if javac.returncode != 0:
        return False, False, javac.stderr

    proc = subprocess.run(
        [os.path.join(TOOLCHAIN, "jdk", "bin", "java"), "-cp", out + ":" + JARS,
         "MediaStreamProof"],
        capture_output=True, text=True, env=env, timeout=300)
    text = proc.stdout + proc.stderr
    m = re.search(r"MEDIA PROOF\s+(\d+) passed, (\d+) failed", text)
    if not m:
        return True, False, text[-2000:]
    return True, int(m.group(2)) == 0 and proc.returncode == 0, text


def main():
    if not os.path.exists(JARS):
        print("missing %s -- run scripts/setup-android-toolchain.sh" % JARS)
        return 2

    # Baseline: the unmutated tree must pass, or every "caught" below is a lie.
    src, out = build_tree()
    compiled, passed, text = run_proof(src, out)
    if not compiled:
        print("baseline did not compile:\n" + text)
        return 2
    if not passed:
        print("baseline FAILED -- fix the proof before trusting this script")
        print(text)
        return 2
    summary = re.search(r"MEDIA PROOF.*", text).group(0)
    print("baseline  %s" % summary)
    print()

    caught = 0
    for name, target, old, new in MUTATIONS:
        src, out = build_tree()
        path = None
        for rel in SOURCES:
            if rel.endswith(target):
                path = os.path.join(src, rel)
                break
        text_before = read([r for r in SOURCES if r.endswith(target)][0])
        if text_before.count(old) != 1:
            print("  SKIP  %-46s anchor x%d" % (name, text_before.count(old)))
            continue
        with open(path, "w", encoding="utf-8") as f:
            f.write(text_before.replace(old, new, 1))

        compiled, passed, output = run_proof(src, out)
        if not compiled:
            caught += 1
            first = next((l for l in output.splitlines() if "error:" in l), "compile error")
            print("  CAUGHT  %-44s compile failed: %s" % (name, first.strip()[:70]))
        elif not passed:
            caught += 1
            m = re.search(r"MEDIA PROOF.*", output)
            print("  CAUGHT  %-44s %s" % (name, m.group(0) if m else "failed"))
        else:
            m = re.search(r"MEDIA PROOF.*", output)
            print("  MISSED  %-44s %s  <-- proof does not cover this fix"
                  % (name, m.group(0) if m else "passed"))

    print()
    print("JAVA MUTATION CHECK  %d/%d caught" % (caught, len(MUTATIONS)))
    return 0 if caught == len(MUTATIONS) else 1


if __name__ == "__main__":
    sys.exit(main())
