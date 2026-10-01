#!/usr/bin/env bash
# Restores a backup.sh archive onto a machine that bootstrap.sh and install-app.sh built (PM-137).
#
#   sudo ./restore.sh projectman-backup.tar.gz
#
# The accounts must exist already (the same worker handles as in the backup): ownership is set by
# name, not by the numbers in the archive, so a rebuilt machine with other uids restores correctly.
# What is there now is not deleted: it is moved to <dir>.before-restore-<time>. The cookie secret
# comes back with the data, so browser logins stay valid; a different secret would end them all.
set -eu

PROFILE=${PROFILE:-/etc/projectman/profile.env}
[ "$(id -u)" = 0 ] || { echo "restore.sh must run as root" >&2; exit 2; }
[ -r "$PROFILE" ] || { echo "no installed profile at $PROFILE (run bootstrap.sh first)" >&2; exit 2; }
# shellcheck source=profile.env
. "$PROFILE"
ARCHIVE=${1:?usage: restore.sh ARCHIVE.tar.gz}
[ -f "$ARCHIVE" ] || { echo "archive not found: $ARCHIVE" >&2; exit 2; }
if [ -f "$ARCHIVE.sha256" ]; then (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256"); fi

# Only the two trees of the backup may be in the archive.
stray=$(tar -tzf "$ARCHIVE" | grep -v -e "^${SERVICE_HOME#/}\(/\|\$\)" -e "^${WORKER_HOME_ROOT#/}\(/\|\$\)" | head -n 1 || true)
[ -z "$stray" ] || { echo "the archive holds a path outside the backup trees: $stray" >&2; exit 1; }

# Nothing is touched until the data in the archive is proven whole and not newer than this build
# (a newer schema: an older build must never start on it; see check-backup.sh, PM-143).
bash "$(dirname "$0")/check-backup.sh" "$ARCHIVE" || { echo "the archive did not pass check-backup.sh: nothing was restored" >&2; exit 1; }

systemctl stop projectman 2>/dev/null || true
stamp=$(date -u +%Y%m%dT%H%M%SZ)
for dir in "$SERVICE_HOME" "$WORKER_HOME_ROOT"; do
  [ -e "$dir" ] && mv "$dir" "$dir.before-restore-$stamp"
done

tar -C / -xzpf "$ARCHIVE" --no-same-owner
chown -R "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME"
chmod 0700 "$SERVICE_HOME" "$PROJECTMAN_HOME"
chown root:root "$WORKER_HOME_ROOT"
chmod 0755 "$WORKER_HOME_ROOT"
for home in "$WORKER_HOME_ROOT"/*; do
  [ -d "$home" ] || continue
  name=$(basename "$home")
  getent passwd "$name" >/dev/null || { echo "no account $name for $home: create the worker first (bootstrap.sh --workers)" >&2; exit 1; }
  chown -R "$name:$name" "$home"
  chmod 0750 "$home"
done

systemctl start projectman
echo "restored $ARCHIVE; the previous state is in *.before-restore-$stamp. Run verify.sh and the browser checks next."
