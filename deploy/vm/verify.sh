#!/usr/bin/env bash
# Measures the managed VM profile (PM-137) and writes a readiness report as JSON.
#
#   sudo bash deploy/vm/verify.sh [--out FILE]
#   cd /srv/projectman && npx tsx scripts/vm-readiness.ts FILE     # the verdict
#
# Run as root on the guest: the probes switch to the service and worker accounts (runuser) and
# try what a worker must not do. The report holds statuses and short evidence only (paths, modes,
# counts, versions); no file content is read or printed, so it contains no secret. Nothing here
# decides readiness: the verdict rule is evaluateVmReadiness() in packages/shared, and a machine
# is ready only when every required check passed. A flag such as VM=true is not looked at.
# Probes that need a negative result also run a positive control, so a typo or a missing tool
# cannot pass as "denied".
set -u

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

PROFILE=${PROFILE:-/etc/projectman/profile.env}
OUT=
while [ $# -gt 0 ]; do
  case $1 in
    --out) OUT=${2:?--out needs a file}; shift 2 ;;
    *) echo "usage: verify.sh [--out FILE]" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "verify.sh must run as root" >&2; exit 2; }
[ -r "$PROFILE" ] || { echo "no installed profile at $PROFILE (run bootstrap.sh)" >&2; exit 2; }
# shellcheck source=profile.env
. "$PROFILE"
cd /

CLI_PATH="$CLI_PREFIX/bin:/usr/local/bin:/usr/bin:/bin"
WORKERS=()
while IFS=: read -r name _ uid _; do
  if [ "$uid" -ge "$WORKER_UID_MIN" ] && [ "$uid" -le "$WORKER_UID_MAX" ]; then WORKERS+=("$name"); fi
done < <(getent passwd)

