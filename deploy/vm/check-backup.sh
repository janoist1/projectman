#!/usr/bin/env bash
# Proves that a backup.sh archive is a whole, restorable home (PM-143), without touching the running
# installation: the data is extracted to a private scratch directory, the move tool's verify runs on
# it (database integrity and schema against THIS build, the cookie secret, attachments against their
# rows, the customization repository and every project's configuration), and the scratch is removed.
#
#   sudo ./check-backup.sh /root/projectman-backup.tar.gz [--scratch /var/tmp]
#
# Exit 0: restorable by this build. Exit 1: a blocking finding (named). A newer schema is a blocker:
# an older build must never start on a database a newer one migrated. restore.sh runs this first.
set -eu

PROFILE=${PROFILE:-/etc/projectman/profile.env}
[ "$(id -u)" = 0 ] || { echo "check-backup.sh must run as root" >&2; exit 2; }
[ -r "$PROFILE" ] || { echo "no installed profile at $PROFILE" >&2; exit 2; }
# shellcheck source=profile.env
. "$PROFILE"
ARCHIVE=${1:?usage: check-backup.sh ARCHIVE.tar.gz [--scratch DIR]}
SCRATCH_ROOT=/var/tmp
if [ "${2:-}" = --scratch ]; then SCRATCH_ROOT=${3:?--scratch needs a directory}; fi
[ -f "$ARCHIVE" ] || { echo "archive not found: $ARCHIVE" >&2; exit 2; }
if [ -f "$ARCHIVE.sha256" ]; then (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256" >/dev/null) || { echo "checksum mismatch: the archive is damaged" >&2; exit 1; }; fi

data=${PROJECTMAN_HOME#/}
tar -tzf "$ARCHIVE" | grep -q "^$data/db.sqlite\$" || { echo "the archive holds no $PROJECTMAN_HOME/db.sqlite" >&2; exit 1; }
for worker in $(getent passwd | cut -d: -f1 | grep "^$WORKER_PREFIX" || true); do
  tar -tzf "$ARCHIVE" | grep -q "^${WORKER_HOME_ROOT#/}/$worker\(/\|\$\)" || echo "note: no home of $worker in the archive (it has no work to restore)" >&2
done

SCRATCH=$(mktemp -d "$SCRATCH_ROOT/projectman-check.XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT
chmod 0700 "$SCRATCH"
tar -xzf "$ARCHIVE" -C "$SCRATCH" --no-same-owner "$data"
CLI_PATH="$CLI_PREFIX/bin:/usr/local/bin:/usr/bin:/bin"
cd "$APP_DIR"
# --no-paths: the repositories of the original machine are not expected on this one.
env PATH="$CLI_PATH" node --import tsx scripts/migrate/cli.ts verify --home "$SCRATCH/$data" --no-paths
