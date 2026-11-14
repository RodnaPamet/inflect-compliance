#!/usr/bin/env bash
#
# NAMED CHANGES TO THE PRODUCTION VM — the runner half.
#
# Run by the `VM apply` workflow (.github/workflows/vm-apply.yml) on a GitHub
# runner already authenticated to GCP, as the identity `VM check` holds, which
# is root on the VM. The workflow's one input is a choice from the list below,
# and each action is written out here: no input names a command, a path, a host
# or a compose argument, because a free-text input would make every push to
# this repository a way to run anything on production. A new action is a pull
# request.
#
#   vm.sh <action>
#
# Every action that writes is preceded, in the same run, by its preflight: the
# write runs only if the preflight exited 0 (`set -e`). For the `apply.sh`
# actions that is a separate preflight-only invocation before the CONFIRM=1 one
# (which preflights again, as apply.sh always does before it writes). The
# actions that run `remote.sh` check their preconditions on the VM before they
# change anything.
#
# THE LOGS ARE PUBLIC, because the repository is. `apply.sh` runs with
# APPLY_PUBLIC_LOG=1, which reduces what any tool on the VM prints to its shape
# (see `show` in apply.sh); `remote.sh` prints names, states, counts and
# limits, never a compose file, an env file or a container's environment.
#
set -euo pipefail

ACTION="${1:?action}"
case "$ACTION" in
    preflight | apply | caddy-preflight | caddy-apply | retire-lab-vhosts-preflight | retire-lab-vhosts | host-config-preflight | host-config-apply | rollback-preflight | rollback | retire-lab-containers | recreate-legacy-mcp-proving | retire-capacity-recorder) ;;
    *) echo "unknown action: $ACTION" >&2; exit 2 ;;
esac

VM_NAME="inflect-compliance"
VM_ZONE="europe-west1-b"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY="$HERE/../apply.sh"

# The OrangeHRM lab's two public vhosts, retired by capacity budget C1
# (docs/implementation-notes/2026-11-12-capacity-c1.md, runbook step 2).
# Literals, not an input: the list of hostnames production may stop serving is
# a reviewed line in this file.
LAB_VHOSTS="hrm-mcp.34-140-180-255.sslip.io orangehrm-lab.34-140-180-255.sslip.io"

# Nothing the runner's environment carries may steer apply.sh: every variable it
# reads is cleared here, so the only values it sees are the ones this script
# sets for the action.
unset CONFIRM DRY_RUN DRY_RUN_ENV_FILE CADDY_ONLY CADDY_RETIRE_HOSTS HOST_CONFIG_ONLY ROLLBACK \
    COMPOSE_BASENAME I_KNOW_THIS_IS_NOT_THE_CANONICAL_COMPOSE REMOTE_DIR HEALTH_ORIGINS \
    KEEP_BACKUPS CADDY_CONTAINER IAP_ATTEMPTS IAP_BACKOFF_SECONDS IAP_UNREACHABLE_EXIT
export APPLY_PUBLIC_LOG=1 VM_NAME VM_ZONE

# apply.sh in one mode, preflight only.
preflight() { env "$@" "$APPLY"; }
# The same mode's preflight, then — only if it passed — the write.
preflight_then_write() {
    env "$@" "$APPLY"
    env "$@" CONFIRM=1 "$APPLY"
}

# A dropped IAP connection (ssh exit 255) is retried, and stops the run when it
# stays dropped (deploy/lib/iap.sh) — but only for calls that are safe to run
# twice: making the stage and copying into it. remote.sh's actions are writes
# that are not known to be safe to repeat, so that call is `ssh_vm_once`: one
# attempt, and a dropped connection is reported as an UNKNOWN outcome.
# shellcheck source=deploy/lib/iap.sh
. "$HERE/../lib/iap.sh"
ssh_vm() { iap_retry ssh 255 - gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap --quiet --command "$1"; }
ssh_vm_once() { iap_once gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap --quiet --command "$1"; }

# remote.sh as root, from a private stage in the operator's home that is
# removed whatever happened. `vm-apply-stage`, not `vm-check-stage`, so this
# never races a `VM check` run on its stage.
on_vm() {
    local files=("$HERE/remote.sh")
    if [ "$ACTION" = recreate-legacy-mcp-proving ]; then
        files+=("$HERE/../docker-compose.legacy-mcp-proving.yml")
    fi
    # shellcheck disable=SC2016  # $HOME is the VM user's, expanded there
    # Its stdout is discarded: on a runner this is the first ssh, which makes a
    # key and prints ssh-keygen's banner and randomart on stdout.
    ssh_vm 'rm -rf "$HOME/vm-apply-stage" && mkdir -m 700 "$HOME/vm-apply-stage"' >/dev/null
    iap_retry scp any - gcloud compute scp --zone "$VM_ZONE" --tunnel-through-iap --quiet "${files[@]}" "$VM_NAME:vm-apply-stage/"
    ssh_vm_once "sudo bash \"\$HOME/vm-apply-stage/remote.sh\" '$ACTION' \"\$HOME/vm-apply-stage\"; rc=\$?; rm -rf \"\$HOME/vm-apply-stage\"; exit \$rc"
}

case "$ACTION" in
    preflight)                   preflight ;;
    apply)                       preflight_then_write ;;
    caddy-preflight)             preflight CADDY_ONLY=1 ;;
    caddy-apply)                 preflight_then_write CADDY_ONLY=1 ;;
    retire-lab-vhosts-preflight) preflight CADDY_ONLY=1 "CADDY_RETIRE_HOSTS=$LAB_VHOSTS" ;;
    retire-lab-vhosts)           preflight_then_write CADDY_ONLY=1 "CADDY_RETIRE_HOSTS=$LAB_VHOSTS" ;;
    host-config-preflight)       preflight HOST_CONFIG_ONLY=1 ;;
    host-config-apply)           preflight_then_write HOST_CONFIG_ONLY=1 ;;
    rollback-preflight)          preflight ROLLBACK=1 ;;
    rollback)                    preflight_then_write ROLLBACK=1 ;;
    retire-lab-containers)       on_vm ;;
    recreate-legacy-mcp-proving) on_vm ;;
    retire-capacity-recorder)    on_vm ;;
esac

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "# VM apply: $ACTION"; echo; echo "Completed. The step log holds the report."; } >> "$GITHUB_STEP_SUMMARY"
fi