as_user() { local u=$1; shift; runuser -u "$u" -- "$@"; }
# can_not USER TEST PATH: true when the TEST (-r, -w, -x) fails for USER on PATH.
can() { as_user "$1" test "$2" "$3" 2>/dev/null; }
tcp_connect() { as_user "$1" timeout 3 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$2" "$3" 2>/dev/null; }
root_connect() { timeout 3 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" 2>/dev/null; }
has_sudo() {
  command -v sudo >/dev/null 2>&1 || return 1
  sudo -n -l -U "$1" 2>/dev/null | grep -q 'may run the following'
}
first_version() { grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1; }

# --- versions ---------------------------------------------------------------------------------

check_os() {
  local got
  got=$(. /etc/os-release && printf '%s %s' "${ID:-?}" "${VERSION_ID:-?}")
  if [ "$got" = "$OS_ID $OS_VERSION_ID" ]; then record os pass "$got"; else record os fail "found $got, pinned $OS_ID $OS_VERSION_ID"; fi
}

check_node() {
  local v major
  v=$(as_user "$SERVICE_USER" env PATH="$CLI_PATH" node --version 2>/dev/null | first_version)
  major=${v%%.*}
  if [ -z "$v" ]; then record node fail "node does not run as $SERVICE_USER"
  elif [ "$major" != "$NODE_MAJOR" ]; then record node fail "node $v, pinned major $NODE_MAJOR"
  elif ! version_at_least "$NODE_MIN" "$v"; then record node fail "node $v, minimum $NODE_MIN"
  elif [ -n "$NODE_VERSION" ] && [ "$v" != "$NODE_VERSION" ]; then record node fail "node $v, pinned $NODE_VERSION"
  else record node pass "node $v (major $NODE_MAJOR, minimum $NODE_MIN)"; fi
}

check_cli() { # id binary pinned
  local id=$1 bin=$2 pinned=$3 v real
  v=$(as_user "$SERVICE_USER" env HOME="$SERVICE_HOME" PATH="$CLI_PATH" timeout 30 "$bin" --version 2>/dev/null | first_version)
  real=$(PATH=$CLI_PATH command -v "$bin" 2>/dev/null)
  real=$(readlink -f "$real" 2>/dev/null)
  if [ -z "$v" ]; then record "$id" fail "$bin does not run as $SERVICE_USER"
  elif [ "$v" != "$pinned" ]; then record "$id" fail "$bin $v, pinned $pinned"
  else
    case $real in
      "$CLI_PREFIX"/*) record "$id" pass "$bin $v from $CLI_PREFIX" ;;
      *) record "$id" fail "$bin $v resolves to $real, outside $CLI_PREFIX" ;;
    esac
  fi
}

check_app_build() {
  local commit loose
  commit=$(head -n 1 "$APP_DIR/DEPLOYED_COMMIT" 2>/dev/null)
  if ! printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$'; then record app-build fail "no recorded commit in $APP_DIR/DEPLOYED_COMMIT"; return; fi
  if [ ! -f "$APP_DIR/apps/server/dist/index.js" ] || [ ! -f "$APP_DIR/apps/web/dist/index.html" ]; then record app-build fail "build output missing"; return; fi
  loose=$(find "$APP_DIR" "$CLI_PREFIX" -xdev ! -type l \( ! -user root -o -perm /022 \) -print -quit 2>/dev/null)
  if [ -n "$loose" ]; then record app-build fail "not root-owned or writable by others: $loose"; return; fi
  record app-build pass "commit $commit built; $APP_DIR and $CLI_PREFIX are root-owned and not writable by others"
}

# --- accounts ---------------------------------------------------------------------------------

BAD_GROUPS="root sudo admin wheel adm docker lxd disk shadow libvirt kvm systemd-journal systemd-network"

bad_groups_of() { # user: privileged groups it belongs to
  local g out=
  for g in $(id -nG "$1" 2>/dev/null); do
    case " $BAD_GROUPS " in *" $g "*) out="$out $g" ;; esac
  done
  printf '%s' "$out"
}

locked_password() { case $(passwd -S "$1" 2>/dev/null | cut -d' ' -f2) in L|LK|NP) return 0 ;; *) return 1 ;; esac; }

check_service_account() {
  local uid bad
  uid=$(id -u "$SERVICE_USER" 2>/dev/null)
  if [ -z "$uid" ]; then record service-account fail "no account $SERVICE_USER"; return; fi
  bad=$(bad_groups_of "$SERVICE_USER")
  if [ "$uid" != "$SERVICE_UID" ]; then record service-account fail "uid $uid, the egress rules name uid $SERVICE_UID"
  elif has_sudo "$SERVICE_USER"; then record service-account fail "$SERVICE_USER has sudo rights"
  elif [ -n "$bad" ]; then record service-account fail "$SERVICE_USER is in privileged groups:$bad"
  elif ! locked_password "$SERVICE_USER"; then record service-account fail "$SERVICE_USER has a usable password"
  else record service-account pass "uid $uid, no sudo, no privileged group, password locked"; fi
}

check_workers_present() {
  local w bad=
  if [ "${#WORKERS[@]}" -lt 2 ]; then record workers-present fail "${#WORKERS[@]} worker account(s) in uid $WORKER_UID_MIN-$WORKER_UID_MAX; at least 2 are needed"; return; fi
  for w in "${WORKERS[@]}"; do
    case $w in "$WORKER_PREFIX"*) ;; *) bad="$bad $w(name)" ;; esac
    [ "$(id -gn "$w" 2>/dev/null)" = "$w" ] || bad="$bad $w(group)"
  done
  if [ -n "$bad" ]; then record workers-present fail "unexpected:$bad"; else record workers-present pass "${#WORKERS[@]} workers: ${WORKERS[*]}"; fi
}

check_workers_unprivileged() {
  local w extra bad= allow
  allow=$(sshd -T 2>/dev/null | grep -i '^allowusers ')
  [ -n "$allow" ] || bad="$bad sshd(no AllowUsers)"
  for w in "${WORKERS[@]}"; do
    extra=$(id -nG "$w" | tr ' ' '\n' | grep -vx "$w" | tr '\n' ' ')
    [ -z "$extra" ] || bad="$bad $w(groups:$extra)"
    has_sudo "$w" && bad="$bad $w(sudo)"
    locked_password "$w" || bad="$bad $w(password)"
    case $(getent passwd "$w" | cut -d: -f7) in */nologin|*/false) ;; *) bad="$bad $w(shell)" ;; esac
    case " $allow " in *" $w "*) bad="$bad $w(ssh)" ;; esac
  done
  if [ -n "$bad" ]; then record workers-unprivileged fail "$bad"; else record workers-unprivileged pass "no sudo, no extra group, password locked, nologin shell, not in sshd AllowUsers (${#WORKERS[@]} workers)"; fi
}

