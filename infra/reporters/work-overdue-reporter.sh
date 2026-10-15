#!/usr/bin/env bash
# Report scheduled work that should have happened and hasn't (#3558).
#
# ── WHY THIS EXISTS: 4,300 FAILURES, 7½ DAYS, NOTHING SAID ──────────────────
#
# #3554. `control-test-scheduler` claimed a due plan, failed to enqueue the
# runner because its hand-rolled BullMQ job id was invalid, rolled the claim
# back so the plan would be re-claimed, and retried — 24 times an hour from
# 2026-10-07T09:09Z until a human grepped production logs for an unrelated
# reason on 2026-10-14. Zero scheduled control tests ran in that window.
#
# Every signal that should have carried it worked perfectly:
#
#   · `enqueueFailures` was incremented, returned to the caller AND
#     `logger.error`-ed on every single attempt;
#   · the tick logged "job completed" each time — truthfully, having enqueued
#     nothing;
#   · `/api/readyz` stayed green, because the process was healthy and only the
#     WORK failed;
#   · a manual trigger worked, because it passes no custom job id.
#
# ── WHY IT MEASURES OVERDUE WORK AND NOT A FAILURE COUNTER ──────────────────
#
# #3558 originally proposed reading the failure counter. That is not readable:
# `runJob` persists nothing, so there is no job-run history in Postgres for a
# reporter to query, and the counter lives only in a log line.
#
# What IS readable is the SYMPTOM — rows whose own scheduling column says they
# are late. That is strictly better than a failure count, because it catches
# every cause with one query: a rejected enqueue, a wedged worker, a drained
# Redis, a crash loop, a plan stuck by a bug nobody has found yet. A counter
# only ever catches the failure mode somebody already thought of.
#
# And it would have caught #3554 WITHIN MINUTES. The rollback restored each
# plan's original `nextRunAt`, so `nextRunAt` sat in the past continuously for
# 7½ days — exactly the condition below.
#
# ── THE FOUR RULES THIS FOLLOWS (infra/reporters/README.md) ─────────────────
#
#   1. No credentials. The GCP token comes from the metadata server; the
#      database is read through `docker exec` under the container's own user.
#   2. EMIT ON THE HEALTHY PATH TOO — `0` is a value. A metric that only
#      appears when something is wrong cannot be distinguished from a reporter
#      that died, and the policy's absence arm would then be meaningless.
#   3. An unreadable number is NOT zero. If any query fails this exits without
#      posting anything, and the policy's `conditionAbsent` turns sustained
#      silence into a page. Posting 0 on a failed read would be the worst
#      possible outcome: a confident all-clear.
#   4. The repo copy is canonical. Change it here and re-install.
#
# ── GRACE PERIODS ARE DERIVED, NOT CHOSEN ──────────────────────────────────
#
# Each family's grace is THREE TIMES its flusher's cron cadence, so two
# consecutive missed runs plus margin are needed before anything is reported —
# a single slow tick is not a page.
#
#   family                cadence   grace
#   control_test_plan     5 min     15 min   (*/5 control-test-scheduler)
#   audit_outbox          5 min     15 min   (*/5 audit-outbox-flush)
#   notification_outbox   10 min    30 min   (*/10 notification-outbox-flush)
#
# `tests/guards/work-overdue-grace-matches-schedule.test.ts` reads these values
# out of THIS FILE and the cadences out of `SCHEDULED_JOBS`, and fails if the
# ratio drops below three. A cadence change without a grace change is exactly
# the edit that would make this reporter cry wolf, and it is the same mechanism
# `fan-out-bucket-matches-schedule.test.ts` uses for the dedupe buckets.
#
# ── WHAT IT DOES NOT COVER, stated so the coverage claim is honest ─────────
#
#   · FAILED rows. An outbox row that exhausted its attempts is work ABANDONED
#     rather than work not progressing — a real gap, a different grace, and a
#     different message. Not folded in here to keep one alert meaning one thing.
#   · The other ~25 entries in SCHEDULED_JOBS. Most write no row a reporter can
#     read, because `runJob` persists nothing. Covering them needs a job-run
#     table first; that is the larger half of #3558 and is not this.
#   · PAUSED or ARCHIVED plans, and plans with no `schedule`. Those are not due.

set -uo pipefail

PROJECT=hazel-design-419410
PG_CONTAINER=${PG_CONTAINER:-inflect-postgres-1}
MD="http://metadata.google.internal/computeMetadata/v1"
H="Metadata-Flavor: Google"
DRY_RUN=${WORK_OVERDUE_DRY_RUN:-0}

