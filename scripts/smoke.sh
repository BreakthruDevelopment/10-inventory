#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up three users over HTTP and proves workspace isolation: one team never sees another's, staff can't do
# manager things, invite links are single use and revocable, and the last manager can't leave.
# Later issues add the items, stock and forecast flow (create an item, receive 10, sell 3, stale count, forecast).
#   BASE_URL=https://app10.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"; JAR_C="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B" "$JAR_C"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /workspaces /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out workspaces and admin redirect"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
signup "$JAR_C" "smoke-c-$RUN_ID@example.test"
pass "three users signed up"


# Helpers: status of a request as a given user; a JSON field from stdin.
status() { # jar method path [body]
  local jar=$1 method=$2 path=$3 body=${4:-}
  if [ -n "$body" ]; then
    curl -s -o /dev/null -w '%{http_code}' -X "$method" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$body" "$BASE_URL$path"
  else
    curl -s -o /dev/null -w '%{http_code}' -X "$method" -b "$jar" -H "origin: $BASE_URL" "$BASE_URL$path"
  fi
}
send() { # jar method path [body]: prints the response body
  local jar=$1 method=$2 path=$3 body=${4:-}
  curl -fsS -X "$method" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" ${body:+-d "$body"} "$BASE_URL$path"
}
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(v)})' "$1"; }
expect() { # what expected actual
  [ "$2" = "$3" ] || fail "$1: expected $2, got $3"
}

expect "anonymous workspace list" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/workspaces")"
pass "anonymous access refused"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' \
  -d '{"name":"x"}' "$BASE_URL/api/workspaces")
expect "cross-origin create" 403 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -d '{"name":"x"}' "$BASE_URL/api/workspaces")
expect "create without an Origin" 403 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{nope' "$BASE_URL/api/workspaces")
expect "malformed JSON" 400 "$code"
code=$(head -c 40000 /dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  --data-binary @- "$BASE_URL/api/workspaces")
expect "oversized body" 413 "$code"
pass "cross-origin, malformed and oversized writes refused"

ws=$(send "$JAR_A" POST /api/workspaces '{"name":"Smoke Corner Store"}' | field workspace.id)
[ -n "$ws" ] && [ "$ws" != "undefined" ] || fail "no workspace id"
expect "creator's role" manager "$(send "$JAR_A" GET "/api/w/$ws" | field workspace.role)"
pass "user A created a workspace and is its manager"

uuid() { node -e 'console.log(require("node:crypto").randomUUID())'; }
item=$(send "$JAR_A" POST "/api/w/$ws/items" '{"sku":"SMOKE-OAT","name":"Smoke oat milk","barcode":"4006381333931","reorderPoint":8}' | field item.id)
expect "barcode lookup" "$item" "$(send "$JAR_A" GET "/api/w/$ws/lookup?code=4006381333931" | field item.id)"
expect "receive 10" 10 "$(send "$JAR_A" POST "/api/w/$ws/movements" "{\"itemId\":\"$item\",\"kind\":\"receive\",\"qty\":10,\"clientOpId\":\"$(uuid)\"}" | field movement.onHandAfter)"
op=$(uuid)
sale="{\"itemId\":\"$item\",\"kind\":\"sale\",\"qty\":3,\"clientOpId\":\"$op\"}"
expect "sell 3" 7 "$(send "$JAR_A" POST "/api/w/$ws/movements" "$sale" | field movement.onHandAfter)"
expect "retry sale" 7 "$(send "$JAR_A" POST "/api/w/$ws/movements" "$sale" | field movement.onHandAfter)"
expect "stale count" 409 "$(status "$JAR_A" POST "/api/w/$ws/movements" "{\"itemId\":\"$item\",\"kind\":\"count\",\"qty\":10,\"expectedVersion\":2,\"clientOpId\":\"$(uuid)\"}")"
expect "ledger reconciles" true "$(send "$JAR_A" GET "/api/w/$ws/items/$item" | field item.ledgerMatches)"
expect "two ledger entries after retry" 2 "$(send "$JAR_A" GET "/api/w/$ws/items/$item" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).item.movements.length))')"
expect "B cannot read item" 404 "$(status "$JAR_B" GET "/api/w/$ws/items/$item")"
expect "B cannot record stock" 404 "$(status "$JAR_B" POST "/api/w/$ws/movements" "$sale")"
expect "manager CSV export" 200 "$(status "$JAR_A" GET "/api/w/$ws/export/items.csv")"
pass "item, barcode lookup, receive/sale, idempotency, stale count and ledger check"


for path in "/api/w/$ws" "/api/w/$ws/members" "/api/w/$ws/invites"; do
  expect "B on $path" 404 "$(status "$JAR_B" GET "$path")"
done
expect "B creating an invite in A's workspace" 404 "$(status "$JAR_B" POST "/api/w/$ws/invites" '{"role":"staff"}')"
expect "B's own workspace list" '[]' "$(send "$JAR_B" GET /api/workspaces | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).workspaces)))')"
pass "user B gets 404 on A's workspace, members and invites"

invite=$(send "$JAR_A" POST "/api/w/$ws/invites" '{"role":"staff"}')
token=$(echo "$invite" | field token)
invite_id=$(echo "$invite" | field invite.id)
[ "${#token}" = 43 ] || fail "invite token should be 43 characters"
expect "signed-out join page" 307 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/join/$token")"
expect "join page for a signed-in user" 200 "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_B" "$BASE_URL/join/$token")"
expect "C before the invite is used" 404 "$(status "$JAR_C" GET "/api/w/$ws")"
pass "user A made an invite link"