# --- protected paths --------------------------------------------------------------------------

check_paths_owner_mode() {
  local spec path want got bad= n=0 w
  local -a specs=(
    "$APP_DIR|root:root 755"
    "$CONFIG_DIR|root:root 755"
    "$CONFIG_DIR/gate.nft|root:root 644"
    "$CONFIG_DIR/profile.env|root:root 644"
    "$STATE_DIR|root:root 755"
    "$CLI_PREFIX|root:root 755"
    "$SERVICE_HOME|$SERVICE_USER:$SERVICE_USER 700"
    "$PROJECTMAN_HOME|$SERVICE_USER:$SERVICE_USER 700"
    "$WORKER_HOME_ROOT|root:root 755"
    "/etc/systemd/system/projectman.service|root:root 644"
    "/etc/systemd/system/projectman-gate.service|root:root 644"
  )
  for w in "${WORKERS[@]}"; do specs+=("$WORKER_HOME_ROOT/$w|$w:$w 750"); done
  for path in "$PROJECTMAN_HOME/secret" "$PROJECTMAN_HOME/db.sqlite"; do
    [ -e "$path" ] && specs+=("$path|$SERVICE_USER:$SERVICE_USER 600")
  done
  for spec in "${specs[@]}"; do
    path=${spec%%|*}; want=${spec#*|}
    got=$(stat -c '%U:%G %a' "$path" 2>/dev/null)
    n=$((n + 1))
    [ "$got" = "$want" ] || bad="$bad $path(${got:-missing}, want $want)"
  done
  if [ -n "$bad" ]; then record paths-owner-mode fail "$bad"; else record paths-owner-mode pass "$n paths have the expected owner and mode"; fi
}

check_worker_denied_read() {
  local w p bad= n=0
  local -a paths=("$PROJECTMAN_HOME" "$SERVICE_HOME")
  for p in secret db.sqlite; do [ -e "$PROJECTMAN_HOME/$p" ] && paths+=("$PROJECTMAN_HOME/$p"); done
  # Positive control: the service reads its own data, so a denial below is the account's doing.
  if ! can "$SERVICE_USER" -r "$PROJECTMAN_HOME" || ! can "$SERVICE_USER" -x "$PROJECTMAN_HOME"; then
    record worker-denied-read fail "control failed: $SERVICE_USER cannot read $PROJECTMAN_HOME, the probe proves nothing"; return
  fi
  for w in "${WORKERS[@]}"; do
    for p in "${paths[@]}"; do
      n=$((n + 1))
      if can "$w" -r "$p" || can "$w" -x "$p"; then bad="$bad $w:$p"; fi
    done
  done
  if [ -n "$bad" ]; then record worker-denied-read fail "readable by a worker:$bad"; else record worker-denied-read pass "$n worker x path probes denied (control: $SERVICE_USER can read $PROJECTMAN_HOME)"; fi
}

check_worker_denied_write() {
  local u p bad= n=0
  local -a paths=(
    "$APP_DIR" "$APP_DIR/apps/server/dist/index.js" "$CONFIG_DIR" "$CONFIG_DIR/gate.nft" "$CONFIG_DIR/profile.env"
    "$STATE_DIR" "$CLI_PREFIX" "/etc/systemd/system/projectman.service" "/etc/systemd/system/projectman-gate.service"
    "/etc/ssh/sshd_config.d" "$WORKER_HOME_ROOT"
  )
  # The service is held to the same limit for everything that is root's: it must not change the app
  # or the boundary either. Control: root-owned paths exist, and the service can write its own data.
  if ! can "$SERVICE_USER" -w "$PROJECTMAN_HOME"; then
    record worker-denied-write fail "control failed: $SERVICE_USER cannot write $PROJECTMAN_HOME, the probe proves nothing"; return
  fi
  for u in "$SERVICE_USER" "${WORKERS[@]}"; do
    for p in "${paths[@]}"; do
      [ -e "$p" ] || { bad="$bad missing:$p"; continue; }
      n=$((n + 1))
      if can "$u" -w "$p"; then bad="$bad $u:$p"; fi
    done
  done
  if [ -n "$bad" ]; then record worker-denied-write fail "writable or missing:$bad"; else record worker-denied-write pass "$n account x path probes denied (service and workers)"; fi
}

check_worker_isolation() {
  local a b bad= n=0
  for a in "${WORKERS[@]}"; do
    # Control: a worker uses its own home.
    if ! can "$a" -w "$WORKER_HOME_ROOT/$a"; then record worker-isolation fail "control failed: $a cannot write its own home"; return; fi
    for b in "${WORKERS[@]}"; do
      [ "$a" = "$b" ] && continue
      n=$((n + 1))
      if can "$a" -r "$WORKER_HOME_ROOT/$b" || can "$a" -x "$WORKER_HOME_ROOT/$b" || can "$a" -w "$WORKER_HOME_ROOT/$b"; then bad="$bad $a->$b"; fi
    done
  done
  if [ -n "$bad" ]; then record worker-isolation fail "access across workers:$bad"; else record worker-isolation pass "$n ordered worker pairs have no access to each other's home"; fi
}

check_no_credential_copies() {
  local w f found= n=0 loose=
  for w in "${WORKERS[@]}"; do
    for f in $CREDENTIAL_FILES; do
      n=$((n + 1))
      [ -e "$WORKER_HOME_ROOT/$w/$f" ] && found="$found $w:$f"
    done
  done
  for f in $CREDENTIAL_FILES; do
    if [ -e "$SERVICE_HOME/$f" ] && [ "$(stat -c '%a' "$SERVICE_HOME/$f")" != 600 ]; then loose="$loose $f"; fi
  done
  if [ -n "$found" ]; then record no-credential-copies fail "login files in worker homes:$found"
  elif [ -n "$loose" ]; then record no-credential-copies fail "service login files not mode 600:$loose"
  else record no-credential-copies pass "no login file in any worker home ($n names tried); the service's own login files are mode 600 where present"; fi
}

check_proc_hidden() {
  local w uids bad=
  for w in "${WORKERS[@]}"; do
    uids=$(as_user "$w" ps -eo uid= 2>/dev/null | tr -d ' ' | sort -u | tr '\n' ' ')
    [ "$uids" = "$(id -u "$w") " ] || bad="$bad $w(sees uids: ${uids:-none})"
  done
  if [ -n "$bad" ]; then record proc-hidden fail "a worker sees other accounts' processes:$bad"; else record proc-hidden pass "each worker sees only its own processes in /proc ($(grep ' /proc ' /proc/mounts | cut -d' ' -f4))"; fi
}

check_service_hardening() {
  local show bad= want
  show=$(systemctl show projectman -p User -p NoNewPrivileges -p PrivateTmp -p ProtectSystem -p RestrictSUIDSGID -p CapabilityBoundingSet 2>/dev/null)
  for want in "User=$SERVICE_USER" NoNewPrivileges=yes PrivateTmp=yes RestrictSUIDSGID=yes CapabilityBoundingSet=; do
    printf '%s\n' "$show" | grep -qx "$want" || bad="$bad $want"
  done
  printf '%s\n' "$show" | grep -Eqx 'ProtectSystem=(full|strict)' || bad="$bad ProtectSystem"
  if [ -n "$bad" ]; then record service-hardening fail "not set on the loaded unit:$bad"; else record service-hardening pass "User, NoNewPrivileges, PrivateTmp, ProtectSystem, RestrictSUIDSGID and an empty capability set on the loaded unit"; fi
}

# --- host isolation ---------------------------------------------------------------------------

check_no_host_mounts() {
  local t found=
  for t in $(cut -d' ' -f3 /proc/mounts | sort -u); do
    case " $FORBIDDEN_FS_TYPES " in *" $t "*) found="$found $t" ;; esac
  done
  [ ! -e /Users ] || found="$found /Users"
  if [ -n "$found" ]; then record no-host-mounts fail "host shares or paths present:$found"; else record no-host-mounts pass "no $FORBIDDEN_FS_TYPES mount type and no /Users"; fi
}

