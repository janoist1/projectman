#!/usr/bin/env bash
# The container's entrypoint (PM-317, docs/HYBRID.md).
#
#   entrypoint.sh serve      restore what a fresh volume lacks, then run the server, Litestream, the
#                            Cloudflare tunnel and the restic backup loop (the default)
#   entrypoint.sh rehearse   restore the replica and the restic snapshot into a scratch directory and
#                            start a standby copy on the loopback, with no tunnel and no replication;
#                            proves a restore works without touching the production replica
#
# Every process is started in a cleared environment (env -i) with only the variables it needs, so the
# server's environment holds no tunnel token, storage key or restic password. That filters the
# environment only: all processes share one uid, so a compromised server could still read the others'
# /proc/<pid>/environ (docs/HYBRID.md, "Processes"). A process exiting stops the rest, and the platform
# restarts the container.
set -euo pipefail

APP_DIR=/app
DATA_DIR="${PROJECTMAN_HOME:-/data}"
RUN_UID=10001
RUN_GID=10001
SERVER_PORT="${PORT:-4700}"

# Phase 1, as root: the volume is mounted root-owned. Hand it to the unprivileged user and drop to it.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR")" != "$RUN_UID" ]; then chown -R "$RUN_UID:$RUN_GID" "$DATA_DIR"; fi
  chmod 700 "$DATA_DIR"
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups --no-new-privs "$0" "$@"
fi

base_env=(PATH="$PATH" HOME="${HOME:-/home/projectman}" TZ="${TZ:-UTC}" LANG=C.UTF-8)

require() {
  local missing=0 name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      echo "entrypoint: $name is not set" >&2
      missing=1
    fi
  done
  if [ "$missing" != 0 ]; then exit 64; fi
}

# The allowlisted environment of one process: the variables whose names match a pattern, and nothing else.
load_env() { # load_env <array name> <name pattern>...
  local -n collected=$1
  shift
  collected=()
  local name pattern
  while IFS= read -r name; do
    for pattern in "$@"; do
      # shellcheck disable=SC2053
      if [[ $name == $pattern ]]; then
        collected+=("$name=${!name}")
        break
      fi
    done
  done < <(compgen -e)
}

load_env server_env 'PROJECTMAN_*' NODE_ENV HOST PORT LOG_LEVEL
load_env litestream_env 'LITESTREAM_*'
load_env restic_env 'RESTIC_*'

restic_run() { env -i "${base_env[@]}" PROJECTMAN_HOME="$DATA_DIR" "${restic_env[@]}" "$APP_DIR/deploy/cloud/backup.sh" "$@"; }
litestream_run() { env -i "${base_env[@]}" PROJECTMAN_HOME="$DATA_DIR" "${litestream_env[@]}" litestream "$@"; }

require_storage() {
  require LITESTREAM_BUCKET LITESTREAM_ENDPOINT LITESTREAM_REGION LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY \
    RESTIC_REPOSITORY RESTIC_PASSWORD RESTIC_ACCESS_KEY_ID RESTIC_SECRET_ACCESS_KEY
}

# Fills a home that lacks its state: the files from restic (a fresh volume only: the marker file is
# written once a home has been set up or restored), then the database from the replica. Any error stops
# the start: a server that comes up empty beside an unreadable backup would replicate over it.
restore_state() { # restore_state <home> <write marker: yes|no>
  local home=$1 marker=$1/.cloud-volume
  mkdir -p "$home"
  if [ ! -e "$marker" ]; then
    echo "entrypoint: a fresh volume: restoring the files from the restic repository, if there is one"
    restic_run restore "$home"
  fi
  if [ ! -e "$home/db.sqlite" ]; then
    echo "entrypoint: restoring the database from the Litestream replica, if there is one"
    litestream_run restore -config "$APP_DIR/deploy/cloud/litestream.yml" -if-db-not-exists -if-replica-exists \
      -o "$home/db.sqlite" "$DATA_DIR/db.sqlite"
  fi
  if [ "$2" = yes ]; then date -u +%Y-%m-%dT%H:%M:%SZ >"$marker"; fi
}

