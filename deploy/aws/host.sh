#!/usr/bin/env bash
# The Lightsail machine's side of `npm run cloud` (PM-532, PM-535, docs/AWS.md).
#
# Nothing is installed on the machine beforehand: the Mac sends this script through ssh (`sudo bash -c
# '<this file>' host.sh <subcommand> <argument…>`), as root, and sends the data a subcommand needs on the
# standard input (the unit file, cloud.env, a tar stream). Standard output is the answer; the complaints
# go to the standard error. Exit status: 0 done, 1 failed, 3 refused (the state forbids continuing;
# trial-reset receipts must be retained because a refusal can follow partial archival).
#
#   bootstrap                 install Docker, git, swap, the directories and the systemd unit (idempotent);
#                             the unit file comes on the standard input
#   receive-env               replace /etc/projectman/cloud.env with the standard input (root only, 600)
#   receive-image <sha40> <platform> <bytes> <sha256> <image-id>
#                             verify/import one native Docker archive on stdin; strict metadata JSON only
#   build <sha40> <repo-url>  fetch that commit and build projectman-cloud:<sha40> from it
#   start <sha40> [ref] [expectedImageId]
#                             verify/run the pinned image (required on ARM), record it in deploy.json
#   stop                      stop and disable the unit, record when it stopped
#   status                    one JSON object on the standard output
#   logs <n>                  the last n journal lines of the unit
#   rehearse                  restore the replica and the snapshot into a scratch container (entrypoint.sh
#                             rehearse); the running board and the replica are not touched
#   seed-check                {"container":"running|stopped","dataEmpty":true|false}
#   seed-digest               {"databaseSha256":"<64 lowercase hex>","databaseBytes":<positive integer>}
#                             closed DB only, before the first start; no arguments or stdin payload
#   trial-reset-inspect       read stopped/disabled state and fixed-path content digests
#   trial-reset-archive <uuid> <plan-sha256> <inventory-sha256> <deploy-sha256|none> <image-sha256|none>
#                             preserve the trial data/metadata, leave empty active data; no stdin
#   trial-reset-verify <same five arguments>
#                             read-only final archive, empty-data and stopped-state verification
#   receive-data              unpack a tar stream into the empty data directory (the container must stand)
#   send-data                 write the data directory as a tar stream (the container must stand)
#   guard-check <hostname>    {"plain":"404","port":"404"}: the status codes the running board gives that hostname
#                             (the feedback guard, PM-510); refused while the board is not running
#   public-check <hostname>   {"publicBoard":b,"emailLoginEnabled":b,"needsSetup":b,"apiStatus":401,"crossOriginStatus":403}:
#                             what the running board says about itself as the public board (PM-672)
#   release-control           one ControlRequest JSON line on stdin (at most 16 KiB), one ControlResponse JSON line
#                             on stdout: the board's local control socket through the fixed client in the
#                             container (PM-749); refused while the board is not running
#   release-probe <sha40> <imageId> linux/arm64
#                             read-only: {"status":<status>,"imagePresent":b,"imageVerified":b,"imageLockHeld":b,
#                             "databaseSchemaVersion":n|null} for the hybrid coordinator (PM-751)
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
DOCKER_DIR=/etc/docker
DOCKER_CONFIG="$DOCKER_DIR/daemon.json"
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
  local sha=$1 ref=$2 stopped=$3 image_id=${4:-} platform=${5:-} old tmp
  old=$(read_deploy)
  tmp=$(mktemp "$STATE_DIR/.deploy.json.XXXXXX")
  jq -n --argjson old "$old" --arg sha "$sha" --arg ref "$ref" --arg at "$(now)" --arg stopped "$stopped" --arg imageId "$image_id" --arg platform "$platform" '
    ($old.current // null) as $current |
    ($old.previous // null) as $previous |
    {
      current: (if $sha == "" then $current else { sha: $sha, ref: $ref, at: $at } + (if $imageId == "" then {} else {imageId: $imageId, platform: $platform} end) end),
      previous: (if $sha != "" and $current != null and ($current.sha != $sha or ($current.imageId // "") != $imageId) then $current else $previous end),
      lastStoppedAt: (if $stopped == "" then null else $stopped end)
    }' >"$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$DEPLOY_JSON"
}

last_stopped_at() {
  read_deploy | jq -r '.lastStoppedAt // empty'
}

# Classify the running daemon, never its version-dependent default or on-disk configuration.
docker_image_store() {
  local info
  info=$(docker info --format '{{json .}}') || die "cannot query Docker daemon image store"
  jq -e -s 'length == 1 and (.[0] | type == "object" and
    (.Driver | type == "string" and length > 0) and
    (.DriverStatus | type == "array" and all(.[];
      type == "array" and length == 2 and all(.[]; type == "string"))))' <<<"$info" >/dev/null ||
    die "invalid Docker daemon image store response"
  if jq -e '.Driver == "overlay2" and all(.DriverStatus[];
    . != ["driver-type", "io.containerd.snapshotter.v1"])' <<<"$info" >/dev/null; then
    echo classic
  else
    echo unsupported
  fi
}

require_classic_docker_store() {
  local store
  store=$(docker_image_store) || die "Docker daemon image store check failed"
  [ "$store" = classic ] || refuse "classic Docker image store required; bootstrap the stopped host first"
}

# Preserve unrelated settings; a failed validation must leave the original file untouched.
configure_docker_store() (
  local config='{"features":{"containerd-snapshotter":false}}' tmp
  [ ! -L "$DOCKER_DIR" ] || refuse "Docker configuration directory is a symlink"
  if [ -e "$DOCKER_CONFIG" ] || [ -L "$DOCKER_CONFIG" ]; then
    [ ! -L "$DOCKER_CONFIG" ] && [ -f "$DOCKER_CONFIG" ] || refuse "Docker configuration is not a regular file"
    config=$(jq -ce -s 'if length == 1 and (.[0] | type == "object" and
      ((has("features") | not) or (.features | type == "object")))
      then .[0] | .features["containerd-snapshotter"] = false
      else error("invalid Docker configuration") end' "$DOCKER_CONFIG") || refuse "invalid Docker configuration"
    jq -e '.features["containerd-snapshotter"] == false' "$DOCKER_CONFIG" >/dev/null && return 0
  fi
  mkdir -p "$DOCKER_DIR"
  tmp=$(mktemp "$DOCKER_DIR/.daemon.json.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  trap 'exit 1' HUP INT TERM
  printf '%s\n' "$config" >"$tmp"
  chown root:root "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$DOCKER_CONFIG"
)

bootstrap() {
  export DEBIAN_FRONTEND=noninteractive
  local missing=() package store=uninstalled running=false unit_state containers updated=false
  mkdir -p "$STATE_DIR"
  umask 077
  exec 9>"$STATE_DIR/.image.lock"
  flock -x 9
  board_running && running=true

  # apt may start Docker during installation: jq and daemon.json must be ready first.
  if ! dpkg -s jq >/dev/null 2>&1; then
    apt-get update -qq
    updated=true
    apt-get install -y -qq --no-install-recommends jq
  fi
  if dpkg -s docker.io >/dev/null 2>&1 ||
    command -v dockerd >/dev/null 2>&1; then
    store=$(docker_image_store) || die "Docker daemon image store check failed"
  fi
  if [ "$store" != classic ]; then
    [ "$running" = false ] || refuse "stop the board before changing the Docker image store"
    unit_state=$(systemctl is-active "$UNIT" 2>/dev/null || true)
    case "$unit_state" in
      inactive|failed) ;;
      *) refuse "cannot prove the board is stopped before changing the Docker image store" ;;
    esac
    if [ -e "$DEPLOY_JSON" ] || [ -L "$DEPLOY_JSON" ]; then
      [ ! -L "$DEPLOY_JSON" ] && [ -f "$DEPLOY_JSON" ] &&
        jq -e -s 'length == 1 and (.[0] | type == "object" and .current == null and .previous == null)' "$DEPLOY_JSON" >/dev/null ||
        refuse "cannot change Docker image store with existing or unreadable deploy history"
    fi
    if [ "$store" != uninstalled ]; then
      containers=$(docker container ls --all --filter "name=^/$CONTAINER$" --format '{{.State}}') ||
        die "cannot check board containers before changing the Docker image store"
      case "$containers" in
        ''|created|exited|dead) ;;
        *) refuse "cannot prove the board container is stopped before changing the Docker image store" ;;
      esac
    fi
  fi
  configure_docker_store
  for package in docker.io docker-buildx git unattended-upgrades; do
    dpkg -s "$package" >/dev/null 2>&1 || missing+=("$package")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    [ "$updated" = true ] || apt-get update -qq
    apt-get install -y -qq --no-install-recommends "${missing[@]}"
  fi
  systemctl enable --now docker >/dev/null
  if [ "$store" = unsupported ]; then
    systemctl restart docker || die "Docker restart failed"
  fi
  require_classic_docker_store

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
  [ "$(host_platform)" = linux/amd64 ] || refuse "ARM hosts cannot build images"
  local sha=${1:-} url=${2:-}
  check_sha "$sha"
  umask 077
  exec 9>"$STATE_DIR/.image.lock"
  flock -x 9
  if read_deploy | jq -e --arg sha "$sha" '[.current, .previous] | any(.sha == $sha and .imageId != null)' >/dev/null; then
    refuse "cannot rebuild a recorded immutable image; use its approved bundle"
  fi
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
  # Do not prune dangling images: a recorded immutable ID can still be needed for rollback.
  docker builder prune --force --keep-storage 2GB >/dev/null
}

