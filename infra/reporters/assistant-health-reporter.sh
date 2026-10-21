#!/usr/bin/env bash
# Report assistant refusal rate and proposal volume to GCP Monitoring (#3856).
#
# ── WHY THESE TWO NUMBERS ───────────────────────────────────────────────────
#
# A spike in either is the early signal, and they fail in opposite directions:
#
#   · REFUSALS UP — the guard is misfiring, and users are being blocked from a
#     feature that works. That shows up as support tickets days later, if at
#     all, because a refused user usually just stops asking.
#   · PROPOSAL VOLUME UP — the model is proposing indiscriminately and the
#     review queue is filling with noise. Reviewers then approve by habit,
#     which is the failure that matters: the queue's whole value is that a
#     human looked.
#
# Neither is visible from `/api/readyz`. The process is healthy in both cases.
#
# ── THE FOUR RULES THIS FOLLOWS (infra/reporters/README.md) ────────────────
#
#   1. No credentials. The GCP token comes from the metadata server; the
#      database is read through `docker exec` under the container's own user.
#   2. EMIT ON THE HEALTHY PATH TOO — `0` is a value. A metric that only
#      appears when something is wrong cannot be told apart from a reporter
#      that died, and the policy's absence arm would mean nothing.
#   3. An unreadable number is NOT zero. If any query fails this exits without
#      posting anything, and the policy's `conditionAbsent` turns sustained
#      silence into a page. Posting 0 on a failed read would be a confident
#      all-clear.
#   4. The repo copy is canonical. Change it here and re-install.
#
# ── WHY THE DENOMINATOR IS "LOGGED TURNS + REFUSALS" AND NOT JUST TURNS ────
#
# This took reading the code rather than assuming. `runGoverned` applies
# `assertNoReviewRequired(await guardUntrustedInput(...))` BEFORE it produces
# an answer, and that THROWS on a review-required verdict — so a refused turn
# never reaches `logAiDecision` and writes no `AiDecisionLog` row at all.
#
# A rate of refusals over `AiDecisionLog` rows would therefore divide by the
# turns that were NOT refused, and would read lower the worse things got. The
# attempts are the sum: rows that got through, plus guard events that stopped
# one.
#
# The guard's own audit row IS written before the throw — `emitGuardAudit`
# runs inside `compose`, ahead of the caller's assertion — so the refusals are
# readable even though the decision log has nothing for them.
#
# ── WHAT IS AND IS NOT COUNTED AS A REFUSAL ────────────────────────────────
#
# COUNTED: `AuditLog` rows with `entity='AiGuard'` whose `entityId` (the guard
# `source`) starts with `assistant`. That covers all three of the assistant's
# guard sources — `assistant`, `assistant:page-context` and
# `assistant:outbound` — and will cover a fourth automatically, which is why
# the match is a prefix rather than a list.
#
# NOT COUNTED, stated so the coverage claim is honest:
#
#   · The guidance-route refusal (#3845). It replaces the answer AFTER the
#     egress guard and writes a `logger.warn`, not a row, so it is not
#     readable from Postgres. It shows in the journal, not here.
#   · The 429 capacity refusal. The stream route refuses before any usecase
#     runs, so there is no row either. A tenant hitting its stream cap is a
#     load signal rather than a guard signal, and conflating them would make
#     this metric fire for a reason its documentation does not mention.
#   · A tenant in `AUDIT` guard mode. The mode resolves non-clean verdicts to
#     `allow`, so nothing is refused and nothing is counted — correctly: the
#     user was not blocked.
#
# ── THE WINDOW ─────────────────────────────────────────────────────────────
#
# One hour, on a 10-minute timer. A rate needs enough attempts to mean
# anything: at the default `AI_RISK_DAILY_QUOTA` of 50 turns per tenant per
# day, a 5-minute window would usually hold zero and the rate would be noise.
# An hour is the shortest window in which the denominator is routinely
# non-trivial.
#
# `AuditLog`'s indexes are all `[tenantId, ...]`-prefixed and this reporter is
# deliberately cross-tenant, so the scan is not index-covered. That is the
# reason the window is bounded tightly and the timer is 10 minutes rather than
# 5 — the same trade the work-overdue reporter makes, noted here so the next
# person does not widen the window without knowing the cost.

set -uo pipefail

PROJECT=hazel-design-419410
PG_CONTAINER=${PG_CONTAINER:-inflect-postgres-1}
MD="http://metadata.google.internal/computeMetadata/v1"
H="Metadata-Flavor: Google"
DRY_RUN=${ASSISTANT_HEALTH_DRY_RUN:-0}

