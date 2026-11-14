# 2026-11-14 — A dropped IAP connection is retried, never read as an answer

## Design

The deploy scripts reach the production VM with `gcloud compute ssh/scp
--tunnel-through-iap`. The tunnel sometimes drops a connection, and ssh then
exits 255. Two `VM apply` runs read that exit as a verdict:

- run 43604116595: the Caddyfile validation's ssh dropped, and the refusal said
  "caddy rejected it" about an unchanged file validated 13 minutes earlier;
- run 43605285337: a hash read dropped, its `|| true` made the answer empty,
  and the preflight said "WOULD CREATE … (absent on the VM)" about a file that
  exists.

`deploy/lib/iap.sh` is sourced by `apply.sh`, `check-drift.sh` and the four
runner halves (`vm-apply`, `vm-check`, `capacity`, `harness-scanner`). Each
keeps its own `ssh_vm` and wraps the gcloud call:

| wrapper | retries | used for |
| --- | --- | --- |
| `iap_retry ssh 255` | a 255 only, 3 attempts, linear backoff (5 s, 10 s) | calls safe to run twice |
| `iap_retry scp any` | every failure | copies (scp reports a dropped connection as 1) |
| `iap_once` | never | remote.sh actions that write (vm-apply, harness-scanner) |

When the attempts are spent the run STOPS: "could not reach the VM over IAP
(ssh exit 255 after 3 attempts)". Stopping is done by signalling the main shell
(USR1, trapped to `exit`), because the callers sit inside `$(…)`, pipelines,
`|| true` and `if !`, where `exit` ends only a subshell and `set -e` is
suspended. `check-drift.sh` stops with its own UNKNOWN exit, 2.

A retried call's stdout is held until the attempt that counts, so a dropped
attempt's partial output never reaches a `$(…)`. The notes and the stop go to
fd 9, a copy of the script's stderr, so a caller's `2>/dev/null` or
`2>&1 | show …` cannot hide them. They carry exit codes and counts only.

## Decisions

- **255 is the line for ssh.** A remote command's status is relayed as itself,
  so a real `1` (caddy rejecting a file) is returned once, unretried, with its
  old meaning. The one way a remote command produces 255 without choosing it is
  being killed by a signal; every retried call is safe to repeat, so that case
  is covered by the audit below.
- **Validations print a marker after the validator ran.** caddy's exit comes
  back as `caddy-validate-exit <n>`, printed by a shell inside the container
  after caddy returned, and the ops agent's as `engine-exit <n>`. No marker
  means the validator never ran (a docker cp, docker exec or ssh failure), which
  is reported as "did not run … NOT a verdict". "caddy rejected it" now means
  caddy ran and rejected it.
- **Validations no longer delete their own input.** The caddy, ops-agent and
  recorder validations removed the staged file in the same call (a trap or a
  trailing `rm`), so a retry after a connection that dropped AFTER the call ran
  found no input and reported a rejection. Cleanup is a separate call now. The
  recorder's trial pass clears its output directory first, so a retry counts
  one pass.
- **`mv` of a staged file became `place_staged`.** A retried `mv` finds no
  source. The helper moves only while the staged file exists, then decides
  success by the target's hash. A `mv`, not a copy, because it replaces the
  inode as these pushes always have. Failures that the callers' suspended
  `set -e` used to skip silently (a failed move inside `caddy_apply` or
  `host_config_apply`) now return 1.
- **Not retried:** `vm-apply/vm.sh`'s and `harness-scanner/vm.sh`'s remote.sh
  run. Their actions are writes (container removal, recreation, scanner
  configure/start/stop) that are not known to be safe to repeat, and a dropped
  connection does not prove the remote process stopped. A 255 there reports the
  outcome as UNKNOWN. `vm-check` and `capacity` run read-only scripts, so their
  run is retried, and the stage is removed by a separate call afterwards.
- **Repeat-safe but not idempotent, accepted:** `recorder_activate`'s
  `systemctl start` of the oneshot runs one more recorder pass on a retry (one
  extra sample row). `systemctl restart`, `caddy reload` and
  `docker compose up -d` converge to the same state.
