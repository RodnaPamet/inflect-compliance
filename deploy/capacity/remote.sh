#!/usr/bin/env bash
#
# THE VM CAPACITY SNAPSHOT — the VM half (the AI roadmap's capacity budget, C0).
#
# Runs ON the VM, as root, from `vm.sh`, which the dispatch-only `VM capacity`
# workflow runs (.github/workflows/vm-capacity.yml). Read-only: it changes
# nothing on the VM.
#
#   remote.sh <samples> <interval-seconds>
#
# What it prints, as Markdown tables, because the workflow's logs are public:
# the machine type, CPU count, memory, swap, disk and load; and per running
# container its name, start time, restart count, configured limits, memory now,
# peak memory since it started (cgroup v2 `memory.peak`, where the kernel has
# it), anonymous and page-cache memory, average CPU since start, and OOM kills;
# then `samples` rows of `docker stats`, `interval` seconds apart.
#
# What it never prints: an environment file, a compose file, a container's
# environment, command line or labels, or a process list. Every `docker`
# call names the fields it prints, and nothing else is read from a container.
#
set -euo pipefail

SAMPLES="${1:-1}"
INTERVAL="${2:-60}"
case "$SAMPLES" in ''|*[!0-9]*) echo "samples must be a whole number" >&2; exit 2 ;; esac
case "$INTERVAL" in ''|*[!0-9]*) echo "interval must be a whole number of seconds" >&2; exit 2 ;; esac
[ "$SAMPLES" -ge 1 ] && [ "$SAMPLES" -le 72 ] || { echo "samples must be 1..72" >&2; exit 2; }
[ "$INTERVAL" -ge 10 ] && [ "$INTERVAL" -le 600 ] || { echo "interval must be 10..600 seconds" >&2; exit 2; }

mib() { awk -v b="${1:-0}" 'BEGIN { if (b == "" || b == "max") print "none"; else printf "%.0f", b / 1048576 }'; }
read_or() { [ -r "$1" ] && cat "$1" || echo "$2"; }
stat_field() { [ -r "$1" ] && awk -v k="$2" '$1 == k { print $2 }' "$1" || true; }

NOW_EPOCH="$(date -u +%s)"

echo "## Host"
echo
MACHINE_TYPE="$(curl -fsS -m 5 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/machine-type 2>/dev/null | sed 's#.*/##' || true)"
echo "| | |"
echo "| --- | --- |"
echo "| Taken (UTC) | $(date -u +%Y-%m-%dT%H:%M:%SZ) |"
echo "| Machine type | ${MACHINE_TYPE:-unknown} |"
echo "| CPUs | $(nproc) |"
awk '
    /^MemTotal:/     { t = $2 }
    /^MemAvailable:/ { a = $2 }
    /^SwapTotal:/    { st = $2 }
    /^SwapFree:/     { sf = $2 }
    END {
        printf "| Memory total (MiB) | %.0f |\n", t / 1024
        printf "| Memory available (MiB) | %.0f |\n", a / 1024
        printf "| Swap total / used (MiB) | %.0f / %.0f |\n", st / 1024, (st - sf) / 1024
    }' /proc/meminfo
echo "| Load (1, 5, 15 min) | $(cut -d' ' -f1-3 /proc/loadavg) |"
echo "| Uptime (days) | $(awk '{ printf "%.1f", $1 / 86400 }' /proc/uptime) |"
echo "| cgroup | $(stat -fc %T /sys/fs/cgroup) |"
echo "| Kernel OOM kills since boot | $(awk '$1 == "oom_kill" { print $2 }' /proc/vmstat) |"
for mount in / /var/lib/docker; do
    if [ -d "$mount" ]; then
        df -BG --output=target,size,used,avail "$mount" | awk -v m="$mount" 'NR == 2 { printf "| Disk %s (size / used / free) | %s / %s / %s |\n", m, $2, $3, $4 }'
    fi
done
echo

echo "## Containers"
echo
echo "Peak is the cgroup's \`memory.peak\` since the container started; \"n/a\" where the kernel does not report it. Anon is process memory; file is page cache, which the kernel reclaims under pressure. CPU is the average since start, in cores."
echo
echo "| Container | Started (UTC) | Restarts | Mem limit (MiB) | CPU limit | Mem now (MiB) | Mem peak (MiB) | Anon (MiB) | File (MiB) | Avg CPU since start | OOM kills |"
echo "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
for ID in $(docker ps --no-trunc --format '{{.ID}}'); do
    NAME="$(docker inspect -f '{{.Name}}' "$ID" | sed 's#^/##')"
    STARTED="$(docker inspect -f '{{.State.StartedAt}}' "$ID" | cut -c1-19)"
    RESTARTS="$(docker inspect -f '{{.RestartCount}}' "$ID")"
    MEM_LIMIT="$(docker inspect -f '{{.HostConfig.Memory}}' "$ID")"
    NANO_CPUS="$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$ID")"
    CG=""
    for candidate in "/sys/fs/cgroup/system.slice/docker-$ID.scope" "/sys/fs/cgroup/docker/$ID"; do
        [ -d "$candidate" ] && CG="$candidate" && break
    done
    CURRENT="$(read_or "$CG/memory.current" "")"
    PEAK="$(read_or "$CG/memory.peak" "")"
    ANON="$(stat_field "$CG/memory.stat" anon)"
    FILE="$(stat_field "$CG/memory.stat" file)"
    USAGE_USEC="$(stat_field "$CG/cpu.stat" usage_usec)"
    OOM="$(stat_field "$CG/memory.events" oom_kill)"
    START_EPOCH="$(date -u -d "$STARTED" +%s 2>/dev/null || echo "$NOW_EPOCH")"
    AVG_CPU="$(awk -v u="${USAGE_USEC:-}" -v s="$((NOW_EPOCH - START_EPOCH))" \
        'BEGIN { if (u == "" || s <= 0) print "n/a"; else printf "%.2f", (u / 1000000) / s }')"
    LIMIT_MIB="$( [ "$MEM_LIMIT" = 0 ] && echo none || mib "$MEM_LIMIT")"
    CPU_LIMIT="$( [ "$NANO_CPUS" = 0 ] && echo none || awk -v n="$NANO_CPUS" 'BEGIN { printf "%.2f", n / 1e9 }')"
    printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' \
        "$NAME" "$STARTED" "$RESTARTS" "$LIMIT_MIB" "$CPU_LIMIT" \
        "$( [ -n "$CURRENT" ] && mib "$CURRENT" || echo n/a)" \
        "$( [ -n "$PEAK" ] && mib "$PEAK" || echo n/a)" \
        "$( [ -n "$ANON" ] && mib "$ANON" || echo n/a)" \
        "$( [ -n "$FILE" ] && mib "$FILE" || echo n/a)" \
        "$AVG_CPU" "${OOM:-n/a}"
done
echo

echo "## Samples"
echo
echo "Container CPU and memory, $SAMPLES sample(s), $INTERVAL s apart."
echo
echo "| Taken (UTC) | Container | CPU | Memory |"
echo "| --- | --- | --- | --- |"
for i in $(seq 1 "$SAMPLES"); do
    TAKEN="$(date -u +%H:%M:%S)"
    docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' |
        awk -F'|' -v t="$TAKEN" '{ printf "| %s | %s | %s | %s |\n", t, $1, $2, $3 }'
    if [ "$i" -lt "$SAMPLES" ]; then sleep "$INTERVAL"; fi
done
