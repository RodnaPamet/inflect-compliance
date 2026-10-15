#!/usr/bin/env bash
#
# deploy/apply.sh — push the repo-canonical prod Compose set to the VM.
#
# The repo is the source of truth for the production stack's STRUCTURE
# (deploy/docker-compose.prod.yml). Watchtower auto-updates only the app +
# worker IMAGES; every structural change — a new service, a volume mount,
# an env addition — lands in the repo and is applied with this script.
# Drift is detected by deploy/check-drift.sh, never tolerated.
#
# Before #2849 there was no such script and the host file was hand-edited,
# so the repo copy diverged ~148 lines without anything noticing. See
# docs/deployment.md "The production Compose file is repo-canonical".
#
# WHAT IT PUSHES (the canonical set — the compose file is NOT the whole
# deployable unit, because it bind-mounts three repo-owned files):
#
#   deploy/docker-compose.prod.yml  → /opt/inflect/docker-compose.prod.yml
#   deploy/init-roles.sh            → /opt/inflect/init-roles.sh
#   prisma.config.ts                → /opt/inflect/prisma.config.ts
#
# …and the HOST CONFIG set, which lives outside /opt/inflect and belongs to a
# host service rather than to the compose project:
#
#   deploy/ops-agent-config.yaml    → /etc/google-cloud-ops-agent/config.yaml
#
# WHY THAT IS A SECOND SET AND NOT A FOURTH ROW OF THE FIRST. Four properties
# differ, and each one would be wrong if the two were merged:
#
#   directory   /etc/… , not ${REMOTE_DIR}, so the entry carries an ABSOLUTE
#               remote path while the canonical set carries a basename.
#   activation  a daemon restart, not `docker compose up -d`. A pushed agent
#               config that nobody reloads changes nothing at all.
#   validation  the agent's own engine parses it (`-in <file>`), which is a
#               real gate: it exits 1 on an unsupported receiver type and on
#               malformed YAML, with the line and column.
#   blast window  NONE. Pushing it recreates no container, so it needs no
#               service window — the opposite of the compose path, which
#               costs a 502 on `app`. Coupling the two would mean a logging
#               fix had to wait for a maintenance window, and a maintenance
#               window had to carry a logging change.
#
# That last one is why HOST_CONFIG_ONLY=1 exists below. The mechanism nobody
# can afford to run is the mechanism that goes unused, and an unused apply
# path is how #2849's 148-line divergence happened in the first place.
#
# This set has exactly one member today, so the agent-specific validate and
# reload steps are named inline rather than carried as fields in the array.
# A second member is the moment to generalise them, not before.
#
# WHAT IT DELIBERATELY DOES NOT PUSH:
#
#   (nothing today — the Caddyfile moved OUT of this list on 2026-10-15, see
#   CADDY_* below and #3589.)
#
# WHAT IT USED TO SAY ABOUT THE CADDYFILE, AND WHY THAT WAS WRONG:
#
#   It said the live copy "serves a SECOND vhost (app.inflect.bg) that the
#   repo copy does not define", so pushing "would delete a live production
#   hostname". The repo copy HAS defined `app.inflect.bg` since somebody
#   reconciled the hostnames, and the comment was not updated. Measured by
#   adapting both with `caddy adapt --adapter caddyfile` inside the running
#   container — which is what Caddy serves, rather than a line diff, because
#   the repo factors shared headers into an `(app_site)` snippet it imports
#   twice while the live copy spells them out per vhost:
#
#       hostnames served, repo copy: app.inflect.bg, inflect.…sslip.io,
#                                    hrm-mcp.…sslip.io,
#                                    legacy-mcp-proving.…sslip.io
#       hostnames served, live copy: the same four
#       adapted configs differ:      yes — the repo ADDS h1/h2/h3, the Next
#                                    cache-control matchers, the 110MB body
#                                    limit and the #1814/#1275 retry settings
#
#   So pushing deletes no hostname. The reason the comment gave was the one
#   thing that was not true, and it outlived the state it described — which is
#   the whole failure mode #3589 is about.
#
# WHAT IT NEVER TOUCHES: /opt/inflect/.env and /opt/inflect/.env.prod. Those
# are host-owned secret files. This script reads their KEY NAMES in preflight
# and never their values, and never echoes either.
#
# Usage:
#   DRY_RUN=1 deploy/apply.sh    # validate the repo file locally, no VM at all
#   deploy/apply.sh              # preflight on the VM, then STOP and print the plan
#   CONFIRM=1 deploy/apply.sh    # preflight, then actually apply
#
#   HOST_CONFIG_ONLY=1 CONFIRM=1 deploy/apply.sh
#                                # push ONLY the host config set and reload its
#                                # service. Touches no container, so it needs no
#                                # service window. Still requires CONFIRM=1.
#
#   CADDY_ONLY=1 CONFIRM=1 deploy/apply.sh
#                                # push ONLY the Caddyfile, then `caddy reload`
#                                # and re-check every hostname it serves.
#                                # Recreates NO container — a reload keeps the
#                                # listeners and the issued certificates — so
#                                # this needs no service window either. Rolls
#                                # the file back and reloads again if any
#                                # hostname stops answering.
#
# Applying recreates containers. Expect a short 502 window on `app` and a
# Redis restart (AOF-persisted, so queued BullMQ jobs survive). Run it in a
# service window. HOST_CONFIG_ONLY=1 is the exception: it recreates nothing.
#
# Exit: 0 = applied (or preflight-only success), 1 = failed, 2 = refused.
set -euo pipefail

# ── Config (override via env) ────────────────────────────────────────────
VM_NAME="${VM_NAME:-inflect-compliance}"
VM_ZONE="${VM_ZONE:-europe-west1-b}"
REMOTE_DIR="${REMOTE_DIR:-/opt/inflect}"
COMPOSE_BASENAME="${COMPOSE_BASENAME:-docker-compose.prod.yml}"
HEALTH_ORIGINS="${HEALTH_ORIGINS:-https://app.inflect.bg https://inflect.34-140-180-255.sslip.io}"

