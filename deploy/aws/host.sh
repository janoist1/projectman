#!/usr/bin/env bash
# The Lightsail machine's side of `npm run cloud` (PM-532, PM-535, docs/AWS.md).
#
# Nothing is installed on the machine beforehand: the Mac sends this script through ssh (`sudo bash -c
# '<this file>' host.sh <subcommand> <argument…>`), as root, and sends the data a subcommand needs on the
# standard input (the unit file, cloud.env, a tar stream). Standard output is the answer; the complaints
# go to the standard error. Exit status: 0 done, 1 failed, 3 refused (the state forbids it, nothing was
# changed).
#
#   bootstrap                 install Docker, git, swap, the directories and the systemd unit (idempotent);
#                             the unit file comes on the standard input
#   receive-env               replace /etc/projectman/cloud.env with the standard input (root only, 600)
#   build <sha40> <repo-url>  fetch that commit and build projectman-cloud:<sha40> from it
#   start <sha40> [ref]       run that image under systemd and record it in deploy.json
#   stop                      stop and disable the unit, record when it stopped
#   status                    one JSON object on the standard output
#   logs <n>                  the last n journal lines of the unit
#   rehearse                  restore the replica and the snapshot into a scratch container (entrypoint.sh
#                             rehearse); the running board and the replica are not touched
#   seed-check                {"container":"running|stopped","dataEmpty":true|false}
#   seed-digest               {"databaseSha256":"<64 lowercase hex>","databaseBytes":<positive integer>}
#                             closed DB only, before the first start; no arguments or stdin payload
#   receive-data              unpack a tar stream into the empty data directory (the container must stand)
#   send-data                 write the data directory as a tar stream (the container must stand)
#   guard-check <hostname>    {"plain":"404","port":"404"}: the status codes the running board gives that hostname
#                             (the feedback guard, PM-510); refused while the board is not running
#   public-check <hostname>   {"publicBoard":b,"emailLoginEnabled":b,"needsSetup":b,"apiStatus":401,"crossOriginStatus":403}:
#                             what the running board says about itself as the public board (PM-672)
#
# The container never gets a published port, the host network, extra privileges or the Docker socket: the
# Cloudflare tunnel inside it connects outwards.
set -euo pipefail

ETC_DIR=/etc/projectman
ENV_FILE="$ETC_DIR/cloud.env"
IMAGE_ENV="$ETC_DIR/image.env"
STATE_DIR=/var/lib/projectman
DATA_DIR="$STATE_DIR/data"
DEPLOY_JSON="$STATE_DIR/deploy.json"
SRC_DIR=/opt/projectman/src
UNIT=projectman-cloud
UNIT_FILE="/etc/systemd/system/$UNIT.service"
CONTAINER=projectman-cloud
IMAGE_REPO=projectman-cloud
# The uid and gid of the `projectman` user inside the image (deploy/cloud/Dockerfile).
DATA_UID=10001
DATA_GID=10001
MIN_FREE_BYTES=$((3 * 1024 * 1024 * 1024))

die() {
  echo "host.sh: $*" >&2
  exit 1
}

refuse() {
  echo "host.sh: refused: $*" >&2
  exit 3
}

now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

check_sha() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || die "not a 40-digit commit id: ${1:-<none>}"
}

check_number() {
  [[ "${1:-}" =~ ^[0-9]{1,5}$ ]] || die "not a number: ${1:-<none>}"
}

# True while the unit or the container is running (or about to).
board_running() {
  case "$(systemctl is-active "$UNIT" 2>/dev/null || true)" in
    active | activating | reloading | deactivating) return 0 ;;
  esac
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = true ]
}

data_empty() {
  [ -z "$(ls -A "$DATA_DIR" 2>/dev/null || true)" ]
}

# deploy.json as it is, or `null` when there is none (or it is damaged).
read_deploy() {
  if [ -s "$DEPLOY_JSON" ] && jq -e . "$DEPLOY_JSON" >/dev/null 2>&1; then
    cat "$DEPLOY_JSON"
  else
    echo null
  fi
}

