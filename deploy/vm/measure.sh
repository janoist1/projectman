#!/usr/bin/env bash
# Samples what the managed VM uses (PM-137): CPU load, memory, disk and the memory of the service
# and of each worker account, as CSV. It only measures: no limit is set or implied. Run it while
# a known number of AI sessions work, then read the peak of each column.
#
#   sudo bash deploy/vm/measure.sh [INTERVAL_SECONDS=10] [SAMPLES=60] > measure.csv
#
# Columns: time, cpus, load1, mem_total_mb, mem_available_mb, swap_used_mb, disk_used_mb,
# disk_avail_mb, then, per account of the profile (service first, workers by uid): rss_mb of all
# its processes. An AI session is 'claude' or 'codex' in the process list: those counts follow.
set -u

PROFILE=${PROFILE:-/etc/projectman/profile.env}
[ -r "$PROFILE" ] || { echo "no installed profile at $PROFILE" >&2; exit 2; }
# shellcheck source=profile.env
. "$PROFILE"
INTERVAL=${1:-10}
SAMPLES=${2:-60}

ACCOUNTS=("$SERVICE_USER")
while IFS=: read -r name _ uid _; do
  if [ "$uid" -ge "$WORKER_UID_MIN" ] && [ "$uid" -le "$WORKER_UID_MAX" ]; then ACCOUNTS+=("$name"); fi
done < <(getent passwd)

# Process lists of other accounts are hidden from non-root (hidepid): run as root to see them all.
[ "$(id -u)" = 0 ] || echo "note: not root, other accounts' processes are invisible (hidepid)" >&2

printf 'time,cpus,load1,mem_total_mb,mem_available_mb,swap_used_mb,disk_used_mb,disk_avail_mb'
for a in "${ACCOUNTS[@]}"; do printf ',rss_mb_%s' "$a"; done
printf ',claude_processes,codex_processes\n'

i=0
while [ "$i" -lt "$SAMPLES" ]; do
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  load=$(cut -d' ' -f1 /proc/loadavg)
  mem_total=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
  mem_avail=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
  swap_used=$(awk '/^SwapTotal:/ {t=$2} /^SwapFree:/ {f=$2} END {print int((t-f)/1024)}' /proc/meminfo)
  disk=$(df -Pm / | awk 'NR==2 {print $3 "," $4}')
  printf '%s,%s,%s,%s,%s,%s,%s' "$now" "$(nproc)" "$load" "$mem_total" "$mem_avail" "$swap_used" "$disk"
  snapshot=$(ps -eo user:32=,rss=,comm=)
  for a in "${ACCOUNTS[@]}"; do
    printf ',%s' "$(printf '%s\n' "$snapshot" | awk -v u="$a" '$1 == u {s += $2} END {print int(s/1024)}')"
  done
  printf ',%s,%s\n' \
    "$(printf '%s\n' "$snapshot" | awk '$3 == "claude" {n++} END {print n+0}')" \
    "$(printf '%s\n' "$snapshot" | awk '$3 == "codex" {n++} END {print n+0}')"
  i=$((i + 1))
  [ "$i" -lt "$SAMPLES" ] && sleep "$INTERVAL"
done