check_no_agent_forwarding() {
  local fwd pid sock found=
  fwd=$(sshd -T 2>/dev/null | grep -i '^allowagentforwarding ' | cut -d' ' -f2)
  pid=$(systemctl show projectman -p MainPID --value 2>/dev/null)
  if [ -n "$pid" ] && [ "$pid" != 0 ] && tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -q '^SSH_AUTH_SOCK='; then found="$found service-env"; fi
  sock=$(find /tmp /var/tmp /run -xdev -type s \( -name 'agent.*' -o -name 'ssh-agent*' -o -name 'S.gpg-agent*' -o -path '*/keyring/ssh' \) -print -quit 2>/dev/null)
  [ -z "$sock" ] || found="$found $sock"
  if [ "$fwd" != no ]; then record no-agent-forwarding fail "sshd allowagentforwarding is '${fwd:-unknown}'"
  elif [ -n "$found" ]; then record no-agent-forwarding fail "agent traces:$found"
  else record no-agent-forwarding pass "sshd allowagentforwarding no; no SSH_AUTH_SOCK in the service; no agent socket under /tmp, /var/tmp, /run"; fi
}

check_worker_sockets() {
  local p w bad= n=0 paths
  # tailscaled's LocalAPI socket is world-writable by default and tells whoever uses it the tailnet's
  # peers and addresses; bootstrap.sh closes its directory (0700), and this probe holds it to that.
  paths=$( { ss -xlnH 2>/dev/null | awk '{print $5}'; printf '%s\n' /var/run/docker.sock /run/containerd/containerd.sock /var/run/libvirt/libvirt-sock /run/lima-guestagent.sock /run/snapd.socket /run/snapd-snap.socket /run/tailscale/tailscaled.sock; } | grep '^/' | sort -u)
  for p in $paths; do
    [ -S "$p" ] || continue
    matches_any "$p" "$WORKER_ALLOWED_SOCKETS" && continue
    # The service is held to the same limit: until PM-140 it runs the CLIs.
    for w in "$SERVICE_USER" "${WORKERS[@]}"; do
      n=$((n + 1))
      if can "$w" -w "$p"; then bad="$bad $w:$p"; fi
    done
  done
  if [ -n "$bad" ]; then record worker-sockets fail "an account can use:$bad"; else record worker-sockets pass "neither the service nor a worker can write a unix socket outside the allowed list ($(printf '%s\n' "$paths" | wc -l | tr -d ' ') sockets seen, the tailscaled one included when present; abstract sockets cannot be permission-checked)"; fi
}

