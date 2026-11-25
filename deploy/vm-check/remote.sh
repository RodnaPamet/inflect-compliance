#!/usr/bin/env bash
#
# READ-ONLY CHECKS ON THE PRODUCTION VM — the VM half.
#
# Runs ON the VM, as root, from `vm.sh`, which the dispatch-only `VM check`
# workflow runs (.github/workflows/vm-check.yml). Read-only: it changes nothing
# on the VM, and its database queries run in read-only transactions.
# tei-embed-timing sends tei-embed a bounded, serial, synthetic load to time it;
# that changes no state, and it starts, stops and recreates nothing.
#
#   remote.sh <check>
#
#   containers           each container's name, image, state and start time,
#                        and the image digest the app and worker run
#   library-sync         the counts from the last library and crosswalk sync
#   log-errors           error and fatal log lines in the last 24 hours, counted
#                        per container and component (or job), with each
#                        container's start time: its log begins there
#   access-review-dates  access-review campaigns with a 1970 date or a period
#                        that ends before it starts, counted per scope (#4390)
#   bcrypt               whether the app's native bcrypt module loads and
#                        verifies a hash (#4340)
#   automation-rules     ENABLED automation rules, counted in all, per trigger
#                        event and per action type, and the tenants holding
#                        one: what AUTOMATION_WEB_EVENTS_ENABLED would wake
#   tei-embed-timing     tei-embed's latency and memory under a small, serial,
#                        synthetic load (Retriever Phase 0.5): a query's
#                        p50/p95, passage batches of 8/16/32/64 against the
#                        seam's 15 s deadline, the cgroup's memory and CPU
#                        throttling before and after
#   migrate-role         the database role `prisma migrate deploy` runs as in
#                        the app container, whether it is a superuser, and
#                        whether the vector extension is available and
#                        installed in the app's database (#5720)
#   calendar-observations `calendar.vendor_observation` lines in the app's and
#                        the worker's logs over the last 72 hours, counted per
#                        provider, operation, status, code and date shape: what
#                        Graph, Entra and Google answered the calendar push
#                        (#5957, docs/runbooks/calendar-vendor-verification.md)
#   managed-agents-workspace-header
#                        the Managed Agents engine's workspace-header tally
#                        lines in the app's and the worker's logs over the last
#                        48 hours, summed per workspace kind and endpoint: how
#                        many responses named the configured Anthropic
#                        workspace, named none, or named another (#5962)
#
# THE WORKFLOW'S LOGS ARE PUBLIC, because the repository is. So this prints
# names, states, versions and counts, and never a log line, a row, an
# environment file, a compose file, or a container's environment, command line
# or labels. Log output is only ever piped into a filter that extracts named
# counters or counts lines; it never reaches stdout itself.
#
set -euo pipefail

CHECK="${1:?check}"
CGROUP_ROOT="${CGROUP_ROOT:-/sys/fs/cgroup}"

# A compose service's running container, by the label compose sets.
container() { docker ps -qf "label=com.docker.compose.service=$1" | head -n 1; }

need() {
    local id
    id="$(container "$1")"
    [ -n "$id" ] || { echo "no running '$1' container" >&2; exit 1; }
    printf '%s' "$id"
}

# ── tei-embed-timing ──────────────────────────────────────────────────────────
#
# Retriever Phase 0.5 (docs/ai-architecture/nemotron-retriever.md): the
# embedder's latency and memory on THIS VM, which the indexing caller's batch
# size and the seam's deadline (TEI_DEADLINE_MS, 15 s) are decided against.
#
# How it reaches the service: `docker exec` into the running tei-embed
# container, running the image's own curl (its healthcheck's) against its own
# loopback port. No container is started, recreated or restarted, no network is
# joined and no port is published. curl times each request itself, so docker
# exec's start-up is not in the figures.
#
# What it sends: text this function generates from a fixed word list, the same
# every run. Never a row, a file or anything read from the stack. Bodies go to
# the container's stdin; every answer is discarded inside the container
# (`-o /dev/null`), except /tokenize's, which only a counter reads.
#
# The load is bounded and serial: one request at a time, 20 queries and three
# runs per batch size, each request cut at 60 s, no request started after
# 480 s, and a batch size that fails stops the larger ones. The container is
# capped at one core at half CPU weight, so the batches compete with the
# request path for at most that core while they run.
TEI_URL="http://127.0.0.1:8080"
TEI_MODEL="intfloat/multilingual-e5-small"
TEI_DEADLINE_S=15
TEI_TIMEOUT_S=60
TEI_BUDGET_S=480
TEI_QUERY_CALLS=20
TEI_BATCH_SIZES="8 16 32 64"
TEI_BATCH_REPS=3
TEI_PASSAGE_WORDS=600