# GRACE_CONTRACT — the guard test parses the three lines below. Keep the shape
# `family=<name> grace_minutes=<int> cadence_minutes=<int>`.
# family=control_test_plan grace_minutes=15 cadence_minutes=5
# family=audit_outbox grace_minutes=15 cadence_minutes=5
# family=notification_outbox grace_minutes=30 cadence_minutes=10

read_count() {
    # $1 = SQL returning exactly one integer.
    docker exec -i "$PG_CONTAINER" \
        sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -f -' <<SQL 2>&1
$1
SQL
}

check() {
    # $1 = family label, $2 = SQL. Sets OUT_<family> or returns non-zero.
    local family="$1" sql="$2" n
    n=$(read_count "$sql")
    local rc=$?
    if [ $rc -ne 0 ] || ! printf '%s' "$n" | grep -Eq '^[0-9]+$'; then
        echo "could not read overdue work for '$family' (rc=$rc): $n" >&2
        return 1
    fi
    printf '%s' "$n"
}

CONTROL_TEST_PLAN=$(check control_test_plan "
SELECT count(*) FROM \"ControlTestPlan\"
 WHERE status = 'ACTIVE'
   AND schedule IS NOT NULL
   AND \"nextRunAt\" IS NOT NULL
   AND \"nextRunAt\" < now() - interval '15 minutes';
") || { echo "emitting NOTHING — an unreadable backlog is not an empty one" >&2; exit 1; }

AUDIT_OUTBOX=$(check audit_outbox "
SELECT count(*) FROM \"AuditOutbox\"
 WHERE status = 'PENDING'
   AND \"nextAttemptAt\" < now() - interval '15 minutes';
") || { echo "emitting NOTHING — an unreadable backlog is not an empty one" >&2; exit 1; }

NOTIFICATION_OUTBOX=$(check notification_outbox "
SELECT count(*) FROM \"NotificationOutbox\"
 WHERE status = 'PENDING'
   AND \"sendAfter\" < now() - interval '30 minutes';
") || { echo "emitting NOTHING — an unreadable backlog is not an empty one" >&2; exit 1; }

TOTAL=$((CONTROL_TEST_PLAN + AUDIT_OUTBOX + NOTIFICATION_OUTBOX))

# The detail goes to the journal when there is any, so whoever reads the page
# has the WHICH as well as the HOW MANY. #3554 took hours to diagnose partly
# because the alert that did not exist would have had to be chased from zero.
if [ "$TOTAL" -gt 0 ]; then
    echo "OVERDUE scheduled work: control_test_plan=$CONTROL_TEST_PLAN audit_outbox=$AUDIT_OUTBOX notification_outbox=$NOTIFICATION_OUTBOX" >&2
    if [ "$CONTROL_TEST_PLAN" -gt 0 ]; then
        read_count "
SELECT \"tenantId\" || ' plan=' || id || ' nextRunAt=' || \"nextRunAt\"
  FROM \"ControlTestPlan\"
 WHERE status = 'ACTIVE' AND schedule IS NOT NULL AND \"nextRunAt\" IS NOT NULL
   AND \"nextRunAt\" < now() - interval '15 minutes'
 ORDER BY \"nextRunAt\" LIMIT 50;
" >&2
    fi
fi

IID=$(curl -s -H "$H" "$MD/instance/id")
ZONE=$(curl -s -H "$H" "$MD/instance/zone" | awk -F/ '{print $NF}')
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ -z "$IID" ] || [ -z "$ZONE" ]; then
    echo "no instance identity from the metadata server" >&2
    exit 1
fi

series_for() {
    # $1 = family label, $2 = count
    printf '{"metric":{"type":"custom.googleapis.com/jobs/work_overdue","labels":{"family":"%s"}},"resource":{"type":"gce_instance","labels":{"instance_id":"%s","zone":"%s","project_id":"%s"}},"points":[{"interval":{"endTime":"%s"},"value":{"int64Value":"%s"}}]}' \
        "$1" "$IID" "$ZONE" "$PROJECT" "$NOW" "$2"
}

PAYLOAD="{\"timeSeries\":[$(series_for control_test_plan "$CONTROL_TEST_PLAN"),$(series_for audit_outbox "$AUDIT_OUTBOX"),$(series_for notification_outbox "$NOTIFICATION_OUTBOX")]}"

if [ "$DRY_RUN" = "1" ]; then
    echo "DRY RUN — would POST to projects/$PROJECT/timeSeries:"
    echo "$PAYLOAD"
    exit 0
fi

TOKEN=$(curl -s -H "$H" "$MD/instance/service-accounts/default/token" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -z "$TOKEN" ] && { echo "no token" >&2; exit 1; }

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "https://monitoring.googleapis.com/v3/projects/$PROJECT/timeSeries" -o /tmp/wo-resp.json -w '%{http_code}'
echo
