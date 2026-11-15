#!/usr/bin/env bash
#
# NAMED CHANGES TO THE PRODUCTION VM — the VM half.
#
# Runs ON the VM, as root, from `vm.sh`, which the dispatch-only `VM apply`
# workflow runs (.github/workflows/vm-apply.yml). It carries the five changes
# `deploy/apply.sh` has no mode for, from the capacity budget C1 runbook
# (docs/implementation-notes/2026-11-12-capacity-c1.md), C1b, #5308 and the
# tei-embed rollback:
#
#   remote.sh <action> <stage-dir>
#
#   retire-lab-containers        runbook step 1: stop and remove the OrangeHRM
#                                lab's three containers, keeping its volumes
#   recreate-legacy-mcp-proving  runbook step 5: install the repo's proving
#                                overlay (staged in <stage-dir>) and recreate
#                                that one service with its limits
#   retire-capacity-recorder     C1b's rollback: stop and disable the capacity
#                                recorder's timer, remove its unit files, its
#                                script and its recorded rows. apply.sh's
#                                host-config modes install it; a revert of
#                                its HOST_CONFIG_SET entries keeps it gone
#   refresh-env-prod-example     #5308: replace the VM's copy of the PUBLIC
#                                template deploy/.env.prod.example (staged in
#                                <stage-dir>) with the repo's, so
#                                check-drift.sh, which trusts that copy only
#                                while it is byte-identical to the repo's,
#                                stops reporting it
#   retire-tei-embed             the tei-embed service's rollback: stop and
#                                remove its one container, keeping the
#                                tei-embed-data volume; by compose if the live
#                                file still defines it, by its compose labels
#                                if not
#
# Each checks its preconditions before it changes anything, and stops if one
# fails.
#
# THE WORKFLOW'S LOGS ARE PUBLIC, because the repository is. This prints
# container and volume names, states, counts and limits. `docker compose` reads
# .env and .env.prod, so its output is only ever piped into `shape`, which keeps
# the resource lines compose prints and withholds the rest; a compose file, an
# env file, or a container's environment, command line or labels is never
# printed.
#
set -euo pipefail

ACTION="${1:?action}"
STAGE="${2:?stage directory}"
cd /opt/inflect
TS="$(date +%Y%m%d-%H%M%S)"

# The host env files, in apply.sh's order: interpolation needs both.
compose() { docker compose --env-file .env --env-file .env.prod "$@"; }

# Compose's output reduced to `<Kind> <name> <state>` lines and the NAME of a
# variable a ':?' guard found missing; everything else is counted and withheld.
shape() {
    awk '
        { n++ }
        match($0, /required variable [A-Za-z_][A-Za-z0-9_]*/) {
            print "  " substr($0, RSTART, RLENGTH); kept++; next
        }
        {
            for (i = 1; i + 1 <= NF; i++) {
                if ($i !~ /^(Container|Network|Volume|Image)$/) continue
                state = (i + 2 <= NF) ? $(i + 2) : ""
                if ($(i + 1) ~ /^[A-Za-z0-9._\/:@-]+$/ && state ~ /^[A-Za-z]*$/) {
                    print "  " $i " " $(i + 1) " " state; kept++; next
                }
            }
        }
        END { if (n > kept) printf "  [%d line(s) withheld: this log is public]\n", n - kept }'
}