# One request body. kind: query (one 20-token query), passages (n passages of
# 600 words, more than the model's 512 tokens, so --auto-truncate makes each
# exactly 512) or tokenize (one passage, for the token count).
tei_body() {
    awk -v kind="$1" -v n="${2:-0}" -v words="$TEI_PASSAGE_WORDS" -v model="$TEI_MODEL" '
        function passage(p,    s, i) {
            s = "passage: synthetic passage " p "."
            for (i = 1; i <= words; i++) s = s " " v[1 + (i * 7 + p * 13) % k]
            return s
        }
        BEGIN {
            k = split("access account annual approval asset audit backup boundary change control data deadline device employee encryption evidence incident inventory key log monitoring notice owner password policy privilege process record recovery register review risk role schedule security service supplier system test training", v, " ")
            if (kind == "tokenize") { printf "{\"inputs\":\"%s\"}", passage(1); exit }
            printf "{\"model\":\"%s\",\"input\":[", model
            if (kind == "query") printf "\"query: which supplier must notify the controller of a personal data breach within seventy two hours\""
            else for (p = 1; p <= n; p++) printf "%s\"%s\"", (p == 1 ? "" : ","), passage(p)
            printf "]}"
        }'
}

# One timed request to /v1/embeddings, the seam's route: prints
# "<http code> <seconds>". A request cut at the timeout prints code 000.
tei_time() {
    tei_body "$2" "${3:-0}" | docker exec -i "$1" curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' --max-time "$TEI_TIMEOUT_S" -H 'content-type: application/json' --data-binary @- "$TEI_URL/v1/embeddings" 2>/dev/null || true
}

# min, median, p95 (nearest rank) and max of the seconds on stdin, times scale.
tei_stats() {
    sort -g | awk -v scale="$1" -v fmt="$2" '
        { x[NR] = $1 * scale }
        END {
            if (NR == 0) { print "- - - -"; exit }
            m = (NR % 2 == 1) ? x[(NR + 1) / 2] : (x[NR / 2] + x[NR / 2 + 1]) / 2
            r = int(0.95 * NR); if (r < 0.95 * NR) r++
            printf fmt " " fmt " " fmt " " fmt "\n", x[1], m, x[r], x[NR]
        }'
}

# A cgroup file's first line, or a field of a flat-keyed one; "-" when absent.
cg_read() { local v=""; [ -r "$1" ] && v="$(head -n 1 "$1")"; printf '%s' "${v:--}"; }
cg_field() { local v=""; [ -r "$1" ] && v="$(awk -v k="$2" '$1 == k { print $2 }' "$1")"; printf '%s' "${v:--}"; }
# Bytes as MiB; "n/a" for anything that is not a number of bytes.
cg_mib() { awk -v b="$1" 'BEGIN { if (b ~ /^[0-9]+$/) printf "%.0f", b / 1048576; else print "n/a" }'; }
# after - before, divided; "n/a" unless both are numbers.
cg_delta() { awk -v a="$1" -v b="$2" -v d="$3" -v fmt="$4" 'BEGIN { if (a ~ /^[0-9]+$/ && b ~ /^[0-9]+$/) printf fmt, (b - a) / d; else print "n/a" }'; }

# memory.current memory.peak anon file oom_kill usage_usec nr_periods
# nr_throttled throttled_usec, one line.
tei_snapshot() {
    echo "$(cg_read "$1/memory.current") $(cg_read "$1/memory.peak") $(cg_field "$1/memory.stat" anon) $(cg_field "$1/memory.stat" file) $(cg_field "$1/memory.events" oom_kill) $(cg_field "$1/cpu.stat" usage_usec) $(cg_field "$1/cpu.stat" nr_periods) $(cg_field "$1/cpu.stat" nr_throttled) $(cg_field "$1/cpu.stat" throttled_usec)"
}