# The two host env files, in interpolation precedence order (later wins).
# `.env` holds POSTGRES_PASSWORD; `.env.prod` holds DATA_ENCRYPTION_KEY and
# REDIS_PASSWORD and is ALSO the file the app/worker containers read via
# `env_file:`. Naming .env.prod for interpolation too is what makes the
# compose-level DATA_ENCRYPTION_KEY agree with the container's by
# construction — see the header of the compose file.
ENV_FILES=(".env" ".env.prod")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCAL_COMPOSE="${SCRIPT_DIR}/${COMPOSE_BASENAME}"
REMOTE_COMPOSE="${REMOTE_DIR}/${COMPOSE_BASENAME}"
TS="$(date +%Y%m%d-%H%M%S)"

log()  { printf '\033[36m[apply]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[apply] WARN:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m[apply] ERROR:\033[0m %s\n' "$*" >&2; }

# ── COMPOSE_BASENAME is an allowlist, not a free variable ────────────────
#
# This script's job is ONE file: the repo-canonical prod compose. Left as a
# bare default, `COMPOSE_BASENAME=docker-compose.pipelock.yml deploy/apply.sh`
# would be a supported invocation — and the pipelock overlay bind-mounts a
# signing key that does not exist on the VM, which Docker silently turns into
# an empty DIRECTORY rather than an error. `docker compose config` validates
# syntax, not bind-mount sources, so the preflight below would pass it.
# Refuse by default; make the escape hatch awkward enough to be a decision.
CANONICAL_COMPOSE="docker-compose.prod.yml"
if [ "$COMPOSE_BASENAME" != "$CANONICAL_COMPOSE" ] \
   && [ "${I_KNOW_THIS_IS_NOT_THE_CANONICAL_COMPOSE:-0}" != "1" ]; then
    err "refusing to act on '${COMPOSE_BASENAME}' — the canonical compose is '${CANONICAL_COMPOSE}'."
    err "  Every running container on the prod VM is labelled with that file."
    err "  If you genuinely mean another one, set"
    err "  I_KNOW_THIS_IS_NOT_THE_CANONICAL_COMPOSE=1 and say why in your notes."
    exit 2
fi

[ -f "$LOCAL_COMPOSE" ] || { err "missing $LOCAL_COMPOSE"; exit 1; }

# The canonical set: "<local path>:<remote basename>".
CANONICAL_SET=(
    "${LOCAL_COMPOSE}:${COMPOSE_BASENAME}"
    "${SCRIPT_DIR}/init-roles.sh:init-roles.sh"
    "${REPO_ROOT}/prisma.config.ts:prisma.config.ts"
)

# The host config set: "<local path>:<ABSOLUTE remote path>".
#
# Absolute, because these do not live under ${REMOTE_DIR}. Same shape as
# check-drift.sh's APPLIABLE array on purpose — the two must name the same
# files or a file gets pushed and never watched, which is precisely how the
# Caddyfile became a standing divergence. tests/guards/deploy-canonical-set-is-watched.test.ts
# asserts the agreement in both directions.
HOST_CONFIG_SET=(
    "${SCRIPT_DIR}/ops-agent-config.yaml:/etc/google-cloud-ops-agent/config.yaml"
)

# ── The Caddyfile ──────────────────────────────────────────────────────────
#
# Its own pair rather than a HOST_CONFIG_SET entry, for a reason the guard
# states: `tests/guards/deploy-canonical-set-is-watched.test.ts` requires every
# HOST_CONFIG_SET remote path to live OUTSIDE ${REMOTE_DIR}, and this one is
# inside it. Its own pair rather than a CANONICAL_SET entry too, because that
# set is activated by `docker compose up -d` and a Caddyfile is not: the file is
# bind-mounted, so a changed file alone recreates nothing and `up -d` would
# report a clean apply over a Caddy still serving the previous config.
#
# What it needs instead is a RELOAD, which is also why it gets a mode of its
# own. `caddy reload` keeps the listeners and the already-issued certificates;
# recreating the container would drop both for the length of a restart, on a
# TLS terminator serving production. So CADDY_ONLY=1 needs no service window,
# and the reload is verified rather than assumed — see caddy_apply.
CADDY_LOCAL="${SCRIPT_DIR}/caddy/Caddyfile"
CADDY_REMOTE="${REMOTE_DIR}/caddy/Caddyfile"
# The container that mounts it. The reload runs INSIDE it, against the path
# Caddy itself is configured with, so a validate that passes here is a validate
# of the file the running process will read.
CADDY_CONTAINER="${CADDY_CONTAINER:-inflect-caddy-1}"
CADDY_CONFIG_IN_CONTAINER="/etc/caddy/Caddyfile"

# The service that reads the host config, and the generated artefact that
# proves the push actually reached it.
#
# `google-cloud-ops-agent` is the umbrella unit; restarting it restarts the
# fluent-bit and otel-collector subagents, which is what re-runs the
# `google_cloud_ops_agent_engine -in <config>` ExecStartPre that COMPILES the
# user config into the collector's own config. Agent 2.72 compiles LOGGING
# into otel.yaml, not into fluent-bit — so otel.yaml is where a pushed change
# becomes observable, and asserting the unit is merely `active` would pass
# over a restart that silently kept the previous pipeline.
OPS_AGENT_UNIT="google-cloud-ops-agent"
OPS_AGENT_ENGINE="/opt/google-cloud-ops-agent/libexec/google_cloud_ops_agent_engine"
OPS_AGENT_COMPILED="/run/google-cloud-ops-agent-opentelemetry-collector/otel.yaml"
# A string the compiled collector config must contain afterwards. It comes from
# the receiver in ops-agent-config.yaml, so it ties the assertion to the file
# being pushed rather than to a constant that would stay true if the push
# silently did nothing.
OPS_AGENT_COMPILED_NEEDLE="/var/lib/docker/containers"

