#!/usr/bin/env python3
"""Make a failed engine boot FAIL instead of hanging.

Four branches in the engine notebook ended with:

    setstage('FAILED: ... - alive for beacon')
    while True: time.sleep(300)

That was meant to keep the failure reachable for diagnosis. What it actually
did was keep the Kaggle run `running` for hours on an engine that could never
serve a request -- burning GPU quota, and making the app report "turning on"
forever, because the status endpoint reads a `running` kernel as a boot in
progress. Both symptoms come from this one line.

The fix announces the reason to the beacon (which is what "alive for beacon"
was for) and then ends the cell, so the run stops and the GPU is handed back.
A dead engine now reports as dead within seconds instead of looking like it is
still starting.

Run: python3 scripts/fail-fast-engine-fix.py [--check]
"""
import json
import pathlib
import sys

ASSET = pathlib.Path(__file__).resolve().parent.parent / (
    "android/app/src/main/assets/aether-notebook-template.json")

# label -> the message that explains the failure to the user
BRANCHES = [
    "ollama install",
    "serve",
    "pulls",
    "all warmups",
]


def old_block(label: str) -> str:
    return (
        "    setstage('FAILED: %s - alive for beacon')\n"
        "    while True: time.sleep(300)\n" % label
    )


def new_block(label: str) -> str:
    return (
        "    setstage('FAILED: %s')\n"
        "    # Announce the reason, then STOP. Hanging here kept the Kaggle run\n"
        "    # 'running' for hours on an engine that could never serve anything:\n"
        "    # it burned GPU quota and made the app report 'turning on' forever,\n"
        "    # because a running kernel reads as a boot still in progress. Ending\n"
        "    # the cell stops the run and hands the GPU back, so the failure is\n"
        "    # reported as a failure within seconds.\n"
        "    notify('ENGINE FAILED: %s - releasing the GPU so the app can report it')\n"
        "    raise SystemExit(1)\n" % (label, label)
    )


def main() -> int:
    check = "--check" in sys.argv
    nb = json.loads(ASSET.read_text(encoding="utf-8"))
    patched = 0
    already = 0
    for cell in nb["cells"]:
        if cell.get("cell_type") != "code":
            continue
        src = cell["source"]
        joined = src if isinstance(src, str) else "".join(src)
        original = joined
        for label in BRANCHES:
            if new_block(label).split("\n")[0] in joined and "while True: time.sleep(300)" not in joined:
                already += 1
                continue
            if old_block(label) in joined:
                joined = joined.replace(old_block(label), new_block(label))
                patched += 1
        if joined != original:
            # A cell's source is a single string in this asset.
            cell["source"] = joined

    if patched == 0:
        print("fail-fast-engine-fix: nothing to do (%d branch(es) already fixed)" % already)
        return 0

    if check:
        print("fail-fast-engine-fix: %d branch(es) still hang the engine" % patched)
        return 1

    ASSET.write_text(
        json.dumps(nb, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    print("fail-fast-engine-fix: %d failure branch(es) now release the GPU" % patched)
    print("  remember: run scripts/sync-engine-source.mjs to refresh the web blob")
    return 0


if __name__ == "__main__":
    sys.exit(main())
