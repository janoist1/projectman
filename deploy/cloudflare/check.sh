#!/usr/bin/env bash
# Checks the public entrance of the live projectman (PM-200, PM-210): Cloudflare Access in front,
# the tunnel, the edge settings and the server's own origin/cookie rules. Guide: docs/DEPLOY.md,
# section "Public entry through Cloudflare Tunnel and Access". It extends the curl checks of the
# tailnet section to the public address. Run it as the owner, from any machine with curl and
# cloudflared.
#
# Usage:
#   cloudflared access login https://chopper.istvan.io >/dev/null   # once; your own login
#   LOGIN_JSON=/path/to/login.json deploy/cloudflare/check.sh [origin]
#
# LOGIN_JSON is a file (mode 600) with {"email": "...", "password": "..."} of a projectman account.
# It is read by curl only; the script never prints it. The origin defaults to
# https://chopper.istvan.io.
#
# What it leaves behind: nothing. The Access token goes to a mode-600 header file in a temporary
# directory (not onto a command line), the cookie jar and the header dumps live there too, the
# projectman session it creates is logged out at the end, and the directory is removed when the
# script exits, however it ends. No long-lived service token is created: the Access token is the
# one `cloudflared access login` fetched for you, with the session length of the Access
# application. Only the status of each check is printed.
#
# The script makes one failed login if the account is wrong, and the login limiter counts it
# (10 per client in 15 minutes).

set -u
umask 077

origin="${1:-https://chopper.istvan.io}"
origin="${origin%/}"
foreign_origin='https://other.example.com'

if [ -z "${LOGIN_JSON:-}" ] || [ ! -f "$LOGIN_JSON" ]; then
  echo 'set LOGIN_JSON to a file with {"email": "...", "password": "..."}' >&2
  exit 2
fi
for tool in curl cloudflared; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required" >&2
    exit 2
  fi
done

tmp=$(mktemp -d "${TMPDIR:-/tmp}/cf-check.XXXXXX") || exit 2
trap 'rm -rf "$tmp"' EXIT

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  failures=$((failures + 1))
}
# check <description> <exit status of the test>
check() {
  if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1"; fi
}

ws_headers=(
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13'
  -H 'Sec-WebSocket-Key: cHJvamVjdG1hbnNtb2tlIQ=='
)

echo "== Without Cloudflare Access ($origin) =="

# Expect the Access login (a redirect to <team>.cloudflareaccess.com) or a 403; anything else
# reached the application, or something in front of it that is not Access.
anonymous() {
  local description=$1 path=$2 out code location
  shift 2
  out=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code} %{redirect_url}' "$@" "$origin$path" 2>/dev/null)
  code=${out%% *}
  location=${out#* }
  case "$code" in
    302 | 303 | 307)
      case "$location" in
        https://*.cloudflareaccess.com/*) pass "$description: redirected to the Access login" ;;
        *) fail "$description: redirected to somewhere else than the Access login (HTTP $code)" ;;
      esac
      ;;
    403) pass "$description: refused (HTTP 403)" ;;
    *) fail "$description: reached something else than the Access login (HTTP ${code:-none})" ;;
  esac
}
anonymous 'GET /' /
anonymous 'GET /api/setup' /api/setup
anonymous 'GET /ws (websocket upgrade)' /ws --http1.1 "${ws_headers[@]}" -H "Origin: $origin"

echo "== With your Cloudflare Access login =="

# `cloudflared access curl` does the same as this: it sends the token in a cf-access-token header.
# Here the header goes through a file, so the token is not on any command line.
token=$(cloudflared access token -app="$origin" 2>/dev/null)
if [ -z "$token" ]; then
  echo "no Access token: run  cloudflared access login $origin >/dev/null  and start again" >&2
  exit 2
fi
printf 'cf-access-token: %s\n' "$token" >"$tmp/access.hdr"
unset token

# Every request below carries the Access token header and goes to the same origin.
acurl() { curl -sS --max-time 15 -H "@$tmp/access.hdr" "$@"; }
# The first status line of a header dump, for the messages.
status_of() { head -n 1 "$1" | tr -d '\r'; }
# Whether a header dump has a header whose name and value match a (case-insensitive) pattern.
has_header() { tr -d '\r' <"$1" | grep -qi "^$2"; }

code=$(acurl -o "$tmp/setup.body" -w '%{http_code}' "$origin/api/setup")
if [ "$code" = 200 ] && grep -q '"needsSetup":false' "$tmp/setup.body"; then
  pass 'GET /api/setup reaches projectman through Access (needsSetup is false)'
else
  fail "GET /api/setup did not answer needsSetup:false through Access (HTTP $code)"
fi

