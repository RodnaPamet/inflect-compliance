#!/usr/bin/env bash
#
# THE CAPACITY RECORDER — one pass (capacity budget step C1b).
#
# Installed on the production VM as /usr/local/lib/inflect-capacity/inflect-capacity-record.sh
# by `deploy/apply.sh`'s host config set (the `VM apply` actions
# `host-config-preflight` / `host-config-apply`), and run as root every 10
# minutes by inflect-capacity-record.timer. Read back by the `VM capacity`
# workflow's `history` mode (deploy/capacity/history.sh).
#
# WHY IT EXISTS. C1b needs app's and worker's memory peaks across the
# 02:00–05:30 UTC nightly jobs and the 00:15–01:45 UTC parser window. The
# snapshot cannot give them: Watchtower recreates app and worker on every merge
# to main, which resets their cgroup `memory.peak`, and `VM capacity` samples
# only once the owner approves a run, which is never at night. So this records
# the same cgroup v2 files the snapshot reads (deploy/capacity/remote.sh), on a
# timer, and keeps the rows for about eight days.
#
# ONE ROW PER RUNNING CONTAINER PER RUN, tab-separated, to
# ${DATA_DIR}/capacity-YYYY-MM-DD.tsv (the UTC day):
#
#   epoch  taken_utc  container  started_at  mem_current  mem_peak  anon  file  cpu_usage_usec
#
# Memory figures are bytes; `cpu_usage_usec` is cumulative since the container
# started, so a delta between two rows with the same `started_at` is CPU time.
# A field the kernel does not report is `-`. `started_at` is what makes a
# restart visible: a new value is a new container, with fresh counters.
#
# NAMES AND NUMBERS ONLY. Two docker calls per run, each naming the fields it
# prints: `docker ps` for id and name, one `docker inspect` for every id's
# start time. Nothing is read from a container's environment, command line or
# labels, and nothing touches a container: a single read pass over cgroups.
#
# IT CAN NEVER FILL THE DISK. Before writing it deletes day files older than
# KEEP_DAYS, then refuses the write (exit 0, with a line in the journal) when
# the day's file is already MAX_FILE_BYTES, when the directory is already
# MAX_DIR_BYTES, or when the filesystem has less than MIN_FREE_KB free. A day is
# about 0.3 MB at today's container count, so the caps are far above normal use.
#
# It exits 0 when Docker is down or unreachable, recording nothing: the gap is
# visible in the history's coverage table, which is the point of having one.
#
# The variables below are overridable only so the tests and apply.sh's
# preflight can run a pass against another directory; the unit sets none.
set -uo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/inflect-capacity}"
CGROUP_ROOT="${CGROUP_ROOT:-/sys/fs/cgroup}"
NOW="${CAPACITY_NOW:-$(date -u +%s)}"
KEEP_DAYS=8
MAX_FILE_BYTES=4194304
MAX_DIR_BYTES=41943040
MIN_FREE_KB=1048576

say() { echo "inflect-capacity-record: $*"; }

case "$NOW" in '' | *[!0-9]*) say "the clock is not a whole number of seconds; nothing recorded"; exit 0 ;; esac

install -d -m 0700 "$DATA_DIR" || { say "cannot create the data directory; nothing recorded"; exit 0; }

# Retention by the date in the NAME, not by mtime: keep today and the KEEP_DAYS
# before it, so a 192-hour read always finds the nine day files it spans.
CUTOFF="$(date -u -d "@$((NOW - KEEP_DAYS * 86400))" +%F)"
for f in "$DATA_DIR"/capacity-*.tsv; do
    [ -e "$f" ] || continue
    day="${f##*/capacity-}"; day="${day%.tsv}"
    if [[ "$day" < "$CUTOFF" ]]; then rm -f -- "$f"; fi
done

