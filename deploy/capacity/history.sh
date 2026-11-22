#!/usr/bin/env bash
#
# THE CAPACITY HISTORY — the VM half of `VM capacity`'s `history` mode
# (capacity budget step C1b).
#
# Runs ON the VM, as root, from `vm.sh`, which the dispatch-only `VM capacity`
# workflow runs (.github/workflows/vm-capacity.yml). Read-only: it reads the
# day files the capacity recorder writes (deploy/capacity/recorder/, installed
# by apply.sh's host config set) and changes nothing. It calls no docker at all.
#
#   history.sh <hours>      1..192, the window ending now
#
# What it prints, as Markdown tables, because the workflow's logs are public:
#
#   - coverage: the window, the first and last row, how many 10-minute passes
#     were recorded against how many fit, and every run of missed passes — so
#     a gap reads as a gap and never as a quiet night;
#   - per container over the window: peak memory.current, the highest
#     memory.peak, peak anonymous memory, restarts seen (distinct start times),
#     average CPU and the highest 10-minute CPU, in cores;
#   - per container, for each day the window covers, the same memory figures
#     over the parser window (00:15–01:45 UTC) and the nightly chain
#     (02:00–05:30 UTC), with whether memory.peak rose inside the window.
#
# memory.peak is the cgroup's high-water mark SINCE THE CONTAINER STARTED, so
# its value in a window can predate the window. "Rose in window" says whether
# the high-water mark was set inside it: yes means the window's max memory.peak
# is that window's own peak; no means the window stayed below an earlier peak,
# and peak memory.current (a 10-minute sample, so a lower bound) is the window's
# best figure. A restart inside the window says so instead.
#
# Names and numbers only: a row carries nothing else (the recorder writes only
# container names matching docker's name rules, and digits), and this script
# re-checks every field before it prints one.
#
set -euo pipefail
export LC_ALL=C

HOURS="${1:-24}"
case "$HOURS" in '' | *[!0-9]*) echo "hours must be a whole number" >&2; exit 2 ;; esac
[ "$HOURS" -ge 1 ] && [ "$HOURS" -le 192 ] || { echo "hours must be 1..192" >&2; exit 2; }

# Overridable only so the tests can read a fixture directory at a fixed time.
DATA_DIR="${DATA_DIR:-/var/lib/inflect-capacity}"
NOW="${CAPACITY_NOW:-$(date -u +%s)}"
case "$NOW" in '' | *[!0-9]*) echo "the clock is not a whole number of seconds" >&2; exit 2 ;; esac
START=$((NOW - HOURS * 3600))

utc() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

echo "## Recorder coverage"
echo
if [ ! -d "$DATA_DIR" ]; then
    echo "No recorder data directory on the VM: the recorder is not installed, so nothing was recorded. This is not a quiet night. Install it with the \`VM apply\` action \`host-config-apply\`."
    exit 0
fi

# The day files the window spans, oldest first, by the date in the name.
FILES=()
DAYS=""
for day in $(seq $((START / 86400)) $((NOW / 86400))); do
    label="$(date -u -d "@$((day * 86400))" +%F)"
    DAYS="$DAYS $day:$label"
    f="$DATA_DIR/capacity-$label.tsv"
    [ -f "$f" ] && FILES+=("$f")
done

EXPECTED_FILES="$(( NOW / 86400 - START / 86400 + 1 ))"

