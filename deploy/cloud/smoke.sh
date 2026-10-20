#!/usr/bin/env bash
# A smoke test of a running cloud instance (PM-317, docs/HYBRID.md). It checks the public setup route
# and, when given, that the engine door refuses an anonymous caller.
#
#   smoke.sh <base-url>
#
# Through the tunnel, when Cloudflare Access guards the host, pass a service token so the test gets
# past Access (the same kind the engine uses):
#
#   CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… smoke.sh https://projectman.example.com
#
# Public board (PM-672): there is no Access in front of the main hostname, so no service token is needed:
#
#   SMOKE_PUBLIC_BOARD=1 smoke.sh https://projectman.example.com
set -euo pipefail

base="${1:?usage: smoke.sh <base-url>}"
base="${base%/}"

headers=()
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  headers=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
fi

failures=0
fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

body="$(curl -sS --max-time 15 ${headers[@]+"${headers[@]}"} -w '\n%{http_code}' "$base/api/setup")" || {
  fail "$base/api/setup is not reachable"
  exit 1
}
code="${body##*$'\n'}"
json="${body%$'\n'*}"
if [ "$code" != 200 ]; then
  fail "/api/setup answered $code (expected 200; a Cloudflare Access login page means the service token is missing or wrong)"
elif ! printf '%s' "$json" | grep -q '"needsSetup"'; then
  fail "/api/setup did not answer projectman JSON"
else
  echo "ok: /api/setup answers: $json"
fi

# A public board (PM-672; SMOKE_PUBLIC_BOARD=1) must say so in its setup status, with a working e-mail login,
# and must keep everything behind the login closed to an anonymous caller. A board that is not public must not
# claim to be.
public_flag="$(printf '%s' "$json" | grep -c '"publicBoard":true' || true)"
if [ "${SMOKE_PUBLIC_BOARD:-0}" = 1 ]; then
  if [ "$public_flag" = 0 ] || ! printf '%s' "$json" | grep -q '"emailLoginEnabled":true'; then
    fail "/api/setup does not say publicBoard:true with emailLoginEnabled:true"
  else
    echo "ok: /api/setup says this is the public board with the e-mail login"
  fi
  me_code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$base/api/auth/me" || true)"
  if [ "$me_code" = 401 ]; then
    echo "ok: /api/auth/me refuses an anonymous caller (401)"
  else
    fail "/api/auth/me answered ${me_code:-none} to an anonymous caller (expected 401)"
  fi
elif [ "$public_flag" != 0 ]; then
  fail "/api/setup says publicBoard:true but SMOKE_PUBLIC_BOARD is not 1"
fi

# The engine door (the link and the file transfers, all under /engine) must refuse a caller without a
# machine key (never a 2xx). The service token passes Access on the /engine application only when
# that application covers the whole /engine path.
#
# The upload door is a POST route (PM-723): a GET to it only reaches the not-found answer, so it is probed
# with both methods; the POST carries an empty binary body and no key.
probe_door() {
  local method="$1" door="$2" door_code
  if [ "$method" = POST ]; then
    door_code="$(curl -sS --max-time 15 ${headers[@]+"${headers[@]}"} -X POST -H 'Content-Type: application/octet-stream' --data-binary '' -o /dev/null -w '%{http_code}' "$base$door" || true)"
  else
    door_code="$(curl -sS --max-time 15 ${headers[@]+"${headers[@]}"} -o /dev/null -w '%{http_code}' "$base$door" || true)"
  fi
  case "$door_code" in
    2??) fail "$method $door answered $door_code without a machine key" ;;
    [345]??) echo "ok: $method $door refuses an anonymous caller ($door_code)" ;;
    000) fail "$method $door is not reachable" ;;
    *) fail "$method $door answered ${door_code:-no status} (expected a refusal)" ;;
  esac
}
probe_door GET /engine/link
probe_door GET /engine/files/downloads/smoke-test
probe_door GET /engine/files/uploads/smoke-test
probe_door POST /engine/files/uploads/smoke-test

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "smoke test passed"