case "$ACTION" in
retire-lab-containers)
    # NEVER `docker compose down`. The lab runs in the production Compose
    # project, so `down` would also remove the project's networks, starting with
    # `inflect_default`, which every production container is attached to; with
    # docker-compose.prod.yml in the -f list it stops the whole stack. `rm
    # --stop --force` acts on the three named services only, and without `-v`
    # removes no volume: the lab's data is kept for the runbook's 30 days.
    LAB_SERVICES=(orangehrm-mcp orangehrm orangehrm-db)
    lab_count() {
        local s total=0
        for s in "${LAB_SERVICES[@]}"; do
            total=$((total + $(docker ps -aq --filter "label=com.docker.compose.service=$s" | wc -l)))
        done
        echo "$total"
    }
    before="$(lab_count)"
    echo "lab containers before: $before"
    if [ "$before" -eq 0 ]; then
        echo "nothing to retire: no container of ${LAB_SERVICES[*]} exists"
    elif [ -f docker-compose.orangehrm-lab.yml ]; then
        compose -f docker-compose.prod.yml -f docker-compose.orangehrm-lab.yml \
            rm --stop --force "${LAB_SERVICES[@]}" 2>&1 | shape
    else
        # The overlay is gone from the VM, so compose cannot name the services.
        # The same three, by the service label compose stamped on them.
        echo "no lab overlay on the VM: removing the containers by their compose service label"
        for s in "${LAB_SERVICES[@]}"; do
            ids="$(docker ps -aq --filter "label=com.docker.compose.service=$s")"
            # shellcheck disable=SC2086  # one id per word is the point
            [ -z "$ids" ] || docker rm --force $ids >/dev/null
        done
    fi
    after="$(lab_count)"
    echo "lab containers after: $after"
    echo "lab volumes kept:"
    docker volume ls --format '{{.Name}}' | grep -F orangehrm | sed 's/^/  /' || echo "  (none)"
    [ "$after" -eq 0 ] || { echo "a lab container is still present" >&2; exit 1; }
    ;;

retire-tei-embed)
    # The rollback of the tei-embed service (owner decision 2026-11-15): a
    # revert of its compose entry is not enough, because `up -d` leaves a
    # service that has left the file running. Like the lab: `rm --stop
    # --force` of that ONE service, never `down` (it would take the project's
    # network, and with it every production container), and never
    # `up -d --remove-orphans` (the scanner and proving-server overlays share
    # this Compose project, so their containers are orphans of the canonical
    # file and would go too). Without `-v`: the tei-embed-data volume, the
    # model weights fetched on first start, is kept, so a re-apply does not
    # fetch them again.
    #
    # The project is compose's default, the directory's name, which is why the
    # live containers are named inflect-<service>-1 and the volume
    # inflect_tei-embed-data. A container is the service's when it carries
    # BOTH compose labels: the identity `compose rm` itself selects on, and
    # stricter than a name, which compose only derives by default.
    SERVICE=tei-embed
    PROJECT="$(basename "$PWD")"
    VOLUME="${PROJECT}_${SERVICE}-data"
    tei_ids() {
        docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" \
            --filter "label=com.docker.compose.service=$SERVICE"
    }
    # Each list is a plain assignment, so a `docker ps` that fails stops the
    # run (set -e) rather than reading as "no container".
    tei_report() {
        local id n name
        n=0
        for id in $2; do
            n=$((n + 1))
            name="$(docker inspect -f '{{.Name}}' "$id")"
            echo "  ${name#/} $(docker inspect -f '{{.State.Status}}' "$id")"
        done
        echo "  $1: $n $SERVICE container(s)"
    }
    # A count, not `grep -q`, which can stop reading early and fail the lister.
    volume_present() { [ "$(docker volume ls --format '{{.Name}}' | grep -cFx "$VOLUME")" -gt 0 ] && echo yes || echo no; }
    vol_before="$(volume_present)"
    ids="$(tei_ids)"
    tei_report before "$ids"
    if [ -z "$ids" ]; then
        echo "nothing to retire: no $SERVICE container exists"
    else
        rc=0
        compose -f docker-compose.prod.yml rm --stop --force "$SERVICE" 2>&1 | shape || rc=$?
        ids="$(tei_ids)"
        if [ -n "$ids" ]; then
            # The live compose file no longer defines the service (compose
            # exits 1, "no such service"), or did not interpolate: compose
            # cannot name it, so the same containers, by the same two labels.
            echo "compose did not remove it (exit $rc): removing the container by its compose project and service labels"
            # shellcheck disable=SC2086  # one id per word is the point
            docker rm --force $ids >/dev/null
        fi
    fi
    ids="$(tei_ids)"
    tei_report after "$ids"
    vol_after="$(volume_present)"
    echo "volume $VOLUME present: before $vol_before, after $vol_after"
    [ -z "$ids" ] || { echo "a $SERVICE container is still present" >&2; exit 1; }
    [ "$vol_after" = "$vol_before" ] || { echo "the $VOLUME volume changed" >&2; exit 1; }
    ;;