ssh_vm() { gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap --command "$1"; }

# ── Host config set: preflight and apply ─────────────────────────────────
#
# Split into two functions because both the full run and HOST_CONFIG_ONLY=1
# need them, and because a preflight that cannot be run without applying is
# not a preflight.

host_config_preflight() {
    local entry local_path remote_path base lsha rsha staged rc
    log "host config set (pushed outside ${REMOTE_DIR}, reloads a host service):"
    for entry in "${HOST_CONFIG_SET[@]}"; do
        local_path="${entry%%:*}"; remote_path="${entry#*:}"; base="$(basename "$remote_path")"
        [ -f "$local_path" ] || { err "host config missing from the repo: $local_path"; return 1; }

        lsha="$(sha256sum "$local_path" | awk '{print $1}')"
        rsha="$(ssh_vm "sudo sha256sum '${remote_path}' 2>/dev/null || true" | awk '{print $1}')"
        if [ -z "$rsha" ]; then
            log "    WOULD CREATE ${remote_path} (absent on the VM)"
        elif [ "$lsha" = "$rsha" ]; then
            log "    unchanged  ${remote_path} (${lsha:0:12})"
        else
            log "    WOULD CHANGE ${remote_path}: repo ${lsha:0:12} → VM ${rsha:0:12}"
        fi

        # Validate with the agent's OWN engine, against TEMP output dirs.
        #
        # The engine compiles the user config into a collector config and
        # writes it under -logs/-state. Pointing those at the live runtime
        # directories would overwrite the running collector's config from a
        # preflight, so they are a throwaway mktemp -d that is removed either
        # way. This is the counterpart of `docker compose config -q` for the
        # compose file: proven to exit 1 on an unsupported receiver type and
        # on malformed YAML (reporting line:column), so it can express failure.
        staged="/tmp/${base}.validate.${TS}"
        log "    validating ${base} with ${OPS_AGENT_UNIT}'s own engine"
        gcloud compute scp "$local_path" "${VM_NAME}:${staged}" \
            --zone "$VM_ZONE" --tunnel-through-iap >/dev/null
        rc=0
        # The engine's output is captured to a file and printed AFTER, rather
        # than piped through `sed` for indentation, because the exit code is the
        # whole point of this step: a pipeline's status is its LAST command's,
        # and `set -o pipefail` is this script's setting, not the remote shell's
        # — so `engine | sed` would report sed's success for a rejected config.
        # On success the output is the MERGED config, which is the host-config
        # counterpart of the compose `up --dry-run` below: it shows what the
        # agent would actually run, including that the built-in pipelines
        # survive the merge.
        ssh_vm "set -e
            T=\$(mktemp -d)
            trap 'sudo rm -rf \"\$T\" \"${staged}\"' EXIT
            sudo mkdir -p \"\$T/logs\" \"\$T/state\"
            rc=0
            sudo ${OPS_AGENT_ENGINE} -service=otel -in '${staged}' \\
                -logs \"\$T/logs\" -state \"\$T/state\" >\"\$T/out\" 2>&1 || rc=\$?
            sed 's/^/      /' \"\$T/out\"
            exit \$rc" || rc=$?
        if [ "$rc" -ne 0 ]; then
            err "${base} is NOT a valid ${OPS_AGENT_UNIT} config — the engine rejected it."
            err "  Its own message is printed above and names either the unsupported field"
            err "  or the line:column of the YAML error. Nothing was changed."
            return 1
        fi
        log "      config OK"
    done
}

