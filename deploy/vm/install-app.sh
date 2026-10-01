#!/usr/bin/env bash
# Installs or updates the app on the managed VM (PM-137), as root.
#
#   sudo ./install-app.sh --archive projectman.tar.gz --commit <40-hex> [--smoke]
#
# The archive is `git archive` output of that commit (the repository is local-only, so nothing is
# cloned). The build runs as the service account in a staging directory; then the whole tree is
# handed to root, so neither the service nor a worker can change the running app afterwards.
# The previous tree stays as $APP_DIR.prev for a rollback. The data is not touched.
set -eu

PROFILE=${PROFILE:-/etc/projectman/profile.env}
ARCHIVE=
COMMIT=
SMOKE=0
while [ $# -gt 0 ]; do
  case $1 in
    --archive) ARCHIVE=${2:?--archive needs a file}; shift 2 ;;
    --commit) COMMIT=${2:?--commit needs a sha}; shift 2 ;;
    --smoke) SMOKE=1; shift ;;
    *) echo "usage: install-app.sh --archive FILE --commit SHA [--smoke]" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "install-app.sh must run as root" >&2; exit 2; }
[ -r "$PROFILE" ] || { echo "no installed profile at $PROFILE (run bootstrap.sh first)" >&2; exit 2; }
# shellcheck source=profile.env
. "$PROFILE"
[ -f "$ARCHIVE" ] || { echo "archive not found: $ARCHIVE" >&2; exit 2; }
printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{40}$' || { echo "--commit must be the full 40-hex commit id" >&2; exit 2; }

STAGE=$APP_DIR.new
CLI_PATH="$CLI_PREFIX/bin:/usr/local/bin:/usr/bin:/bin"
umask 022

rm -rf "$STAGE"
install -d -o root -g root -m 0755 "$STAGE"
tar -xzf "$ARCHIVE" -C "$STAGE" --no-same-owner
chown -R "$SERVICE_USER:$SERVICE_USER" "$STAGE"

# Install the build dependencies too: do not use --omit=dev before building.
runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="$CLI_PATH" sh -c 'cd "$1" && npm ci --no-audit --no-fund && npm run build' _ "$STAGE"
if [ "$SMOKE" = 1 ]; then
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="$CLI_PATH" sh -c 'cd "$1" && npm run smoke:prod' _ "$STAGE"
fi
printf '%s\n' "$COMMIT" > "$STAGE/DEPLOYED_COMMIT"
chown -R root:root "$STAGE"
chmod -R go-w "$STAGE"

systemctl stop projectman 2>/dev/null || true
rm -rf "$APP_DIR.prev"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.prev"
mv "$STAGE" "$APP_DIR"
# The launcher (PM-140) runs from the app tree too: the new one takes over (its socket stays).
systemctl try-restart projectman-launcher.service 2>/dev/null || true
systemctl start projectman
echo "installed $COMMIT in $APP_DIR (previous tree: $APP_DIR.prev)"
