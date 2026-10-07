#!/usr/bin/env bash
#
# deploy/check-drift.sh — detect drift between the repo-canonical prod
# config set and what the VM actually runs.
#
# "Config set", not "Compose set": it also watches host config that belongs to
# a systemd service rather than to the compose project — today
# /etc/google-cloud-ops-agent/config.yaml, which apply.sh pushes from its own
# HOST_CONFIG_SET. Until that file was versioned it was the last piece of
# production config living only on the VM, which is the exact class of drift
# #2849 built these two scripts to eliminate.
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
#       decision, not something apply.sh can fix. One entry today: the
#       Caddyfile.
#
#       This note used to say the array was EMPTY as of 2026-09-26 and that
#       exit 3 was therefore unreachable. It was wrong when it was written —
#       the entry is right there below, and on 2026-09-26 what got reconciled
#       was the Caddyfile's CONTENT, not its entry. The two are different
#       claims and the header collapsed them, which is how a reader ends up
#       treating a reachable exit code as dead.
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
#
# The last entry is host config rather than compose config — it lives outside
# ${REMOTE_DIR} and belongs to a systemd service, and apply.sh pushes it from
# its own HOST_CONFIG_SET. It is watched HERE and not in a separate array
# because the property this script reports on is identical for both: the repo
# is the source of truth and the VM must match it. Only the push mechanism
# differs, and that is apply.sh's concern, not this script's.
#
# tests/guards/deploy-canonical-set-is-watched.test.ts asserts this array and
# apply.sh's two push arrays name the same files, in both directions. A file
# pushed but unwatched drifts silently; a file watched but unpushed is a
# standing warning nobody can action — the Caddyfile has been exactly that
# since 2026-09-26.
APPLIABLE=(
    "${SCRIPT_DIR}/${COMPOSE_BASENAME}:${REMOTE_DIR}/${COMPOSE_BASENAME}"
    "${SCRIPT_DIR}/init-roles.sh:${REMOTE_DIR}/init-roles.sh"
    "${REPO_ROOT}/prisma.config.ts:${REMOTE_DIR}/prisma.config.ts"
    "${SCRIPT_DIR}/ops-agent-config.yaml:/etc/google-cloud-ops-agent/config.yaml"
)

