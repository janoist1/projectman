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
# BOARD_MODE=public (optional, PM-672) checks the public board instead: the main hostname has no Cloudflare Access
# in front of it, the board's own login is the boundary (no cloudflared and no Access token needed). The default,
# private, is the Access setup. `npm run cloud -- check` sets it from access.boardMode.
#
# FEEDBACK_ORIGIN (optional, e.g. https://jelolo.example.com) adds the checks of the marking
# widget's public entrance (PM-513), which has no Access application: they carry neither the Access
# token nor a login.
#   FEEDBACK_ORIGIN=https://jelolo.example.com LOGIN_JSON=... deploy/cloudflare/check.sh
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

# BOARD_MODE=public (PM-672): the board's own login is the browser boundary, with no Cloudflare Access in front of the
# main hostname. Then the anonymous visitor reaches the login page and the e-mail code request but nothing behind
# the login, and no Access token (and no cloudflared) is used. The default, private, is the Access setup above.
board_mode="${BOARD_MODE:-private}"
case "$board_mode" in
  private | public) ;;
  *)
    echo 'BOARD_MODE must be private or public' >&2
    exit 2
    ;;
esac

if [ -z "${LOGIN_JSON:-}" ] || [ ! -f "$LOGIN_JSON" ]; then
  echo 'set LOGIN_JSON to a file with {"email": "...", "password": "..."}' >&2
  exit 2
fi
tools=(curl)
if [ "$board_mode" = private ]; then tools+=(cloudflared); fi
for tool in "${tools[@]}"; do
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

# Without a login (curl alone): the public board answers like this.
# public_anonymous <description> <expected status> <path> [curl options...]
public_anonymous() {
  local description=$1 expected=$2 path=$3 code
  shift 3
  code=$(curl -sS -o "$tmp/anonymous.body" --max-time 10 -w '%{http_code}' "$@" "$origin$path" 2>/dev/null)
  if [ "$code" = "$expected" ]; then pass "$description (HTTP $code)"; else fail "$description: HTTP ${code:-none}, expected $expected"; fi
}

if [ "$board_mode" = public ]; then
  echo "== Public board, without a login ($origin) =="
  public_anonymous 'GET / reaches the page' 200 /
  public_anonymous 'GET /api/setup reaches projectman' 200 /api/setup
  if grep -q '"publicBoard":true' "$tmp/anonymous.body" && grep -q '"emailLoginEnabled":true' "$tmp/anonymous.body" &&
    grep -q '"needsSetup":false' "$tmp/anonymous.body"; then
    pass '/api/setup says: public board, e-mail login enabled, owner set up'
  else
    fail '/api/setup does not say publicBoard:true, emailLoginEnabled:true and needsSetup:false'
  fi
  public_anonymous 'GET /api/auth/me without a login is refused' 401 /api/auth/me
  public_anonymous 'GET /ws (websocket upgrade) without a login is refused' 401 /ws --http1.1 "${ws_headers[@]}" \
    -H "Origin: $origin"
  # An address nobody invited gets the same answer as any other (no list of who may log in), and no mail.
  public_anonymous 'POST /api/auth/email/request is reachable' 202 /api/auth/email/request -X POST \
    -H "Origin: $origin" -H 'Content-Type: application/json' --data '{"email":"public-check@example.invalid"}'
  public_anonymous 'POST /api/auth/login from a foreign Origin is refused' 403 /api/auth/login -X POST \
    -H "Origin: $foreign_origin" -H 'Content-Type: application/json' --data '{}'
  echo
  echo "== With your own login ($origin) =="
  # No Access token: the main hostname has no Access in front of it.
  acurl() { curl -sS --max-time 15 "$@"; }
else
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
fi
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
  tr -d '\r' <"$tmp/login.headers" | grep -i '^set-cookie:' | grep -qi ';[[:space:]]*httponly'
  check 'the session cookie (Set-Cookie) is HttpOnly' $?
  tr -d '\r' <"$tmp/login.headers" | grep -i '^set-cookie:' | grep -qi ';[[:space:]]*samesite=\(lax\|strict\)'
  check 'the session cookie (Set-Cookie) is SameSite Lax or Strict' $?
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
  { [[ "$code" =~ ^[45][0-9][0-9]$ ]] && grep -q '"needsSetup":false' "$tmp/setup.body"; }; then
  pass "POST /api/setup is refused (HTTP $code)"