# Report what a Caddyfile push would change, and refuse a config Caddy rejects.
#
# Two separate checks, and the second is the one the old UNRECONCILED note
# asked for. `caddy validate` proves the file PARSES and adapts; comparing the
# HOSTNAMES of both adapted configs proves the push does not silently stop
# serving something. A validate alone would happily accept a file that drops a
# production vhost.
caddy_preflight() {
    local lsha rsha staged rc repo_hosts live_hosts gone
    [ -f "$CADDY_LOCAL" ] || { err "Caddyfile missing from the repo: $CADDY_LOCAL"; return 1; }

    log "Caddyfile (pushed to ${CADDY_REMOTE}, activated by reload — no container is recreated):"
    lsha="$(sha256sum "$CADDY_LOCAL" | awk '{print $1}')"
    rsha="$(ssh_vm "sudo sha256sum '${CADDY_REMOTE}' 2>/dev/null || true" | awk '{print $1}')"
    if [ -z "$rsha" ]; then
        log "    WOULD CREATE ${CADDY_REMOTE} (absent on the VM)"
    elif [ "$lsha" = "$rsha" ]; then
        log "    unchanged  ${CADDY_REMOTE} (${lsha:0:12})"
    else
        log "    WOULD CHANGE ${CADDY_REMOTE}: repo ${lsha:0:12} → VM ${rsha:0:12}"
    fi

    staged="/tmp/Caddyfile.validate.${TS}"
    gcloud compute scp "$CADDY_LOCAL" "${VM_NAME}:${staged}" \
        --zone "$VM_ZONE" --tunnel-through-iap >/dev/null

    log "    validating with ${CADDY_CONTAINER}'s own caddy binary"
    rc=0
    # Copied INTO the container rather than validated over a bind mount,
    # because the staged file is not mounted anywhere — and `caddy validate`
    # resolves `import` relative to the config, so it has to sit where the real
    # one does for a multi-file config to behave the same way.
    ssh_vm "set -e
        sudo docker cp '${staged}' '${CADDY_CONTAINER}:/tmp/Caddyfile.candidate'
        rc=0
        sudo docker exec '${CADDY_CONTAINER}' caddy validate \
            --config /tmp/Caddyfile.candidate --adapter caddyfile >/tmp/caddyval.${TS} 2>&1 || rc=\$?
        sed 's/^/      /' /tmp/caddyval.${TS}
        sudo rm -f /tmp/caddyval.${TS} '${staged}'
        exit \$rc" || rc=$?
    if [ "$rc" -ne 0 ]; then
        err "the repo Caddyfile is NOT valid — caddy rejected it. Its message is above."
        err "  Nothing was changed."
        ssh_vm "sudo docker exec '${CADDY_CONTAINER}' rm -f /tmp/Caddyfile.candidate" >/dev/null 2>&1 || true
        return 1
    fi
    log "      config OK"

    # ── The hostname comparison ────────────────────────────────────────────
    #
    # `caddy adapt` emits the JSON Caddy actually runs. Comparing the hostname
    # sets answers the question the old exclusion reason got wrong: whether
    # pushing would stop serving a name that is served today.
    repo_hosts="$(ssh_vm "sudo docker exec '${CADDY_CONTAINER}' sh -c \"caddy adapt --config /tmp/Caddyfile.candidate --adapter caddyfile 2>/dev/null | grep -oE '\\\"[a-z0-9.-]+\\\\.(bg|io)\\\"' | tr -d '\\\"' | sort -u\"" | tr -d '\r')"
    live_hosts="$(ssh_vm "sudo docker exec '${CADDY_CONTAINER}' sh -c \"caddy adapt --config '${CADDY_CONFIG_IN_CONTAINER}' --adapter caddyfile 2>/dev/null | grep -oE '\\\"[a-z0-9.-]+\\\\.(bg|io)\\\"' | tr -d '\\\"' | sort -u\"" | tr -d '\r')"
    ssh_vm "sudo docker exec '${CADDY_CONTAINER}' rm -f /tmp/Caddyfile.candidate" >/dev/null 2>&1 || true

    if [ -z "$live_hosts" ]; then
        err "could not read the hostnames the LIVE config serves — refusing to push blind."
        err "  An empty answer here is UNKNOWN, not 'serves nothing'."
        return 1
    fi
    log "    hostnames served now : $(echo "$live_hosts" | tr '\n' ' ')"
    log "    hostnames after push : $(echo "$repo_hosts" | tr '\n' ' ')"
    gone="$(comm -23 <(echo "$live_hosts") <(echo "$repo_hosts") || true)"
    if [ -n "$gone" ]; then
        err "pushing would STOP SERVING: $(echo "$gone" | tr '\n' ' ')"
        err "  That is the thing #3589's exclusion reason existed to prevent, and it is"
        err "  checked rather than assumed. Reconcile the repo copy first."
        return 1
    fi
    log "    no hostname is lost"
}

# Push the Caddyfile and RELOAD, then prove every hostname still answers.
#
# Rolls back on a failed reload and on a hostname that stops responding. A
# reload that fails leaves the previous config running — Caddy does not accept a
# bad one — but the FILE would then disagree with what is being served, which is
# drift created by the tool whose job is to prevent it.
caddy_apply() {
    local staged backup rc host code bad
    staged="/tmp/Caddyfile.new.${TS}"
    backup="${CADDY_REMOTE}.bak.${TS}"

    log "backing up ${CADDY_REMOTE} → ${backup}"
    ssh_vm "sudo sh -c \"mkdir -p '$(dirname "${CADDY_REMOTE}")' && cp -a '${CADDY_REMOTE}' '${backup}' && chmod 600 '${backup}'\" 2>/dev/null || true"

    log "pushing ${CADDY_REMOTE}"
    # Flattened staging name. `/tmp/${remote_base}.new` would be
    # `/tmp/caddy/Caddyfile.new` for this nested path, and /tmp/caddy does not
    # exist — the mechanical blocker the UNRECONCILED entry named.
    gcloud compute scp "$CADDY_LOCAL" "${VM_NAME}:${staged}" \
        --zone "$VM_ZONE" --tunnel-through-iap
    ssh_vm "sudo mv '${staged}' '${CADDY_REMOTE}' && sudo chown root:root '${CADDY_REMOTE}'"

    log "reloading caddy (keeps listeners and issued certificates)"
    rc=0
    ssh_vm "sudo docker exec '${CADDY_CONTAINER}' caddy reload \
        --config '${CADDY_CONFIG_IN_CONTAINER}' --adapter caddyfile 2>&1 | sed 's/^/      /'" || rc=$?
    if [ "$rc" -ne 0 ]; then
        err "caddy reload FAILED — restoring ${backup} and reloading again."
        ssh_vm "sudo cp -a '${backup}' '${CADDY_REMOTE}' && sudo docker exec '${CADDY_CONTAINER}' caddy reload --config '${CADDY_CONFIG_IN_CONTAINER}' --adapter caddyfile" || true
        return 1
    fi

    # ── Verify, from OUTSIDE ───────────────────────────────────────────────
    #
    # Each hostname is fetched over public HTTPS rather than asked of Caddy's
    # admin API, because the property that matters is that a client can still
    # reach it. Any HTTP status counts as served: these vhosts legitimately
    # answer 200, 302, 401 and 405 depending on what they front, and pinning a
    # code would make this fail on a healthy endpoint. A connection failure
    # gives curl's 000, which is what this is looking for.
    bad=""
    for host in $(ssh_vm "sudo docker exec '${CADDY_CONTAINER}' sh -c \"caddy adapt --config '${CADDY_CONFIG_IN_CONTAINER}' --adapter caddyfile 2>/dev/null | grep -oE '\\\"[a-z0-9.-]+\\\\.(bg|io)\\\"' | tr -d '\\\"' | sort -u\"" | tr -d '\r'); do
        code="$(ssh_vm "curl -s -o /dev/null -w '%{http_code}' --max-time 20 'https://${host}/' || true" | tr -d '\r')"
        if [ "$code" = "000" ] || [ -z "$code" ]; then
            err "    ${host} -> ${code:-no answer}"
            bad="${bad} ${host}"
        else
            log "    ${host} -> ${code}"
        fi
    done
    if [ -n "$bad" ]; then
        err "these hostnames stopped answering after the reload:${bad}"
        err "  restoring ${backup} and reloading again."
        ssh_vm "sudo cp -a '${backup}' '${CADDY_REMOTE}' && sudo docker exec '${CADDY_CONTAINER}' caddy reload --config '${CADDY_CONFIG_IN_CONTAINER}' --adapter caddyfile" || true
        return 1
    fi
    log "Caddyfile applied and every hostname answers."
}