# write_deploy <sha|""> <ref> <lastStoppedAt|"">: the new current image (the old one becomes the previous
# one unless it is the same), written in one step.
write_deploy() {
  local sha=$1 ref=$2 stopped=$3 old tmp
  old=$(read_deploy)
  tmp=$(mktemp "$STATE_DIR/.deploy.json.XXXXXX")
  jq -n --argjson old "$old" --arg sha "$sha" --arg ref "$ref" --arg at "$(now)" --arg stopped "$stopped" '
    ($old.current // null) as $current |
    ($old.previous // null) as $previous |
    {
      current: (if $sha == "" then $current else { sha: $sha, ref: $ref, at: $at } end),
      previous: (if $sha != "" and $current != null and $current.sha != $sha then $current else $previous end),
      lastStoppedAt: (if $stopped == "" then null else $stopped end)
    }' >"$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$DEPLOY_JSON"
}

last_stopped_at() {
  read_deploy | jq -r '.lastStoppedAt // empty'
}

bootstrap() {
  export DEBIAN_FRONTEND=noninteractive
  local missing=() package
  for package in docker.io docker-buildx git jq unattended-upgrades; do
    dpkg -s "$package" >/dev/null 2>&1 || missing+=("$package")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends "${missing[@]}"
  fi
  systemctl enable --now docker >/dev/null

  # (no `grep -q` in a pipe: pipefail would count the SIGPIPE it can cause)
  if ! swapon --show=NAME --noheadings | grep -x /swapfile >/dev/null; then
    if [ ! -f /swapfile ]; then
      fallocate -l 2G /swapfile
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
    fi
    swapon /swapfile
  fi
  grep -qs '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab

  install -d -m 700 "$ETC_DIR"
  # The data directory belongs to the image's user once data is in it: only the mode is set here.
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"

  [ ! -t 0 ] || die "bootstrap needs the unit file on the standard input"
  local tmp
  tmp=$(mktemp "$ETC_DIR/.unit.XXXXXX")
  cat >"$tmp"
  grep -q '^\[Service\]' "$tmp" || {
    rm -f "$tmp"
    die "the standard input is not a systemd unit"
  }
  chmod 644 "$tmp"
  mv "$tmp" "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable "$UNIT" >/dev/null 2>&1
  echo "bootstrap done: $(docker --version)"
}

receive_env() {
  [ ! -t 0 ] || die "receive-env needs cloud.env on the standard input"
  install -d -m 700 "$ETC_DIR"
  local tmp="$ETC_DIR/.cloud.env.new"
  rm -f "$tmp"
  install -m 600 -o root -g root /dev/stdin "$tmp"
  if [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    die "cloud.env came empty"
  fi
  mv "$tmp" "$ENV_FILE"
  echo "cloud.env received"
}

build() {
  local sha=${1:-} url=${2:-}
  check_sha "$sha"
  [[ "$url" =~ ^https://[A-Za-z0-9._~:/@%+-]+$ ]] || die "not an https repository URL: $url"
  local free
  free=$(df -B1 --output=avail "$STATE_DIR" | tail -n 1 | tr -d ' ')
  [ "$free" -ge "$MIN_FREE_BYTES" ] || refuse "less than 3 GiB free on the disk; free some (docker system prune)"

  export GIT_TERMINAL_PROMPT=0
  mkdir -p "$(dirname "$SRC_DIR")"
  [ -d "$SRC_DIR/.git" ] || git init -q "$SRC_DIR"
  cd "$SRC_DIR"
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$url"
  else
    git remote add origin "$url"
  fi
  git fetch --quiet --tags --force origin
  git cat-file -e "$sha^{commit}" 2>/dev/null || git fetch --quiet origin "$sha" || true
  git cat-file -e "$sha^{commit}" 2>/dev/null || die "the commit $sha is not in $url"
  git checkout --quiet --detach --force "$sha"
  git clean -ffdxq
  [ "$(git rev-parse HEAD)" = "$sha" ] || die "the checkout is not at $sha"

  docker build --progress=plain -f deploy/cloud/Dockerfile --build-arg PROJECTMAN_VERSION="$sha" -t "$IMAGE_REPO:$sha" .
  prune_images "$sha"
  echo "built $IMAGE_REPO:$sha"
}

# Keeps the new image and the current and previous ones of deploy.json (a rollback needs them); the other
# images and the build cache beyond 2 GB go.
prune_images() {
  local keep=" $1 " deploy tag field sha
  deploy=$(read_deploy)
  for field in current previous; do
    sha=$(jq -r ".$field.sha // empty" <<<"$deploy")
    [ -z "$sha" ] || keep="$keep$sha "
  done
  while read -r tag; do
    case "$keep" in *" $tag "*) continue ;; esac
    docker image rm "$IMAGE_REPO:$tag" >/dev/null 2>&1 || true
  done < <(docker image ls "$IMAGE_REPO" --format '{{.Tag}}')
  docker image prune --force >/dev/null
  docker builder prune --force --keep-storage 2GB >/dev/null
}

start() {
  local sha=${1:-} ref=${2:-}
  check_sha "$sha"
  [ -n "$ref" ] || ref=$sha
  [[ "$ref" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || die "not a usable ref name: $ref"
  docker image inspect "$IMAGE_REPO:$sha" >/dev/null 2>&1 || die "the image $IMAGE_REPO:$sha is not built"
  [ -s "$ENV_FILE" ] || die "$ENV_FILE is missing (receive-env first)"

  # The old container's stop time is what a Litestream point-in-time restore needs after a failed migration.
  local stopped
  stopped=$(last_stopped_at)
  if board_running; then
    systemctl stop "$UNIT"
    stopped=$(now)
  fi
  printf 'IMAGE=%s:%s\n' "$IMAGE_REPO" "$sha" >"$IMAGE_ENV"
  chmod 644 "$IMAGE_ENV"
  write_deploy "$sha" "$ref" "$stopped"
  systemctl enable "$UNIT" >/dev/null 2>&1
  systemctl start "$UNIT"
  echo "started $IMAGE_REPO:$sha"
}

stop() {
  local stopped=""
  if board_running; then
    stopped=1
  fi
  systemctl stop "$UNIT"
  systemctl disable "$UNIT" >/dev/null 2>&1 || true
  if [ -n "$stopped" ]; then
    write_deploy "" "" "$(now)"
  fi
  echo "stopped"
}

status() {
  local unit container=absent health=none image="" deploy data_bytes=0 free_bytes=0
  local mem_total mem_available swap_total swap_used
  unit=$(systemctl is-active "$UNIT" 2>/dev/null || true)
  [ -n "$unit" ] || unit=unknown
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    container=$(docker inspect -f '{{.State.Status}}' "$CONTAINER")
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")
    image=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")
  fi
  deploy=$(read_deploy)
  if [ -d "$DATA_DIR" ]; then
    data_bytes=$(du -sb "$DATA_DIR" | cut -f1)
  fi
  free_bytes=$(df -B1 --output=avail "$STATE_DIR" | tail -n 1 | tr -d ' ')
  read -r mem_total mem_available < <(free -b | awk '/^Mem:/ { print $2, $7 }')
  read -r swap_total swap_used < <(free -b | awk '/^Swap:/ { print $2, $3 }')
  jq -n --arg unit "$unit" --arg container "$container" --arg health "$health" --arg image "$image" \
    --argjson deploy "$deploy" --argjson dataBytes "${data_bytes:-0}" --argjson freeBytes "${free_bytes:-0}" \
    --argjson total "${mem_total:-0}" --argjson available "${mem_available:-0}" \
    --argjson swapTotal "${swap_total:-0}" --argjson swapUsed "${swap_used:-0}" '{
      unit: $unit,
      container: $container,
      health: $health,
      image: $image,
      deploy: $deploy,
      disk: { dataBytes: $dataBytes, freeBytes: $freeBytes },
      memory: { totalBytes: $total, availableBytes: $available, swapTotalBytes: $swapTotal, swapUsedBytes: $swapUsed }
    }'
}

logs() {
  local lines=${1:-200}
  check_number "$lines"
  journalctl -u "$UNIT" -n "$lines" --no-pager
}

rehearse() {
  local image
  image=$( (sed -n 's/^IMAGE=//p' "$IMAGE_ENV" 2>/dev/null || true) | tail -n 1)
  [ -n "$image" ] || refuse "no image has been started yet"
  [ -s "$ENV_FILE" ] || refuse "$ENV_FILE is missing"
  docker run --rm --env-file "$ENV_FILE" -e REHEARSAL_PORT=4701 "$image" rehearse
}

seed_check() {
  local running=stopped empty=true
  if board_running; then running=running; fi
  data_empty || empty=false
  printf '{"container":"%s","dataEmpty":%s}\n' "$running" "$empty"
}

seed_database_closed() {
  board_running && refuse "the board is running or starting; seed-digest requires it stopped"
  local database="$DATA_DIR/db.sqlite" suffix
  [ -f "$database" ] && [ ! -L "$database" ] || refuse "db.sqlite must be a regular file, not a symlink"
  for suffix in -wal -shm -journal; do
    [ ! -e "$database$suffix" ] && [ ! -L "$database$suffix" ] || refuse "db.sqlite$suffix is present"
  done
}

# Ubuntu 24.04 coreutils; metadata includes nanosecond modification/change times and inode identity.
# No SQLite connection, migration, container start or persistent state is involved.
seed_digest() {
  [ "$#" -eq 0 ] || die "seed-digest takes no arguments"
  seed_database_closed
  local database="$DATA_DIR/db.sqlite" before after bytes digest
  before=$(stat -c '%d:%i:%s:%y:%z' -- "$database")
  bytes=$(stat -c '%s' -- "$database")
  [[ "$bytes" =~ ^[0-9]+$ ]] && [ "$bytes" -gt 0 ] && [ "$bytes" -le 9007199254740991 ] || die "invalid database size"
  digest=$(sha256sum -- "$database")
  digest=${digest%% *}
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "invalid database digest"
  after=$(stat -c '%d:%i:%s:%y:%z' -- "$database")
  [ "$before" = "$after" ] || die "database changed during hashing"
  seed_database_closed
  printf '{"databaseSha256":"%s","databaseBytes":%s}\n' "$digest" "$bytes"
}

# What the running board answers an unknown hostname (the feedback hostname's guard, PM-510): the status
# code of /api/setup with `Host: <name>` and with `Host: <name>:443`; both must be 404 (`npm run cloud --
# publish --feedback` refuses otherwise). Nothing leaves the machine: the request goes to the port inside
# the container.
guard_check() {
  local name=${1:-} plain port
  [[ "$name" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "not a hostname: ${name:-<none>}"
  board_running || refuse "the board is not running; deploy it before the guard can be checked"
  plain=$(docker exec "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -H "Host: $name" http://127.0.0.1:4700/api/setup || true)
  port=$(docker exec "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' -H "Host: $name:443" http://127.0.0.1:4700/api/setup || true)
  [[ "$plain" =~ ^[0-9]{3}$ ]] || plain=000
  [[ "$port" =~ ^[0-9]{3}$ ]] || port=000
  printf '{"plain":"%s","port":"%s"}\n' "$plain" "$port"
}

# What the running board says about itself as the public board (PM-672), with `Host: <name>`, from inside the
# container (nothing leaves the machine): the capabilities of GET /api/setup (a missing one is false), the status
# of an anonymous GET /api/auth/me, and of a POST /api/auth/login from a foreign Origin. `publish` allows a public
# board only on true,true,false,401,403 (docs/AWS.md "Public board").
public_check() {
  local name=${1:-} setup api cross board=false email=false needs=false
  [[ "$name" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "not a hostname: ${name:-<none>}"
  board_running || refuse "the board is not running; deploy it before the public board can be checked"
  setup=$(docker exec "$CONTAINER" curl -s --max-time 10 -H "Host: $name" http://127.0.0.1:4700/api/setup || true)
  api=$(docker exec "$CONTAINER" curl -s --max-time 10 -o /dev/null -w '%{http_code}' -H "Host: $name" http://127.0.0.1:4700/api/auth/me || true)
  cross=$(docker exec "$CONTAINER" curl -s --max-time 10 -o /dev/null -w '%{http_code}' -X POST -H "Host: $name" \
    -H 'Origin: https://foreign.invalid' -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:4700/api/auth/login || true)
  [[ "$setup" == *'"publicBoard":true'* ]] && board=true
  [[ "$setup" == *'"emailLoginEnabled":true'* ]] && email=true
  [[ "$setup" == *'"needsSetup":true'* ]] && needs=true
  [[ "$api" =~ ^[0-9]{3}$ ]] || api=000
  [[ "$cross" =~ ^[0-9]{3}$ ]] || cross=000
  printf '{"publicBoard":%s,"emailLoginEnabled":%s,"needsSetup":%s,"apiStatus":%s,"crossOriginStatus":%s}\n' \
    "$board" "$email" "$needs" "$((10#$api))" "$((10#$cross))"
}

receive_data() {
  [ ! -t 0 ] || die "receive-data needs a tar stream on the standard input"
  board_running && refuse "the board is running; a seed goes in before the first start"
  data_empty || refuse "$DATA_DIR is not empty"
  mkdir -p "$DATA_DIR"
  if ! tar -x -f - -C "$DATA_DIR" --no-same-owner; then
    # It was empty when we began, so emptying it again loses nothing.
    find "$DATA_DIR" -mindepth 1 -delete
    die "the tar stream could not be unpacked; the data directory is empty again"
  fi
  chown -R "$DATA_UID:$DATA_GID" "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  echo "data received"
}

send_data() {
  board_running && refuse "the board is running; stop it first (a copy of a live database is no copy)"
  [ -d "$DATA_DIR" ] || die "$DATA_DIR does not exist"
  tar -c -f - -C "$DATA_DIR" .
}

main() {
  [ "$(id -u)" = 0 ] || die "run it as root (sudo)"
  local subcommand=${1:-}
  shift || true
  case "$subcommand" in
    bootstrap) bootstrap ;;
    receive-env) receive_env ;;
    build) build "$@" ;;
    start) start "$@" ;;
    stop) stop ;;
    status) status ;;
    logs) logs "$@" ;;
    rehearse) rehearse ;;
    seed-check) seed_check ;;
    seed-digest) seed_digest "$@" ;;
    receive-data) receive_data ;;
    send-data) send_data ;;
    guard-check) guard_check "$@" ;;
    public-check) public_check "$@" ;;
    *) die "usage: host.sh bootstrap|receive-env|build|start|stop|status|logs|rehearse|seed-check|seed-digest|receive-data|send-data|guard-check|public-check" ;;
  esac
}

main "$@"
