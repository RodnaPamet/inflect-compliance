#!/usr/bin/env bash
# Report the stranded identity-write backlog to GCP Monitoring (#2842).
#
# ── WHAT AN UNSETTLED WRITE IS ──────────────────────────────────────────────
#
# `IdentityWriteJournal` captures an account's prior state BEFORE the product
# calls the directory, then settles the row with the outcome. Two outcomes are
# UNSETTLED — the write's result was never confirmed:
#
#     PENDING        we crashed between the capture and the report
#     INDETERMINATE  the provider call never reported back
#
# Both mean the same thing to a human: the directory MAY OR MAY NOT have
# changed, and an account is in unknown state. It is the one identity condition
# that cannot be left to someone noticing — a leaver whose disable half-landed
# looks, from every screen, exactly like a leaver who was disabled.
#
# ── WHY THIS IS NOT A PROMETHEUS ALERT ──────────────────────────────────────
#
# `src/lib/observability/integration-metrics.ts` carried, for months, the
# instruction `ALERT ON increase(identity_write_unsettled_total[2d]) > 0`. That
# alert could never have worked here, twice over:
#
#   1. There is no Prometheus and no Alertmanager. `deploy/docker-compose.prod.yml`
#      references neither. `infra/alerts/rules.yml` and `infra/alerts/receivers.yml`
#      describe a stack that is not deployed — 22 rules, none of them running.
#   2. The app container has NO `OTEL_*` environment set, so the OTel meter
#      exports nowhere. `recordIdentityWritesUnsettled` increments a counter
#      that is discarded in-process. The metric is DEAD in production, not
#      merely unalerted.
#
# Adding a 23rd rule to `rules.yml` would have been worse than nothing: it would
# read, to the next person, as coverage.
#
# ── AND WHY NOT THE OTEL COUNTER EVEN IF IT DID EXPORT ──────────────────────
#
# `identity.write.unsettled` is emitted only from `readUnsettledBacklog`, at the
# head of a leaver pass. So the signal exists only WHEN A PASS RUNS. If the
# dispatcher stops — the job unscheduled, the worker wedged, the tenant narrowed
# back to DISABLED after an incident — the counter goes quiet, and quiet reads as
# healthy. That is the same silent-success shape `infra/alerts/external-uptime.yml`
# was rewritten to remove.
#
# It is also a monotonic COUNTER fed a LEVEL, as its own docblock warns: three
# rows stranded for ever add +3 every night, so the sum can say "it stopped
# growing" but never "the backlog is clear". This reporter emits the LEVEL as a
# gauge, which is the shape the question actually has.
#
# This reporter reads the DATABASE on its own timer. It has no dependency on the
# pass running, which matters most in exactly the case where the pass is what
# broke.
#
# ── WHY `docker exec` AND NOT A CONNECTION STRING ───────────────────────────
#
# Same reasoning as `container-health-reporter.sh` taking its token from the
# metadata server: this script holds NO credential. It runs psql inside the
# postgres container under the container's own superuser, so there is nothing
# here to leak and nothing to rotate. It also bypasses pgbouncer deliberately —
# a monitoring read must not consume an application pool slot.
#
# ── THE RLS TRAP, WHICH IS THE WHOLE REASON THIS COMMENT IS LONG ────────────
#
# `IdentityWriteJournal` is `FORCE ROW LEVEL SECURITY` with
#     tenant_isolation   USING ("tenantId" = current_setting('app.tenant_id', true))
#     superuser_bypass   USING (current_setting('role') != 'app_user')
#
# Measured on production 2026-09-24, same database, same table, same instant:
#
#     psql as postgres, no SET ROLE            -> 3 rows
#     BEGIN; SET LOCAL ROLE app_user; ...      -> 0 rows
#
# So a reporter that helpfully "does the right thing" and assumes the app's RLS
# posture returns ZERO FOR EVERY TENANT, for ever, and the alert is silent by
# construction. There is no error, no warning and no way to tell that reading
# from the number. This script MUST NOT `SET ROLE app_user`. The `postgres` role
# is `rolsuper=t rolbypassrls=t`, which is what makes the cross-tenant sweep
# possible at all — a genuinely cross-tenant read is the one case
# `runWithoutRls({ reason: 'cross-tenant-sweep' })` exists for in the app, and
# this is its out-of-process equivalent.
#
# ── TOTAL, NOT PER TENANT ───────────────────────────────────────────────────
#
# One series, no tenant label, always emitted. Three reasons, in order:
#
#   1. ABSENCE HAS TO BE UNAMBIGUOUS. The alert's second condition is "this
#      metric stopped arriving". With a per-tenant label, a tenant strands a row
#      and a NEW time series appears; when the row is settled the series simply
#      stops — indistinguishable from the reporter dying. A tenant deleted, or
#      one that has never stranded anything, emits nothing at all. Absence would
#      then be normal, and an absence condition over normal absence is noise.
#      One always-present series makes "no data" mean exactly one thing.
#   2. CARDINALITY IS UNBOUNDED BY DESIGN. Tenants are added by signup (10 in
#      production today). A GCP custom metric label is a per-series cost and
#      stale series linger long after the tenant is gone.
#   3. THE ALERT DOES NOT NEED IT. Every answer is the same — go and look. WHICH
#      tenant is a triage question, and triage has the per-tenant breakdown right
#      here in journald (`journalctl -u identity-unsettled-reporter`) plus the
#      journal table itself.
#
# ── ABSENCE IS NOT HEALTH ───────────────────────────────────────────────────
#
# If the query fails for ANY reason — postgres down, container renamed, psql
# error, a non-numeric answer — this script emits NOTHING and exits non-zero. It
# never posts 0 on a failed read. Reporting 0 would convert "we cannot tell" into
# "there is no backlog", which is the exact inversion this whole subsystem
# exists to prevent, and `readUnsettledBacklog` already refuses it in the app by
# returning null rather than 0. The alert policy's `conditionAbsent` arm is what
# catches the silence.
#
# ── DRY RUN ─────────────────────────────────────────────────────────────────
#
# `IDENTITY_UNSETTLED_DRY_RUN=1` does every read and prints the payload it WOULD
# post, without touching GCP. That is how this was exercised against production
# before anything was armed, and it is the first step of the apply procedure in
# infra/reporters/README.md — posting a point creates the metric descriptor, so
# the first real POST is not reversible in the way a dry run is.
set -uo pipefail

