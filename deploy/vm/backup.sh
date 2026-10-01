#!/usr/bin/env bash
# Backs up everything the managed VM profile keeps (PM-137), as root.
#
#   sudo ./backup.sh /path/outside/the/backed-up/dirs/projectman-backup.tar.gz
#
# The service is stopped for a consistent copy (SQLite WAL files, customization/.git, the cookie
# secret, attachments, worktrees) and started again. The archive holds the CLIs' login state and
# transcripts, so it is a SECRET: it is created readable by root only. Encrypt it before it leaves
# the machine, and keep it away from the repository and from any task, note or message.
# Not included: /etc/projectman, the app and the CLIs (bootstrap.sh and install-app.sh rebuild
# them from the repository and the profile) and the Tailscale identity (a person re-registers).
set -eu

PROFILE=${PROFILE:-/etc/projectman/profile.env}
[ "$(id -u)" = 0 ] || { echo "backup.sh must run as root" >&2; exit 2; }
[ -r "$PROFILE" ] || { echo "no installed profile at $PROFILE" >&2; exit 2; }
# shellcheck source=profile.env
. "$PROFILE"
OUT=${1:?usage: backup.sh OUT.tar.gz}
case $(realpath -m "$OUT") in
  "$SERVICE_HOME"/*|"$WORKER_HOME_ROOT"/*) echo "the archive must be outside $SERVICE_HOME and $WORKER_HOME_ROOT" >&2; exit 2 ;;
esac
[ ! -e "$OUT" ] || { echo "$OUT exists" >&2; exit 2; }

was_active=0
if [ "$(systemctl is-active projectman 2>/dev/null)" = active ]; then was_active=1; fi
restart() { [ "$was_active" = 1 ] && systemctl start projectman; return 0; }
trap restart EXIT

systemctl stop projectman 2>/dev/null || true
umask 077
tar --numeric-owner -C / -czpf "$OUT" "${SERVICE_HOME#/}" "${WORKER_HOME_ROOT#/}"
(cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
echo "backup written to $OUT ($(du -h "$OUT" | cut -f1)); checksum in $OUT.sha256"
