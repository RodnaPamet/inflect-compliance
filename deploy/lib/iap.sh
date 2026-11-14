# shellcheck shell=bash
#
# deploy/lib/iap.sh — reaching the production VM over IAP, where a dropped
# connection is retried and never read as an answer.
#
# SOURCED, never run: by deploy/apply.sh, deploy/check-drift.sh and the runner
# halves deploy/vm-apply/vm.sh, deploy/vm-check/vm.sh, deploy/capacity/vm.sh and
# deploy/harness-scanner/vm.sh. Each keeps its own `ssh_vm` (its flags differ)
# and wraps the gcloud call in one of the two functions below.
#
# WHY (owner decision 2026-11-14). The IAP tunnel sometimes drops a connection,
# and ssh then exits 255. The scripts read that exit as a VERDICT about the VM:
#
#   VM apply run 43604116595: the Caddyfile was unchanged and its hash matched
#   the one validated 13 minutes earlier, yet the apply refused with "the repo
#   Caddyfile is NOT valid — caddy rejected it". The validation's ssh had
#   failed, and the failure was read as caddy's rejection.
#
#   VM apply run 43605285337: `[/usr/bin/ssh] exited with return code [255]`,
#   then "WOULD CREATE …inflect-capacity-record.service (absent on the VM)". The
#   hash read failed, and its `|| true` turned the failure into "absent".
#
# THE RULE. 255 is ssh's own exit for a connection that failed: a remote
# command's status is relayed as itself and is 255 only if the remote command
# chose it. So:
#
#   iap_retry ssh 255 …   retries a 255 (up to IAP_ATTEMPTS, short linear
#                         backoff), and returns any other status untouched, so
#                         a real non-zero exit from the remote command keeps the
#                         meaning it had. Only for calls that are SAFE TO REPEAT.
#   iap_retry scp any …   retries every failure: a copy is always safe to repeat,
#                         and scp reports a dropped connection as 1, not 255.
#   iap_once ssh …        runs once and never retries, for a call that is not
#                         known to be safe to repeat (a remote.sh write action).
#
# When the attempts are spent, or iap_once's single attempt dropped, the answer
# is UNKNOWN, and the run STOPS with "could not reach the VM over IAP". It stops
# the WHOLE script, not just the function: the callers run these inside `$(…)`,
# pipelines, `|| true` and `if !`, where a plain `exit` ends only a subshell and
# `set -e` is suspended, which is how a failed read became "absent" in the
# first place. So the subshell signals the main shell (USR1, trapped below to an
# exit), then exits itself.
#
# Output. A retried call's stdout is held until the attempt that counts, so a
# dropped attempt's partial output never reaches a `$(…)` or a pipe; stderr
# passes through. The retry notes and the could-not-reach error are written to
# fd 9, a copy of the script's stderr taken here, so a caller's `2>/dev/null`
# or `2>&1 | show …` cannot swallow them. They carry exit codes and counts
# only, which keeps the public-log rule of the VM workflows.

IAP_ATTEMPTS="${IAP_ATTEMPTS:-3}"
IAP_BACKOFF_SECONDS="${IAP_BACKOFF_SECONDS:-5}"
IAP_UNREACHABLE_EXIT="${IAP_UNREACHABLE_EXIT:-1}"
case "$IAP_ATTEMPTS" in '' | *[!0-9]* | 0) IAP_ATTEMPTS=3 ;; esac
case "$IAP_BACKOFF_SECONDS" in '' | *[!0-9]*) IAP_BACKOFF_SECONDS=5 ;; esac
case "$IAP_UNREACHABLE_EXIT" in '' | *[!0-9]*) IAP_UNREACHABLE_EXIT=1 ;; esac

IAP_MAIN_PID=$$
exec 9>&2
trap 'exit "$IAP_UNREACHABLE_EXIT"' USR1

iap_note() { printf '[iap] %s\n' "$*" >&9; }

# Stop the whole run: the answer is unknown.
iap_stop() {
    iap_note "ERROR: $*"
    iap_note "  An unanswered call is UNKNOWN, never a verdict about the VM: stopping here."
    kill -USR1 "$IAP_MAIN_PID" 2>/dev/null || true
    exit "$IAP_UNREACHABLE_EXIT"
}

# iap_retry <ssh|scp> <255|any> <stdin file, or -> <command…>
iap_retry() {
    local what="$1" on="$2" input="$3" attempt=1 rc out pause
    shift 3
    out="$(mktemp)" || iap_stop "could not make a temporary file for the ${what} output"
    while :; do
        rc=0
        if [ "$input" = - ]; then
            "$@" >"$out" 9>&- || rc=$?
        else
            "$@" <"$input" >"$out" 9>&- || rc=$?
        fi
        if [ "$rc" -eq 0 ] || { [ "$on" = 255 ] && [ "$rc" -ne 255 ]; }; then
            cat "$out"
            rm -f "$out"
            return "$rc"
        fi
        [ "$attempt" -lt "$IAP_ATTEMPTS" ] || break
        pause=$((IAP_BACKOFF_SECONDS * attempt))
        iap_note "${what} to the VM failed (exit ${rc}), attempt ${attempt} of ${IAP_ATTEMPTS}: retrying in ${pause}s"
        sleep "$pause"
        attempt=$((attempt + 1))
    done
    rm -f "$out"
    if [ "$what" = scp ]; then
        iap_stop "could not copy a file to the VM over IAP (scp exit ${rc} after ${IAP_ATTEMPTS} attempts)."
    fi
    iap_stop "could not reach the VM over IAP (ssh exit ${rc} after ${IAP_ATTEMPTS} attempts)."
}

# iap_once <command…> — one attempt, streamed. A 255 stops the run with the
# action's outcome UNKNOWN; any other status is returned as the remote's own.
iap_once() {
    local rc=0
    "$@" 9>&- || rc=$?
    if [ "$rc" -eq 255 ]; then
        iap_stop "the connection to the VM dropped while the action ran (ssh exit 255, 1 attempt; not retried, because repeating it is not known to be safe). Its outcome is UNKNOWN: read the VM's state before running it again."
    fi
    return "$rc"
}
