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
#   receive-data              unpack a tar stream into the empty data directory (the container must stand)
#   send-data                 write the data directory as a tar stream (the container must stand)
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
    receive-data) receive_data ;;
    send-data) send_data ;;
    *) die "usage: host.sh bootstrap|receive-env|build|start|stop|status|logs|rehearse|seed-check|receive-data|send-data" ;;
  esac
}

main "$@"
