#!/usr/bin/env bash
# Builds the managed VM profile (PM-137) on a clean Ubuntu Server guest, as root. Idempotent.
#
#   sudo deploy/vm/bootstrap.sh --workers "dev codex qa" [--admin-user ubuntu]
#
# What it does: installs the pinned Node and CLI versions into root-owned places; creates the
# service account, one unprivileged account per worker and the protected directories; limits
# ssh to the admin (no agent forwarding, no password); loads the system-managed egress rules;
# hides other accounts' processes; masks snapd (a world-writable control socket); installs the
# service unit. What it does NOT do, because only a person may: log in to the provider
# subscriptions, create the first owner, set up Tailscale, or give any account a token. See
# docs/VM.md for those steps. The app itself is installed by install-app.sh.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
PROFILE_SRC=${PROFILE:-$here/profile.env}
WORKERS_ARG=
ADMIN_USER=${SUDO_USER:-}

while [ $# -gt 0 ]; do
  case $1 in
    --workers) WORKERS_ARG=${2:?--workers needs a blank-separated list of member handles}; shift 2 ;;
    --admin-user) ADMIN_USER=${2:?--admin-user needs a name}; shift 2 ;;
    *) echo "usage: bootstrap.sh --workers \"handle ...\" [--admin-user USER]" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "bootstrap.sh must run as root" >&2; exit 2; }
[ -n "$WORKERS_ARG" ] || { echo "--workers is required (at least two member handles)" >&2; exit 2; }
[ -n "$ADMIN_USER" ] && id "$ADMIN_USER" >/dev/null 2>&1 || { echo "--admin-user must name an existing account (the one you log in with)" >&2; exit 2; }
[ "$ADMIN_USER" != root ] || { echo "the admin must not be root" >&2; exit 2; }

# shellcheck source=profile.env
. "$PROFILE_SRC"
umask 022
export DEBIAN_FRONTEND=noninteractive

log() { printf '== %s\n' "$*"; }

# --- the machine must be what the profile pins ----------------------------------------------
got=$(. /etc/os-release && printf '%s %s' "$ID" "$VERSION_ID")
[ "$got" = "$OS_ID $OS_VERSION_ID" ] || { echo "this profile pins $OS_ID $OS_VERSION_ID, found $got" >&2; exit 1; }

# --- packages ---------------------------------------------------------------------------------
log "packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git build-essential python3 make g++ \
  nftables acl xz-utils iproute2 util-linux procps passwd openssh-server psmisc coreutils

# --- Node (pinned major; tarball checked against nodejs.org's SHASUMS256.txt) ---------------------
log "node"
case $(uname -m) in x86_64) node_arch=x64 ;; aarch64) node_arch=arm64 ;; *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;; esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -n "$NODE_VERSION" ]; then
  node_dir=https://nodejs.org/dist/v$NODE_VERSION
else
  curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt" -o "$work/latest.txt"
  NODE_VERSION=$(grep -Eo "node-v$NODE_MAJOR\.[0-9]+\.[0-9]+-linux-$node_arch\.tar\.xz" "$work/latest.txt" | head -n 1 | sed 's/^node-v//; s/-linux.*//')
  [ -n "$NODE_VERSION" ] || { echo "could not resolve the newest Node $NODE_MAJOR release" >&2; exit 1; }
  node_dir=https://nodejs.org/dist/v$NODE_VERSION