host_config_apply() {
    local entry local_path remote_path base compiled
    for entry in "${HOST_CONFIG_SET[@]}"; do
        local_path="${entry%%:*}"; remote_path="${entry#*:}"; base="$(basename "$remote_path")"

        # Back up into ${REMOTE_DIR}, not beside the live file.
        #
        # Two reasons, both about the directory rather than the file. The
        # prune step below walks ${REMOTE_DIR}/*.bak.* and keeps the newest
        # KEEP_BACKUPS, and check-drift.sh fails loudly on anything there
        # readable beyond root — a backup written into /etc/… would inherit
        # neither control and would accumulate, unexamined, forever. And a
        # dead config sitting beside a live one in a directory a daemon owns
        # is a hazard worth not creating, even though this agent names its
        # config as a single file (`-in <path>` in the unit) and so would not
        # read it.
        log "backing up ${remote_path} → ${REMOTE_DIR}/${base}.bak.${TS}"
        ssh_vm "sudo sh -c \"cp -a '${remote_path}' '${REMOTE_DIR}/${base}.bak.${TS}' && chmod 600 '${REMOTE_DIR}/${base}.bak.${TS}'\" 2>/dev/null || true"

        log "pushing ${remote_path}"
        gcloud compute scp "$local_path" "${VM_NAME}:/tmp/${base}.new.${TS}" \
            --zone "$VM_ZONE" --tunnel-through-iap
        # 644, matching the live mode: this file carries no credential, and the
        # agent reads it as root anyway. The backup above is 600 regardless,
        # because a dead copy has no reader to accommodate.
        ssh_vm "sudo mv '/tmp/${base}.new.${TS}' '${remote_path}' \
            && sudo chown root:root '${remote_path}' && sudo chmod 644 '${remote_path}'"

        log "restarting ${OPS_AGENT_UNIT} (no container is touched)"
        if ! ssh_vm "sudo systemctl restart '${OPS_AGENT_UNIT}'"; then
            err "${OPS_AGENT_UNIT} failed to restart after the push. Roll back with:"
            err "  sudo cp -a '${REMOTE_DIR}/${base}.bak.${TS}' '${remote_path}' && sudo systemctl restart ${OPS_AGENT_UNIT}"
            return 1
        fi

        # WIRED IS NOT DELIVERED. `systemctl is-active` goes green for an agent
        # that restarted while keeping its previous pipeline, so assert on the
        # COMPILED collector config instead: the needle comes from the receiver
        # in the file just pushed, so this fails if the push did not take.
        log "verifying the push reached the collector (${OPS_AGENT_COMPILED})"
        # `|| compiled=""` because `set -o pipefail` is on: a transient ssh
        # failure here would otherwise abort the script through the command
        # substitution, AFTER the compose stack has already been applied —
        # killing the run at the one point where its output is what an operator
        # needs. An empty read is UNKNOWN and falls into the failure branch
        # below, which is the safe direction.
        compiled="$(ssh_vm "sudo grep -c -F '${OPS_AGENT_COMPILED_NEEDLE}' '${OPS_AGENT_COMPILED}' 2>/dev/null || echo 0" | tr -d '[:space:]')" \
            || compiled=""
        if [ -z "$compiled" ] || [ "$compiled" = "0" ]; then
            err "${OPS_AGENT_UNIT} restarted but the compiled collector config does not"
            err "  mention '${OPS_AGENT_COMPILED_NEEDLE}'. The push did not take effect."
            err "  Roll back with:"
            err "  sudo cp -a '${REMOTE_DIR}/${base}.bak.${TS}' '${remote_path}' && sudo systemctl restart ${OPS_AGENT_UNIT}"
            return 1
        fi
        log "  OK   the receiver from ${base} is present in the compiled config (${compiled} ref(s))"
    done
}

# ── CADDY_ONLY: the other no-service-window path (#3589) ─────────────────
#
# Returns before anything compose-related runs, like HOST_CONFIG_ONLY, so it
# cannot recreate a container even by mistake. It is a separate flag rather
# than a widening of that one because the two activate differently — a systemd
# restart there, a `caddy reload` here — and a single flag covering both would
# make "no service window" depend on which files happened to change.
if [ "${CADDY_ONLY:-0}" = "1" ]; then
    if [ "${DRY_RUN:-0}" = "1" ]; then
        err "CADDY_ONLY=1 and DRY_RUN=1 are mutually exclusive: validating a Caddyfile"
        err "  means running caddy's own binary, which lives in the container on the VM."
        err "  Drop DRY_RUN to preflight against the VM without applying."
        exit 2
    fi
    log "CADDY_ONLY — the Caddyfile only. No container is recreated; caddy is reloaded."
    caddy_preflight || exit 1
    if [ "${CONFIRM:-0}" != "1" ]; then
        log ""
        log "PREFLIGHT ONLY — nothing has been applied. Re-run with CONFIRM=1."
        log "No service window is needed: a reload keeps the listeners and the certs."
        exit 0
    fi
    caddy_apply || exit 1
    log "Caddyfile applied. Verify with deploy/check-drift.sh."
    exit 0
fi