# The refusal rate that should wake somebody. Not a round number: the guard's
# default `balanced` mode flags rather than blocks, and a healthy tenant's
# assistant traffic does trip it occasionally — a policy body quoting
# "ignore previous instructions" in a training example is a real document.
# Sustained refusal of a THIRD of attempts is not that.
REFUSAL_PCT_ALARM=33

read_count() {
    # $1 = SQL returning exactly one integer.
    docker exec -i "$PG_CONTAINER" \
        sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -f -' <<SQL 2>&1
$1
SQL
}

check() {
    # $1 = label, $2 = SQL. Echoes the integer, or returns non-zero.
    local label="$1" sql="$2" n rc
    n=$(read_count "$sql")
    rc=$?
    if [ $rc -ne 0 ] || ! printf '%s' "$n" | grep -Eq '^[0-9]+$'; then
        echo "could not read '$label' (rc=$rc): $n" >&2
        return 1
    fi
    printf '%s' "$n"
}

BAIL='echo "emitting NOTHING — an unreadable number is not a healthy one" >&2; exit 1'

TURNS=$(check assistant_turns "
SELECT count(*) FROM \"AiDecisionLog\"
 WHERE feature = 'assistant'
   AND \"createdAt\" > now() - interval '1 hour';
") || eval "$BAIL"

REFUSALS=$(check assistant_refusals "
SELECT count(*) FROM \"AuditLog\"
 WHERE entity = 'AiGuard'
   AND \"entityId\" LIKE 'assistant%'
   AND \"createdAt\" > now() - interval '1 hour';
") || eval "$BAIL"

PROPOSALS=$(check assistant_proposals "
SELECT count(*) FROM \"AgentProposal\"
 WHERE \"createdAt\" > now() - interval '1 hour';
") || eval "$BAIL"

ATTEMPTS=$((TURNS + REFUSALS))
# Integer percent. Zero attempts is 0% BY DEFINITION and not a missing value:
# no attempt was refused because none was made, which is the healthy reading
# and must not look like an absent metric (rule 2).
if [ "$ATTEMPTS" -gt 0 ]; then
    REFUSAL_PCT=$(( (REFUSALS * 100) / ATTEMPTS ))
else
    REFUSAL_PCT=0
fi

# Detail to the journal when there is something to say, so whoever is paged has
# the WHICH as well as the HOW MANY.
if [ "$REFUSAL_PCT" -ge "$REFUSAL_PCT_ALARM" ]; then
    echo "assistant refusal rate ${REFUSAL_PCT}% (refusals=$REFUSALS attempts=$ATTEMPTS) over the last hour" >&2
    read_count "
SELECT \"entityId\" || ' ' || action || ' n=' || count(*)
  FROM \"AuditLog\"
 WHERE entity = 'AiGuard'
   AND \"entityId\" LIKE 'assistant%'
   AND \"createdAt\" > now() - interval '1 hour'
 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20;
" >&2
fi

IID=$(curl -s -H "$H" "$MD/instance/id")
ZONE=$(curl -s -H "$H" "$MD/instance/zone" | awk -F/ '{print $NF}')
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ -z "$IID" ] || [ -z "$ZONE" ]; then
    echo "no instance identity from the metadata server" >&2
    exit 1
fi

series_of() {
    # $1 = metric short name, $2 = value
    printf '{"metric":{"type":"custom.googleapis.com/ai/%s"},"resource":{"type":"gce_instance","labels":{"instance_id":"%s","zone":"%s","project_id":"%s"}},"points":[{"interval":{"endTime":"%s"},"value":{"int64Value":"%s"}}]}' \
        "$1" "$IID" "$ZONE" "$PROJECT" "$NOW" "$2"
}

# FOUR series in ONE post. `timeSeries` accepts differing metric types, so the
# split is for the ALERTS' sake, not the reporter's. `assistant_turns` and
# `assistant_refusals` are published alongside the rate because a percentage
# with no denominator cannot be interpreted on a dashboard at 03:00 — 100% of
# two attempts and 100% of two hundred are different incidents.
PAYLOAD="{\"timeSeries\":[\
$(series_of assistant_refusal_pct "$REFUSAL_PCT"),\
$(series_of assistant_refusals "$REFUSALS"),\
$(series_of assistant_turns "$TURNS"),\
$(series_of assistant_proposal_volume "$PROPOSALS")]}"

if [ "$DRY_RUN" = "1" ]; then
    echo "DRY RUN — would POST to projects/$PROJECT/timeSeries:"
    echo "$PAYLOAD"
    exit 0
fi

TOKEN=$(curl -s -H "$H" "$MD/instance/service-accounts/default/token" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -z "$TOKEN" ] && { echo "no token" >&2; exit 1; }

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "https://monitoring.googleapis.com/v3/projects/$PROJECT/timeSeries" -o /tmp/ah-resp.json -w '%{http_code}'
echo