# One pass over the rows. Every output line is `<section>\t<sort key>\t<text>`,
# sorted and stripped below, because awk has no portable sort.
REPORT="$(
    { [ "${#FILES[@]}" -eq 0 ] || cat -- "${FILES[@]}"; } | awk -F'\t' \
        -v start="$START" -v now="$NOW" -v days="$DAYS" -v startl="$(utc "$START")" -v nowl="$(utc "$NOW")" -v hours="$HOURS" '
    function mib(b) { return (b == "" || b == "-") ? "n/a" : sprintf("%.0f", b / 1048576) }
    function num(v) { return v ~ /^[0-9]+$/ }
    function maxv(a, b) { return (a == "" || (b != "" && b + 0 > a + 0)) ? b : a }
    # How many 10-minute marks (:00, :10, ...) fall in [lo, hi].
    function marks(lo, hi) { return (hi < lo) ? 0 : int(hi / 600) - int((lo + 599) / 600) + 1 }
    BEGIN {
        OFS = "\t"
        # The two windows, in seconds of the UTC day, inclusive.
        wname[1] = "parser 00:15-01:45"; wfrom[1] = 900;  wto[1] = 6300
        wname[2] = "nightly 02:00-05:30"; wfrom[2] = 7200; wto[2] = 19800
        nd = split(days, dl, " ")
        for (i = 1; i <= nd; i++) { split(dl[i], kv, ":"); daylabel[kv[1]] = kv[2] }
    }
    /^#/ || NF == 0 { next }
    {
        if (NF != 9 || !num($1) || $3 !~ /^[A-Za-z0-9][A-Za-z0-9_.-]*$/ \
            || $2 !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z$/ \
            || ($4 != "-" && $4 !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z$/)) { bad++; next }
        for (i = 5; i <= 9; i++) if ($i != "-" && !num($i)) { bad++; next }
        e = $1 + 0
        if (e < start || e > now) next
        # A pass starts a few seconds after its mark; the mark is its slot, so
        # the 05:30 pass belongs to 02:00-05:30 and a second pass in one slot
        # (the run an apply starts) is not counted twice.
        m = e - e % 600
        c = $3; cur = $5; pk = $6; an = $7; us = $9; st = $4
        rows++
        if (!(m in seen)) { seen[m] = 1; ne++; ep[ne] = m; ts[m] = $2 }
        if (!(c in crow)) { nc++; cname[nc] = c }
        crow[c]++
        if (cur != "-") wcur[c] = maxv(wcur[c], cur)
        if (pk != "-") wpk[c] = maxv(wpk[c], pk)
        if (an != "-") wan[c] = maxv(wan[c], an)
        if (st != "-" && !((c, st) in starts)) { starts[c, st] = 1; nstarts[c]++; laststart[c] = st }
        if (st != "-" && st > laststart[c]) laststart[c] = st
        # CPU: a delta only between two rows of the same container start.
        if ((c in pe) && pst[c] == st && st != "-" && us != "-" && pus[c] != "-" && e > pe[c] && us + 0 >= pus[c] + 0) {
            dt = e - pe[c]; du = us - pus[c]
            sdu[c] += du; sdt[c] += dt
            if (dt <= 900) { r = du / 1000000 / dt; if (!(c in mr) || r > mr[c]) mr[c] = r }
        }
        pe[c] = e; pst[c] = st; pus[c] = us
        # The two daily windows.
        d = int(m / 86400); s = m % 86400
        for (w = 1; w <= 2; w++) {
            if (s < wfrom[w] || s > wto[w]) continue
            k = d SUBSEP w SUBSEP c
            if (!(k in drow)) { dfpk[k] = pk; dfst[k] = st }
            drow[k]++
            if (cur != "-") dcur[k] = maxv(dcur[k], cur)
            if (pk != "-") dpk[k] = maxv(dpk[k], pk)
            if (an != "-") dan[k] = maxv(dan[k], an)
            dlpk[k] = pk; dlst[k] = st
            if (st != "-" && !((k, st) in dstarts)) { dstarts[k, st] = 1; dnst[k]++ }
            dw = d SUBSEP w
            if (!((dw, m) in dwseen)) { dwseen[dw, m] = 1; dwpass[dw]++ }
        }
    }
    END {
        print "C", 1, "| Window (UTC) | " startl " to " nowl " (" hours " h) |"
        print "C", 2, "| Rows read | " rows + 0 " |"
        print "C", 3, "| Rows unreadable (skipped) | " bad + 0 " |"
        expected = marks(start, now)
        print "C", 4, "| 10-minute passes recorded / that fit the window | " ne + 0 " / " expected " |"
        if (ne > 0) {
            print "C", 5, "| First row / last row (UTC) | " ts[ep[1]] " / " ts[ep[ne]] " |"
        } else {
            print "C", 5, "| First row / last row (UTC) | none: NO ROW IN THE WINDOW. This is a gap, not a quiet night. |"
        }
        # Gaps: a run of 10-minute marks with no pass, the window edges
        # included. Between two passes that is any distance over one slot.
        prev = start; prevl = "window start"
        for (i = 1; i <= ne + 1; i++) {
            # The newest mark is not a miss until its pass has had a minute.
            if (i <= ne) { e = ep[i]; el = ts[e]; missed = marks(i == 1 ? start : prev + 1, e - 1) }
            else { e = now; el = "now"; missed = marks(ne == 0 ? start : prev + 1, now - 60) }
            if (missed > 0) {
                ng++
                if (ng <= 40) print "G", sprintf("%012d", prev), "| " prevl " | " el " | " sprintf("%.0f", (e - prev) / 60) " | " missed " |"
            }
            prev = e; prevl = el
        }
        print "C", 6, "| Gaps (one or more missed passes) | " ng + 0 (ng > 40 ? " (the first 40 are listed)" : "") " |"
        for (i = 1; i <= nc; i++) {
            c = cname[i]
            avg = (sdt[c] > 0) ? sprintf("%.2f", sdu[c] / 1000000 / sdt[c]) : "n/a"
            mx = (c in mr) ? sprintf("%.2f", mr[c]) : "n/a"
            rs = (nstarts[c] > 0) ? nstarts[c] - 1 : "n/a"
            print "W", c, "| " c " | " crow[c] " | " mib(wcur[c]) " | " mib(wpk[c]) " | " mib(wan[c]) " | " rs " | " (laststart[c] != "" ? laststart[c] : "n/a") " | " avg " | " mx " |"
        }
        # Every daily window that overlaps the read window, with or without rows.
        for (d = int(start / 86400); d <= int(now / 86400); d++) {
            for (w = 1; w <= 2; w++) {
                a = d * 86400 + wfrom[w]; b = d * 86400 + wto[w]
                if (b < start || a > now) continue
                lo = (a > start) ? a : start; hi = (b < now) ? b : now
                fit = marks(lo, hi)
                part = (a < start || b > now) ? " (partly outside the read window)" : ""
                dw = d SUBSEP w
                got = (dw in dwpass) ? dwpass[dw] : 0
                print "P", sprintf("%08d%d", d, w), "| " daylabel[d] " | " wname[w] part " | " got " / " fit " |"
                any = 0
                for (i = 1; i <= nc; i++) {
                    c = cname[i]; k = d SUBSEP w SUBSEP c
                    if (!(k in drow)) continue
                    any = 1
                    if (dfst[k] != dlst[k] || dnst[k] > 1) rose = "restarted"
                    else if (drow[k] < 2) rose = "one row"
                    else if (dfpk[k] == "-" || dlpk[k] == "-") rose = "n/a"
                    else rose = (dlpk[k] + 0 > dfpk[k] + 0) ? "yes" : "no"
                    print "D", sprintf("%08d%d", d, w) "\t" c, "| " daylabel[d] " | " wname[w] " | " c " | " drow[k] " | " mib(dcur[k]) " | " mib(dpk[k]) " | " mib(dan[k]) " | " rose " |"
                }
                if (!any) print "D", sprintf("%08d%d", d, w) "\t~", "| " daylabel[d] " | " wname[w] " | NO ROWS: a gap, not a quiet night | 0 | n/a | n/a | n/a | n/a |"
            }
        }
    }
    '
)"