tei_timing() {
    local id health cg c started tokens start code secs i n r times ok why skip slowest
    local b_cur b_peak b_anon b_file b_oom b_use b_per b_thr b_thu
    local a_cur a_peak a_anon a_file a_oom a_use a_per a_thr a_thu
    id="$(docker ps --no-trunc -qf "label=com.docker.compose.service=tei-embed" | head -n 1)"
    [ -n "$id" ] || { echo "no running 'tei-embed' container" >&2; exit 1; }
    health="$(docker inspect -f '{{.State.Health.Status}}' "$id")"
    [ "$health" = healthy ] || { echo "tei-embed is $health, not healthy: no load sent" >&2; exit 1; }
    started="$(docker inspect -f '{{.State.StartedAt}}' "$id" | cut -c1-19)"
    cg=""
    for c in "$CGROUP_ROOT/system.slice/docker-$id.scope" "$CGROUP_ROOT/docker/$id"; do
        if [ -d "$c" ]; then cg="$c"; break; fi
    done

    echo "## tei-embed timing (Retriever Phase 0.5)"
    echo
    echo "Synthetic text generated by this check, never tenant data. One request at a time, from inside the container to its own port; each cut at ${TEI_TIMEOUT_S} s. Times are curl's own, in the container."
    echo
    echo "| Fact | Value |"
    echo "| --- | --- |"
    echo "| Host CPU | $(awk -F': *' '$1 ~ /^model name/ { print $2; exit }' /proc/cpuinfo) |"
    echo "| Host vCPUs | $(nproc) |"
    echo "| AVX2 / AVX-512F | $(grep -qw avx2 /proc/cpuinfo && echo yes || echo no) / $(grep -qw avx512f /proc/cpuinfo && echo yes || echo no) |"
    echo "| tei-embed started (UTC) | $started |"
    echo "| tei-embed memory limit (MiB) | $(cg_mib "$(cg_read "$cg/memory.max")") |"
    echo "| tei-embed CPU quota (period) | $(cg_read "$cg/cpu.max") |"
    tokens="$(tei_body tokenize | docker exec -i "$id" curl -sS --max-time "$TEI_TIMEOUT_S" -H 'content-type: application/json' --data-binary @- "$TEI_URL/tokenize" 2>/dev/null | grep -o '"id":' | wc -l || true)"
    echo "| Tokens in one synthetic passage | $tokens (the model reads 512; --auto-truncate cuts the rest) |"
    echo

    read -r b_cur b_peak b_anon b_file b_oom b_use b_per b_thr b_thu <<< "$(tei_snapshot "$cg")"
    start=$SECONDS
    # Warm-up, not counted: one query and one batch of 8.
    tei_time "$id" query > /dev/null
    tei_time "$id" passages 8 > /dev/null

    echo "## Query (one 20-token query, \"query: \" prefix)"
    echo
    times=""; why=""
    for i in $(seq 1 "$TEI_QUERY_CALLS"); do
        if [ $((SECONDS - start)) -ge "$TEI_BUDGET_S" ]; then why="time budget"; break; fi
        read -r code secs <<< "$(tei_time "$id" query)"
        if [ "${code:-}" != 200 ]; then why="HTTP ${code:-none}"; break; fi
        times+="$secs"$'\n'
    done
    echo "| Calls | Min ms | p50 ms | p95 ms | Max ms |"
    echo "| --- | --- | --- | --- | --- |"
    echo "| $(printf '%s' "$times" | grep -c . || true) | $(printf '%s' "$times" | tei_stats 1000 %.1f | tr ' ' '|' | sed 's/|/ | /g') |"
    [ -z "$why" ] || echo "Stopped early: $why."
    echo

    echo "## Passage batches (512 tokens each, \"passage: \" prefix)"
    echo
    echo "| Batch | Runs | Min s | Median s | p95 s | Max s |"
    echo "| --- | --- | --- | --- | --- | --- |"
    skip=""
    local verdicts=""
    for n in $TEI_BATCH_SIZES; do
        if [ -n "$skip" ]; then
            echo "| $n | 0 | - | - | - | - |"
            verdicts+="- $n passages: not measured ($skip)"$'\n'
            continue
        fi
        times=""; ok=0; why=""
        for r in $(seq 1 "$TEI_BATCH_REPS"); do
            if [ $((SECONDS - start)) -ge "$TEI_BUDGET_S" ]; then why="time budget"; break; fi
            read -r code secs <<< "$(tei_time "$id" passages "$n")"
            if [ "${code:-}" = 200 ]; then
                times+="$secs"$'\n'; ok=$((ok + 1))
            elif [ "${code:-}" = 000 ]; then
                why="no answer within ${TEI_TIMEOUT_S} s"; break
            else
                why="HTTP ${code:-none}"; break
            fi
        done
        echo "| $n | $ok | $(printf '%s' "$times" | tei_stats 1 %.2f | tr ' ' '|' | sed 's/|/ | /g') |"
        slowest="$(printf '%s' "$times" | tei_stats 1 %.2f | cut -d' ' -f4)"
        if [ "$why" = "time budget" ] && [ "$ok" -eq 0 ]; then
            verdicts+="- $n passages: not measured (time budget)"$'\n'
            skip="time budget"
        elif [ -n "$why" ] && [ "$why" != "time budget" ]; then
            verdicts+="- $n passages: over ${TEI_DEADLINE_S} s ($why)"$'\n'
            skip="a smaller batch failed"
        elif awk -v s="$slowest" -v d="$TEI_DEADLINE_S" 'BEGIN { exit !(s <= d) }'; then
            verdicts+="- $n passages: within ${TEI_DEADLINE_S} s (slowest $slowest s of $ok runs${why:+, $why})"$'\n'
        else
            verdicts+="- $n passages: over ${TEI_DEADLINE_S} s (slowest $slowest s of $ok runs${why:+, $why})"$'\n'
        fi
    done
    echo

    read -r a_cur a_peak a_anon a_file a_oom a_use a_per a_thr a_thu <<< "$(tei_snapshot "$cg")"
    echo "## Against the seam's deadline (TEI_DEADLINE_MS, ${TEI_DEADLINE_S} s)"
    echo
    echo "Judged on the slowest run of each size: the deadline binds every call."
    echo
    printf '%s' "$verdicts"
    echo

    echo "## tei-embed cgroup, before and after the load"
    echo
    echo "memory.peak is the high-water mark since the container started; a rise means this load set it."
    echo
    echo "| Measure | Before | After |"
    echo "| --- | --- | --- |"
    echo "| memory.current (MiB) | $(cg_mib "$b_cur") | $(cg_mib "$a_cur") |"
    echo "| memory.peak (MiB) | $(cg_mib "$b_peak") | $(cg_mib "$a_peak") |"
    echo "| anon (MiB) | $(cg_mib "$b_anon") | $(cg_mib "$a_anon") |"
    echo "| file (MiB) | $(cg_mib "$b_file") | $(cg_mib "$a_file") |"
    echo "| OOM kills | $b_oom | $a_oom |"
    echo
    echo "| CPU during the load | Value |"
    echo "| --- | --- |"
    echo "| Wall time (s) | $((SECONDS - start)) |"
    echo "| CPU used (core-seconds) | $(cg_delta "$b_use" "$a_use" 1000000 %.1f) |"
    echo "| Throttled periods | $(cg_delta "$b_thr" "$a_thr" 1 %.0f) of $(cg_delta "$b_per" "$a_per" 1 %.0f) |"
    echo "| Throttled time (s) | $(cg_delta "$b_thu" "$a_thu" 1000000 %.1f) |"
}