recreate-legacy-mcp-proving)
    OVERLAY=docker-compose.legacy-mcp-proving.yml
    SERVICE=legacy-mcp-proving
    NEW="$OVERLAY.new.$TS"
    [ -s "$STAGE/$OVERLAY" ] || { echo "the stage is missing $OVERLAY" >&2; exit 1; }
    install -m 0644 -o root -g root "$STAGE/$OVERLAY" "$NEW"
    trap 'rm -f "/opt/inflect/$NEW"' EXIT

    # Preconditions, each a yes or no; no value is read out.
    [ -s "$SERVICE/app.mjs" ] || { echo "precondition: /opt/inflect/$SERVICE/app.mjs is absent" >&2; exit 1; }
    grep -qE '^LEGACY_MCP_PROVING_TOKEN=.' .env.prod \
        || { echo "precondition: LEGACY_MCP_PROVING_TOKEN is not set in .env.prod" >&2; exit 1; }
    echo "preconditions: the bundle and the token are present"

    # The staged overlay, validated beside the live files so its relative paths
    # resolve as they will at `up` time.
    rc=0
    compose -f docker-compose.prod.yml -f "$NEW" config -q 2>&1 | shape || rc=$?
    [ "$rc" -eq 0 ] || { echo "the overlay does not validate. Nothing was changed." >&2; exit 1; }
    echo "overlay config OK"

    if [ -f "$OVERLAY" ]; then
        if cmp -s "$OVERLAY" "$NEW"; then
            echo "the live overlay already matches the repo; recreating to apply it"
        else
            cp -a "$OVERLAY" "$OVERLAY.bak.$TS" && chmod 600 "$OVERLAY.bak.$TS"
            echo "previous overlay kept as $OVERLAY.bak.$TS"
        fi
    fi
    mv "$NEW" "$OVERLAY"

    compose -f docker-compose.prod.yml -f "$OVERLAY" up -d --no-deps "$SERVICE" 2>&1 | shape

    id="$(docker ps -aq --filter "label=com.docker.compose.service=$SERVICE" | head -n 1)"
    [ -n "$id" ] || { echo "no $SERVICE container after up" >&2; exit 1; }
    # Its health check runs every 30 s; wait up to three minutes for a verdict.
    health=""
    for _ in $(seq 1 18); do
        health="$(docker inspect -f '{{.State.Health.Status}}' "$id")"
        [ "$health" = "starting" ] || break
        sleep 10
    done
    echo "$SERVICE: state $(docker inspect -f '{{.State.Status}}' "$id"), health $health"
    echo "$SERVICE: memory limit $(docker inspect -f '{{.HostConfig.Memory}}' "$id") bytes, CPU limit $(docker inspect -f '{{.HostConfig.NanoCpus}}' "$id") nano-CPUs"
    [ "$health" = "healthy" ] || { echo "$SERVICE is not healthy" >&2; exit 1; }
    ;;