# The window bounds, formatted here: portable awk cannot format a date.
section() { printf '%s\n' "$REPORT" | awk -F'\t' -v s="$1" '$1 == s' | sort -t "$(printf '\t')" -k2,2 | awk -F'\t' '{ print $NF }'; }
section_d() { printf '%s\n' "$REPORT" | awk -F'\t' '$1 == "D"' | sort -t "$(printf '\t')" -k2,2 -k3,3 | awk -F'\t' '{ print $NF }'; }

echo "| | |"
echo "| --- | --- |"
section C
echo "| Day files read / that the window spans | ${#FILES[@]} / $EXPECTED_FILES |"
echo

GAPS="$(section G)"
if [ -n "$GAPS" ]; then
    echo "Gaps: no pass was recorded between these two points. A gap is missing data, not a quiet night."
    echo
    echo "| From | To | Minutes | Passes missed |"
    echo "| --- | --- | --- | --- |"
    printf '%s\n' "$GAPS"
    echo
fi

echo "## Per container, over the window"
echo
echo "Memory in MiB. memory.current is sampled every 10 minutes, so its peak is a lower bound; memory.peak is the kernel's high-water mark since the container started. Restarts seen is distinct start times minus one. CPU is in cores: the average over every pair of rows from one container start, and the highest 10-minute average."
echo
echo "| Container | Rows | Peak memory.current | Max memory.peak | Peak anon | Restarts seen | Last start (UTC) | Avg CPU | Max 10-min CPU |"
echo "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
section W
echo

echo "## Parser and nightly windows, per day"
echo
echo "Passes recorded in each window, against how many fit it:"
echo
echo "| Day (UTC) | Window | Passes recorded / that fit |"
echo "| --- | --- | --- |"
section P
echo
echo "\"Rose in window\": yes means memory.peak was set inside the window, so its max there is that window's own peak; no means the window stayed under an earlier peak; restarted means a new container started inside it."
echo
echo "| Day (UTC) | Window | Container | Rows | Peak memory.current | Max memory.peak | Peak anon | Rose in window |"
echo "| --- | --- | --- | --- | --- | --- | --- | --- |"
section_d
