#!/usr/bin/env bash
# The machine-checkable part of the VM rehearsal (PM-143), as root, on the managed VM.
#
#   sudo bash deploy/vm/rehearse.sh readiness|tests|restart|backup|all [--out DIR]
#
#   readiness  verify.sh, then the verdict on its report (every required check passed, the report fresh)
#   tests      the WHOLE test suite of the deployed commit, the pseudo-terminal files included, as the
#              service account in a scratch copy of the app. A skipped test is a failure here: the
#              sandbox exemption of PM-134 does not count for the VM.
#   restart    restarts the service, waits for the app to answer, readiness again (the gate came back)
#   backup     backup.sh, then check-backup.sh on the archive (restorable by this build)
#   all        the four, in this order
#
# Each step appends one line to a log (default /var/lib/projectman-boundary/rehearsal-<time>.log):
# step, PASS or FAIL, and counts: never file contents, never a secret. What no script can show (the
# browser and the phone, the members' real conversations, the exit-request trial) is the human part of
# docs/MIGRATION.md; this log is only the proof of the rest. Exit status 1 when a step failed.
set -u

PROFILE=${PROFILE:-/etc/projectman/profile.env}
[ "$(id -u)" = 0 ] || { echo "rehearse.sh must run as root" >&2; exit 2; }
[ -r "$PROFILE" ] || { echo "no installed profile at $PROFILE" >&2; exit 2; }
# shellcheck source=profile.env
. "$PROFILE"
STEP=${1:-}
case $STEP in readiness | tests | restart | backup | all) ;; *) echo "usage: rehearse.sh readiness|tests|restart|backup|all [--out DIR]" >&2; exit 2 ;; esac
OUT_DIR=$STATE_DIR
if [ "${2:-}" = --out ]; then OUT_DIR=${3:?--out needs a directory}; fi
install -d -o root -g root -m 0755 "$OUT_DIR"
LOG=$OUT_DIR/rehearsal-$(date -u +%Y%m%dT%H%M%SZ).log
CLI_PATH="$CLI_PREFIX/bin:/usr/local/bin:/usr/bin:/bin"
HERE=$(cd "$(dirname "$0")" && pwd)
FAILED=0

note() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
pass() { note "PASS $1 ${2:-}"; }
fail() { note "FAIL $1 ${2:-}"; FAILED=1; }

step_readiness() {
  local report=$STATE_DIR/readiness.json verdict
  if ! bash "$HERE/verify.sh" --out "$report" >/dev/null 2>&1; then fail readiness "verify.sh did not finish"; return; fi
  verdict=$(cd "$APP_DIR" && env PATH="$CLI_PATH" node --import tsx scripts/vm-readiness.ts "$report" 60 2>&1)
  if printf '%s\n' "$verdict" | grep -q '^READY'; then pass readiness "$(printf '%s\n' "$verdict" | grep -c 'pass') checks reported"; else fail readiness "$(printf '%s\n' "$verdict" | grep -i -e 'fail' -e 'not ready' | head -n 3 | tr '\n' ';')"; fi
}

step_tests() {
  local scratch out summary
  scratch=$(mktemp -d "$SERVICE_HOME/rehearsal.XXXXXX") || { fail tests "no scratch directory"; return; }
  out=$scratch.out
  cp -a "$APP_DIR/." "$scratch/" && chown -R "$SERVICE_USER:$SERVICE_USER" "$scratch"
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="$CLI_PATH" CI=1 sh -c 'cd "$1" && npm test' _ "$scratch" >"$out" 2>&1
  local status=$?
  # vitest prints "Tests  N passed | M skipped" per workspace: any skipped, failed or todo test fails the step.
  summary=$(grep -E '^ *Tests +' "$out" | tr -s ' ' | tr '\n' ';')
  # apps/server/vitest.config.ts leaves the pseudo-terminal files out, with a notice and no "skipped" count,
  # when no pseudo-terminal can be opened: on the VM that is a failure, so the notice and their absence both count.
  local ptyfiles goldens
  ptyfiles=$(grep -c 'integration\.test\.ts' "$out")
  goldens=$(grep -c 'golden-path-.*\.test\.ts' "$out")
  if grep -q 'No pseudo-terminal can be opened' "$out" || [ "$ptyfiles" -lt 1 ] || [ "$goldens" -lt 1 ]; then
    fail tests "the pseudo-terminal test files did not run (integration files seen: $ptyfiles, golden paths: $goldens); the output is kept in $out"
    rm -rf "$scratch"
    return
  fi
  if [ "$status" = 0 ] && [ -n "$summary" ] && ! printf '%s' "$summary" | grep -Eq 'skipped|failed|todo'; then
    pass tests "$summary; pseudo-terminal files run: $ptyfiles integration, $goldens golden path"
  else
    fail tests "exit $status; ${summary:-no summary}; the output is kept in $out"
    rm -rf "$scratch"
    return
  fi
  rm -rf "$scratch" "$out"
}

step_restart() {
  local waited=0
  systemctl restart projectman || { fail restart "systemctl restart failed"; return; }
  while ! curl -fsS "http://127.0.0.1:$APP_PORT/api/setup" >/dev/null 2>&1; do
    waited=$((waited + 1))
    if [ "$waited" -gt 30 ]; then fail restart "the app did not answer within 30 s"; return; fi
    sleep 1
  done
  pass restart "answered after ${waited} s; units: $(systemctl is-active projectman projectman-gate | tr '\n' ' ')"
  step_readiness
}

step_backup() {
  local archive=$OUT_DIR/rehearsal-backup-$$.tar.gz
  case $(realpath -m "$archive") in "$SERVICE_HOME"/* | "$WORKER_HOME_ROOT"/*) fail backup "--out must be outside the backed-up trees"; return ;; esac
  if ! bash "$HERE/backup.sh" "$archive" >/dev/null 2>&1; then fail backup "backup.sh failed"; return; fi
  if bash "$HERE/check-backup.sh" "$archive" >/dev/null 2>&1; then pass backup "archive $(du -h "$archive" | cut -f1), restorable by this build"; else fail backup "check-backup.sh refused the archive"; fi
  # The archive is a SECRET and only a rehearsal artifact: removed (a real backup is made with backup.sh by a person).
  rm -f "$archive" "$archive.sha256"
}

note "rehearsal $STEP of $(cat "$APP_DIR/DEPLOYED_COMMIT" 2>/dev/null || echo unknown-commit) on $(. /etc/os-release && echo "$PRETTY_NAME")"
case $STEP in
  readiness) step_readiness ;;
  tests) step_tests ;;
  restart) step_restart ;;
  backup) step_backup ;;
  all) step_readiness; step_tests; step_restart; step_backup ;;
esac
[ "$FAILED" = 0 ] && note "rehearsal $STEP: every step passed" || note "rehearsal $STEP: a step FAILED"
echo "log: $LOG"
exit "$FAILED"
