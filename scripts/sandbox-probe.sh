#!/bin/sh
# Manual entry point only. No real agent CLI is launched by this script.
# See docs/SANDBOX-PROBE.md for interactive subscription-only instructions.
set -eu
exec node "$(dirname "$0")/sandbox-probe.mjs" "$@"