check_listeners() {
  local addr port proc bad= n=0 tailnet=0
  while read -r addr proc; do
    port=${addr##*:}; addr=${addr%:*}
    n=$((n + 1))
    case $addr in 127.*|'[::1]'|::1) continue ;; esac
    case " $ALLOWED_PUBLIC_TCP " in *" $port "*) continue ;; esac
    # tailscaled listens on the guest's tailnet addresses for its own peer API. Nothing reaches
    # those ports: the ingress chain drops all but HTTPS from tailscale0 (gate-loaded checks it).
    case $addr in
      100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|'[fd7a:115c:a1e0:'*)
        case $proc in *'"tailscaled"'*) tailnet=$((tailnet + 1)); continue ;; esac ;;
    esac
    bad="$bad $addr:$port"
  done < <(ss -ltnpH 2>/dev/null | awk '{print $4, $6}')
  if [ -n "$bad" ]; then record listeners fail "TCP listeners on non-loopback addresses:$bad"; else record listeners pass "$n TCP listeners: loopback, one of: $ALLOWED_PUBLIC_TCP, or tailscaled on a tailnet address ($tailnet; closed by the ingress chain)"; fi
}

# --- network gate -----------------------------------------------------------------------------

check_gate_loaded() {
  local rules bad=
  rules=$(nft list table inet projectman_gate 2>/dev/null)
  [ -n "$rules" ] || { record gate-loaded fail "table inet projectman_gate is not loaded"; return; }
  for want in 'chain worker_egress' 'chain egress' 'chain ingress' "$SERVICE_UID" "$WORKER_UID_MIN-$WORKER_UID_MAX" 'nfproto ipv6' '169.254.0.0/16' 'iifname "tailscale0"' 'tcp dport 22'; do
    printf '%s\n' "$rules" | grep -qF "$want" || bad="$bad '$want'"
  done
  [ "$(systemctl is-enabled projectman-gate 2>/dev/null)" = enabled ] || bad="$bad unit-not-enabled"
  [ "$(systemctl is-active projectman-gate 2>/dev/null)" = active ] || bad="$bad unit-not-active"
  if [ -n "$bad" ]; then record gate-loaded fail "missing in the loaded rules:$bad"; else record gate-loaded pass "table loaded for uid $SERVICE_UID and uids $WORKER_UID_MIN-$WORKER_UID_MAX; projectman-gate.service enabled and active"; fi
}

