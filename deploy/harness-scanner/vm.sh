#!/usr/bin/env bash
#
# THE HARNESS SCANNER ON THE PRODUCTION VM — the runner half (#3665).
#
# Run by the `Scanner VM` workflow (.github/workflows/scanner-vm.yml) on a
# GitHub runner already authenticated to GCP. Reaches the VM the way
# `deploy/apply.sh` does, `gcloud compute ssh --tunnel-through-iap`, stages
# `remote.sh` (and, for `configure`, the overlay, the configuration and the
# credentials) in a private directory in the operator's home, runs it as root,
# and removes the stage whatever happened.
#
#   vm.sh <action>
#   configure also needs CONFIG_FILE and ENV_PARTIAL: the filled-in
#   configuration and the credential lines, both written by the workflow.
#
set -euo pipefail

ACTION="${1:?action}"
case "$ACTION" in
    preflight | configure | public-key | dry-run | start | status | stop) ;;
    *) echo "unknown action: $ACTION" >&2; exit 2 ;;
esac

VM_NAME="${VM_NAME:-inflect-compliance}"
VM_ZONE="${VM_ZONE:-europe-west1-b}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERLAY="$HERE/../docker-compose.harness-scanner.yml"

# The pinned digest, read from the overlay in this checkout — the one reviewed
# place it is written.
IMAGE="$(sed -n 's#^ *image: *\(ghcr\.io/rodnapamet/agent-harness-scanner@sha256:[0-9a-f]\{64\}\) *$#\1#p' "$OVERLAY")"
[ -n "$IMAGE" ] || { echo "the overlay names no pinned scanner digest" >&2; exit 1; }

ssh_vm() { gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap --quiet --command "$1"; }

LOCAL_STAGE="$(mktemp -d)"
trap 'rm -rf "$LOCAL_STAGE"' EXIT
chmod 700 "$LOCAL_STAGE"
cp "$HERE/remote.sh" "$LOCAL_STAGE/remote.sh"
if [ "$ACTION" = configure ]; then
    cp "$OVERLAY" "$LOCAL_STAGE/docker-compose.harness-scanner.yml"
    install -m 0600 "${CONFIG_FILE:?CONFIG_FILE}" "$LOCAL_STAGE/config.json"
    install -m 0600 "${ENV_PARTIAL:?ENV_PARTIAL}" "$LOCAL_STAGE/env.partial"
fi

ssh_vm 'rm -rf "$HOME/harness-scanner-stage" && mkdir -m 700 "$HOME/harness-scanner-stage"'
gcloud compute scp --zone "$VM_ZONE" --tunnel-through-iap --quiet "$LOCAL_STAGE"/* "$VM_NAME:harness-scanner-stage/"
ssh_vm "sudo bash \"\$HOME/harness-scanner-stage/remote.sh\" '$ACTION' \"\$HOME/harness-scanner-stage\" '$IMAGE'; rc=\$?; rm -rf \"\$HOME/harness-scanner-stage\"; exit \$rc"