else
  fail "POST /api/setup was not refused (HTTP $code)"
fi

# The edge's headers, on a page, an API answer and an answer the tunnel made itself.
acurl -o "$tmp/root.body" -D "$tmp/root.headers" "$origin/"
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

# The edge keeps nothing of the board (PM-536): a page and an API answer behind a login must never come from
# Cloudflare's cache, so a cached copy cannot outlive a logout or reach someone without a session.
for name in root api; do
  case "$name" in
    root) where=/ ;;
    *) where=/api/setup ;;
  esac
  has_header "$tmp/$name.headers" 'cf-cache-status: *hit'
  if [ $? -eq 0 ]; then fail "$where: cf-cache-status is HIT; the edge caches the board"; else pass "$where: cf-cache-status is not HIT"; fi
done

# The edge adds nothing to the page: no analytics beacon, Rocket Loader, e-mail decoding or Zaraz (they would
# need script sources the board's Content-Security-Policy does not allow, and they read the page).
if grep -qiE 'cloudflareinsights|rocket-loader|email-decode|/cdn-cgi/zaraz|/cdn-cgi/scripts' "$tmp/root.body"; then
  fail 'the page has an edge-injected script (cloudflareinsights, rocket-loader, email-decode, zaraz or cdn-cgi/scripts)'
else
  pass 'the page has no edge-injected script'
fi

# End the session this script made.
if [ "$login_ok" -eq 0 ]; then
  code=$(acurl -o /dev/null -w '%{http_code}' -b "$tmp/cookies" -X POST -H "Origin: $origin" \
    "$origin/api/auth/logout")
  case "$code" in
    2??) pass 'the script logged its session out' ;;
    *) fail "the script's session could not be logged out (HTTP $code); log it out in the app" ;;
  esac
fi

# The marking widget's public entrance (PM-506, PM-513), when FEEDBACK_ORIGIN names it. It has no
# Access application, so none of these requests carries the Access token or a login.
if [ -n "${FEEDBACK_ORIGIN:-}" ]; then
  feedback_origin="${FEEDBACK_ORIGIN%/}"
  echo
  echo "== The widget's public entrance, without Access ($feedback_origin) =="
  # No Access token header here, unlike acurl above.
  fcurl() { curl -sS --max-time 15 "$@"; }

  code=$(fcurl -o "$tmp/widget.body" -w '%{http_code}' "$feedback_origin/feedback/widget.js")
  if [ "$code" = 200 ]; then
    pass 'GET /feedback/widget.js is 200'
  else
    fail "GET /feedback/widget.js is not 200 (HTTP $code)"
  fi

  # A page that is not one of the instance's surfaces is refused, and gets no CORS grant.
  code=$(fcurl -o /dev/null -D "$tmp/preflight.headers" -w '%{http_code}' -X OPTIONS \
    -H "Origin: $foreign_origin" -H 'Access-Control-Request-Method: POST' \
    "$feedback_origin/feedback/api/v1/marks")
  if [ "$code" = 403 ]; then pass 'OPTIONS /feedback/api/v1/marks from a foreign Origin is 403'; else fail "OPTIONS /feedback/api/v1/marks from a foreign Origin is not 403 (HTTP $code)"; fi
  if has_header "$tmp/preflight.headers" 'access-control-allow-origin:'; then
    fail 'the refused preflight carries an access-control-allow-origin header'
  else
    pass 'the refused preflight carries no access-control-allow-origin header'
  fi

  # Everything else is not served on this hostname: the tunnel's 404 rule, and behind it the server's
  # host guard. The last path is sent as written (--path-as-is): Cloudflare's ^/feedback/ rule lets it
  # through, so only the server can refuse it.
  for path in / /api/setup /ws /hooks/x /mcp/x /feedback/../api/setup; do
    code=$(fcurl --path-as-is -o /dev/null -w '%{http_code}' "$feedback_origin$path")
    if [ "$code" = 404 ]; then pass "GET $path is 404"; else fail "GET $path is not 404 (HTTP $code)"; fi
  done
fi

echo
if [ "$failures" -eq 0 ]; then
  echo 'all checks passed'
else
  echo "$failures check(s) failed"
  exit 1
fi
