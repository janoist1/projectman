#!/usr/bin/env bash
# Runs the move tool (scripts/migrate/cli.ts, PM-143) on the managed VM as the service account, with
# the pinned Node, so what it creates (a standby home, repositories, pending work) belongs to the
# service and not to root.
#
#   sudo bash /srv/projectman/deploy/vm/migrate.sh apply --package /var/lib/projectman/incoming/pkg \
#        --target-home /var/lib/projectman/data --map /Users/i/Dev/projectman=/var/lib/projectman/repos/PM
#   sudo bash /srv/projectman/deploy/vm/migrate.sh verify --home /var/lib/projectman/data
#   sudo bash /srv/projectman/deploy/vm/migrate.sh instance activate --home /var/lib/projectman/data --confirm-source-retired
#
# The package is a secret: put it under $SERVICE_HOME/incoming (mode 0700, owned by the service),
# never somewhere a worker can read. The service must be stopped for apply, verify and instance
# changes (the tool refuses when the database is open). docs/MIGRATION.md has the whole procedure.
set -eu

PROFILE=${PROFILE:-/etc/projectman/profile.env}
[ "$(id -u)" = 0 ] || { echo "migrate.sh must run as root" >&2; exit 2; }
[ -r "$PROFILE" ] || { echo "no installed profile at $PROFILE (run bootstrap.sh first)" >&2; exit 2; }
# shellcheck source=profile.env
. "$PROFILE"
[ $# -gt 0 ] || { echo "usage: migrate.sh <inventory|package|apply|verify|instance|work> ..." >&2; exit 2; }

CLI_PATH="$CLI_PREFIX/bin:/usr/local/bin:/usr/bin:/bin"
umask 077
exec runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="$CLI_PATH" PROJECTMAN_HOME="$PROJECTMAN_HOME" \
  sh -c 'cd "$1" && shift && exec node --import tsx scripts/migrate/cli.ts "$@"' _ "$APP_DIR" "$@"
