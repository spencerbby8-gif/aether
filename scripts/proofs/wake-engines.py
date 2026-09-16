#!/usr/bin/env python3
"""
Wake any subset of the three engines on real Kaggle, verifying the slot tag is in
each rendered notebook before it is pushed.

  python3 scripts/proofs/wake-engines.py a b
"""
import json
import os
import subprocess
import sys
import urllib.request

OFF_KEY = os.environ["ENGINE_OFF_KEY"]
TOPIC = os.environ["BEACON_TOPIC"]
SLUG = "qwen-3-8-27b-uncensored-chat"
TITLE = "Qwen 3.8 27B Uncensored Chat"

def _cred(slot, user_env, key_env, default_user=""):
    """Credentials for a slot, env first.

    Every slot resolves its key from the environment only (KAGGLE_KEY_x).
    No key is ever committed, so none can appear in a diff or a log.
    """
    user = os.environ.get(user_env) or default_user
    key = os.environ.get(key_env, "")
    return user, key


KEYS = {
    "a": _cred("a", "KAGGLE_USERNAME_A", "KAGGLE_KEY_A", "fridaymoses"),
    "b": _cred("b", "KAGGLE_USERNAME_B", "KAGGLE_KEY_B", "spencercoldtr"),
    "c": _cred("c", "KAGGLE_USERNAME_C", "KAGGLE_KEY_C", "dyceelvk"),
    "d": _cred("d", "KAGGLE_USERNAME_D", "KAGGLE_KEY_D"),
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
            # Cold-wake fix: mounts the public engine cache (ollama tarball +
            # model store) read-only at /kaggle/input, so boot skips the
            # 21-41s binary download and the 111-353s model pull. The kernel
            # falls back to downloading if the mount is absent.
            "datasetDataSources": ["%s/aether-engine-cache" % user],
        }).encode()
        req = urllib.request.Request(
            "https://www.kaggle.com/api/v1/kernels/push", data=body,
            headers={"Authorization": "Bearer " + key,
                     "Content-Type": "application/json"})
        try:
            r = json.loads(urllib.request.urlopen(req, timeout=180).read().decode())
        except Exception as e:
            print("  engine %s PUSH FAILED: %s" % (slot.upper(), e))
            return 1
        # Kaggle rejects a push with HTTP 200 and an error in the body -- a
        # blank ref and versionNumber 0. Read as success, that costs twenty
        # five minutes waiting for a kernel that was never created, which is
        # exactly what happened when an account hit its weekly GPU quota.
        err = r.get("error") or r.get("errorNullable")
        if err or not r.get("ref"):
            print("  engine %s PUSH REJECTED: %s"
                  % (slot.upper(), err or "no ref returned (ref=%r v%s)"
                     % (r.get("ref"), r.get("versionNumber"))))
            return 1
        print("  engine %s pushed -> ref %s v%s  (slot tag verified, %d bytes)"
              % (slot.upper(), r.get("ref"), r.get("versionNumber"), len(nb)))
    return 0


if __name__ == "__main__":
    args = [a.lower() for a in sys.argv[1:]] or ["a"]
    bad = [a for a in args if a not in KEYS]
    if bad:
        print("unknown slot(s): %s" % ", ".join(bad))
        sys.exit(2)
    sys.exit(main(args))