# Login with the account's own Origin: the cookie must be Secure and the origin accepted.
login_ok=1
code=$(acurl -o "$tmp/login.body" -D "$tmp/login.headers" -c "$tmp/cookies" -w '%{http_code}' \
  -H "Origin: $origin" -H 'Content-Type: application/json' --data-binary "@$LOGIN_JSON" \
  "$origin/api/auth/login")
if [ "$code" = 200 ] && ! grep -q 'invalid_origin' "$tmp/login.body"; then
  login_ok=0
  pass 'login with its own origin works (no invalid_origin)'
else
  reason=$(grep -o '"code":"[^"]*"' "$tmp/login.body" | head -n 1)
  fail "login with its own origin did not work (HTTP $code ${reason:-})"
fi
if [ "$login_ok" -eq 0 ]; then
  tr -d '\r' <"$tmp/login.headers" | grep -i '^set-cookie:' | grep -qi ';[[:space:]]*secure'
  check 'the session cookie (Set-Cookie) is Secure' $?
else
  fail 'the session cookie (Set-Cookie) is Secure: no login'
fi

# A foreign origin is refused (the origin is compared before the login is).
code=$(acurl -o "$tmp/foreign.body" -w '%{http_code}' -X POST -H "Origin: $foreign_origin" \
  "$origin/api/auth/logout")
if [ "$code" = 403 ] && grep -q 'invalid_origin' "$tmp/foreign.body"; then
  pass 'a foreign origin gets 403 invalid_origin'
else
  fail "a foreign origin did not get 403 invalid_origin (HTTP $code)"
fi

# The websocket handshake: 101, then the connection stays open until curl's timeout.
if [ "$login_ok" -eq 0 ]; then
  acurl --http1.1 --max-time 3 -o /dev/null -D "$tmp/ws.headers" -b "$tmp/cookies" \
    -H "Origin: $origin" "${ws_headers[@]}" "$origin/ws" 2>/dev/null
  if head -n 1 "$tmp/ws.headers" 2>/dev/null | grep -q ' 101'; then
    pass '/ws answers 101 Switching Protocols'
  else
    fail "/ws did not answer 101 ($(status_of "$tmp/ws.headers" 2>/dev/null))"
  fi
else
  fail '/ws answers 101 Switching Protocols: no login'
fi

# The internal endpoints are not passed on by the tunnel.
for path in /hooks/x /mcp/x; do
  name=${path#/}
  name=${name%%/*}
  code=$(acurl -o /dev/null -D "$tmp/$name.headers" -w '%{http_code}' "$origin$path")
  if [ "$code" = 404 ]; then pass "GET $path is 404"; else fail "GET $path is not 404 (HTTP $code)"; fi
done

# The first setup is refused from a remote client.
code=$(acurl -o "$tmp/post-setup.body" -w '%{http_code}' -X POST -H "Origin: $origin" \
  -H 'Content-Type: application/json' --data '{}' "$origin/api/setup")
if grep -q 'setup_requires_localhost' "$tmp/post-setup.body" ||
  { [ "$code" -ge 400 ] && grep -q '"needsSetup":false' "$tmp/setup.body"; }; then
  pass "POST /api/setup is refused (HTTP $code)"
else
  fail "POST /api/setup was not refused (HTTP $code)"
fi

# The edge's headers, on a page, an API answer and an answer the tunnel made itself.
acurl -o /dev/null -D "$tmp/root.headers" "$origin/"
acurl -o /dev/null -D "$tmp/api.headers" "$origin/api/setup"
for name in root api hooks; do
  file="$tmp/$name.headers"
  case "$name" in
    root) where=/ ;;
    api) where=/api/setup ;;
    *) where=/hooks/x ;;
  esac
  has_header "$file" 'strict-transport-security:'
  check "$where: Strict-Transport-Security is set" $?
  has_header "$file" "content-security-policy:.*frame-ancestors 'none'"
  check "$where: Content-Security-Policy has frame-ancestors 'none'" $?
  has_header "$file" 'x-frame-options: *deny'
  check "$where: X-Frame-Options is DENY" $?
done

# End the session this script made.
if [ "$login_ok" -eq 0 ]; then
  code=$(acurl -o /dev/null -w '%{http_code}' -b "$tmp/cookies" -X POST -H "Origin: $origin" \
    "$origin/api/auth/logout")
  case "$code" in
    2??) pass 'the script logged its session out' ;;
    *) fail "the script's session could not be logged out (HTTP $code); log it out in the app" ;;
  esac
fi

echo
if [ "$failures" -eq 0 ]; then
  echo 'all checks passed'
else
  echo "$failures check(s) failed"
  exit 1
fi
