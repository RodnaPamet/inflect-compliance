#!/usr/bin/env bash
#
# THE VM CAPACITY SNAPSHOT — the runner half (the AI roadmap's capacity budget, C0).
#
# Run by the `VM capacity` workflow (.github/workflows/vm-capacity.yml) on a
# GitHub runner already authenticated to GCP. Reaches the VM the way
# `deploy/apply.sh` and the scanner's `vm.sh` do, `gcloud compute ssh
# --tunnel-through-iap`: stages `remote.sh` in a private directory in the
# operator's home, runs it as root, and removes the stage whatever happened.
# The report goes to stdout and, when the runner provides one, to the job
# summary.
#
#   vm.sh <samples> <interval-seconds>
#
set -euo pipefail

SAMPLES="${1:?samples}"
INTERVAL="${2:?interval seconds}"
case "$SAMPLES$INTERVAL" in *[!0-9]*) echo "samples and interval must be whole numbers" >&2; exit 2 ;; esac

VM_NAME="${VM_NAME:-inflect-compliance}"
VM_ZONE="${VM_ZONE:-europe-west1-b}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ssh_vm() { gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap --quiet --command "$1"; }

ssh_vm 'rm -rf "$HOME/vm-capacity-stage" && mkdir -m 700 "$HOME/vm-capacity-stage"'
gcloud compute scp --zone "$VM_ZONE" --tunnel-through-iap --quiet "$HERE/remote.sh" "$VM_NAME:vm-capacity-stage/remote.sh"

REPORT="$(mktemp)"
trap 'rm -f "$REPORT"' EXIT
ssh_vm "sudo bash \"\$HOME/vm-capacity-stage/remote.sh\" '$SAMPLES' '$INTERVAL'; rc=\$?; rm -rf \"\$HOME/vm-capacity-stage\"; exit \$rc" | tee "$REPORT"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "# VM capacity snapshot"; echo; cat "$REPORT"; } >> "$GITHUB_STEP_SUMMARY"
fi