# ── migrate-role ──────────────────────────────────────────────────────────────
#
# Which database role production migrations run as, and whether it is a
# superuser: #5720's migration runs `CREATE EXTENSION vector`, which needs one.
#
# The URL is the one `prisma migrate deploy` uses in the app container, resolved
# exactly as prisma.config.ts resolves it: DIRECT_DATABASE_URL when it is SET
# (`??` falls back only on undefined, so a set-but-empty value is still the one
# used), DATABASE_URL otherwise. It is read from the RUNNING container, so it is
# the effective value whatever file set it.
#
# THE URL CARRIES A PASSWORD, AND THESE LOGS ARE PUBLIC. It lives only in a shell
# variable: never printed, never echoed into a pipe, never an argument to any
# command. It is cut apart with parameter expansion alone, and only the user name
# and the database name leave it, each printed only when it is a plain lower-case
# identifier and "unprintable" otherwise. The host is printed as a class. The
# password is never used: the question goes to Postgres as the image's own
# superuser, inside the postgres container, with the role passed as a psql
# variable (`-v r=...`, read as :'r') so it is never part of the SQL text.
SAFE_IDENT='^[a-z_][a-z0-9_]{0,62}$'
SAFE_VERSION='^[0-9][0-9.]{0,15}$'

migrate_role() {
    local app url rc source rest userinfo user hostpart host db role dbname cls
    local super createrole available installed avail_v inst_v v
    app="$(need app)"
    # printenv exits 1 when the variable is unset (coreutils and busybox
    # alike); docker exec's own failures are 125 and up.
    url="$(docker exec "$app" printenv DIRECT_DATABASE_URL)" && rc=0 || rc=$?
    if [ "$rc" -eq 0 ]; then
        source="DIRECT_DATABASE_URL"
    elif [ "$rc" -eq 1 ]; then
        url="$(docker exec "$app" printenv DATABASE_URL)" && rc=0 || rc=$?
        if [ "$rc" -eq 0 ]; then
            source="DATABASE_URL (the fallback: DIRECT_DATABASE_URL is unset)"
        elif [ "$rc" -eq 1 ]; then
            url=""; source="neither (DIRECT_DATABASE_URL and DATABASE_URL are both unset)"
        else
            echo "could not read the app container's environment" >&2; exit 1
        fi
    else
        echo "could not read the app container's environment" >&2; exit 1
    fi

    # scheme://user:password@host:port/db?params, cut with expansion only.
    rest="${url#*://}"
    user=""; hostpart="$rest"
    if [[ "$rest" == *@* ]]; then
        userinfo="${rest%@*}"
        user="${userinfo%%:*}"
        hostpart="${rest##*@}"
    fi
    host="${hostpart%%[/?]*}"
    host="${host%%:*}"
    db=""
    if [[ "$hostpart" == */* ]]; then db="${hostpart#*/}"; db="${db%%\?*}"; fi
    url=""; rest=""; userinfo=""; hostpart=""

    role="unprintable"; [[ "$user" =~ $SAFE_IDENT ]] && role="$user"
    dbname="unprintable"; [[ "$db" =~ $SAFE_IDENT ]] && dbname="$db"
    case "$host" in
        postgres) cls="the postgres service" ;;
        pgbouncer) cls="pgbouncer" ;;
        *) cls="other" ;;
    esac

    echo "## Database role for migrations (#5720)"
    echo
    echo "| Fact | Value |"
    echo "| --- | --- |"
    echo "| Supplied by | $source |"
    echo "| Role | $role |"
    echo "| Host | $cls |"
    echo "| Database | $dbname |"

    # Each answer row is a tag and fixed words or numbers; anything else in a
    # row is dropped below, never printed.
    super="not asked"; createrole="not asked"; available="not asked"; installed="not asked"
    avail_v="-"; inst_v="-"
    if [ "$role" != unprintable ] && [ "$dbname" != unprintable ]; then
        local answer tag a b
        answer="$(docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$(need postgres)" psql -X -q -tA -F ' ' -v ON_ERROR_STOP=1 -U postgres -d "$dbname" -v r="$role" 2>/dev/null <<'SQL'