fi
if [ ! -x "/opt/node-v$NODE_VERSION/bin/node" ]; then
  tarball=node-v$NODE_VERSION-linux-$node_arch.tar.xz
  curl -fsSL "$node_dir/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  curl -fsSL "$node_dir/$tarball" -o "$work/$tarball"
  (cd "$work" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$work/$tarball" -C /opt
  mv "/opt/node-v$NODE_VERSION-linux-$node_arch" "/opt/node-v$NODE_VERSION"
  chown -R root:root "/opt/node-v$NODE_VERSION"
fi
for bin in node npm npx; do ln -sfn "/opt/node-v$NODE_VERSION/bin/$bin" "/usr/local/bin/$bin"; done
node_found=$(/usr/local/bin/node --version | sed 's/^v//')
[ "${node_found%%.*}" = "$NODE_MAJOR" ] || { echo "node $node_found is not major $NODE_MAJOR" >&2; exit 1; }

# --- accounts ---------------------------------------------------------------------------------
log "accounts"
if ! getent passwd "$SERVICE_USER" >/dev/null; then
  groupadd --gid "$SERVICE_UID" "$SERVICE_USER"
  useradd --uid "$SERVICE_UID" --gid "$SERVICE_USER" --create-home --home-dir "$SERVICE_HOME" --shell /bin/bash "$SERVICE_USER"
fi
[ "$(id -u "$SERVICE_USER")" = "$SERVICE_UID" ] || { echo "$SERVICE_USER exists with another uid than $SERVICE_UID" >&2; exit 1; }
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$SERVICE_HOME" "$PROJECTMAN_HOME"

install -d -o root -g root -m 0755 "$WORKER_HOME_ROOT" "$CONFIG_DIR" "$STATE_DIR" "$APP_DIR" "$SPOOL_ROOT"

next_uid() {
  local uid=$WORKER_UID_MIN
  while getent passwd "$uid" >/dev/null || getent group "$uid" >/dev/null; do uid=$((uid + 1)); done
  [ "$uid" -le "$WORKER_UID_MAX" ] || { echo "the worker uid range $WORKER_UID_MIN-$WORKER_UID_MAX is full" >&2; exit 1; }
  echo "$uid"
}

count=0
for handle in $WORKERS_ARG; do
  case $handle in
    *[!a-z0-9-]*|-*|'') echo "bad member handle: $handle" >&2; exit 1 ;;
  esac
  name=$WORKER_PREFIX$handle
  [ "${#name}" -le 32 ] || { echo "account name $name is longer than 32 characters" >&2; exit 1; }
  if ! getent passwd "$name" >/dev/null; then
    uid=$(next_uid)
    groupadd --gid "$uid" "$name"
    # nologin: sessions are started by the launcher with runuser/setpriv, never through a login.
    useradd --uid "$uid" --gid "$name" --no-create-home --home-dir "$WORKER_HOME_ROOT/$name" --shell /usr/sbin/nologin "$name"
  fi
  # The group is the worker's alone; the service joins it (read-only below) to read the transcripts
  # the CLIs write in the worker's home. A worker is in no other group.
  install -d -o "$name" -g "$name" -m 0750 "$WORKER_HOME_ROOT/$name"
  usermod -aG "$name" "$SERVICE_USER"
  # Hand-over bundles (PM-140): `in` is the service's to write and the worker's to read (set-group-id,
  # so each bundle is in the worker's group); `out` the reverse. Nothing else crosses accounts.
  install -d -o root -g root -m 0755 "$SPOOL_ROOT/$handle"
  install -d -o "$SERVICE_USER" -g "$name" -m 2750 "$SPOOL_ROOT/$handle/in"
  install -d -o "$name" -g "$name" -m 0750 "$SPOOL_ROOT/$handle/out"
  count=$((count + 1))
done
[ "$count" -ge 2 ] || { echo "at least two workers are needed to measure the isolation between them" >&2; exit 2; }

# --- the pinned CLIs, in a root-owned prefix --------------------------------------------------
log "cli"
install -d -o root -g root -m 0755 "$CLI_PREFIX"
HOME=/root PATH=/usr/local/bin:/usr/bin:/bin npm install -g --prefix "$CLI_PREFIX" --no-audit --no-fund \
  "@anthropic-ai/claude-code@$CLAUDE_CLI_VERSION" "@openai/codex@$CODEX_CLI_VERSION"
chown -R root:root "$CLI_PREFIX"
chmod -R go-w "$CLI_PREFIX"

# --- ssh: the admin only, no agent forwarding, no password ------------------------------------
log "sshd"
cat > /etc/ssh/sshd_config.d/10-projectman.conf <<EOF
# Managed by projectman bootstrap.sh (PM-137). The first value of a keyword wins, hence 10-.
AllowUsers $ADMIN_USER
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
# Local forwarding stays: the Mac reaches the app through ssh -L.
AllowTcpForwarding local
EOF
if sshd -t; then systemctl reload ssh 2>/dev/null || systemctl reload sshd; else rm -f /etc/ssh/sshd_config.d/10-projectman.conf; echo "sshd rejected the drop-in, removed it" >&2; exit 1; fi

# --- snapd: a world-writable control socket the profile does not need ---------------------------
systemctl disable --now snapd.socket snapd.service >/dev/null 2>&1 || true
systemctl mask snapd.socket snapd.service >/dev/null 2>&1 || true

# --- processes of other accounts are invisible to the workers ---------------------------------
log "procfs hidepid"
getent group "$PROC_GROUP" >/dev/null || groupadd --system "$PROC_GROUP"
proc_gid=$(getent group "$PROC_GROUP" | cut -d: -f3)
install -d -m 0755 /etc/systemd/system/systemd-logind.service.d
printf '[Service]\nSupplementaryGroups=%s\n' "$PROC_GROUP" > /etc/systemd/system/systemd-logind.service.d/projectman-proc.conf
grep -v '^proc[[:space:]]\+/proc[[:space:]]' /etc/fstab > "$work/fstab" || true
printf 'proc /proc proc defaults,hidepid=2,gid=%s 0 0\n' "$proc_gid" >> "$work/fstab"
cat "$work/fstab" > /etc/fstab
systemctl daemon-reload
# logind first, so it already holds the group when procfs starts hiding processes from it.
systemctl restart systemd-logind
mount -o "remount,hidepid=2,gid=$proc_gid" /proc

