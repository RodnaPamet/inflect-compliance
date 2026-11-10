#!/usr/bin/env bash
#
# READ-ONLY CHECKS ON THE PRODUCTION VM — the VM half.
#
# Runs ON the VM, as root, from `vm.sh`, which the dispatch-only `VM check`
# workflow runs (.github/workflows/vm-check.yml). Read-only: it changes nothing
# on the VM, and its one database query runs in a read-only transaction.
#
#   remote.sh <check>
#
#   containers           each container's name, image, state and start time,
#                        and the image digest the app and worker run
#   library-sync         the counts from the last library and crosswalk sync
#   log-errors           error and fatal log lines in the last 24 hours, counted
#                        per container and component (or job)
#   access-review-dates  access-review campaigns with a 1970 date or a period
#                        that ends before it starts, counted per scope (#4390)
#   bcrypt               whether the app's native bcrypt module loads and
#                        verifies a hash (#4340)
#
# THE WORKFLOW'S LOGS ARE PUBLIC, because the repository is. So this prints
# names, states, versions and counts, and never a log line, a row, an
# environment file, a compose file, or a container's environment, command line
# or labels. Log output is only ever piped into a filter that extracts named
# counters or counts lines; it never reaches stdout itself.
#
set -euo pipefail

CHECK="${1:?check}"

# A compose service's running container, by the label compose sets.
container() { docker ps -qf "label=com.docker.compose.service=$1" | head -n 1; }

need() {
    local id
    id="$(container "$1")"
    [ -n "$id" ] || { echo "no running '$1' container" >&2; exit 1; }
    printf '%s' "$id"
}

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

*)
    echo "unknown check: $CHECK" >&2
    exit 2
    ;;
esac
