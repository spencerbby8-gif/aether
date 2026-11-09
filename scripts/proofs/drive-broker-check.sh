#!/usr/bin/env bash
# Live checks against the deployed google-drive-token Edge Function and the
# service-role-only credential table. These assert ACCESS CONTROL only: they
# deliberately do not attempt a Google exchange, which needs a real account.
set -u
KEY="${AETHER_PUBLISHABLE_KEY:-sb_publishable_cusqr6nSrtwed1VQTJTG_Q_BlVvrdFp}"
BASE="${AETHER_SUPABASE_URL:-https://jvuqxazndloiekikzrnb.supabase.co}"
FN="$BASE/functions/v1/google-drive-token"
pass=0; fail=0

check() { # name expected_status actual_status body
  if [ "$2" = "$3" ]; then
    echo "  ok   $1 (HTTP $3)"
    pass=$((pass+1))
  else
    echo "  FAIL $1 (expected HTTP $2, got $3) body: $(echo "$4" | head -c 160)"
    fail=$((fail+1))
  fi
}

body=$(mktemp)
status=$(curl -sS -o "$body" -w '%{http_code}' -X POST "$FN" -H "apikey: $KEY" \
  -H 'Content-Type: application/json' -d '{"action":"access"}')
check "anonymous call is refused" 401 "$status" "$(cat "$body")"

status=$(curl -sS -o "$body" -w '%{http_code}' -X POST "$FN" -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"action":"access"}')
check "the publishable key cannot impersonate a user" 401 "$status" "$(cat "$body")"

status=$(curl -sS -o "$body" -w '%{http_code}' "$BASE/rest/v1/google_drive_credentials?select=user_id" -H "apikey: $KEY")
check "refresh-token table is not readable by clients" 401 "$status" "$(cat "$body")"

status=$(curl -sS -o "$body" -w '%{http_code}' "$FN" -H "apikey: $KEY")
check "the function answers only POST" 405 "$status" "$(cat "$body")"

status=$(curl -sS -o "$body" -w '%{http_code}' -X POST "$FN" -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"action":"disconnect"}')
check "disconnect without a session is refused" 401 "$status" "$(cat "$body")"

grep -q 'refresh_token' "$body" 2>/dev/null && { echo "  FAIL no token material may appear in an error body"; fail=$((fail+1)); }

echo
echo "DRIVE BROKER CHECK  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