host_platform() {
  case "$(uname -m)" in
    x86_64) echo linux/amd64 ;;
    aarch64|arm64) echo linux/arm64 ;;
    *) refuse "unsupported host architecture" ;;
  esac
}

check_image_id() {
  [[ "${1:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "invalid image ID"
}

verify_image() {
  local sha=$1 platform=$2 image_id=$3
  docker image inspect "$image_id" | jq -e --arg id "$image_id" --arg platform "$platform" --arg sha "$sha" '
    length == 1 and .[0].Id == $id and .[0].Os == "linux" and
    ("linux/" + .[0].Architecture) == $platform and
    .[0].Config.Labels["org.opencontainers.image.revision"] == $sha and
    ([.[0].Config.Env[] | select(startswith("PROJECTMAN_VERSION="))] == ["PROJECTMAN_VERSION=" + $sha])
  ' >/dev/null || die "image ID, platform, revision or version mismatch"
}

# A bounded, root-only stream; validate the archive and its sole tag before Docker may change any image.
receive_image() (
  [ "$#" -eq 5 ] || die "receive-image needs five arguments"
  local sha=$1 platform=$2 bytes=$3 hash=$4 image_id=$5 free existing tmp config config_hash
  check_sha "$sha"
  [[ "$platform" = linux/amd64 || "$platform" = linux/arm64 ]] || die "invalid platform"
  [[ "$bytes" =~ ^[1-9][0-9]{0,15}$ ]] && [ "$bytes" -le 9007199254740991 ] || die "invalid archive size"
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || die "invalid archive hash"
  check_image_id "$image_id"
  umask 077
  exec 9>"$STATE_DIR/.image.lock"
  flock -x 9
  require_classic_docker_store
  [ "$(host_platform)" = "$platform" ] || refuse "image platform differs from host"
  [ "$(docker info --format '{{.OSType}}/{{.Architecture}}')" = "$platform" ] || {
    # Docker reports Go or kernel architecture names depending on its version.
    case "$(docker info --format '{{.OSType}}/{{.Architecture}}'):$platform" in
      linux/x86_64:linux/amd64|linux/aarch64:linux/arm64) ;;
      *) refuse "Docker daemon platform differs from host" ;;
    esac
  }
  existing=$(docker image inspect -f '{{.Id}}' "$IMAGE_REPO:$sha" 2>/dev/null || true)
  [ -z "$existing" ] || [ "$existing" = "$image_id" ] || refuse "source tag already names another image"
  free=$(df -B1 --output=avail "$STATE_DIR" | tail -n 1 | tr -d ' ')
  [ "$free" -ge "$((bytes + MIN_FREE_BYTES))" ] || refuse "insufficient disk for image stream"
  umask 077
  tmp=$(mktemp "$STATE_DIR/.image.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  trap 'exit 1' HUP INT TERM
  head -c "$((bytes + 1))" >"$tmp"
  [ "$(stat -c %s "$tmp")" = "$bytes" ] || die "truncated or oversized image stream"
  [ "$(sha256sum "$tmp" | cut -d ' ' -f1)" = "$hash" ] || die "image archive hash mismatch"
  free=$(df -B1 --output=avail "$STATE_DIR" | tail -n 1 | tr -d ' ')
  [ "$free" -ge "$MIN_FREE_BYTES" ] || refuse "insufficient disk for Docker import"
  config=$(tar -xOf "$tmp" manifest.json | jq -er --arg tag "$IMAGE_REPO:$sha" '
    if length == 1 and .[0].RepoTags == [$tag] then .[0].Config else error("unexpected archive tags") end') || die "invalid Docker archive manifest"
  [[ "$config" =~ ^([0-9a-f]{64}\.json|blobs/sha256/[0-9a-f]{64})$ ]] || die "invalid image config path"
  config_hash=$(tar -xOf "$tmp" "$config" | sha256sum | cut -d ' ' -f1)
  [ "sha256:$config_hash" = "$image_id" ] || die "archive config digest mismatch"
  tar -xOf "$tmp" "$config" | jq -e --arg platform "$platform" --arg sha "$sha" '
    .os == "linux" and ("linux/" + .architecture) == $platform and
    .config.Labels["org.opencontainers.image.revision"] == $sha and
    ([.config.Env[] | select(startswith("PROJECTMAN_VERSION="))] == ["PROJECTMAN_VERSION=" + $sha])
  ' >/dev/null || die "archive platform, revision or version mismatch"
  docker load --input "$tmp" >&2 || die "Docker image import failed"
  verify_image "$sha" "$platform" "$image_id"
  printf '{"imageId":"%s","platform":"%s","revision":"%s"}\n' "$image_id" "$platform" "$sha"
)

start() {
  local sha=${1:-} ref=${2:-} image_id=${3:-} platform image
  check_sha "$sha"
  umask 077
  exec 9>"$STATE_DIR/.image.lock"
  flock -x 9
  require_classic_docker_store
  [ -n "$ref" ] || ref=$sha
  [[ "$ref" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || die "not a usable ref name: $ref"
  platform=$(host_platform)
  image="$IMAGE_REPO:$sha"
  if [ -n "$image_id" ]; then
    check_image_id "$image_id"
    verify_image "$sha" "$platform" "$image_id"
    image=$image_id
  else
    [ "$platform" = linux/amd64 ] || refuse "ARM start requires a recorded image ID"
    docker image inspect "$image" >/dev/null 2>&1 || die "the image $image is not built"
  fi
  [ -s "$ENV_FILE" ] || die "$ENV_FILE is missing (receive-env first)"

  # The old container's stop time is what a Litestream point-in-time restore needs after a failed migration.
  local stopped
  stopped=$(last_stopped_at)
  if board_running; then
    systemctl stop "$UNIT"
    stopped=$(now)
  fi
  printf 'IMAGE=%s\n' "$image" >"$IMAGE_ENV"
  chmod 644 "$IMAGE_ENV"
  write_deploy "$sha" "$ref" "$stopped" "$image_id" "$platform"
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
  local unit container=absent health=none image="" image_id="" deploy data_bytes=0 free_bytes=0
  local mem_total mem_available swap_total swap_used
  unit=$(systemctl is-active "$UNIT" 2>/dev/null || true)
  [ -n "$unit" ] || unit=unknown
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    container=$(docker inspect -f '{{.State.Status}}' "$CONTAINER")
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")
    image=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")
    image_id=$(docker inspect -f '{{.Image}}' "$CONTAINER")
  fi
  deploy=$(read_deploy)
  if [ -d "$DATA_DIR" ]; then
    data_bytes=$(du -sb "$DATA_DIR" | cut -f1)
  fi
  free_bytes=$(df -B1 --output=avail "$STATE_DIR" | tail -n 1 | tr -d ' ')
  read -r mem_total mem_available < <(free -b | awk '/^Mem:/ { print $2, $7 }')
  read -r swap_total swap_used < <(free -b | awk '/^Swap:/ { print $2, $3 }')
  jq -n --arg unit "$unit" --arg container "$container" --arg health "$health" --arg image "$image" --arg imageId "$image_id" \
    --argjson deploy "$deploy" --argjson dataBytes "${data_bytes:-0}" --argjson freeBytes "${free_bytes:-0}" \
    --argjson total "${mem_total:-0}" --argjson available "${mem_available:-0}" \
    --argjson swapTotal "${swap_total:-0}" --argjson swapUsed "${swap_used:-0}" '{
      unit: $unit,
      container: $container,
      health: $health,
      image: $image,
      imageId: (if $imageId == "" then null else $imageId end),
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

# The admin channel to the board's local control socket (PM-749): one request line (at most 16 KiB, read
# from the standard input) goes to the control client the image carries, which runs inside the running
# container as the board's own user and answers with one JSON line. The command, the user, the container and
# the socket path are fixed here; nothing from the input becomes an argument, a path or a process, and no
# port or mount is opened. The client refuses a malformed or oversized request (exit 2 -> refused here).
release_control() {
  [ "$#" -eq 0 ] || die "release-control takes no arguments"
  [ ! -t 0 ] || die "release-control needs one request line on the standard input"
  board_running || refuse "the board is not running; there is no control socket to reach"
  local status=0
  # One byte over the limit is enough for the client to see that the request is too long.
  # The relay starts with an empty environment (PM-754): `/usr/bin/env -i` clears what `docker exec` inherits from
  # the container before Node starts, so NODE_OPTIONS, NODE_PATH and every secret of the board stay out. Only
  # PATH and LANG are set; the socket path is an argument. There is no fallback to the inherited environment.
  head -c $((16 * 1024 + 1)) | docker exec -i -u "$DATA_UID:$DATA_GID" "$CONTAINER" \
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
    /usr/local/bin/node /app/apps/server/dist/control/cli.js /data/control.sock || status=$?
  case "$status" in
    0) ;;
    2) refuse "the control relay refused the request" ;;
    *) die "the control relay failed (status $status)" ;;
  esac
}

# The hybrid coordinator's read-only look at one immutable image (PM-751): `release-probe <sha40> <imageId>
# linux/arm64`. Nothing is created, loaded, started or stopped. The answer is one JSON object and never holds a
# path, a log line or an environment value:
#   imageVerified    the same revision/version/platform/ID checks the start makes, on the image the ID names
#   imageLockHeld    another host.sh run holds `.image.lock` (a non-blocking shared try on the existing file,
#                    released at once; a missing file is not held, and none is created)
#   databaseSchemaVersion  PRAGMA user_version of the board's database through a read-only connection as the
#                    board's own user, or null when it cannot be read; no migration, copy or write
release_probe() {
  [ "$#" -eq 3 ] || die "release-probe needs three arguments"
  local sha=$1 image_id=$2 platform=$3 present=false verified=false held=false schema=null
  check_sha "$sha"
  check_image_id "$image_id"
  [ "$platform" = linux/arm64 ] || die "release-probe takes linux/arm64 only"
  if docker image inspect "$image_id" >/dev/null 2>&1; then
    present=true
    if [ "$(host_platform)" = "$platform" ] && (verify_image "$sha" "$platform" "$image_id") >/dev/null 2>&1; then
      verified=true
    fi
  fi
  if [ -f "$STATE_DIR/.image.lock" ] && [ ! -L "$STATE_DIR/.image.lock" ]; then
    # Opened read-only: the descriptor lives in this subshell only and goes away with it.
    ( exec 8<"$STATE_DIR/.image.lock" && flock -s -n 8 ) >/dev/null 2>&1 || held=true
  fi
  schema=$(probe_schema_version)
  jq -n --argjson status "$(status)" --argjson present "$present" --argjson verified "$verified" \
    --argjson held "$held" --argjson schema "$schema" '{
      status: $status,
      imagePresent: $present,
      imageVerified: $verified,
      imageLockHeld: $held,
      databaseSchemaVersion: $schema
    }'
}

# Prints the schema version number, or `null`. The Python program takes no argument, path or SQL from outside.
probe_schema_version() {
  local database="$DATA_DIR/db.sqlite" value=""
  if [ -f "$database" ] && [ ! -L "$database" ] && command -v python3 >/dev/null 2>&1 && command -v setpriv >/dev/null 2>&1; then
    value=$(setpriv --reuid="$DATA_UID" --regid="$DATA_GID" --clear-groups \
      python3 -I -S -c 'import sqlite3,sys
try:
    c = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True, timeout=5)
    print(c.execute("PRAGMA user_version").fetchone()[0])
except Exception:
    pass' "$database" 2>/dev/null || true)
  fi
  if [[ "$value" =~ ^[0-9]{1,9}$ ]]; then echo "$value"; else echo null; fi
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

# Ubuntu 24.04's existing interpreter only: no installation or fallback. The isolated embedded
# program accepts no paths or stdin payload; names and credentials never enter diagnostics.
trial_reset() {
  command -v python3 >/dev/null 2>&1 || refuse "trial reset requires existing Python3"
  python3 -I -S - "$@" <<'TRIAL_RESET_PY'
import datetime
import errno
import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import uuid

STATE = "/var/lib/projectman"
ETC = "/etc/projectman"
MOUNTINFO = "/proc/self/mountinfo"
PROCESS_ROOT = "/proc"
SYSTEMCTL = "/usr/bin/systemctl"
DOCKER = "/usr/bin/docker"
HOST_PLATFORM = sys.platform
ROOT_UID = 0
DATA_UID = 10001
DATA_GID = 10001
UNIT = "projectman-cloud"
MAX_SAFE = 9007199254740991
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
UTC = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\Z")

class Refusal(Exception):
    pass

def need(condition):
    if not condition:
        raise Refusal()

def capabilities():
    need(HOST_PLATFORM == "linux" and os.geteuid() == ROOT_UID)
    need(hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY"))
    need(all(f in os.supports_dir_fd for f in (os.open, os.stat, os.rename, os.mkdir)))
    need(os.listdir in os.supports_fd)
    # Reading this also proves mountinfo is available before any write.
    mounts()

def mounts():
    result = []
    with open(MOUNTINFO, "r", encoding="utf-8", errors="strict") as source:
        for line in source:
            fields = line.split(" ")
            need(len(fields) >= 10 and " - " in line)
            result.append(re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), fields[4]))
    need(bool(result))
    return result

def no_mounts(paths):
    for mount in mounts():
        need(not any(mount == p or mount.startswith(p + "/") for p in paths))

DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
FILE_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)

def stamp(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

def st(parent, name):
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None

def secure_dir(path):
    fd = os.open("/", DIR_FLAGS)
    try:
        for part in path.strip("/").split("/"):
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise

def private_dir(fd, exact=False):
    s = os.fstat(fd)
    need(stat.S_ISDIR(s.st_mode) and s.st_uid == ROOT_UID)
    need(stat.S_IMODE(s.st_mode) == 0o700 if exact else not s.st_mode & 0o022)

def bound(fd, path):
    current = secure_dir(path)
    try:
        a, b = os.fstat(fd), os.fstat(current)
        need((a.st_dev, a.st_ino) == (b.st_dev, b.st_ino))
    finally:
        os.close(current)

def names(fd):
    # surrogateescape names from the OS must round-trip as real UTF-8, never replacements.
    entries = os.listdir(fd)
    return sorted(entries, key=lambda s: s.encode("utf-8", "strict"))

def file_digest(parent, name, device=None):
    before = st(parent, name)
    if before is None:
        return None
    need(stat.S_ISREG(before.st_mode) and (device is None or before.st_dev == device))
    need(0 <= before.st_size <= MAX_SAFE)
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    try:
        need(stamp(before) == stamp(os.fstat(fd)))
        h, size = hashlib.sha256(), 0
        while True:
            data = os.read(fd, 1024 * 1024)
            if not data:
                break
            h.update(data)
            size += len(data)
            need(size <= before.st_size and stamp(before) == stamp(os.fstat(fd)))
        after = st(parent, name)
        need(after is not None and stamp(before) == stamp(after) == stamp(os.fstat(fd)))
        need(size == before.st_size)
        return (h.hexdigest(), size, stamp(before))
    finally:
        os.close(fd)

def inventory(fd):
    root = os.fstat(fd)
    entries, observations = [], []
    def walk(parent, prefix):
        before = os.fstat(parent)
        need(before.st_dev == root.st_dev and stat.S_ISDIR(before.st_mode))
        listing = names(parent)
        for name in listing:
            relative = prefix + name
            s = st(parent, name)
            need(s is not None and s.st_dev == root.st_dev)
            if stat.S_ISDIR(s.st_mode):
                child = os.open(name, DIR_FLAGS, dir_fd=parent)
                try:
                    need(stamp(s) == stamp(os.fstat(child)))
                    entries.append((relative, "directory", 0, ""))
                    walk(child, relative + "/")
                finally:
                    os.close(child)
            else:
                d = file_digest(parent, name, root.st_dev)
                need(d is not None)
                entries.append((relative, "file", d[1], d[0]))
            observations.append((relative, stamp(s)))
        need(listing == names(parent) and stamp(before) == stamp(os.fstat(parent)))
    walk(fd, "")
    # Re-open each relative path component without following a replaced directory or symlink.
    for relative, before in observations:
        parts = relative.split("/")
        parent = os.dup(fd)
        try:
            for part in parts[:-1]:
                child = os.open(part, DIR_FLAGS, dir_fd=parent)
                os.close(parent)
                parent = child
            after = st(parent, parts[-1])
            need(after is not None and before == stamp(after))
        finally:
            os.close(parent)
    need(stamp(root) == stamp(os.fstat(fd)))
    h, files, directories, size, database = hashlib.sha256(), 0, 0, 0, None
    for name, kind, length, content in sorted(entries, key=lambda e: e[0].encode("utf-8")):
        h.update((name + "\0" + kind + "\0" + str(length) + "\0" + content + "\0").encode("utf-8"))
        if kind == "file":
            files += 1
            size += length
            if name == "db.sqlite":
                database = content
        else:
            directories += 1
    need(database is not None and max(files, directories, size) <= MAX_SAFE)
    return dict(inventorySha256=h.hexdigest(), files=files, directories=directories, bytes=size, databaseSha256=database)

def run(args, allowed=(0,)):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
    if result.returncode not in allowed:
        raise RuntimeError()
    return result.stdout.decode("utf-8", "strict").strip()

def stopped():
    inactive = run([SYSTEMCTL, "show", UNIT, "--property=ActiveState", "--value"]) == "inactive"
    disabled = run([SYSTEMCTL, "is-enabled", UNIT], (0, 1)) == "disabled"
    # The dedicated trial host must have no running/starting containers, including backup sidecars.
    ids = run([DOCKER, "ps", "--all", "--quiet", "--no-trunc"]).splitlines()
    for identity in ids:
        need(re.fullmatch(r"[0-9a-f]{12,64}", identity) is not None)
        containers = json.loads(run([DOCKER, "inspect", identity]))
        need(isinstance(containers, list) and len(containers) == 1)
        c = containers[0]
        state = c["State"]
        need(type(state["Running"]) is bool and type(state["Restarting"]) is bool)
        need(not state["Running"] and not state["Restarting"])
        need(state["Status"] in ("exited", "dead"))
    # Read process command names/arguments, never their environment or output.
    for pid in os.listdir(PROCESS_ROOT):
        if not pid.isdecimal():
            continue
        try:
            with open(PROCESS_ROOT + "/" + pid + "/cmdline", "rb") as f:
                args = f.read().split(b"\0")
            need(not any(os.path.basename(arg) in (b"litestream", b"restic", b"backup.sh") for arg in args))
        except (FileNotFoundError, ProcessLookupError):
            continue
    need(inactive and disabled)
    return dict(unitInactive=True, unitDisabled=True, containerStopped=True)

def read_receipt(parent, plan_id):
    s = st(parent, "reset.json")
    need(s is not None and stat.S_ISREG(s.st_mode) and stat.S_IMODE(s.st_mode) == 0o600 and s.st_uid == ROOT_UID)
    fd = os.open("reset.json", FILE_FLAGS, dir_fd=parent)
    try:
        need(stamp(s) == stamp(os.fstat(fd)) and s.st_size <= 4096)
        try:
            value = json.loads(os.read(fd, 4097).decode("utf-8", "strict"))
        except ValueError:
            raise Refusal()
        after = st(parent, "reset.json")
        need(after is not None and stamp(s) == stamp(os.fstat(fd)) == stamp(after))
    finally:
        os.close(fd)
    need(type(value) is dict and set(value) == {"version", "planId", "planSha256", "startedAt", "phase"})
    need(type(value["version"]) is int and value["version"] == 1 and value["planId"] == plan_id)
    need(type(value["planSha256"]) is str and DIGEST.fullmatch(value["planSha256"]) is not None)
    need(type(value["startedAt"]) is str and UTC.fullmatch(value["startedAt"]) is not None)
    try:
        datetime.datetime.fromisoformat(value["startedAt"].replace("Z", "+00:00"))
    except ValueError:
        raise Refusal()
    need(value["phase"] in ("started", "archived"))
    return value

def prior_resets(state):
    s = st(state, "trial-archive")
    if s is None:
        return
    root = os.open("trial-archive", DIR_FLAGS, dir_fd=state)
    try:
        private_dir(root, True)
        for name in names(root):
            need(UUID.fullmatch(name) is not None)
            child = os.open(name, DIR_FLAGS, dir_fd=root)
            try:
                private_dir(child, True)
                need(read_receipt(child, name)["phase"] == "archived")
            finally:
                os.close(child)
    finally:
        os.close(root)

def write_receipt(parent, value):
    tmp = ".reset-" + str(uuid.uuid4())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        os.fchmod(fd, 0o600)
        payload = (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(payload)
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, "reset.json", src_dir_fd=parent, dst_dir_fd=parent)
    os.fsync(parent)

def metadata(parent, name):
    d = file_digest(parent, name)
    return None if d is None else d[0]

def expected_metadata(parent, name, expected):
    need(metadata(parent, name) == (None if expected == "none" else expected))

def empty_active(state, etc):
    need(st(state, "deploy.json") is None and st(etc, "image.env") is None)
    data = os.open("data", DIR_FLAGS, dir_fd=state)
    try:
        s = os.fstat(data)
        need(stat.S_IMODE(s.st_mode) == 0o700 and s.st_uid == DATA_UID and s.st_gid == DATA_GID and not names(data))
    finally:
        os.close(data)

def verify_archive(state, etc, parent, plan_id, plan_sha, inventory_sha, deploy_sha, image_sha, require_receipt=True):
    private_dir(parent, True)
    if require_receipt:
        receipt = read_receipt(parent, plan_id)
        need(receipt["planSha256"] == plan_sha and receipt["phase"] == "archived")
    stopped()
    no_mounts([STATE, ETC])
    need(set(names(parent)) == {"reset.json", "data"} | ({"deploy.json"} if deploy_sha != "none" else set()) | ({"image.env"} if image_sha != "none" else set()))
    data = os.open("data", DIR_FLAGS, dir_fd=parent)
    try:
        need(inventory(data)["inventorySha256"] == inventory_sha)
    finally:
        os.close(data)
    expected_metadata(parent, "deploy.json", deploy_sha)
    expected_metadata(parent, "image.env", image_sha)
    empty_active(state, etc)
    stopped()
    no_mounts([STATE, ETC])
    bound(state, STATE)
    bound(etc, ETC)
    bound(parent, STATE + "/trial-archive/" + plan_id)
    return dict(archiveDirectory=STATE + "/trial-archive/" + plan_id, inventorySha256=inventory_sha, dataEmpty=True, unitInactive=True, unitDisabled=True)

def main():
    action, args = sys.argv[1], sys.argv[2:]
    need(action in ("inspect", "archive", "verify"))
    need(len(args) == (0 if action == "inspect" else 5))
    if args:
        plan_id, plan_sha, inventory_sha, deploy_sha, image_sha = args
        need(UUID.fullmatch(plan_id) is not None)
        need(all(DIGEST.fullmatch(s) is not None for s in (plan_sha, inventory_sha)))
        need(all(s == "none" or DIGEST.fullmatch(s) is not None for s in (deploy_sha, image_sha)))
    capabilities()
    state, etc = secure_dir(STATE), secure_dir(ETC)
    private_dir(state)
    private_dir(etc)
    no_mounts([STATE, ETC])
    stopped()
    # Same lock inode as start/build/receive-image, never replaced or truncated by reset.
    lock = os.open(".image.lock", FILE_FLAGS, dir_fd=state)
    lock_stat = os.fstat(lock)
    need(stat.S_ISREG(lock_stat.st_mode) and lock_stat.st_uid == ROOT_UID and not lock_stat.st_mode & 0o022)
    try:
        fcntl.flock(lock, (fcntl.LOCK_EX if action == "archive" else fcntl.LOCK_SH) | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Refusal()
    prior_resets(state)
    if action == "verify":
        parent = secure_dir(STATE + "/trial-archive/" + plan_id)
        return verify_archive(state, etc, parent, *args)
    data = os.open("data", DIR_FLAGS, dir_fd=state)
    measured = inventory(data)
    deploy, image = metadata(state, "deploy.json"), metadata(etc, "image.env")
    stopped()
    no_mounts([STATE, ETC])
    bound(state, STATE)
    bound(etc, ETC)
    need(stamp(st(state, "data")) == stamp(os.fstat(data)))
    if action == "inspect":
        return dict(**stopped(), **measured, deployJsonSha256=deploy, imageEnvSha256=image)
    need(measured["inventorySha256"] == inventory_sha)
    need(deploy == (None if deploy_sha == "none" else deploy_sha) and image == (None if image_sha == "none" else image_sha))
    # All read-only preconditions hold. Every later failure leaves its archive/receipt in place.
    if st(state, "trial-archive") is None:
        os.mkdir("trial-archive", 0o700, dir_fd=state)
        os.fsync(state)
    root = os.open("trial-archive", DIR_FLAGS, dir_fd=state)
    private_dir(root, True)
    need(os.fstat(root).st_dev == os.fstat(data).st_dev)
    need(st(root, plan_id) is None)
    os.mkdir(plan_id, 0o700, dir_fd=root)
    os.fsync(root)
    parent = os.open(plan_id, DIR_FLAGS, dir_fd=root)
    receipt = dict(version=1, planId=plan_id, planSha256=plan_sha, startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"), phase="started")
    write_receipt(parent, receipt)
    # Re-read immediately before metadata moves, while the existing start lock remains exclusive.
    stopped()
    need(inventory(data) == measured)
    expected_metadata(state, "deploy.json", deploy_sha)
    expected_metadata(etc, "image.env", image_sha)
    for source, name, expected in ((state, "deploy.json", deploy_sha), (etc, "image.env", image_sha)):
        if expected != "none":
            os.rename(name, name, src_dir_fd=source, dst_dir_fd=parent)
            os.fsync(source)
            os.fsync(parent)
    need(stamp(st(state, "data")) == stamp(os.fstat(data)))
    os.rename("data", "data", src_dir_fd=state, dst_dir_fd=parent)
    os.fsync(state)
    os.fsync(parent)
    os.mkdir("data", 0o700, dir_fd=state)
    active = os.open("data", DIR_FLAGS, dir_fd=state)
    os.fchown(active, DATA_UID, DATA_GID)
    os.fchmod(active, 0o700)
    os.fsync(active)
    os.fsync(state)
    answer = verify_archive(state, etc, parent, *args, require_receipt=False)
    receipt["phase"] = "archived"
    write_receipt(parent, receipt)
    return answer

def interrupted(signum, frame):
    raise RuntimeError()

for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(s, interrupted)
try:
    print(json.dumps(main(), separators=(",", ":")))
except (Refusal, FileNotFoundError, NotADirectoryError, UnicodeError):
    print("host.sh: refused: unsafe or changed trial reset state; preserve receipts for owner recovery", file=sys.stderr)
    sys.exit(3)
except OSError as error:
    if error.errno in (errno.ELOOP, errno.EACCES, errno.EPERM):
        print("host.sh: refused: unsafe or unreadable trial reset state; preserve receipts for owner recovery", file=sys.stderr)
        sys.exit(3)
    print("host.sh: trial reset I/O failed; preserve receipts for owner recovery", file=sys.stderr)
    sys.exit(1)
except BaseException:
    print("host.sh: trial reset computation or transport failed; preserve receipts for owner recovery", file=sys.stderr)
    sys.exit(1)
TRIAL_RESET_PY
}

main() {
  [ "$(id -u)" = 0 ] || die "run it as root (sudo)"
  local subcommand=${1:-}
  shift || true
  case "$subcommand" in
    bootstrap) bootstrap ;;
    receive-env) receive_env ;;
    receive-image) receive_image "$@" ;;
    build) build "$@" ;;
    start) start "$@" ;;
    stop) stop ;;
    status) status ;;
    logs) logs "$@" ;;
    rehearse) rehearse ;;
    seed-check) seed_check ;;
    seed-digest) seed_digest "$@" ;;
    trial-reset-inspect) trial_reset inspect "$@" ;;
    trial-reset-archive) trial_reset archive "$@" ;;
    trial-reset-verify) trial_reset verify "$@" ;;
    receive-data) receive_data ;;
    send-data) send_data ;;
    guard-check) guard_check "$@" ;;
    public-check) public_check "$@" ;;
    release-control) release_control "$@" ;;
    release-probe) release_probe "$@" ;;
    *) die "usage: host.sh bootstrap|receive-env|receive-image|build|start|stop|status|logs|rehearse|seed-check|seed-digest|trial-reset-inspect|trial-reset-archive|trial-reset-verify|receive-data|send-data|guard-check|public-check|release-control|release-probe" ;;
  esac
}

main "$@"
