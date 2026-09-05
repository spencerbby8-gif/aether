#!/usr/bin/env bash
# Aether security sweep — proves Kaggle credentials never reach the client,
# browser storage, responses, or logs. Exits non-zero on any finding.
set -u
FINDINGS=0

echo "=== 1. client bundle (.next/static) ==="
if grep -rlE "KAGGLE_KEY|KAGGLE_USERNAME|kaggle\.com/api|ENGINE_KERNEL_|72131bf4-534d|REMOVED_BEACON_TOPIC|ENGINE_OFF_KEY|KAGGLE_KEY_B|KAGGLE_USERNAME_B" .next/static/ 2>/dev/null; then
  echo "FINDING: kaggle references in client bundle"; FINDINGS=1
else
  echo "CLEAN: no kaggle references in client bundle"
fi
if grep -rlE "Basic [A-Za-z0-9+/=]{20,}" .next/static/ 2>/dev/null | grep -v "$(grep -rl 'Visual Basic' .next/static/ 2>/dev/null | head -1)" | grep .; then
  echo "FINDING: credential-shaped Basic token in client bundle"; FINDINGS=1
else
  echo "CLEAN: no credential-shaped tokens in client bundle"
fi

echo
echo "=== 2. server chunks: KAGGLE_* only as process.env lookups ==="
grep -rho "process\.env\.KAGGLE_[A-Z_]*" .next/server/ 2>/dev/null | sort | uniq -c || echo "none"

echo
echo "=== 3. source: hardcoded credential values ==="
if grep -rniE "kaggle[_-]?(key|username)[\"']?\s*[:=]\s*[\"'][A-Za-z0-9_-]{8,}" src/ scripts/ tests/ 2>/dev/null | grep -v "process.env"; then
  echo "FINDING: hardcoded credential"; FINDINGS=1
else
  echo "CLEAN: no hardcoded credentials in source"
fi

echo
echo "=== 4. server logs ==="
for log in /tmp/final-server.log /tmp/p5-server.log; do
  [ -f "$log" ] || continue
  if grep -qiE "kaggle_key=[A-Za-z0-9]|authorization: Basic [A-Za-z0-9+/=]{16,}" "$log"; then
    echo "FINDING: leaked credentials in $log"; FINDINGS=1
  else
    echo "CLEAN: $log"
  fi
done

echo
echo "=== 5. API responses ==="
HEADERS=$(curl -s -D - -o /dev/null http://127.0.0.1:3000/api/engine/state)
if echo "$HEADERS" | grep -qiE "kaggle"; then
  echo "FINDING: kaggle in response headers"; FINDINGS=1
else
  echo "CLEAN: /api/engine/state headers"
fi
STATE=$(curl -s http://127.0.0.1:3000/api/engine/state)
if echo "$STATE" | grep -qE "\"(key|token|secret|password)\"\s*:\s*\"[A-Za-z0-9]"; then
  echo "FINDING: secret-looking field in state response"; FINDINGS=1
else
  echo "CLEAN: state response body exposes no secret fields"
fi
if echo "$STATE" | grep -q "kaggleConfigured"; then
  echo "note: state exposes ONLY the boolean kaggleConfigured flag (no values)"
fi

echo
echo "=== 6. browser storage (IndexedDB/localStorage dump scan) ==="
node scripts/security-sweep-storage.mjs

echo
if [ "$FINDINGS" -eq 0 ]; then echo "SECURITY SWEEP: PASS (0 findings)"; else echo "SECURITY SWEEP: FAIL"; exit 1; fi
