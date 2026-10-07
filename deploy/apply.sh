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
#   deploy/caddy/Caddyfile — the live /opt/inflect/caddy/Caddyfile serves a
#   SECOND vhost (app.inflect.bg, answering 200 today) that the repo copy
#   does not define, while the repo copy carries retry/HTTP-3 settings from
#   #1814/#1275 that the live one never received. Each side has content the
#   other lacks, so "push the repo copy" would delete a live production
#   hostname. Reconciling them is a decision with a TLS blast radius and it
#   has not been made — check-drift.sh reports the divergence separately and
#   exits 3 for it, so it stays visible instead of being quietly pushed.
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

log "deploy OK. Verify with deploy/check-drift.sh. Rollback command if needed later:"
printf '  %s\n' "$ROLLBACK"