start_server() { # start_server <home> <port> [extra NAME=value...]; sets server_pid
  local home=$1 port=$2
  shift 2
  env -i "${base_env[@]}" "${server_env[@]}" PROJECTMAN_HOME="$home" PORT="$port" HOST=127.0.0.1 PROJECTMAN_MODE=cloud "$@" \
    node "$APP_DIR/apps/server/dist/index.js" &
  server_pid=$!
}

wait_for_server() { # wait_for_server <port>
  local attempt
  for attempt in $(seq 1 90); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$1/api/setup" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "entrypoint: the server exited while starting" >&2
      return 1
    fi
    sleep 1
  done
  echo "entrypoint: the server did not answer on port $1 in 90 seconds" >&2
  return 1
}

server_pid='' litestream_pid='' tunnel_pid='' backup_pid=''

terminate() {
  trap - TERM INT
  local pid
  # No new requests first, then the server (its graceful stop), then Litestream, to ship the last writes.
  for pid in "$backup_pid" "$tunnel_pid"; do
    if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  if [ -n "$server_pid" ]; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ -n "$litestream_pid" ]; then
    kill -TERM "$litestream_pid" 2>/dev/null || true
    wait "$litestream_pid" 2>/dev/null || true
  fi
}

serve() {
  require TUNNEL_TOKEN
  require_storage
  restore_state "$DATA_DIR" yes

  trap 'terminate; exit 143' TERM INT

  env -i "${base_env[@]}" PROJECTMAN_HOME="$DATA_DIR" "${litestream_env[@]}" \
    litestream replicate -config "$APP_DIR/deploy/cloud/litestream.yml" &
  litestream_pid=$!

  start_server "$DATA_DIR" "$SERVER_PORT"
  wait_for_server "$SERVER_PORT"

  # The tunnel opens only once the server answers. The origin is set in the Cloudflare dashboard
  # (http://127.0.0.1:4700) and must NOT override the Host header: a loopback Host would make a remote
  # request look local to the server.
  env -i "${base_env[@]}" TUNNEL_TOKEN="$TUNNEL_TOKEN" \
    cloudflared tunnel --no-autoupdate run &
  tunnel_pid=$!

  (
    interval="${BACKUP_INTERVAL_SECONDS:-21600}"
    sleep "${BACKUP_FIRST_DELAY_SECONDS:-300}"
    while true; do
      restic_run backup || echo "entrypoint: the restic backup failed; the next try is in ${interval}s" >&2
      sleep "$interval"
    done
  ) &
  backup_pid=$!

  local status=0
  wait -n || status=$?
  echo "entrypoint: a process exited (status $status); stopping the others" >&2
  terminate
  if [ "$status" = 0 ]; then exit 1; fi
  exit "$status"
}

rehearse() {
  require_storage
  local scratch="${REHEARSAL_DIR:-$(mktemp -d)}"
  local port="${REHEARSAL_PORT:-4701}"
  echo "entrypoint: rehearsal in $scratch (no tunnel, no replication, a standby copy)"
  restore_state "$scratch" no
  if [ ! -e "$scratch/db.sqlite" ]; then
    echo "entrypoint: REHEARSAL FAILED: there is no database in the replica" >&2
    exit 3
  fi
  # A standby copy starts no sessions (PM-143).
  printf '{"version":1,"role":"standby","reason":"restore rehearsal","setAt":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$scratch/instance.json"
  chmod 600 "$scratch/instance.json"

  trap 'terminate; exit 143' TERM INT
  start_server "$scratch" "$port"
  wait_for_server "$port"
  "$APP_DIR/deploy/cloud/smoke.sh" "http://127.0.0.1:$port" || {
    terminate
    exit 1
  }
  terminate
  echo "entrypoint: REHEARSAL PASSED: the replica and the snapshot restored and the server started on them"
}

case "${1:-serve}" in
  serve) serve ;;
  rehearse) rehearse ;;
  *)
    echo "usage: entrypoint.sh serve | rehearse" >&2
    exit 64
    ;;
esac