# ── HOST_CONFIG_ONLY: the no-service-window path ─────────────────────────
#
# Returns before anything compose-related runs, so it cannot recreate a
# container even by mistake. It skips the env-file preflight too: these files
# carry no ${VAR} interpolation and no secret, so there is nothing on the host
# for them to depend on.
if [ "${HOST_CONFIG_ONLY:-0}" = "1" ]; then
    if [ "${DRY_RUN:-0}" = "1" ]; then
        err "HOST_CONFIG_ONLY=1 and DRY_RUN=1 are mutually exclusive: validating these"
        err "  files means running the host service's own engine, which only exists on"
        err "  the VM. Drop DRY_RUN to preflight against the VM without applying."
        exit 2
    fi
    log "HOST_CONFIG_ONLY — the host config set only. No container is recreated."
    host_config_preflight || exit 1
    if [ "${CONFIRM:-0}" != "1" ]; then
        log ""
        log "PREFLIGHT ONLY — nothing has been applied. Re-run with CONFIRM=1."
        log "No service window is needed: this path recreates no container."
        exit 0
    fi
    host_config_apply || exit 1
    log "host config applied. Verify with deploy/check-drift.sh."
    exit 0
fi

# ── DRY_RUN: local only, never reaches the VM ────────────────────────────
#
# WHAT IT PROVES: the compose file is valid YAML and every ${VAR} in it
# resolves. WHAT IT DOES NOT PROVE: that the VM holds the secrets — that is
# the preflight below, and only the preflight can answer it.
#
# The compose file declares `env_file: ./.env.prod`, and `docker compose
# config` errors if that file is absent — a failure that has nothing to do
# with this script's subject but arrives in the same channel as a real
# ':?' guard. Reporting both as one message is how a caller ends up chasing
# a secret that was never missing, so DRY_RUN builds a throwaway project
# directory with an empty .env.prod placeholder and validates THERE, and the
# two failure classes are told apart below.
#
# With no DRY_RUN_ENV_FILE, dummy values are generated for the three
# interpolation variables, so `DRY_RUN=1 deploy/apply.sh` works from a clean
# checkout and is usable in CI.
if [ "${DRY_RUN:-0}" = "1" ]; then
    # Beside the compose file rather than in /tmp, and deliberately: where
    # `docker` is the snap package the CLI has a PRIVATE /tmp, so a project
    # directory under /tmp fails "couldn't find env file" for a file that
    # demonstrably exists. Anywhere docker can read the compose file, it can
    # read a sibling. Gitignored as deploy/.apply-dryrun-*/.
    TMP_PROJECT="$(mktemp -d "${SCRIPT_DIR}/.apply-dryrun-XXXXXX")"
    trap 'rm -rf "$TMP_PROJECT"' EXIT
    cp "$LOCAL_COMPOSE" "${TMP_PROJECT}/${COMPOSE_BASENAME}"
    # Placeholder for the `env_file:` directive only. Never read for values.
    : > "${TMP_PROJECT}/.env.prod"

    if [ -n "${DRY_RUN_ENV_FILE:-}" ]; then
        if [ ! -f "$DRY_RUN_ENV_FILE" ]; then
            err "DRY_RUN_ENV_FILE=$DRY_RUN_ENV_FILE does not exist."
            exit 1
        fi
        INTERP_ENV="$DRY_RUN_ENV_FILE"
        log "DRY_RUN — validating $LOCAL_COMPOSE against $DRY_RUN_ENV_FILE"
    else
        INTERP_ENV="${TMP_PROJECT}/.interp"
        cat > "$INTERP_ENV" <<'DUMMY'
POSTGRES_PASSWORD=dry-run-placeholder
REDIS_PASSWORD=dry-run-placeholder
DATA_ENCRYPTION_KEY=dry-run-placeholder
DUMMY
        log "DRY_RUN — validating $LOCAL_COMPOSE with generated placeholder values"
        log "  (this checks the YAML resolves; it says NOTHING about the VM's secrets)"
    fi

    if OUT="$(docker compose -f "${TMP_PROJECT}/${COMPOSE_BASENAME}" --env-file "$INTERP_ENV" config -q 2>&1)"; then
        log "compose config OK — no VM was contacted."
        exit 0
    fi
    printf '%s\n' "$OUT" >&2
    # Two distinct causes, two distinct messages.
    if printf '%s' "$OUT" | grep -q 'required variable'; then
        err "a ':?' guard fired — the compose file is working as designed, and the"
        err "  variable it names is absent from the env file you passed."
    else
        err "compose config failed for a reason OTHER than a missing variable —"
        err "  read the compose error above; it is about the file, not about secrets."
    fi
    exit 1
fi

# ── Preflight, entirely read-only except for one staged temp file ────────
log "preflight against ${VM_NAME} (${VM_ZONE})"

for entry in "${CANONICAL_SET[@]}"; do
    local_path="${entry%%:*}"
    [ -f "$local_path" ] || { err "canonical file missing from the repo: $local_path"; exit 1; }
done

# 1. The host env files must exist, and must CARRY the three interpolation
#    variables. We check for the KEY, never the value, and print neither.
ENV_CHECK_CMD="set -e; cd '${REMOTE_DIR}'"
for f in "${ENV_FILES[@]}"; do
    ENV_CHECK_CMD="${ENV_CHECK_CMD}; test -f '${f}' || { echo \"MISSING_ENV_FILE ${f}\"; exit 9; }"
done
ENV_CHECK_CMD="${ENV_CHECK_CMD}; for k in POSTGRES_PASSWORD REDIS_PASSWORD DATA_ENCRYPTION_KEY; do"
ENV_CHECK_CMD="${ENV_CHECK_CMD} if sudo grep -qE \"^\${k}=.\" ${ENV_FILES[*]}; then echo \"PRESENT \${k}\"; else echo \"ABSENT \${k}\"; fi; done"

