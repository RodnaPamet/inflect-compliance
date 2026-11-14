#!/usr/bin/env bash
#
# READ-ONLY CHECKS ON THE PRODUCTION VM — the runner half.
#
# Run by the `VM check` workflow (.github/workflows/vm-check.yml) on a GitHub
# runner already authenticated to GCP. Reaches the VM the way `deploy/apply.sh`
# and `deploy/capacity/vm.sh` do, `gcloud compute ssh --tunnel-through-iap`:
# stages `remote.sh` in a private directory in the operator's home, runs it as
# root, and removes the stage whatever happened. The report goes to stdout and,
# when the runner provides one, to the job summary.
#
#   vm.sh <check>
#
set -euo pipefail

CHECK="${1:?check}"
case "$CHECK" in
    containers | library-sync | log-errors | access-review-dates | bcrypt | automation-rules) ;;
    *) echo "unknown check: $CHECK" >&2; exit 2 ;;
esac

VM_NAME="${VM_NAME:-inflect-compliance}"
VM_ZONE="${VM_ZONE:-europe-west1-b}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Every check is read-only, so every call here is safe to run twice: a dropped
# IAP connection (ssh exit 255) is retried, and stops the run when it stays
# dropped (deploy/lib/iap.sh). For the same reason the check's own call does not
# remove the stage — a retry must find remote.sh still there — and a separate
# call removes it afterwards.
# shellcheck source=deploy/lib/iap.sh
. "$HERE/../lib/iap.sh"
ssh_vm() { iap_retry ssh 255 - gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap --quiet --command "$1"; }

ssh_vm 'rm -rf "$HOME/vm-check-stage" && mkdir -m 700 "$HOME/vm-check-stage"'
iap_retry scp any - gcloud compute scp --zone "$VM_ZONE" --tunnel-through-iap --quiet "$HERE/remote.sh" "$VM_NAME:vm-check-stage/remote.sh"

REPORT="$(mktemp)"
trap 'rm -f "$REPORT"' EXIT
rc=0
ssh_vm "sudo bash \"\$HOME/vm-check-stage/remote.sh\" '$CHECK'" | tee "$REPORT" || rc=$?
ssh_vm 'rm -rf "$HOME/vm-check-stage"'
[ "$rc" -eq 0 ] || exit "$rc"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "# VM check: $CHECK"; echo; cat "$REPORT"; } >> "$GITHUB_STEP_SUMMARY"
fi