# --- configuration and units, all root's ------------------------------------------------------
log "gate and service unit"
install -m 0644 -o root -g root "$PROFILE_SRC" "$CONFIG_DIR/profile.env"
install -m 0644 -o root -g root "$here/projectman-gate.nft" "$CONFIG_DIR/gate.nft"
# tailscaled makes its LocalAPI socket world-writable (0666) in /run/tailscale (0755): any account
# could read the tailnet's peers and addresses through it. The directory becomes root's alone;
# `sudo tailscale ...` keeps working. The drop-in is harmless before Tailscale is installed.
install -d -m 0755 /etc/systemd/system/tailscaled.service.d
printf '[Service]\nRuntimeDirectoryMode=0700\n' > /etc/systemd/system/tailscaled.service.d/projectman.conf
chmod 0644 /etc/systemd/system/tailscaled.service.d/projectman.conf
install -m 0644 -o root -g root "$here/projectman-gate.service" /etc/systemd/system/projectman-gate.service
install -m 0644 -o root -g root "$here/../projectman.service" /etc/systemd/system/projectman.service

# --- the VM boundary (PM-140): its configuration, the launcher and the readiness timer ----------
log "boundary"
base_json=
for destination in $EGRESS_BASE; do
  printf '%s' "$destination" | grep -Eq '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?:[0-9]{1,5}$' \
    || { echo "bad EGRESS_BASE entry (want host:port): $destination" >&2; exit 1; }
  base_json="$base_json{\"host\":\"${destination%:*}\",\"port\":${destination##*:}},"
done
cat > "$work/boundary.json" <<EOF
{
  "schemaVersion": 1,
  "profile": "$PROFILE_NAME",
  "profileVersion": $PROFILE_VERSION,
  "serviceUser": "$SERVICE_USER",
  "launcher": { "socket": "$LAUNCHER_SOCKET", "maxSessions": $LAUNCHER_MAX_SESSIONS },
  "workers": {
    "prefix": "$WORKER_PREFIX",
    "homeRoot": "$WORKER_HOME_ROOT",
    "uidMin": $WORKER_UID_MIN,
    "uidMax": $WORKER_UID_MAX,
    "spoolRoot": "$SPOOL_ROOT"
  },
  "programs": {
    "git": "/usr/bin/git",
    "mkdir": "/usr/bin/mkdir",
    "rm": "/usr/bin/rm",
    "mv": "/usr/bin/mv",
    "claude": "$CLI_PREFIX/bin/claude",
    "codex": "$CLI_PREFIX/bin/codex",
    "node": "/usr/local/bin/node"
  },
  "appDir": "$APP_DIR",
  "bridgeRoot": "/run/$BRIDGE_DIR",
  "systemdRun": "/usr/bin/systemd-run",
  "systemctl": "/usr/bin/systemctl",
  "workerPath": "$CLI_PREFIX/bin:/usr/local/bin:/usr/bin:/bin",
  "egress": { "host": "127.0.0.1", "port": $EGRESS_PORT, "grantHours": $EGRESS_GRANT_HOURS, "base": [${base_json%,}] },
  "readiness": { "report": "$STATE_DIR/readiness.json", "maxAgeSeconds": $READINESS_MAX_AGE_SECONDS },
  "appPort": $APP_PORT
}
EOF
# Well-formed JSON at least; the server and the launcher check it against their schema at start.
/usr/local/bin/node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$work/boundary.json" \
  || { echo "the generated boundary configuration is not valid JSON" >&2; exit 1; }
install -m 0644 -o root -g root "$work/boundary.json" "$BOUNDARY_CONFIG"
for unit in projectman-launcher.socket projectman-launcher.service projectman-verify.service projectman-verify.timer; do
  install -m 0644 -o root -g root "$here/$unit" "/etc/systemd/system/$unit"
done
# The service runs behind the boundary: sessions only through the launcher, workspaces per member.
install -d -m 0755 /etc/systemd/system/projectman.service.d
cat > /etc/systemd/system/projectman.service.d/boundary.conf <<EOF
# Managed by projectman bootstrap.sh (PM-140).
[Unit]
Wants=projectman-launcher.socket
After=projectman-launcher.socket

[Service]
Environment=PROJECTMAN_BOUNDARY_CONFIG=$BOUNDARY_CONFIG
Environment=PROJECTMAN_WORKSPACES=member
# The members' bridge sockets: /run/$BRIDGE_DIR/<handle>/{app,egress}.sock, made by the service.
RuntimeDirectory=$BRIDGE_DIR
RuntimeDirectoryMode=0755
EOF
chmod 0644 /etc/systemd/system/projectman.service.d/boundary.conf

nft -c -f "$CONFIG_DIR/gate.nft"
systemctl daemon-reload
systemctl enable projectman-gate >/dev/null
systemctl restart projectman-gate
systemctl enable --now projectman-launcher.socket >/dev/null
systemctl enable projectman-launcher.service >/dev/null
systemctl enable --now projectman-verify.timer >/dev/null
systemctl enable projectman >/dev/null
# If Tailscale was installed before this run, restart it so the directory mode applies.
if systemctl cat tailscaled >/dev/null 2>&1; then systemctl restart tailscaled; fi

log "done"
cat <<EOF
Bootstrap finished: node $node_found, $count workers, egress gate, launcher socket and readiness timer.
Next (docs/VM.md): install-app.sh, the subscription logins, the first owner over the ssh forward,
then 'sudo bash $APP_DIR/deploy/vm/verify.sh --out $STATE_DIR/readiness.json'.
EOF