retire-capacity-recorder)
    # The recorder touches no container and nothing depends on it, so this
    # stops it and removes every file it placed. It reports what it found and
    # what is left, by name and count; the rows themselves are never printed.
    UNIT=inflect-capacity-record
    FILES=("/etc/systemd/system/$UNIT.timer" "/etc/systemd/system/$UNIT.service" /usr/local/lib/inflect-capacity/inflect-capacity-record.sh)
    present() { local f n=0; for f in "${FILES[@]}"; do [ -e "$f" ] && n=$((n + 1)); done; echo "$n"; }
    rows_dir=/var/lib/inflect-capacity
    echo "recorder files before: $(present) of ${#FILES[@]}; day files: $(find "$rows_dir" -maxdepth 1 -name 'capacity-*.tsv' 2>/dev/null | wc -l)"
    echo "timer before: $(systemctl is-enabled "$UNIT.timer" 2>/dev/null || true) / $(systemctl is-active "$UNIT.timer" 2>/dev/null || true)"
    systemctl disable --now "$UNIT.timer" >/dev/null 2>&1 || true
    systemctl stop "$UNIT.service" >/dev/null 2>&1 || true
    rm -f "${FILES[@]}"
    rmdir /usr/local/lib/inflect-capacity 2>/dev/null || true
    rm -rf "$rows_dir"
    systemctl daemon-reload
    systemctl reset-failed "$UNIT.service" "$UNIT.timer" >/dev/null 2>&1 || true
    left="$(present)"
    echo "recorder files after: $left; data directory present: $([ -e "$rows_dir" ] && echo yes || echo no)"
    echo "timer after: $(systemctl is-active "$UNIT.timer" 2>/dev/null || true)"
    [ "$left" -eq 0 ] && [ ! -e "$rows_dir" ] || { echo "a recorder file is still present" >&2; exit 1; }
    ;;

refresh-env-prod-example)
    # The VM keeps a copy of deploy/.env.prod.example beside .env.prod. It is a
    # PUBLIC template, and check-drift.sh accepts its credential-shaped
    # placeholders only while it is byte-identical to the repo's copy, so a
    # repo change to the template (RATE_LIMIT_MODE, #5308) turns the VM's copy
    # into a reported credential until this replaces it. It writes that one
    # path and nothing else: never .env.prod, never .env.
    #
    # Hashes, not content: a 12-character prefix of each file's sha256 is what
    # the log shows. The previous copy is kept root-only, because what a
    # hand-edited copy held is not known.
    FILE=.env.prod.example
    NEW="$FILE.new.$TS"
    [ -s "$STAGE/$FILE" ] || { echo "the stage is missing $FILE" >&2; exit 1; }
    # Preconditions, each a yes or no. A symlink would make the install write
    # through it to wherever it points.
    [ ! -L "$FILE" ] || { echo "precondition: /opt/inflect/$FILE is a symlink. Nothing was changed." >&2; exit 1; }
    [ ! -e "$FILE" ] || [ -f "$FILE" ] || { echo "precondition: /opt/inflect/$FILE is not a regular file. Nothing was changed." >&2; exit 1; }
    repo_sha="$(sha256sum "$STAGE/$FILE" | awk '{print $1}')"
    live_sha=""
    if [ -f "$FILE" ]; then live_sha="$(sha256sum "$FILE" | awk '{print $1}')"; fi
    echo "repo copy: sha256 ${repo_sha:0:12}"
    echo "live copy: ${live_sha:+sha256 ${live_sha:0:12}}${live_sha:-absent}"
    if [ "$live_sha" = "$repo_sha" ]; then
        echo "the live copy already matches the repo; nothing changed"
    else
        install -m 0644 -o root -g root "$STAGE/$FILE" "$NEW"
        trap 'rm -f "/opt/inflect/$NEW"' EXIT
        if [ -n "$live_sha" ]; then
            cp -a "$FILE" "$FILE.bak.$TS" && chmod 600 "$FILE.bak.$TS"
            echo "previous copy kept as $FILE.bak.$TS (root only)"
        fi
        mv "$NEW" "$FILE"
        after="$(sha256sum "$FILE" | awk '{print $1}')"
        echo "live copy now: sha256 ${after:0:12}"
        [ "$after" = "$repo_sha" ] || { echo "the live copy does not match the repo after the install" >&2; exit 1; }
    fi
    ;;

*)
    echo "unknown action: $ACTION" >&2
    exit 2
    ;;
esac
