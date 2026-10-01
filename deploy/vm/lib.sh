# shellcheck shell=bash
# Shared helpers of the managed VM profile (PM-137). Sourced by verify.sh (and its test), never run.
# Compatible with bash 3.2 so the report format can be tested on a Mac as well as on the guest.

CHECK_LINES=()

# json_escape TEXT: printable ASCII only, one line, quotes and backslashes escaped, at most 500
# characters. Evidence is a short note of what was measured, not a transcript.
json_escape() {
  local s=$1
  s=$(printf '%s' "$s" | LC_ALL=C tr '\t\r\n' '   ' | LC_ALL=C tr -cd '\040-\176')
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "${s:0:500}"
}

# record ID STATUS EVIDENCE  (STATUS: pass | fail | unverified)
record() {
  local id=$1 status=$2 evidence=${3:-}
  [ -n "$evidence" ] || evidence='(no detail)'
  CHECK_LINES+=("{\"id\":\"$id\",\"status\":\"$status\",\"evidence\":\"$(json_escape "$evidence")\"}")
}

# emit_report NAME VERSION OS KERNEL ARCH: the report on stdout, in the shape of VmReadinessReport
# (packages/shared/src/deploy/vm-readiness.ts). Nothing but the checks decides readiness.
emit_report() {
  local name=$1 version=$2 os=$3 kernel=$4 arch=$5 first=1 line
  printf '{"schemaVersion":1,"profile":{"name":"%s","version":%s},"generatedAt":"%s","host":{"os":"%s","kernel":"%s","arch":"%s"},"checks":[' \
    "$(json_escape "$name")" "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(json_escape "$os")" "$(json_escape "$kernel")" "$(json_escape "$arch")"
  for line in "${CHECK_LINES[@]}"; do
    if [ "$first" = 1 ]; then first=0; else printf ','; fi
    printf '%s' "$line"
  done
  printf ']}\n'
}

# matches_any PATH PATTERNS: true when PATH matches one of the blank-separated glob PATTERNS.
matches_any() {
  local path=$1 patterns=$2 pat ok=1
  set -f
  for pat in $patterns; do
    # shellcheck disable=SC2254
    case $path in $pat) ok=0 ;; esac
  done
  set +f
  return "$ok"
}

# version_at_least MIN ACTUAL: dotted versions, compared with sort -V.
version_at_least() {
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}