SELECT 'role', CASE WHEN rolsuper THEN 'yes' ELSE 'no' END, CASE WHEN rolcreaterole THEN 'yes' ELSE 'no' END FROM pg_roles WHERE rolname = :'r';
SELECT 'available', count(*), coalesce(max(default_version), '-') FROM pg_available_extensions WHERE name = 'vector';
SELECT 'installed', count(*), coalesce(max(extversion), '-') FROM pg_extension WHERE extname = 'vector';
SQL
)" || answer=""
        if [ -z "$answer" ]; then
            super="unknown"; createrole="unknown"; available="unknown"; installed="unknown"
        else
            super="no such role"; createrole="no such role"; available="unknown"; installed="unknown"
            while read -r tag a b; do
                case "$tag" in
                    role) super="$a"; createrole="$b" ;;
                    available) available="$a"; avail_v="$b" ;;
                    installed) installed="$a"; inst_v="$b" ;;
                esac
            done <<< "$answer"
        fi
    fi
    case "$available" in 0) available="no" ;; 1) available="yes" ;; esac
    case "$installed" in 0) installed="no" ;; 1) installed="yes" ;; esac
    for v in super createrole available installed; do
        [[ "${!v}" =~ ^(yes|no|unknown|not\ asked|no\ such\ role)$ ]] || printf -v "$v" '%s' unknown
    done
    [[ "$avail_v" =~ $SAFE_VERSION ]] || avail_v="-"
    [[ "$inst_v" =~ $SAFE_VERSION ]] || inst_v="-"

    echo "| Superuser | $super |"
    echo "| Can create roles | $createrole |"
    echo "| vector available (default version) | $available ($avail_v) |"
    echo "| vector installed in the database (version) | $installed ($inst_v) |"
    echo
    if [ "$super" = "not asked" ]; then
        echo "Postgres was not asked: the role or the database name is not a plain identifier, so neither is passed on."
        echo
    elif [ "$super" = unknown ]; then
        echo "Postgres did not answer, as \`postgres\` in that database."
        echo
    fi
    echo "migrations run as $role, superuser: $super; vector available: $available; installed: $installed"
    if [ "$super" = no ] || [ "$super" = "no such role" ]; then
        echo
        if [ "$installed" = yes ]; then
            echo "The role is not a superuser, but the extension is already installed, so \`CREATE EXTENSION IF NOT EXISTS vector\` has nothing to do."
        else
            echo "The role is not a superuser, so the migration's \`CREATE EXTENSION vector\` would fail under it: create the extension first, once, as \`postgres\` in the app's database (docs/deployment.md, \"Read-only checks without a key\", migrate-role)."
        fi
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# The posture provider-name recipe — #5476.
#
# ONE derivation, two readers. `postureProviderName` in
# `src/app-layer/integrations/cloud-posture/provider-name.ts` is the source of
# truth, and the product attaches by the name it returns. This is that same
# recipe, spelled for `node -e` because the app container runs plain node and
# cannot import a TypeScript module by path.
#
# A second spelling of one name is the shape that goes wrong silently, so it is
# not left to care: `tests/guardrails/posture-provider-name-recipe.test.ts`
# EXTRACTS this variable from this file, EXECUTES it, and compares its output
# against the TypeScript function's for the same inputs. A drifted recipe fails
# CI, and the failure names this line.
#
# Length-prefixed rather than separator-joined, for the reason the TypeScript
# records: ('a','b:c') and ('a:b','c') both build `a:b:c`, and a collision here
# merges two tenants' credentials.
#
# PUBLIC LOG DISCIPLINE: the tenant id arrives on stdin and is NEVER printed. A
# connection id is an opaque cuid naming no customer, and a provider name is a
# digest. Nothing here can print a slug, an account or a credential.
# NO ARROW FUNCTIONS in here, deliberately. The "remote.sh writes no file"
# guard scans every line for a redirect, and `=> v` reads as `>` followed by a
# target. Dropping the arrows keeps that guard strict rather than widening a
# write-detector to accommodate a style choice.
POSTURE_NAME_RECIPE='
const { createHash } = require("crypto");
function lp(v) { return v.length + ":" + v; }
const rows = [];
const lines = require("readline").createInterface({ input: process.stdin });
lines.on("line", function (line) {
    const parts = line.split("|");
    if (parts.length < 3) return;
    const tenantId = parts[0];
    const connectionId = parts[1];
    const enabled = parts[2];
    if (!tenantId || !connectionId) return;
    const digest = createHash("sha256")
        .update(lp(tenantId) + lp(connectionId), "utf8")
        .digest("hex")
        .slice(0, 32);
    rows.push("| " + connectionId + " | " + enabled + " | inflect-posture-" + digest + " |");
});
lines.on("close", function () {
    console.log("| connection | enabled | expected provider |");
    console.log("| --- | --- | --- |");
    for (const r of rows) console.log(r);
    console.log("");
    console.log("posture connections: " + rows.length);
});
'