log "checking the host env files carry the three interpolation variables (key names only)"
ENV_REPORT="$(ssh_vm "$ENV_CHECK_CMD")" || {
    err "could not read the env files on ${VM_NAME}. Check gcloud auth / VM state."
    exit 1
}
printf '%s\n' "$ENV_REPORT" | sed 's/^/    /'

if printf '%s' "$ENV_REPORT" | grep -q '^ABSENT '; then
    err "an interpolation variable is absent from ${REMOTE_DIR}/{${ENV_FILES[0]},${ENV_FILES[1]}}."
    err ""
    err "  This is the fail-fast working, not a script bug — the compose file holds no"
    err "  literals, so a variable it cannot resolve is a deploy that must not start."
    err ""
    err "  REDIS_PASSWORD in particular has never existed as a standalone key on this"
    err "  host: Redis auth reaches the app inside REDIS_URL. The compose file needs it"
    err "  by itself for --requirepass and REDISCLI_AUTH. An operator adds it to"
    err "  ${REMOTE_DIR}/.env.prod, set to the credential already embedded in REDIS_URL"
    err "  (verified identical to the live --requirepass on 2026-09-24). Do that by hand;"
    err "  this script does not write secret files."
    exit 1
fi

# 2. Stage the new compose beside the live one and validate it THERE, so the
#    relative bind-mount and env_file paths resolve exactly as they will at
#    `up` time. Nothing live is touched: the live file still has its name.
STAGED="${REMOTE_COMPOSE}.new.${TS}"
log "staging ${LOCAL_COMPOSE} → ${VM_NAME}:${STAGED}"
gcloud compute scp "$LOCAL_COMPOSE" "${VM_NAME}:/tmp/${COMPOSE_BASENAME}.new.${TS}" \
    --zone "$VM_ZONE" --tunnel-through-iap
ssh_vm "sudo mv '/tmp/${COMPOSE_BASENAME}.new.${TS}' '${STAGED}'"

ENV_ARGS=""
for f in "${ENV_FILES[@]}"; do ENV_ARGS="${ENV_ARGS} --env-file '${f}'"; done

cleanup_staged() { ssh_vm "sudo rm -f '${STAGED}'" >/dev/null 2>&1 || true; }

log "validating on the VM: docker compose config (this is where a ':?' guard fires)"
if ! ssh_vm "cd '${REMOTE_DIR}' && sudo docker compose ${ENV_ARGS} -f '$(basename "$STAGED")' config -q"; then
    err "docker compose config FAILED on the VM. Nothing was changed — the live file"
    err "  still has its own name and every container is untouched."
    cleanup_staged
    exit 1
fi
log "  config OK — every \${VAR} resolved"

# 3. Show what `up -d` would actually do. Compose's own --dry-run simulates
#    the API calls, so this names the containers that would be recreated
#    without creating any. Advisory: an older compose without --dry-run just
#    warns rather than blocking the apply.
log "simulating the apply (docker compose up -d --dry-run)"
if ! ssh_vm "cd '${REMOTE_DIR}' && sudo docker compose ${ENV_ARGS} -f '$(basename "$STAGED")' up -d --dry-run 2>&1 | sed 's/^/    /'"; then
    warn "up --dry-run was not usable on this host — continuing without the simulation."
fi

# 4. The other canonical files: report whether each would change.
log "other canonical files (pushed alongside the compose file):"
for entry in "${CANONICAL_SET[@]:1}"; do
    local_path="${entry%%:*}"; remote_base="${entry##*:}"
    lsha="$(sha256sum "$local_path" | awk '{print $1}')"
    rsha="$(ssh_vm "sudo sha256sum '${REMOTE_DIR}/${remote_base}' 2>/dev/null || true" | awk '{print $1}')"
    if [ "$lsha" = "$rsha" ]; then
        log "    unchanged  ${remote_base} (${lsha:0:12})"
    else
        log "    WOULD CHANGE ${remote_base}: repo ${lsha:0:12} → VM ${rsha:0:12}"
    fi
done

# 5. The host config set: report, and validate with the owning service's engine.
if ! host_config_preflight; then
    cleanup_staged
    exit 1
fi

# 5b. The Caddyfile: report, validate with caddy's own binary, and refuse a
#     push that would stop serving a hostname that is served today.
if ! caddy_preflight; then
    cleanup_staged
    exit 1
fi

if [ "${CONFIRM:-0}" != "1" ]; then
    log ""
    log "PREFLIGHT ONLY — nothing has been applied."
    log "The staged file has been removed. Re-run with CONFIRM=1 to apply, in a"
    log "service window: applying recreates containers (expect a short 502 on app)."
    cleanup_staged
    exit 0
fi

# ── Apply ────────────────────────────────────────────────────────────────
log "backing up ${REMOTE_COMPOSE} → ${REMOTE_COMPOSE}.bak.${TS}"
# `cp -a` preserves the SOURCE's mode, so a backup of a 600 file is already
# 600 — but only if the source is. Backups written by any other path, and the
# ones already on the VM, were 644: #2889 found 7 `.env.prod.bak.*` world
# readable, each a complete credential set, three of whose secrets were still
# live five months later.
#
# Chmod is applied EXPLICITLY rather than trusted from `cp -a`, because the
# property that matters — a dead copy of a config file is readable only by
# root — should not depend on the live file's mode being right at the moment
# the copy is taken.
ssh_vm "sudo cp -a '${REMOTE_COMPOSE}' '${REMOTE_COMPOSE}.bak.${TS}' && sudo chmod 600 '${REMOTE_COMPOSE}.bak.${TS}'"

log "installing the validated file"
ssh_vm "sudo mv '${STAGED}' '${REMOTE_COMPOSE}' && sudo chown root:root '${REMOTE_COMPOSE}'"

