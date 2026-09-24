#!/usr/bin/env bash
# Report docker container health to GCP Monitoring as a custom metric (#2745).
#
# WHY THIS EXISTS. The worker healthcheck flips the container to `unhealthy`
# when the BullMQ heartbeat goes stale — a signal only a CONSUMING worker can
# produce. Nothing watched that: `restart: unless-stopped` does not act on
# unhealthy, and the /api/readyz uptime check is the APP tier's view and stays
# 200 with a dead worker. This carries the signal to where an alert can see it.
#
# WHY NO OPS AGENT. The VM's service account already holds
# `monitoring.write`, so a token from the metadata server is enough. Installing
# an agent to move one number would be a bigger footprint for no more signal.
#
# WHAT IT REPORTS. custom.googleapis.com/docker/container_health, one point per
# container, labelled by name:
#     1 = healthy, or running with no healthcheck declared
#     0 = unhealthy, or not running
#
# A container with no healthcheck reports 1 DELIBERATELY. Reporting 0 would
# make caddy and watchtower permanently "failing" and the alert useless within
# a day. Absence of a healthcheck is not evidence of ill health — and the
# ABSENCE of this metric entirely is handled by a separate alert condition,
# because a reporter that has died must not read as "everything is fine".
set -uo pipefail

PROJECT=hazel-design-419410
MD="http://metadata.google.internal/computeMetadata/v1"
H="Metadata-Flavor: Google"

TOKEN=$(curl -s -H "$H" "$MD/instance/service-accounts/default/token" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -z "$TOKEN" ] && { echo "no token" >&2; exit 1; }
IID=$(curl -s -H "$H" "$MD/instance/id")
ZONE=$(curl -s -H "$H" "$MD/instance/zone" | awk -F/ '{print $NF}')
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

SERIES=""
while IFS='|' read -r name state health; do
    [ -z "$name" ] && continue
    if [ "$state" != "running" ]; then v=0
    elif [ "$health" = "unhealthy" ]; then v=0
    elif [ "$health" = "starting" ]; then continue   # not yet a verdict; say nothing
    else v=1
    fi
    [ -n "$SERIES" ] && SERIES="$SERIES,"
    SERIES="$SERIES{\"metric\":{\"type\":\"custom.googleapis.com/docker/container_health\",\"labels\":{\"container\":\"$name\"}},\"resource\":{\"type\":\"gce_instance\",\"labels\":{\"instance_id\":\"$IID\",\"zone\":\"$ZONE\",\"project_id\":\"$PROJECT\"}},\"points\":[{\"interval\":{\"endTime\":\"$NOW\"},\"value\":{\"int64Value\":\"$v\"}}]}"
done < <(docker ps -a --filter "name=inflect-" --format '{{.Names}}' | while read -r n; do
             docker inspect "$n" --format '{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null | sed 's|^/||'
         done)

# ── Root filesystem usage (#2745 follow-up) ────────────────────────────────
#
# WHY THIS IS HERE AND NOT IN AN OPS AGENT. `agent.googleapis.com/disk/*` has a
# descriptor in this project but writes NO time series for this VM — the agent
# is not installed here, and installing one to move a second number would be a
# bigger footprint than one line of df.
#
# WHY IT EXISTS AT ALL. On 2026-09-24 the root filesystem reached 100%,
# postgres could not write WAL, crashed mid-write, began recovery and crashed
# again — eight times. Every crash took /api/readyz down, so the FIRST signal
# of a full disk was a database already failing. 14 GB of it was images from
# two historical org renames that nothing was responsible for removing:
# WATCHTOWER_CLEANUP only prunes the image path it manages, so a renamed
# registry path orphans its images permanently.
#
# Reported as a PERCENTAGE, not bytes free, so the threshold does not need
# revisiting when the disk is resized.
DISK_PCT=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "$DISK_PCT" ]; then
    [ -n "$SERIES" ] && SERIES="$SERIES,"
    SERIES="$SERIES{\"metric\":{\"type\":\"custom.googleapis.com/host/disk_percent_used\",\"labels\":{\"mount\":\"root\"}},\"resource\":{\"type\":\"gce_instance\",\"labels\":{\"instance_id\":\"$IID\",\"zone\":\"$ZONE\",\"project_id\":\"$PROJECT\"}},\"points\":[{\"interval\":{\"endTime\":\"$NOW\"},\"value\":{\"int64Value\":\"$DISK_PCT\"}}]}"
fi

[ -z "$SERIES" ] && { echo "no containers" >&2; exit 0; }

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"timeSeries\":[$SERIES]}" \
  "https://monitoring.googleapis.com/v3/projects/$PROJECT/timeSeries" -o /tmp/ch-resp.json -w '%{http_code}'