# ─────────────────────────────────────────────────────────────────────────────
# calendar-observations — #5957.
#
# The calendar push writes one `calendar.vendor_observation` line per vendor
# answer the open items of docs/calendar-push-design.md depend on
# (src/app-layer/integrations/providers/calendar/vendor-observation.ts). The
# owner runs the real-account steps in
# docs/runbooks/calendar-vendor-verification.md; this counts what they left.
#
# PUBLIC LOG DISCIPLINE. A line reaches this program only through the grep for
# its message, and the program prints COUNTS keyed on five values, each read
# from its own key with a strict pattern and then held to a fixed vocabulary or
# shape. Anything else is printed as (other) or -, never as itself:
#   provider   one of three words
#   operation  one of the product's operations, listed below
#   status     exactly three digits
#   code       a machine code: a letter, then letters, digits, _ . -, at most 64
#   dateShape  one of four words
# The line's other keys (pino's level, time, pid and hostname, and anything a
# future change might add) are never read. The two lists are held equal to the
# TypeScript's by tests/guards/vm-check-workflow.test.ts, and no `>` appears in
# the program because the "writes no file" guard reads every line for one.
CALENDAR_OBSERVATION_COUNTER='
BEGIN {
    split("graph.insert graph.insert_existing graph.insert_duplicate graph.duplicate_found graph.duplicate_not_found graph.patch google.insert entra.admin_consent_error entra.personal_consent_error entra.exchange_error", ops, " ")
    for (i in ops) op_ok[ops[i]] = 1
    split("graph google entra", pv, " ")
    for (i in pv) provider_ok[pv[i]] = 1
    split("same_date shifted_back shifted_forward unreadable", ds, " ")
    for (i in ds) shape_ok[ds[i]] = 1
}
function str(key,    re) {
    re = "\"" key "\":\"[A-Za-z0-9_.-]+\""
    if (!match($0, re)) return ""
    return substr($0, RSTART + length(key) + 4, RLENGTH - length(key) - 5)
}
{
    p = str("provider"); if (!(p in provider_ok)) p = "(other)"
    o = str("operation"); if (!(o in op_ok)) o = "(other)"
    c = str("code"); if (c !~ /^[A-Za-z]/ || !(length(c) <= 64)) c = "-"
    d = str("dateShape"); if (!(d in shape_ok)) d = "-"
    s = "-"
    if (match($0, /"status":[0-9]+[,}]/) && RLENGTH == 13) s = substr($0, RSTART + 9, 3)
    n[p " " o " " s " " c " " d]++
}
END { for (k in n) printf "%s\t%d\n", k, n[k] }
'

# ─────────────────────────────────────────────────────────────────────────────
# managed-agents-workspace-header — #5962.
#
# The Managed Agents engine's client checks the `anthropic-workspace-id` header
# of every response (src/lib/agentic/managed-agents/workspace-header.ts) and,
# when a run segment, a provisioning or a clean-up pass is done with the client,
# writes ONE `managed-agents: workspace-header tally` line: per endpoint, how
# many responses matched, were missing the header, or named another workspace,
# and whose workspace it was (OWN or HOSTED). Production has no metrics backend,
# so these lines are the evidence the owner decides
# REFUSE_MISSING_WORKSPACE_HEADER on.
#
# PUBLIC LOG DISCIPLINE. A line reaches this program only through the grep for
# its message, and the program prints SUMS: for each of the engine's thirteen
# endpoint names (a fixed list, held equal to MANAGED_AGENTS_ENDPOINT_NAMES in
# src/lib/agentic/tool-runner/client.ts by tests/guards/vm-check-workflow.test.ts)
# it reads the three counts that follow that name, digits only, at most nine,
# and adds them. The kind is read as one of two words, anything else counted
# as (other). No other part of a line (pino's level, time, pid and hostname, a
# request or tenant id the logger adds) is ever read, and no line, timestamp
# or id is printed. No `>` appears in the program, because the "writes no file"
# guard reads every line for one, and no `{n,m}` interval either, which mawk
# may not read.
MANAGED_AGENTS_TALLY_SUMMER='
BEGIN {
    count = split("agents.create agents.retrieve agents.update environments.create environments.retrieve sessions.create sessions.list sessions.retrieve sessions.delete sessions.events.list sessions.events.send sessions.events.stream agents.archive", names, " ")
    kinds[1] = "OWN"; kinds[2] = "HOSTED"; kinds[3] = "(other)"
    total = 0
}
NF == 0 { next }
{
    k = "(other)"
    if (match($0, /"kind":"[A-Z]+"/)) {
        k = substr($0, RSTART + 8, RLENGTH - 9)
        if (k != "OWN" && k != "HOSTED") k = "(other)"
    }
    lines[k]++
    total++
    for (i = 1; i <= count; i++) {
        key = "\"" names[i] "\":{\"match\":"
        at = index($0, key)
        if (!at) continue
        rest = substr($0, at + length(key) - 8)
        if (!match(rest, /^"match":[0-9]+,"missing":[0-9]+,"mismatch":[0-9]+}/)) continue
        split(substr(rest, RSTART, RLENGTH), parts, /[:,}]/)
        if (!(length(parts[2]) <= 9 && length(parts[4]) <= 9 && length(parts[6]) <= 9)) continue
        m[k, i] += parts[2]
        mi[k, i] += parts[4]
        mm[k, i] += parts[6]
    }
}
END {
    if (total == 0) {
        print "No tally lines in the window. That is not evidence about any endpoint: no Managed Agents run, provisioning or clean-up finished inside it, or a container restarted after one did."
        exit
    }
    printf "Tally lines read: %d (one per client: a run segment, a provisioning or a clean-up pass)\n", total
    for (j = 1; j <= 3; j++) {
        k = kinds[j]
        if (!(k in lines)) continue
        printf "\n### %s workspace: %d tally lines\n\n", k, lines[k]
        print "| Endpoint | Match | Missing | Mismatch |"
        print "| --- | --- | --- | --- |"
        for (i = 1; i <= count; i++) printf "| %s | %d | %d | %d |\n", names[i], m[k, i], mi[k, i], mm[k, i]
    }
}
'

