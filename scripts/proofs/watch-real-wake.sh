#!/usr/bin/env bash
# Watch a real Kaggle engine boot and capture its live tunnel URL from ntfy.
KEY=KGAT_REDACTED
USER=fridaymoses
SLUG=qwen-3-8-27b-uncensored-chat
TOPIC=aether-proof-7f3k9x2q
OUT=/tmp/aether-real/watch.log
mkdir -p /tmp/aether-real
: > "$OUT"

for i in $(seq 1 46); do
  st=$(curl -s -m 25 -H "Authorization: Bearer $KEY" \
    "https://www.kaggle.com/api/v1/kernels/status?userName=$USER&kernelSlug=$SLUG")
  status=$(echo "$st" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo '?')
  # ntfy poll: the engine posts "AGENT LIVE LINK: <url>" once its tunnel is up.
  link=$(curl -s -m 25 "https://ntfy.sh/$TOPIC/json?poll=1&since=30m" 2>/dev/null \
    | python3 -c "
import json,sys,re
best=None
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: e=json.loads(line)
    except Exception: continue
    m=re.search(r'AGENT LIVE LINK:\s*(\S+)', e.get('message','') or '')
    if m: best=m.group(1)
print(best or '')
" 2>/dev/null)
  echo "[$(date -u +%H:%M:%S)] iter=$i status=$status link=${link:-none}" >> "$OUT"
  if [ -n "$link" ]; then echo "LIVE $link" >> "$OUT"; break; fi
  sleep 20
done
echo "DONE" >> "$OUT"