guest_private_ip() {
  ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' | head -n 1
}

guest_global_ipv6() {
  ip -6 -o addr show scope global 2>/dev/null | grep -v deprecated | awk '{print $4}' | cut -d/ -f1 | head -n 1
}

# control_probe ADDR: runs a listener on ADDR (an address of the guest that is not loopback) and
# prints one word: ok (root connects, no confined account does), nolistener, norootaccess, or
# leak:<accounts that connected>.
control_probe() {
  local addr=$1 tmp pid port w ok=1 bad=
  tmp=$(mktemp)
  timeout 20 node -e 'const s=require("net").createServer(c=>c.end()).listen(0,process.argv[1],()=>console.log(s.address().port))' "$addr" > "$tmp" 2>/dev/null &
  pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do port=$(head -n 1 "$tmp"); [ -n "$port" ] && break; sleep 0.3; done
  if [ -z "$port" ]; then kill "$pid" 2>/dev/null; rm -f "$tmp"; echo nolistener; return; fi
  root_connect "$addr" "$port" && ok=0
  for w in "$SERVICE_USER" "${WORKERS[@]}"; do tcp_connect "$w" "$addr" "$port" && bad="$bad $w"; done
  kill "$pid" 2>/dev/null; rm -f "$tmp"
  if [ "$ok" != 0 ]; then echo norootaccess
  elif [ -n "$bad" ]; then echo "leak:$bad"
  else echo ok; fi
}

check_gate_control() {
  local v4 v6 r4 r6 note
  v4=$(guest_private_ip)
  v6=$(guest_global_ipv6)
  if [ -z "$v4" ]; then record gate-control unverified "the guest has no private IPv4 address to run the control listener on"; return; fi
  r4=$(control_probe "$v4")
  if [ -n "$v6" ]; then r6=$(control_probe "$v6"); note="and on its global IPv6 address"; else r6=ok; note="; no global IPv6 address on this guest, so IPv6 was not probed here (the rules refuse all non-loopback IPv6)"; fi
  case "$r4/$r6" in
    ok/ok) record gate-control pass "root reached a listener on a private IPv4 address $note of the guest; the service and ${#WORKERS[@]} workers were refused" ;;
    *nolistener*|*norootaccess*) record gate-control fail "control failed (IPv4 $r4, IPv6 $r6): root could not use the listener, the probe proves nothing" ;;
    *) record gate-control fail "a confined account reached an address of the guest (IPv4 $r4, IPv6 $r6)" ;;
  esac
}

check_gate_blocks_host() {
  local gw gw6 ts w t p bad= n=0 v6note
  local -a targets=()
  gw=$(ip -4 route show default 2>/dev/null | awk '/default/ {print $3; exit}')
  [ -n "$gw" ] && targets+=("$gw")
  # The IPv6 gateway is link-local with a scope: fe80::1%eth0.
  gw6=$(ip -6 route show default 2>/dev/null | awk '/default/ {for (i = 1; i <= NF; i++) { if ($i == "via") g = $(i + 1); if ($i == "dev") d = $(i + 1) } print g "%" d; exit}')
  [ -n "$gw6" ] && targets+=("$gw6")
  targets+=("$METADATA_ADDRESS")
  ts=$(tailscale ip -4 2>/dev/null | head -n 1)
  [ -n "$ts" ] && targets+=("$ts")
  for t in $EXTRA_PROBE_ADDRESSES; do targets+=("$t"); done
  # A global IPv6 address of the internet, tried on HTTPS: if root reaches it, the confined accounts
  # must not (IPv6 is closed for them as a whole, so the Mac's and the LAN's global addresses are too).
  v6note="no IPv6 internet from this guest: global IPv6 not probed (the rules refuse all non-loopback IPv6)"
  if root_connect "$PROBE_IPV6_PUBLIC" 443; then targets+=("$PROBE_IPV6_PUBLIC"); v6note="global IPv6 probed (root reaches $PROBE_IPV6_PUBLIC)"; fi
  if [ -z "$gw" ] && [ -z "$gw6" ]; then record gate-blocks-host unverified "no default gateway: the host side cannot be probed"; return; fi
  for w in "$SERVICE_USER" "${WORKERS[@]}"; do
    for t in "${targets[@]}"; do
      for p in $PROBE_TCP_PORTS; do
        n=$((n + 1))
        if tcp_connect "$w" "$t" "$p"; then bad="$bad $w->$t:$p"; fi
      done
    done
  done
  if [ -n "$bad" ]; then record gate-blocks-host fail "a confined account connected:$bad"; else record gate-blocks-host pass "$n service and worker connections to the gateways (${gw:-no IPv4}, ${gw6:-no IPv6}), the metadata address, the guest's tailnet address and extra targets (${EXTRA_PROBE_ADDRESSES:-none given}) on ports $PROBE_TCP_PORTS: none connected; $v6note"; fi
}

