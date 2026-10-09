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

# The engine door (the link and the file transfers, all under /engine) must refuse a caller without a
# machine key (never a 2xx). The service token passes Access on the /engine application only when
# that application covers the whole /engine path.
for door in /engine/link /engine/files/downloads/smoke-test /engine/files/uploads/smoke-test; do
  door_code="$(curl -sS --max-time 15 ${headers[@]+"${headers[@]}"} -o /dev/null -w '%{http_code}' "$base$door" || true)"
  case "$door_code" in
    2??) fail "$door answered $door_code without a machine key" ;;
    000) fail "$door is not reachable" ;;
    *) echo "ok: $door refuses an anonymous caller ($door_code)" ;;
  esac
done

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "smoke test passed"
