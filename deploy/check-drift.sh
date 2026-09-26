#!/usr/bin/env bash
#
# deploy/check-drift.sh — detect drift between the repo-canonical prod
# Compose set and what the VM actually runs.
#
# Run it on a WEEKLY cadence (cron, or a scheduled Actions job once a GCP
# service-account secret exists) so a hand-edit on the VM surfaces in days
# rather than during an incident. #2849 existed because nothing did this:
# the host file and the repo file diverged ~148 lines and the first person
# to notice would have been whoever reached for version control mid-outage.
#
# Watchtower rewrites IMAGES, never the compose file, so drift here always
# means a human edited the VM out of band, or changed the repo and did not
# run deploy/apply.sh.
#
# SCOPE IS WIDER THAN apply.sh ON PURPOSE. The compose file bind-mounts
# repo-owned files, and a compose file that is in sync says nothing about
# them. (The sibling repo agri-saas learned this the hard way: it hashed
# only the compose file, and the VM's database Dockerfile sat three months
# behind the repo with drift green throughout.) The asymmetry is the safe
# direction — detect everything, push only what has been reconciled.
#
# Usage: deploy/check-drift.sh
# Exit:
#   0 = in sync
#   1 = drift in a file apply.sh can push (reconcile, then run apply.sh)
#   2 = could not reach the VM (UNKNOWN — never read this as "no drift")
#   3 = the only differences are in UNRECONCILED files — an outstanding
#       decision, not something apply.sh can fix. That array is EMPTY as of
#       2026-09-26 (the Caddyfile was reconciled), so this exit is currently
#       unreachable; the code stays because the next such file will need it.
set -euo pipefail

VM_NAME="${VM_NAME:-inflect-compliance}"
VM_ZONE="${VM_ZONE:-europe-west1-b}"
REMOTE_DIR="${REMOTE_DIR:-/opt/inflect}"
COMPOSE_BASENAME="${COMPOSE_BASENAME:-docker-compose.prod.yml}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

err()  { printf '\033[31m[drift]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[drift]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m[drift]\033[0m %s\n' "$*"; }

# Same allowlist as apply.sh: this reports on ONE compose file, and a bare
# override would silently point it at a file nobody deploys — drift then
# stays green on the file it is not looking at, which is the failure mode
# this whole script exists to prevent.
CANONICAL_COMPOSE="docker-compose.prod.yml"
if [ "$COMPOSE_BASENAME" != "$CANONICAL_COMPOSE" ] \
   && [ "${I_KNOW_THIS_IS_NOT_THE_CANONICAL_COMPOSE:-0}" != "1" ]; then
    err "refusing to act on '${COMPOSE_BASENAME}' — the canonical compose is '${CANONICAL_COMPOSE}'."
    err "  Set I_KNOW_THIS_IS_NOT_THE_CANONICAL_COMPOSE=1 if you genuinely mean another one."
    exit 2
fi

# APPLIABLE: reconciled, and apply.sh pushes them. "<local>:<remote>".
APPLIABLE=(
    "${SCRIPT_DIR}/${COMPOSE_BASENAME}:${REMOTE_DIR}/${COMPOSE_BASENAME}"
    "${SCRIPT_DIR}/init-roles.sh:${REMOTE_DIR}/init-roles.sh"
    "${REPO_ROOT}/prisma.config.ts:${REMOTE_DIR}/prisma.config.ts"
)

# UNRECONCILED: watched, reported, NOT pushed by apply.sh. Each entry owes a
# reason, because an un-actionable warning that outlives its explanation is
# how a check becomes noise people filter out.
UNRECONCILED=(
    "${SCRIPT_DIR}/caddy/Caddyfile:${REMOTE_DIR}/caddy/Caddyfile:the CONTENT is reconciled as of 2026-09-26 — the repo copy is now the superset, defining both hostnames and carrying the HTTP/3 and Cache-Control work — but apply.sh still cannot push it: its push loop stages through /tmp/\${remote_base}.new.\${TS}, which for a nested path becomes /tmp/caddy/Caddyfile.new.… and that directory does not exist on the VM. Pushing needs a flattened staging name first, and apply.sh is the push path for every other canonical file, so that change wants its own diff"
)

remote_sha() {
    gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap \
        --command "sudo sha256sum '$1' 2>/dev/null || true" 2>/dev/null | awk '{print $1}'
}

# Reachability probe FIRST, so "could not reach the VM" is never scored as
# "nothing differs". A failed probe means UNKNOWN.
if ! gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap \
        --command "test -d '${REMOTE_DIR}'" >/dev/null 2>&1; then
    err "could not reach ${REMOTE_DIR} on ${VM_NAME} (${VM_ZONE})."
    err "  This is UNKNOWN, not 'in sync'. Check gcloud auth / IAP / VM state."
    exit 2