case "$CHECK" in
containers)
    echo "## Containers"
    echo
    echo "| Name | Image | Status |"
    echo "| --- | --- | --- |"
    docker ps --format '| {{.Names}} | {{.Image}} | {{.Status}} |'
    echo
    echo "## App and worker image"
    echo
    echo "| Service | Started (UTC) | Image digest |"
    echo "| --- | --- | --- |"
    for svc in app worker; do
        id="$(need "$svc")"
        echo "| $svc | $(docker inspect -f '{{.State.StartedAt}}' "$id") | $(docker inspect -f '{{.Image}}' "$id") |"
    done
    ;;

library-sync)
    # The run's summary line carries the counts; nothing else is printed.
    summary="$(docker logs "$(need app)" 2>&1 | grep -F '"component":"library-sync"' | grep -F '"totalFound"' | tail -n 1 || true)"
    [ -n "$summary" ] || { echo "no library-sync summary in the app's log since it started"; exit 0; }
    echo "## Last library sync"
    echo
    echo "| Counter | Value |"
    echo "| --- | --- |"
    printf '%s\n' "$summary" | grep -oE '"(totalFound|created|updated|skipped|failed|mappingSets)":[0-9]+' \
        | tr -d '"' | awk -F: '{ printf "| %s | %s |\n", $1, $2 }'
    ms="$(printf '%s\n' "$summary" | grep -oE '"time":[0-9]+' | cut -d: -f2 || true)"
    [ -z "$ms" ] || printf '\nLogged at %s.\n' "$(date -u -d "@$((ms / 1000))" +%Y-%m-%dT%H:%M:%SZ)"
    ;;

log-errors)
    # pino levels: 50 error, 60 fatal. Counted per component, or per job when
    # the line names no component. Both are code identifiers, and nothing else
    # in the line is ever printed.
    echo "## Error and fatal log lines, last 24 hours"
    echo
    # A container's log starts when the container does. Watchtower replaces the
    # app and worker on every new image, so the 24 hours shrink to the time
    # since then, and lines from before it are gone. Say so, with the start
    # time, so an empty table is never read as a quiet day.
    for svc in app worker; do
        echo "- $svc: logs since $(docker inspect -f '{{.State.StartedAt}}' "$(need "$svc")") (container start)"
    done
    echo
    echo "Lines from before a container started are not covered; integration runs are also recorded in the IntegrationExecution table."
    echo
    echo "| Container | Component | Lines |"
    echo "| --- | --- | --- |"
    total=0
    for svc in app worker; do
        counts="$(docker logs --since 24h "$(need "$svc")" 2>&1 | grep -E '"level":(50|60)[,}]' \
            | awk '{ k = "(none)"
                     if (match($0, /"component":"[A-Za-z0-9._:-]+"/) && RLENGTH <= 78) k = substr($0, RSTART + 13, RLENGTH - 14)
                     else if (match($0, /"jobName":"[A-Za-z0-9._:-]+"/) && RLENGTH <= 76) k = "job " substr($0, RSTART + 11, RLENGTH - 12)
                     c[k]++ }
                   END { for (k in c) printf "%s\t%d\n", k, c[k] }' | sort || true)"
        while IFS=$'\t' read -r comp n; do
            [ -n "${n:-}" ] || continue
            echo "| $svc | $comp | $n |"
            total=$((total + n))
        done <<< "$counts"
    done
    echo
    echo "Total: $total"
    ;;

access-review-dates)
    echo "## Access-review campaigns with a 1970 date or a backwards period (#4390)"
    echo
    docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$(need postgres)" \
        sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P footer=off' <<'SQL'
SELECT scope,
  count(*) AS campaigns,
  count(*) FILTER (WHERE "dueAt" < '1971-01-01') AS due_in_1970,
  count(*) FILTER (WHERE "periodStartAt" < '1971-01-01' OR "periodEndAt" < '1971-01-01') AS period_in_1970,
  count(*) FILTER (WHERE "periodEndAt" < "periodStartAt") AS period_backwards
FROM "AccessReview" WHERE "deletedAt" IS NULL GROUP BY scope ORDER BY scope;
SQL
    ;;

bcrypt)
    echo "## Native bcrypt in the running app (#4340)"
    echo
    docker exec "$(need app)" node -e \
        'const b = require("bcrypt"); const h = b.hashSync("vm-check", 4); console.log(b.compareSync("vm-check", h) && !b.compareSync("other", h) ? "loads and verifies: yes" : "loads, but verification is WRONG")'
    ;;

automation-rules)
    # What turning AUTOMATION_WEB_EVENTS_ENABLED on would wake (#5541): every
    # ENABLED rule starts acting on new events the web process emits. Counts
    # only. A trigger event is printed only when it is an event-name literal;
    # anything else in the column is counted as (other), never printed.
    echo "## Enabled automation rules (what AUTOMATION_WEB_EVENTS_ENABLED would wake)"
    echo
    echo "Rules on events the worker emits (scheduled sweeps, jobs) fire today whatever the switch says."
    echo
    docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$(need postgres)" \
        sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P footer=off' <<'SQL'
SELECT count(*) AS enabled_rules,
  count(DISTINCT "tenantId") AS tenants_with_an_enabled_rule
FROM "AutomationRule" WHERE status = 'ENABLED' AND "deletedAt" IS NULL;
SELECT CASE WHEN "triggerEvent" ~ '^[A-Z][A-Z0-9_]{0,63}$' THEN "triggerEvent" ELSE '(other)' END AS trigger_event,
  count(*) AS enabled_rules
