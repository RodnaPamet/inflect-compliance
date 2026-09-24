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
# Applying recreates containers. Expect a short 502 window on `app` and a
# Redis restart (AOF-persisted, so queued BullMQ jobs survive). Run it in a
# service window.
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

ssh_vm() { gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap --command "$1"; }

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
ssh_vm "sudo cp -a '${REMOTE_COMPOSE}' '${REMOTE_COMPOSE}.bak.${TS}'"

log "installing the validated file"
ssh_vm "sudo mv '${STAGED}' '${REMOTE_COMPOSE}' && sudo chown root:root '${REMOTE_COMPOSE}'"

for entry in "${CANONICAL_SET[@]:1}"; do
    local_path="${entry%%:*}"; remote_base="${entry##*:}"
    log "pushing ${remote_base}"
    ssh_vm "sudo cp -a '${REMOTE_DIR}/${remote_base}' '${REMOTE_DIR}/${remote_base}.bak.${TS}' 2>/dev/null || true"
    gcloud compute scp "$local_path" "${VM_NAME}:/tmp/${remote_base}.new.${TS}" \
        --zone "$VM_ZONE" --tunnel-through-iap
    ssh_vm "sudo mv '/tmp/${remote_base}.new.${TS}' '${REMOTE_DIR}/${remote_base}' && sudo chown root:root '${REMOTE_DIR}/${remote_base}'"
done

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

log "deploy OK. Verify with deploy/check-drift.sh. Rollback command if needed later:"
printf '  %s\n' "$ROLLBACK"