fi

APPLIABLE_DRIFT=0
for entry in "${APPLIABLE[@]}"; do
    local_path="${entry%%:*}"; remote_path="${entry##*:}"
    if [ ! -f "$local_path" ]; then
        err "missing from the repo: $local_path — the canonical set is not where this script expects it."
        APPLIABLE_DRIFT=1
        continue
    fi
    lsha="$(sha256sum "$local_path" | awk '{print $1}')"
    rsha="$(remote_sha "$remote_path")"
    if [ -z "$rsha" ]; then
        err "DRIFT — ${remote_path} is absent or unreadable on ${VM_NAME}."
        APPLIABLE_DRIFT=1
    elif [ "$lsha" != "$rsha" ]; then
        err "DRIFT — $(basename "$remote_path"): repo ${lsha:0:12} vs VM ${rsha:0:12}"
        APPLIABLE_DRIFT=1
    else
        ok "in sync — $(basename "$remote_path") (${lsha:0:12})"
    fi
done

UNRECONCILED_DRIFT=0
for entry in "${UNRECONCILED[@]}"; do
    local_path="${entry%%:*}"; rest="${entry#*:}"
    remote_path="${rest%%:*}"; reason="${rest#*:}"
    lsha="$(sha256sum "$local_path" 2>/dev/null | awk '{print $1}')"
    rsha="$(remote_sha "$remote_path")"
    if [ -n "$lsha" ] && [ "$lsha" = "$rsha" ]; then
        ok "in sync — $(basename "$remote_path") (${lsha:0:12}) [was unreconciled; it can move to APPLIABLE now]"
    else
        warn "UNRECONCILED — $(basename "$remote_path"): repo ${lsha:0:12} vs VM ${rsha:0:12}"
        warn "    ${reason}"
        warn "    apply.sh deliberately does NOT push this. Resolving it means merging both"
        warn "    directions by hand and then moving the entry into APPLIABLE above."
        UNRECONCILED_DRIFT=1
    fi
done

# ── Backup permissions ─────────────────────────────────────────────────────
#
# A group- or world-readable file under the deploy directory is a finding on
# its own, independent of drift (#2889).
#
# The history: 7 `.env.prod.bak.*` files sat at 644 for five months, each a
# complete credential set, three of whose secrets were still live when they
# were found. `apply.sh` now chmods every backup it writes and prunes the old
# ones — but nothing stopped a hand-run `cp` from recreating the exposure, and
# "we fixed the ones that existed" is not a control.
#
# Checked here because this script already walks the deploy directory on a
# schedule and already exits non-zero for a condition an operator must act on.
# It fails LOUDLY rather than warning: a readable credential set is not an
# outstanding decision, it is a live exposure.
ok "checking deploy-directory permissions"
LOOSE=$(gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap \
    --command "sudo find '${REMOTE_DIR}' -maxdepth 1 -type f \\( -perm /o+r -o -perm /g+r \\) 2>/dev/null | sort" 2>/dev/null || true)
if [ -n "$LOOSE" ]; then
    err ""
    err "Files under ${REMOTE_DIR} are readable beyond root:"
    printf '%s\n' "$LOOSE" | while read -r f; do err "  $f"; done
    err ""
    err "Each .env.prod backup is a complete credential set. Fix with:"
    err "  gcloud compute ssh ${VM_NAME} --zone ${VM_ZONE} --tunnel-through-iap \\"
    err "    --command \"sudo chmod 600 ${REMOTE_DIR}/*\""
    err ""
    err "Then ask what wrote them at that mode, because apply.sh no longer does."
    exit 1
fi

if [ "$APPLIABLE_DRIFT" -ne 0 ]; then
    err ""
    err "The live stack no longer matches the repo. Either:"
    err "  • the VM was hand-edited  → reconcile the change INTO the repo file, commit,"
    err "    then re-run this check; or"
    err "  • the repo changed but was not applied → run deploy/apply.sh (service window)."
    err ""
    err "See the exact compose diff — WARNING, the live file carries inline secrets, so"
    err "diff it into a file you control, never onto a shared terminal:"
    err "  gcloud compute ssh ${VM_NAME} --zone ${VM_ZONE} --tunnel-through-iap \\"
    err "    --command \"sudo cat '${REMOTE_DIR}/${COMPOSE_BASENAME}'\" > /tmp/live.yml"
    exit 1
fi

if [ "$UNRECONCILED_DRIFT" -ne 0 ]; then
    warn ""
    warn "Everything apply.sh owns is in sync. What differs is an outstanding DECISION,"
    warn "not an un-run deploy. Exit 3 so a scheduled run still flags it."
    exit 3
fi

ok "in sync — the whole canonical set matches ${VM_NAME}:${REMOTE_DIR}"
exit 0