FROM "AutomationRule" WHERE status = 'ENABLED' AND "deletedAt" IS NULL GROUP BY 1 ORDER BY 1;
SELECT "actionType" AS action_type, count(*) AS enabled_rules
FROM "AutomationRule" WHERE status = 'ENABLED' AND "deletedAt" IS NULL GROUP BY 1 ORDER BY 1;
SQL
    ;;

posture-provider-names)
    # #5476: the gateway provider name the product WILL attach for each posture
    # connection, so the operator can `provider create` each one holding that
    # connection's own cloud credential.
    #
    # The product never creates a provider. Writing a provider's credential needs
    # gateway-wide mTLS with OU=operator, and that certificate is deliberately
    # absent from both VMs; the app's identity is OU=openshell-user, which reaches
    # attach, exec and the readiness read and none of the operator surface. So the
    # operator provisions and the product attaches (owner decision) — and this
    # check is how the operator learns which names to provision.
    #
    # Until a connection's provider exists, its sandboxed collection refuses by
    # name rather than attaching somebody else's credential (#5251, #5475).
    echo "## Expected posture provider names (#5476)"
    echo
    echo "Provision each with the operator certificate, holding that connection's own"
    echo "cloud credential. The product attaches by name and never writes one."
    echo
    # TWO STEPS rather than one pipeline, so the heredoc marker is the last token
    # on its line: the read-only-query guard extracts every heredoc and requires
    # each to begin with SELECT, and a trailing pipe sharing that line would land
    # inside the extracted text. Keeping that guard's reading simple is worth one
    # variable. (This comment names no marker either, for the same reason — the
    # guard finds heredocs by splitting on the literal.)
    #
    # `$rows` holds `tenantId|id|isEnabled` per connection and is never echoed —
    # it goes straight into the digest step, which prints the connection and the
    # name and drops the tenant id.
    rows="$(docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$(need postgres)" \
        sh -c 'psql -X -q -At -F "|" -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT "tenantId", id, "isEnabled"
FROM "IntegrationConnection"
WHERE provider IN ('aws-posture', 'azure-posture', 'gcp-posture')
ORDER BY id;
SQL
)"
    printf '%s\n' "$rows" | docker exec -i "$(need app)" node -e "$POSTURE_NAME_RECIPE"
    ;;

tei-embed-timing)
    tei_timing
    ;;

migrate-role)
    migrate_role
    ;;

calendar-observations)
    # #5957: what Graph, Entra and Google answered the calendar push, as counts.
    # The callbacks run in the app and the nightly push in the worker, so both
    # logs are read. Nothing of a line but the five counted values is printed.
    echo "## Calendar vendor observations, last 72 hours (#5957)"
    echo
    echo "Counts of \`calendar.vendor_observation\` lines, per provider, operation, HTTP status, machine code and date shape. Read each row against docs/runbooks/calendar-vendor-verification.md."
    echo
    # A container's log starts when the container does: Watchtower replaces the
    # app and worker on every new image, so the 72 hours shrink to the time
    # since then. Say so, so an empty table is never read as a vendor's answer.
    for svc in app worker; do
        echo "- $svc: logs since $(docker inspect -f '{{.State.StartedAt}}' "$(need "$svc")") (container start)"
    done
    echo
    echo "| Container | Provider | Operation | Status | Code | Date shape | Lines |"
    echo "| --- | --- | --- | --- | --- | --- | --- |"
    total=0
    for svc in app worker; do
        counts="$(docker logs --since 72h "$(need "$svc")" 2>&1 | grep -F '"msg":"calendar.vendor_observation"' \
            | awk "$CALENDAR_OBSERVATION_COUNTER" | sort || true)"
        while IFS=$'\t' read -r key n; do
            [ -n "${n:-}" ] || continue
            read -r prov op st code shape <<< "$key"
            echo "| $svc | $prov | $op | $st | $code | $shape | $n |"
            total=$((total + n))
        done <<< "$counts"
    done
    echo
    echo "Total: $total"
    if [ "$total" -eq 0 ]; then
        echo
        echo "No observation in the window. That is not an answer from a vendor: the step was not run inside the window, or a container restarted after it."
    fi
    ;;

managed-agents-workspace-header)
    # #5962: which Managed Agents endpoints answered with the workspace header.
    # Runs and clean-ups run in the worker and a provisioning in the app, so both
    # logs are read. Nothing of a line but the counts is printed.
    echo "## Managed Agents workspace header, last 48 hours (#5962)"
    echo
    echo "Sums of the engine's \`managed-agents: workspace-header tally\` lines: per endpoint, the responses that named the configured Anthropic workspace (match), named none (missing) or named another (mismatch). A container's log starts when the container does, so the window is shorter after a new image."
    echo
    all=""
    for svc in app worker; do
        tally="$(docker logs --since 48h "$(need "$svc")" 2>&1 | grep -F '"msg":"managed-agents: workspace-header tally"' || true)"
        [ -z "$tally" ] || all="$all$tally"$'\n'
    done
    printf '%s' "$all" | awk "$MANAGED_AGENTS_TALLY_SUMMER"
    ;;

*)
    echo "unknown check: $CHECK" >&2
    exit 2
    ;;
esac