for entry in "${CANONICAL_SET[@]:1}"; do
    local_path="${entry%%:*}"; remote_base="${entry##*:}"
    log "pushing ${remote_base}"
    ssh_vm "sudo sh -c \"cp -a '${REMOTE_DIR}/${remote_base}' '${REMOTE_DIR}/${remote_base}.bak.${TS}' && chmod 600 '${REMOTE_DIR}/${remote_base}.bak.${TS}'\" 2>/dev/null || true"
    gcloud compute scp "$local_path" "${VM_NAME}:/tmp/${remote_base}.new.${TS}" \
        --zone "$VM_ZONE" --tunnel-through-iap
    ssh_vm "sudo mv '/tmp/${remote_base}.new.${TS}' '${REMOTE_DIR}/${remote_base}' && sudo chown root:root '${REMOTE_DIR}/${remote_base}'"
done

# The host config set, before the prune below so the backup it writes is
# covered by the same retention.
#
# A failure here does NOT abort the deploy. The compose file has already been
# pushed by this point, so returning early would leave the VM holding a
# compose file that was never applied — drift created by the tool whose job is
# to prevent it. It is recorded instead and reported with the health result at
# the end, which is also where an operator is already looking.
HOST_CONFIG_FAILED=0
host_config_apply || HOST_CONFIG_FAILED=1

# The Caddyfile, on the same terms and for the same reason: the compose file is
# already pushed by this point, so a failure here is recorded and reported with
# the health result rather than aborting into a half-applied VM. `caddy_apply`
# restores its own backup and reloads, so a failure leaves Caddy serving what it
# served before — the failure to report is that the repo copy did not land.
CADDY_FAILED=0
caddy_apply || CADDY_FAILED=1

# ── Prune ──────────────────────────────────────────────────────────────────
#
# Keep the last KEEP_BACKUPS per basename, delete the rest (#2889).
#
# Unbounded retention of dead config buys nothing. The rollback command this
# script prints names THIS run's timestamp, so the only backup an operator is
# ever told to use is the newest one; older copies are reachable only by
# someone who goes looking, and each `.env.prod.bak.*` is a complete
# credential set that ages into a set nobody remembers rotating.
#
# `shred` rather than `rm`: these are credential files on a VM whose disk is a
# GCE persistent disk, and the cost of overwriting a handful of small files is
# nothing next to leaving them recoverable.
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
log "pruning backups, keeping the newest ${KEEP_BACKUPS} per file"
ssh_vm "sudo sh -c '
  cd \"${REMOTE_DIR}\" 2>/dev/null || exit 0
  for base in \$(ls -1 *.bak.* 2>/dev/null | sed \"s/\\.bak\\..*//\" | sort -u); do
    ls -1t \"\$base\".bak.* 2>/dev/null | tail -n +\$((${KEEP_BACKUPS} + 1)) | while read -r old; do
      shred -u \"\$old\" 2>/dev/null || rm -f \"\$old\"
    done
  done
'"

log "docker compose up -d"
ssh_vm "cd '${REMOTE_DIR}' && sudo docker compose ${ENV_ARGS} -f '${COMPOSE_BASENAME}' up -d"

# ── Health-verify ────────────────────────────────────────────────────────
#
# BOTH public origins, because Caddy serves two vhosts and a Caddyfile or
# cert problem can take one down while the other answers — checking only the
# sslip.io host would have reported a dead app.inflect.bg as a clean deploy.
# /api/readyz (not /api/livez): livez is dependency-free and stays green
# through a Redis or DB outage, which is exactly the failure a deploy causes.
log "health-verifying: ${HEALTH_ORIGINS}"
HEALTH_FAILED=0
for origin in $HEALTH_ORIGINS; do
    code=""
    for _ in 1 2 3 4 5 6 7 8; do
        # 000 is a sentinel OUTSIDE the healthy range; the comparison below
        # fails closed on it, unlike `|| echo 0`.
        code="$(curl -fsS -o /dev/null -w '%{http_code}' "${origin}/api/readyz" 2>/dev/null || echo 000)"
        [ "$code" = "200" ] && break
        sleep 5
    done
    if [ "$code" = "200" ]; then
        log "  OK   ${origin}/api/readyz → 200"
    else
        err "  FAIL ${origin}/api/readyz → ${code}"
        HEALTH_FAILED=1
    fi
done

ROLLBACK="gcloud compute ssh ${VM_NAME} --zone ${VM_ZONE} --tunnel-through-iap --command \"sudo cp -a '${REMOTE_COMPOSE}.bak.${TS}' '${REMOTE_COMPOSE}' && cd '${REMOTE_DIR}' && sudo docker compose${ENV_ARGS} -f '${COMPOSE_BASENAME}' up -d\""

if [ "$HEALTH_FAILED" = "1" ]; then
    err "applied, but health checks FAILED. Roll back with:"
    printf '  %s\n' "$ROLLBACK" >&2
    exit 1
fi

if [ "$HOST_CONFIG_FAILED" = "1" ]; then
    err "the compose stack applied and is HEALTHY, but the host config set did not."
    err "  Read the host-config errors above — the app is serving; what is broken is"
    err "  whatever that service does (for the ops agent: log export, silently)."
    err "  Fix the file and re-run with HOST_CONFIG_ONLY=1 CONFIRM=1 — no service"
    err "  window is needed for that path."
    exit 1
fi

if [ "$CADDY_FAILED" = "1" ]; then
    err "the compose stack applied and is HEALTHY, but the Caddyfile did not."
    err "  Caddy is serving what it served BEFORE this run: caddy_apply restores its"
    err "  own backup and reloads, so nothing is half-applied at the edge. What is"
    err "  wrong is that the repo copy has not landed, so the next check-drift.sh will"
    err "  report it."
    err "  Fix the file and re-run with CADDY_ONLY=1 CONFIRM=1 — no service window is"
    err "  needed for that path."
    exit 1
fi

log "deploy OK. Verify with deploy/check-drift.sh. Rollback command if needed later:"
printf '  %s\n' "$ROLLBACK"