check_egress_open() {
  local host=${EGRESS_OPEN_PROBE%:*} port=${EGRESS_OPEN_PROBE##*:}
  if [ "${#WORKERS[@]}" -gt 0 ] && tcp_connect "${WORKERS[0]}" "$host" "$port"; then record egress-open pass "${WORKERS[0]} reached $EGRESS_OPEN_PROBE"
  else record egress-open unverified "${WORKERS[0]:-no worker} could not reach $EGRESS_OPEN_PROBE (no internet from this network, or a gate that is too tight)"; fi
}

# --- service ----------------------------------------------------------------------------------

check_service_active() {
  local body
  if [ "$(systemctl is-active projectman 2>/dev/null)" != active ]; then record service-active fail "projectman.service is $(systemctl is-active projectman 2>/dev/null)"; return; fi
  body=$(curl -fsS --max-time 5 "http://127.0.0.1:$APP_PORT/api/setup" 2>/dev/null)
  case $body in
    *needsSetup*) record service-active pass "active; GET http://127.0.0.1:$APP_PORT/api/setup answers" ;;
    *) record service-active fail "active, but /api/setup on 127.0.0.1:$APP_PORT did not answer as the app" ;;
  esac
}

check_tailscale() {
  local status
  command -v tailscale >/dev/null 2>&1 || { record tailscale unverified "tailscale is not installed"; return; }
  status=$(tailscale serve status 2>&1)
  if printf '%s' "$status" | grep -qi 'funnel on'; then record tailscale fail "Funnel is on: the app would be public"
  elif printf '%s' "$status" | grep -q "127.0.0.1:$APP_PORT\|localhost:$APP_PORT"; then record tailscale pass "Serve proxies the loopback port $APP_PORT; Funnel is off"
  else record tailscale unverified "Serve is not set up for port $APP_PORT"; fi
}

check_os
check_node
check_cli claude-cli claude "$CLAUDE_CLI_VERSION"
check_cli codex-cli codex "$CODEX_CLI_VERSION"
check_app_build
check_service_account
check_workers_present
check_workers_unprivileged
check_paths_owner_mode
check_worker_denied_read
check_worker_denied_write
check_worker_isolation
check_no_credential_copies
check_proc_hidden
check_service_hardening
check_no_host_mounts
check_no_agent_forwarding
check_worker_sockets
check_listeners
check_gate_loaded
check_gate_control
check_gate_blocks_host
check_egress_open
record domain-gate unverified "not implemented: the domain-level network gate is part of PM-140"
record launcher unverified "not implemented: the protected launcher is part of PM-140; the runner still starts sessions as $SERVICE_USER"
check_service_active
check_tailscale

if [ -n "$OUT" ]; then
  emit_report "$PROFILE_NAME" "$PROFILE_VERSION" "$(. /etc/os-release && printf '%s' "$PRETTY_NAME")" "$(uname -r)" "$(uname -m)" > "$OUT"
  chmod 0644 "$OUT"
  echo "report written to $OUT" >&2
else
  emit_report "$PROFILE_NAME" "$PROFILE_VERSION" "$(. /etc/os-release && printf '%s' "$PRETTY_NAME")" "$(uname -r)" "$(uname -m)"
fi
