#!/usr/bin/env bash
#
# THE VM CAPACITY SNAPSHOT AND HISTORY — the runner half (the AI roadmap's
# capacity budget, C0; the history mode is C1b).
#
# Run by the `VM capacity` workflow (.github/workflows/vm-capacity.yml) on a
# GitHub runner already authenticated to GCP. Reaches the VM the way
# `deploy/apply.sh` and the scanner's `vm.sh` do, `gcloud compute ssh
# --tunnel-through-iap`: stages `remote.sh` or `history.sh` in a private
# directory in the operator's home, runs it as root, and removes the stage
# whatever happened.
#
# The report goes to stdout and, when the runner provides one, to the job
# summary.
#
#   vm.sh snapshot <samples> <interval-seconds> [hours]
#                         remote.sh: the host and every container now, and
#                         `samples` rows of `docker stats`
#   vm.sh history <samples> <interval-seconds> <hours>
#                         history.sh: what the capacity recorder (installed by
#                         apply.sh's host config set) wrote over the last
#                         `hours` (1-192); samples and interval are ignored
#
# The workflow passes all four inputs whatever the mode, so its one `run:` line
# never changes shape; the unused ones are checked and ignored.
#
set -euo pipefail

MODE="${1:?mode}"
SAMPLES="${2:?samples}"
INTERVAL="${3:?interval seconds}"
HOURS="${4:-24}"
case "$MODE" in snapshot | history) ;; *) echo "mode must be snapshot or history" >&2; exit 2 ;; esac
case "$SAMPLES$INTERVAL$HOURS" in *[!0-9]*) echo "samples, interval and hours must be whole numbers" >&2; exit 2 ;; esac

VM_NAME="${VM_NAME:-inflect-compliance}"
VM_ZONE="${VM_ZONE:-europe-west1-b}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$MODE" = history ]; then
    SCRIPT=history.sh
    ARGS="'$HOURS'"
    TITLE="VM capacity history (last $HOURS h)"
else
    SCRIPT=remote.sh
    ARGS="'$SAMPLES' '$INTERVAL'"
    TITLE="VM capacity snapshot"
fi

# Both modes are read-only, so every call here is safe to run twice: a dropped
# IAP connection (ssh exit 255) is retried, and stops the run when it stays
# dropped (deploy/lib/iap.sh). For the same reason the report's own call does
# not remove the stage — a retry must find the script still there — and a
# separate call removes it afterwards.
# shellcheck source=deploy/lib/iap.sh
. "$HERE/../lib/iap.sh"
ssh_vm() { iap_retry ssh 255 - gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --tunnel-through-iap --quiet --command "$1"; }

# Its stdout is discarded: on a runner this is the first ssh, which makes a key
# and prints ssh-keygen's banner and randomart on stdout.
ssh_vm 'rm -rf "$HOME/vm-capacity-stage" && mkdir -m 700 "$HOME/vm-capacity-stage"' >/dev/null
iap_retry scp any - gcloud compute scp --zone "$VM_ZONE" --tunnel-through-iap --quiet "$HERE/$SCRIPT" "$VM_NAME:vm-capacity-stage/$SCRIPT"

REPORT="$(mktemp)"
trap 'rm -f "$REPORT"' EXIT
rc=0
ssh_vm "sudo bash \"\$HOME/vm-capacity-stage/$SCRIPT\" $ARGS" | tee "$REPORT" || rc=$?
ssh_vm 'rm -rf "$HOME/vm-capacity-stage"' >/dev/null
[ "$rc" -eq 0 ] || exit "$rc"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "# $TITLE"; echo; cat "$REPORT"; } >> "$GITHUB_STEP_SUMMARY"
fi