joined=$(send "$JAR_B" POST "/api/join/$token")
expect "B accepts" true "$(echo "$joined" | field joined)"
expect "B's role" staff "$(echo "$joined" | field role)"
expect "B accepts twice" false "$(send "$JAR_B" POST "/api/join/$token" | field joined)"
expect "B reads the workspace" 200 "$(status "$JAR_B" GET "/api/w/$ws")"
expect "invite list is hidden from staff" 403 "$(status "$JAR_B" GET "/api/w/$ws/invites")"
expect "staff can't create invites" 403 "$(status "$JAR_B" POST "/api/w/$ws/invites" '{"role":"staff"}')"
expect "staff can't list members" 403 "$(status "$JAR_B" GET "/api/w/$ws/members")"
pass "user B joined as staff once; staff can't invite or list members (403)"
expect "staff can sell" 6 "$(send "$JAR_B" POST "/api/w/$ws/movements" "{\"itemId\":\"$item\",\"kind\":\"sale\",\"qty\":1,\"clientOpId\":\"$(uuid)\"}" | field movement.onHandAfter)"
expect "staff cannot edit item" 403 "$(status "$JAR_B" PATCH "/api/w/$ws/items/$item" '{"version":4,"name":"Forbidden"}')"
expect "staff cannot export" 403 "$(status "$JAR_B" GET "/api/w/$ws/export/items.csv")"
pass "staff stock permissions"


expect "C with a used link" 404 "$(status "$JAR_C" POST "/api/join/$token")"
expect "C with a made-up link" 404 "$(status "$JAR_C" POST "/api/join/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")"
second=$(send "$JAR_A" POST "/api/w/$ws/invites" '{}')
second_id=$(echo "$second" | field invite.id)
expect "revoke" 204 "$(status "$JAR_A" DELETE "/api/w/$ws/invites/$second_id")"
expect "C with a revoked link" 404 "$(status "$JAR_C" POST "/api/join/$(echo "$second" | field token)")"
expect "revoking a used invite" 409 "$(status "$JAR_A" DELETE "/api/w/$ws/invites/$invite_id")"
pass "used and revoked links are dead"

me=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/auth/get-session" | field user.id)
expect "last manager can't leave" 409 "$(status "$JAR_A" DELETE "/api/w/$ws/members/$me")"
expect "last manager can't be demoted" 409 "$(status "$JAR_A" PATCH "/api/w/$ws/members/$me" '{"role":"staff"}')"
pass "last manager rule holds"

b_id=$(curl -fsS -b "$JAR_B" "$BASE_URL/api/auth/get-session" | field user.id)
expect "staff can't remove the manager" 403 "$(status "$JAR_B" DELETE "/api/w/$ws/members/$me")"
expect "B leaves" 204 "$(status "$JAR_B" DELETE "/api/w/$ws/members/$b_id")"
expect "B after leaving" 404 "$(status "$JAR_B" GET "/api/w/$ws")"
pass "staff can leave and then loses access"

expect "admin stats for a user" 403 "$(status "$JAR_A" GET /api/admin/stats)"
expect "admin stats for nobody" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/admin/stats")"
pass "admin counts are admin-only"

echo "SMOKE PASS"
