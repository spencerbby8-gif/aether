#!/usr/bin/env python3
"""
Wake any subset of the three engines on real Kaggle, verifying the slot tag is in
each rendered notebook before it is pushed.

  python3 scripts/proofs/wake-engines.py a b
"""
import json
import subprocess
import sys
import urllib.request

OFF_KEY = "REMOVED_ENGINE_OFF_KEY"
TOPIC = "REMOVED_BEACON_TOPIC"
SLUG = "qwen-3-8-27b-uncensored-chat"
TITLE = "Qwen 3.8 27B Uncensored Chat"

KEYS = {
    "a": ("fridaymoses", "KGAT_REDACTED"),
    "b": ("spencercoldtr", "KGAT_REDACTED"),
    "c": ("dyceelvk", "KGAT_REDACTED"),
}

TS = '''
import { renderAetherNotebook } from "./src/server/engine/aether-engine-source";
const slots = process.argv[1].split(",");
const out: Record<string, string> = {};
for (const s of slots) {
  out[s] = renderAetherNotebook({
    offKey: "%s", beaconToken: "%s", beaconTopic: "%s", slot: s,
  });
}
process.stdout.write(JSON.stringify(out));
''' % (OFF_KEY, TOPIC, TOPIC)


def main(slots):
    raw = subprocess.run(
        ["npx", "--yes", "tsx", "-e", TS, ",".join(slots)],
        capture_output=True, text=True, cwd="/home/user/aether",
    ).stdout
    notebooks = json.loads(raw)

    for slot in slots:
        user, key = KEYS[slot]
        nb = notebooks[slot]
        # Never push a notebook that would boot an anonymous engine.
        assert "SLOT = '%s'" % slot in nb, "slot tag missing for %s" % slot
        assert "{{AETHER_" not in nb, "unresolved placeholder for %s" % slot
        body = json.dumps({
            "slug": "%s/%s" % (user, SLUG),
            "newTitle": TITLE,
            "text": nb,
            "language": "python",
            "kernelType": "notebook",
            "isPrivate": True,
            "enableGpu": True,
            "enableInternet": True,
        }).encode()
        req = urllib.request.Request(
            "https://www.kaggle.com/api/v1/kernels/push", data=body,
            headers={"Authorization": "Bearer " + key,
                     "Content-Type": "application/json"})
        try:
            r = json.loads(urllib.request.urlopen(req, timeout=180).read().decode())
            print("  engine %s pushed -> ref %s v%s  (slot tag verified, %d bytes)"
                  % (slot.upper(), r.get("ref"), r.get("versionNumber"), len(nb)))
        except Exception as e:
            print("  engine %s PUSH FAILED: %s" % (slot.upper(), e))
            return 1
    return 0


if __name__ == "__main__":
    args = [a.lower() for a in sys.argv[1:]] or ["a"]
    bad = [a for a in args if a not in KEYS]
    if bad:
        print("unknown slot(s): %s" % ", ".join(bad))
        sys.exit(2)
    sys.exit(main(args))