# UNRECONCILED: watched, reported, NOT pushed by apply.sh. Each entry owes a
# reason, because an un-actionable warning that outlives its explanation is
# how a check becomes noise people filter out.
UNRECONCILED=(
    "${SCRIPT_DIR}/caddy/Caddyfile:${REMOTE_DIR}/caddy/Caddyfile:the CONTENT is reconciled as of 2026-09-26 — the repo copy is the superset, defining both hostnames and carrying the HTTP/3 and Cache-Control work. The MECHANICAL blocker this entry used to cite is gone: it said apply.sh had no flattened staging name for a nested remote path, and as of the ops-agent change apply.sh's HOST_CONFIG_SET loop stages every push through /tmp/\$(basename).new.\${TS}, which the Caddyfile could use unchanged. What remains is NOT mechanical. Caddy needs a reload rather than a restart, so pushing it means adding and verifying that step; the repo and VM copies are still not byte-equal, so the first push is a real content change to a live TLS terminator serving two production hostnames; and nobody has taken that decision. Moving this entry to APPLIABLE is therefore a deliberate act with its own verification, not the one-line array edit it now looks like"
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

# ── Permissions under the deploy directory ─────────────────────────────────
#
# A group- or world-readable file here is not uniformly a finding, and treating
# it as one is why this check could never pass (#3210).
#
# The history it was built for is real: 7 `.env.prod.bak.*` files sat at 644 for
# five months, each a complete credential set, three of whose secrets were still
# live when they were found (#2889). apply.sh now chmods every backup it writes
# and prunes the old ones, but "we fixed the ones that existed" is not a control,
# so the directory is checked on a schedule.
#
# What was wrong was the verdict, not the check. It failed on ANY loose file and
# told the operator to `chmod 600 ${REMOTE_DIR}/*` -- which would have stopped
# the app, because `prisma.config.ts` is bind-mounted into `app` and `worker` and
# both run as `nextjs` (uid 1001). So the one file that MUST stay readable was
# reported identically to a leaked credential set, and the remedy for the second
# was fatal to the first.
#
# Three classes now, and only one of them is an exposure:
#
#   SECRET    a credential-shaped assignment whose value is a LITERAL, readable
#             beyond root. This is the #2889 class. Exit 1.
#   REQUIRED  bind-mounted into a container running as a NON-ROOT user, so a
#             narrower mode breaks that container. Expected; not a finding.
#   TIDY      neither: dead config or a non-secret file that happens to be 644.
#             Worth cleaning, not worth failing a scheduled check over, and
#             failing on it is what masked the exit 3 the Caddyfile owes.
#
# REQUIRED is DERIVED, never listed. A hand-maintained allowlist of "files a
# container needs" goes stale the moment a mount changes, and would then either
# fail on a legitimate mount or -- worse -- stay silent about a credential. The
# authority is `docker inspect`: a mount source under ${REMOTE_DIR} on a
# container whose `.Config.User` is non-empty.
ok "checking deploy-directory permissions"

# One remote pass: classify every loose file. Printed as `<CLASS> <path>` so the
# parsing below is a field read rather than a second guess at the filesystem.
#
# The secret test skips comments and requires the value to not be an
# interpolation. Two bugs are already baked out of it, both found by RUNNING it:
#
#   `"` must be consumed before the value is inspected, or every
#   `PASSWORD: "${VAR}"` reads as a literal starting with a quote.
#
#   `?` and `{` must be EXCLUDED from the value's first character, or
#   `${POSTGRES_PASSWORD:?it is required}` reads as `PASSWORD` + `:` + `?`
#   and scores the canonical compose at 4 literal credentials -- a file a
#   guard already proves has none. The `:?` is compose's fail-fast syntax, so
#   the very token that triggered the false positive is PROOF of interpolation.
CLASSIFY=$(cat <<'REMOTE'
set -e
REMOTE_DIR_X="$1"
# every mount source under the deploy dir belonging to a non-root container
required=""
for c in $(sudo docker ps --format '{{.Names}}' 2>/dev/null); do
    u=$(sudo docker inspect "$c" --format '{{.Config.User}}' 2>/dev/null)
    [ -z "$u" ] && continue
    for src in $(sudo docker inspect "$c" --format '{{range .Mounts}}{{.Source}}
{{end}}' 2>/dev/null); do
        case "$src" in "$REMOTE_DIR_X"/*) required="$required
$src";; esac
    done
done
sudo find "$REMOTE_DIR_X" -maxdepth 1 -type f \( -perm /o+r -o -perm /g+r \) 2>/dev/null | sort | while read -r f; do
    if printf '%s\n' "$required" | grep -qxF "$f"; then
        echo "REQUIRED $f"
    elif sudo grep -aE '^[^#]*(PASSWORD|SECRET|_KEY|TOKEN)[A-Z_]*[=:][[:space:]]*"?[^${?"[:space:]]' "$f" >/dev/null 2>&1; then
        echo "SECRET $f"
    else
        echo "TIDY $f"
    fi
done
REMOTE
)
CLASSIFIED=$(gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap \
    --command "sh -s '${REMOTE_DIR}'" <<< "$CLASSIFY" 2>/dev/null || true)

SECRET_CANDIDATES=$(printf '%s\n' "$CLASSIFIED" | sed -n 's/^SECRET //p')

# PUBLIC: a candidate whose bytes are a file this repo already tracks is not a
# secret, whatever its contents look like. `deploy/.env.prod.example` is the
# live case -- it holds `AUTH_SECRET=replace-me`, which IS a credential-shaped
# literal, and it is also committed and public, so reporting it as an exposure
# is noise that teaches an operator to skim this section.
#
# Compared by HASH against the repo copy rather than by name: a same-named file
# that has DRIFTED from the tracked one is exactly the case worth flagging, and
# a name match alone would wave it through.
SECRETS=""
for f in $SECRET_CANDIDATES; do
    [ -n "$f" ] || continue
    repo_copy="${SCRIPT_DIR}/$(basename "$f")"
    if [ -f "$repo_copy" ] \
       && [ "$(sha256sum "$repo_copy" | awk '{print $1}')" = "$(remote_sha "$f")" ]; then
        ok "  $(basename "$f") holds a credential-shaped literal but is byte-identical"
        ok "    to the tracked ${repo_copy#"${REPO_ROOT}/"} — public, not an exposure."
        continue
    fi
    SECRETS="${SECRETS}${f}
"
done
SECRETS=$(printf '%s' "$SECRETS" | sed '/^$/d')
REQUIRED_F=$(printf '%s\n' "$CLASSIFIED" | sed -n 's/^REQUIRED //p')
TIDY=$(printf '%s\n' "$CLASSIFIED" | sed -n 's/^TIDY //p')

# An empty classification is UNKNOWN, not clean: the find, the docker calls or
# the ssh could all have failed. Say so rather than scoring silence as a pass.
if [ -z "$CLASSIFIED" ]; then
    warn "could not classify ${REMOTE_DIR} permissions — treat as UNKNOWN, not clean."
else
    [ -n "$REQUIRED_F" ] && {
        ok "  $(printf '%s\n' "$REQUIRED_F" | wc -l | tr -d ' ') file(s) readable by design (bind-mounted into a non-root container):"
        printf '%s\n' "$REQUIRED_F" | while read -r f; do [ -n "$f" ] && ok "    $(basename "$f")"; done
    }
    [ -n "$TIDY" ] && {
        warn "  $(printf '%s\n' "$TIDY" | wc -l | tr -d ' ') file(s) readable beyond root with no credential in them:"
        printf '%s\n' "$TIDY" | while read -r f; do [ -n "$f" ] && warn "    $(basename "$f")"; done
        warn "    Not an exposure, so this does not fail. Narrow or delete them per file —"
        warn "    check 'docker inspect <name> --format {{.Config.User}}' first, because a"
        warn "    mount into a non-root container needs the mode it has."
    }
fi

if [ -n "$SECRETS" ]; then
    err ""
    err "CREDENTIAL readable beyond root under ${REMOTE_DIR}:"
    printf '%s\n' "$SECRETS" | while read -r f; do [ -n "$f" ] && err "  $f"; done
    err ""
    err "Each of these carries a credential-shaped value that is a LITERAL, not a"
    err "\${VAR}. This is the #2889 class and it is a live exposure."
    err ""
    err "Fix them INDIVIDUALLY — never 'chmod 600 ${REMOTE_DIR}/*', which would"
    err "break any file a non-root container bind-mounts (see the REQUIRED list"
    err "above):"
    printf '%s\n' "$SECRETS" | while read -r f; do
        [ -n "$f" ] && err "  gcloud compute ssh ${VM_NAME} --zone ${VM_ZONE} --tunnel-through-iap \\"
        [ -n "$f" ] && err "    --command \"sudo chmod 600 '$f'\""
    done
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