TODAY_FILE="$DATA_DIR/capacity-$(date -u -d "@$NOW" +%F).tsv"
file_bytes="$( [ -f "$TODAY_FILE" ] && stat -c %s "$TODAY_FILE" || echo 0)"
dir_bytes="$(find "$DATA_DIR" -maxdepth 1 -type f -name 'capacity-*.tsv' -printf '%s\n' | awk '{ s += $1 } END { print s + 0 }')"
free_kb="$(df -Pk "$DATA_DIR" | awk 'NR == 2 { print $4 }')"
if [ "$file_bytes" -ge "$MAX_FILE_BYTES" ]; then say "today's file is at its cap ($MAX_FILE_BYTES bytes); nothing recorded"; exit 0; fi
if [ "$dir_bytes" -ge "$MAX_DIR_BYTES" ]; then say "the data directory is at its cap ($MAX_DIR_BYTES bytes); nothing recorded"; exit 0; fi
if [ "${free_kb:-0}" -lt "$MIN_FREE_KB" ]; then say "less than $MIN_FREE_KB KiB free on the filesystem; nothing recorded"; exit 0; fi

# Id and name of every running container. A failure is Docker being down.
if ! PS_OUT="$(timeout 20 docker ps --no-trunc --format '{{.ID}} {{.Names}}' 2>/dev/null)"; then
    say "docker is not answering; nothing recorded"
    exit 0
fi
[ -n "$PS_OUT" ] || { say "no running container; nothing recorded"; exit 0; }

# One inspect for every id: `<id> <StartedAt>`.
mapfile -t IDS < <(awk '{ print $1 }' <<<"$PS_OUT")
if ! INSPECT_OUT="$(timeout 20 docker inspect --format '{{.Id}} {{.State.StartedAt}}' "${IDS[@]}" 2>/dev/null)"; then
    say "docker inspect failed; nothing recorded"
    exit 0
fi

read_value() { if [ -r "$1" ]; then tr -d '[:space:]' <"$1"; else echo -; fi; }
stat_value() { if [ -r "$1" ]; then awk -v k="$2" '$1 == k { print $2; found = 1 } END { if (!found) print "-" }' "$1"; else echo -; fi; }
number_or_dash() { case "$1" in '' | *[!0-9]*) echo - ;; *) echo "$1" ;; esac; }

TAKEN="$(date -u -d "@$NOW" +%Y-%m-%dT%H:%M:%SZ)"
ROWS=""
while read -r ID NAME; do
    [ -n "$ID" ] || continue
    # A container name is [a-zA-Z0-9][a-zA-Z0-9_.-]*; anything else is not
    # written, so a row can never carry text the reader would print.
    case "$NAME" in '' | *[!A-Za-z0-9_.-]*) continue ;; esac
    STARTED="$(awk -v id="$ID" '$1 == id { print substr($2, 1, 19) "Z"; exit }' <<<"$INSPECT_OUT")"
    case "$STARTED" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;; *) STARTED=- ;; esac
    CG=""
    for candidate in "$CGROUP_ROOT/system.slice/docker-$ID.scope" "$CGROUP_ROOT/docker/$ID"; do
        [ -d "$candidate" ] && CG="$candidate" && break
    done
    [ -n "$CG" ] || continue
    CURRENT="$(number_or_dash "$(read_value "$CG/memory.current")")"
    PEAK="$(number_or_dash "$(read_value "$CG/memory.peak")")"
    ANON="$(number_or_dash "$(stat_value "$CG/memory.stat" anon)")"
    FILE="$(number_or_dash "$(stat_value "$CG/memory.stat" file)")"
    USAGE="$(number_or_dash "$(stat_value "$CG/cpu.stat" usage_usec)")"
    ROWS+="$NOW	$TAKEN	$NAME	$STARTED	$CURRENT	$PEAK	$ANON	$FILE	$USAGE"$'\n'
done <<<"$PS_OUT"

[ -n "$ROWS" ] || { say "no container cgroup was readable; nothing recorded"; exit 0; }

# One append per run, so a reader never sees half a pass. The header is written
# once, when the day's file is created.
umask 077
if [ ! -s "$TODAY_FILE" ]; then
    printf '# epoch\ttaken_utc\tcontainer\tstarted_at\tmem_current\tmem_peak\tanon\tfile\tcpu_usage_usec\n' >>"$TODAY_FILE"
fi
printf '%s' "$ROWS" >>"$TODAY_FILE"
exit 0
