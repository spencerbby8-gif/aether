#!/usr/bin/env bash
# Turns android/credentials.properties into the two assets the APK reads:
#
#   aether-credentials.dat          obfuscated JSON (XOR + Base64)
#   aether-notebook-template.json   the engine notebook, placeholders intact
#
# The credentials file and the generated .dat are both gitignored. The notebook
# template is NOT secret -- it ships with {{...}} placeholders -- so it is safe
# to commit, and baking it means the APK never needs the Aether server.
set -euo pipefail
cd "$(dirname "$0")/.."

PROPS=android/credentials.properties
ASSETS=android/app/src/main/assets
mkdir -p "$ASSETS"

# --- 1. notebook template (no secrets involved) -----------------------------
node -e '
const { aetherNotebookTemplate } = require("./src/server/engine/aether-engine-source.ts");
' 2>/dev/null || true
npx tsx -e '
import { aetherNotebookTemplate } from "./src/server/engine/aether-engine-source";
import { writeFileSync } from "node:fs";
const t = aetherNotebookTemplate();
JSON.parse(t); // must be valid notebook JSON
writeFileSync("android/app/src/main/assets/aether-notebook-template.json", t);
console.log("  notebook template: " + t.length + " bytes, placeholders intact: "
  + ["{{AETHER_OFF_KEY}}","{{AETHER_BEACON_TOKEN}}","{{AETHER_BEACON_TOPIC}}","{{AETHER_SLOT}}"]
      .every(p => t.includes(p)));
'

# --- 2. credentials (obfuscated) -------------------------------------------
if [[ ! -f "$PROPS" ]]; then
  echo
  echo "No $PROPS -- the APK will build but show \"no engine credentials\"."
  echo "Copy android/credentials.properties.example, fill it in, re-run this script."
  exit 0
fi

python3 - "$PROPS" "$ASSETS/aether-credentials.dat" <<'PY'
import base64, json, re, sys
props_path, out_path = sys.argv[1], sys.argv[2]
vals = {}
for line in open(props_path):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    vals[k.strip()] = v.strip()

cfg = {
    "kernelSlug":   vals.get("kernelSlug", ""),
    "offKey":       vals.get("offKey", ""),
    "beaconTopic":  vals.get("beaconTopic", ""),
    "beaconSecret": vals.get("beaconSecret", ""),
}
for slot in ("A", "B", "C"):
    u, k = vals.get(f"engine{slot}.user", ""), vals.get(f"engine{slot}.key", "")
    if u and k:
        cfg["engine" + slot] = {"user": u, "key": k}

missing = [n for n, v in cfg.items() if not v and n != "beaconSecret"]
engines = [s for s in "ABC" if "engine" + s in cfg]
print(f"  engines baked : {', '.join(engines) or 'NONE'}")
print(f"  kernelSlug    : {cfg['kernelSlug'] or '(MISSING)'}")
print(f"  offKey        : {'set' if cfg['offKey'] else '(MISSING)'}")
print(f"  beaconTopic   : {cfg['beaconTopic'] or '(MISSING)'}")
if missing:
    print(f"  WARNING missing: {', '.join(missing)}")
if not engines:
    print("  ERROR: no engines have both a user and a key."); sys.exit(1)

MASK = b"aether-obfuscation-mask-not-a-secret"
raw = json.dumps(cfg, separators=(",", ":")).encode()
xored = bytes(b ^ MASK[i % len(MASK)] for i, b in enumerate(raw))
open(out_path, "wb").write(base64.b64encode(xored))
print(f"  wrote {out_path} ({len(xored)} bytes obfuscated)")
PY
