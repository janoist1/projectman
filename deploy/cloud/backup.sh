#!/usr/bin/env bash
# The restic side of the cloud backup (PM-317, docs/HYBRID.md): everything in PROJECTMAN_HOME except
# the database. The database is replicated by Litestream, which restic cannot copy consistently.
#
#   backup.sh backup            back up (creates the repository the first time), then forget old snapshots
#   backup.sh restore <dir>     restore the latest snapshot into <dir>; exit 0 and no files if the repository
#                               does not exist yet (a brand new installation), non-zero on any other error
#   backup.sh check             verify the repository
#
# The repository password (RESTIC_PASSWORD) is not the storage key: whoever has the storage key but not
# the password sees only encrypted data. The entrypoint gives this script only the RESTIC_* variables.
set -euo pipefail

: "${PROJECTMAN_HOME:?PROJECTMAN_HOME is not set}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is not set}"
: "${RESTIC_ACCESS_KEY_ID:?RESTIC_ACCESS_KEY_ID is not set}"
: "${RESTIC_SECRET_ACCESS_KEY:?RESTIC_SECRET_ACCESS_KEY is not set}"

export AWS_ACCESS_KEY_ID="$RESTIC_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$RESTIC_SECRET_ACCESS_KEY"
if [ -n "${RESTIC_REGION:-}" ]; then export AWS_DEFAULT_REGION="$RESTIC_REGION"; fi
unset RESTIC_ACCESS_KEY_ID RESTIC_SECRET_ACCESS_KEY RESTIC_REGION

# The database and its write-ahead files are Litestream's; the rest is rebuilt or not worth keeping.
EXCLUDES=(
  --exclude "$PROJECTMAN_HOME/db.sqlite"
  --exclude "$PROJECTMAN_HOME/db.sqlite-wal"
  --exclude "$PROJECTMAN_HOME/db.sqlite-shm"
  --exclude "$PROJECTMAN_HOME/logs"
  --exclude "$PROJECTMAN_HOME/browsers"
  --exclude "$PROJECTMAN_HOME/.restore-staging"
)

repository_exists() {
  local status=0
  restic cat config >/dev/null 2>&1 || status=$?
  case "$status" in
    0) return 0 ;;
    10) return 1 ;; # restic: the repository does not exist
    *)
      echo "backup: the repository cannot be read (restic status $status): wrong password, key or endpoint?" >&2
      exit "$status"
      ;;
  esac
}

command_name="${1:-backup}"
case "$command_name" in
  backup)
    repository_exists || restic init
    restic backup "$PROJECTMAN_HOME" "${EXCLUDES[@]}" --tag projectman-cloud --host projectman-cloud
    # Daily for a week, weekly for a month, monthly for half a year.
    restic forget --tag projectman-cloud --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
    ;;
  restore)
    target="${2:?usage: backup.sh restore <dir>}"
    if ! repository_exists; then
      echo "backup: no restic repository yet; nothing to restore" >&2
      exit 0
    fi
    # The snapshot keeps absolute paths, so it goes to a staging directory and the home's files are copied up.
    staging="$(mktemp -d "${TMPDIR:-/tmp}/restore.XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    restic restore latest --tag projectman-cloud --host projectman-cloud --target "$staging"
    if [ -d "$staging$PROJECTMAN_HOME" ]; then
      mkdir -p "$target"
      cp -a "$staging$PROJECTMAN_HOME/." "$target/"
    else
      echo "backup: the latest snapshot has no $PROJECTMAN_HOME" >&2
      exit 1
    fi
    ;;
  check)
    restic check
    ;;
  *)
    echo "usage: backup.sh backup | restore <dir> | check" >&2
    exit 64
    ;;
esac