PROJECT=hazel-design-419410
PG_CONTAINER=${PG_CONTAINER:-inflect-postgres-1}
MD="http://metadata.google.internal/computeMetadata/v1"
H="Metadata-Flavor: Google"
DRY_RUN=${IDENTITY_UNSETTLED_DRY_RUN:-0}

# How stale an unsettled row must be before it counts as STRANDED.
#
# NOT INVENTED HERE. This is `UNSETTLED_STALE_MS` from
# src/app-layer/usecases/identity-leaver-pass.ts, which is `60 * 60 * 1000`, and
# its docblock gives the reasoning: "a row is minted and settled within the same
# candidate, seconds apart, so anything unsettled for an hour was left behind
# rather than being in flight." The window is generous on purpose — it exists to
# avoid counting a concurrent pass's IN-FLIGHT write as stranded.
#
# The two must not drift. `tests/guards/unsettled-reporter-matches-the-product.test.ts`
# parses both and fails if they disagree, because a reporter quietly measuring a
# different population from the code that settles the rows produces a number
# nobody can act on.
STALE_INTERVAL='1 hour'

# ── read ────────────────────────────────────────────────────────────────────
#
# SQL goes over STDIN, not as an argument. An earlier draft interpolated it into
# `sh -c "psql -tAc \"$SQL\""`; the inner shell re-parsed the quotes, stripped
# the ones around "IdentityWriteJournal", and Postgres folded the bare
# identifier to lowercase and errored. Over stdin there is one level of quoting
# and the identifier survives.
#
# Cross-tenant on purpose, and both unsettled outcomes, spelled the same way
# `listUnsettledWrites` spells them.
COUNT=$(docker exec -i "$PG_CONTAINER" \
    sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -f -' <<SQL 2>&1
SELECT count(*) FROM "IdentityWriteJournal"
 WHERE outcome IN ('PENDING','INDETERMINATE')
   AND "attemptedAt" < now() - interval '$STALE_INTERVAL';
SQL
)
RC=$?

# A clean non-negative integer, or nothing at all. Matched with `[0-9]+` rather
# than tested with `-n`: psql writes its errors to the same capture, and
# `ERROR:  relation "..." does not exist` is a non-empty string that a laxer
# check would hand to the metric API as a value.
if [ $RC -ne 0 ] || ! printf '%s' "$COUNT" | grep -Eq '^[0-9]+$'; then
    echo "could not read the unsettled-write backlog (rc=$RC): $COUNT" >&2
    echo "emitting NOTHING — an unreadable backlog is not an empty one" >&2
    exit 1
fi

# ── triage detail, only when there is something to triage ───────────────────
#
# journald, not the metric. Carries tenant and provider so an operator knows
# where to look without opening psql, and the oldest `attemptedAt` so they can
# see whether the backlog is ageing or was just created. `linkId` is the safe
# handle the product itself logs; `externalUserId` and `detail` are deliberately
# NOT selected, for the same reasons `listUnsettledWrites` refuses them — one is
# a directory identifier, the other is encrypted free text about a named person.
if [ "$COUNT" -gt 0 ]; then
    echo "UNSETTLED identity writes: $COUNT stranded row(s) older than $STALE_INTERVAL" >&2
    docker exec -i "$PG_CONTAINER" \
        sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -f -' >&2 2>&1 <<SQL
SELECT "tenantId" || ' ' || provider || ' n=' || count(*) || ' oldest=' || min("attemptedAt")
  FROM "IdentityWriteJournal"
 WHERE outcome IN ('PENDING','INDETERMINATE')
   AND "attemptedAt" < now() - interval '$STALE_INTERVAL'
 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 50;
SQL
fi

# ── post ────────────────────────────────────────────────────────────────────
IID=$(curl -s -H "$H" "$MD/instance/id")
ZONE=$(curl -s -H "$H" "$MD/instance/zone" | awk -F/ '{print $NF}')
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ -z "$IID" ] || [ -z "$ZONE" ]; then
    echo "no instance identity from the metadata server" >&2
    exit 1
fi

SERIES="{\"metric\":{\"type\":\"custom.googleapis.com/identity/write_unsettled\"},\"resource\":{\"type\":\"gce_instance\",\"labels\":{\"instance_id\":\"$IID\",\"zone\":\"$ZONE\",\"project_id\":\"$PROJECT\"}},\"points\":[{\"interval\":{\"endTime\":\"$NOW\"},\"value\":{\"int64Value\":\"$COUNT\"}}]}"

if [ "$DRY_RUN" = "1" ]; then
    echo "DRY RUN — would POST to projects/$PROJECT/timeSeries:"
    echo "{\"timeSeries\":[$SERIES]}"
    exit 0
fi

TOKEN=$(curl -s -H "$H" "$MD/instance/service-accounts/default/token" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -z "$TOKEN" ] && { echo "no token" >&2; exit 1; }

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"timeSeries\":[$SERIES]}" \
  "https://monitoring.googleapis.com/v3/projects/$PROJECT/timeSeries" -o /tmp/iu-resp.json -w '%{http_code}'
