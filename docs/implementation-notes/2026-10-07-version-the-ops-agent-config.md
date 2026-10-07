# 2026-10-07 — version the Ops Agent config into the canonical deploy set

**Commit:** `<pending> chore(deploy): the ops agent config joins the canonical set`

## Design

`/etc/google-cloud-ops-agent/config.yaml` is what ships the app container's
logs to Cloud Logging. It was written by hand during #3099 and lived **only on
the VM** — the last piece of production config outside git, which is exactly
the class of drift #2849 built `deploy/apply.sh` and `deploy/check-drift.sh` to
eliminate for the compose file.

It now has a repo-canonical copy at `deploy/ops-agent-config.yaml`, byte-identical
to the live file (`sha256 4f7dbd92d139…`), pushed by `apply.sh` and watched by
`check-drift.sh`.

```
CANONICAL_SET     "<local>:<remote BASENAME>"    → ${REMOTE_DIR}/<basename>
                  activated by docker compose up -d
                  validated by docker compose config -q
                  costs a 502 on `app`

HOST_CONFIG_SET   "<local>:<ABSOLUTE remote>"    → /etc/google-cloud-ops-agent/config.yaml
                  activated by systemctl restart google-cloud-ops-agent
                  validated by the agent's own engine (-in <file>)
                  costs NOTHING — no container is touched
```

### Why a second array rather than a fourth row of the first

Four properties differ and each would be wrong if merged: the remote path is
absolute rather than a basename, activation is a daemon restart rather than
`up -d`, validation is the service's own parser rather than compose's, and the
blast window is **none**.

That last one drove `HOST_CONFIG_ONLY=1`. Coupled to the compose path, a
logging fix would have to wait for a maintenance window and a maintenance
window would have to carry a logging change. A mechanism nobody can afford to
run is a mechanism that goes unused, and an unused apply path is how the
original 148-line divergence happened. `HOST_CONFIG_ONLY=1` returns before any
compose code, so it cannot recreate a container even by mistake.

### Two assertions, because a copy is not an apply

`apply.sh` verifies the restart **compiled** the file it just pushed, by
looking for the receiver path in the generated collector config.
`systemctl is-active` goes green for an agent that restarted while keeping its
previous pipeline, and agent 2.72 compiles logging into
`/run/google-cloud-ops-agent-opentelemetry-collector/otel.yaml` — not into
fluent-bit, which is where #3099 first looked.

`tests/guards/deploy-canonical-set-is-watched.test.ts` asserts the push set and
the watch set name the same files, in both directions. Pushed-but-unwatched
drifts silently; watched-but-unpushed is a standing warning nobody can action
— the Caddyfile has been precisely that since 2026-09-26.

## Files

| file | role |
| --- | --- |
| `deploy/ops-agent-config.yaml` | NEW — the repo-canonical agent config, byte-identical to live |
| `deploy/apply.sh` | `HOST_CONFIG_SET`, the preflight/apply function pair, `HOST_CONFIG_ONLY=1` |
| `deploy/check-drift.sh` | the agent config joins `APPLIABLE`; two stale header claims corrected |
| `tests/guards/deploy-canonical-set-is-watched.test.ts` | NEW — set agreement, reload, and the config's own pipeline shape |
| `docs/deployment.md` | the host config set, the comparison table, `HOST_CONFIG_ONLY` |

## Decisions

- **Backups land in `${REMOTE_DIR}`, not beside the live file.** The prune step
  walks `${REMOTE_DIR}/*.bak.*` and `check-drift.sh` fails loudly on anything
  there readable beyond root; a backup written into `/etc/…` would inherit
  neither control and would accumulate unexamined. The agent names its config
  as a single file (`-in <path>` in the unit, confirmed), so a dead copy beside
  it would not be read — the reason is retention and permissions, not parsing.

- **The validator was proven in both directions before being shipped.** The
  engine exits 0 on the real config, 1 with `logging receiver with type "…" is
  not supported` on a bad receiver, and 1 with `[3:9] sequence end token ']'
  not found` on malformed YAML. A gate that cannot reject is not a gate, and
  this one is the only thing standing between a typo and silent loss of log
  export.

- **The engine's output is captured to a file and printed after, not piped
  through `sed`.** A pipeline's status is its last command's, and
  `set -o pipefail` is this script's setting, not the remote shell's — so
  `engine | sed` would have reported sed's success for a rejected config. The
  exit code is the entire point of the step.

- **`|| compiled=""` on the verification read.** With `pipefail` on, a
  transient ssh failure inside that command substitution would abort the script
  *after* the compose stack had been applied — killing the run at the one point
  where its output is what an operator needs. Empty reads as UNKNOWN and falls
  into the failure branch, which is the safe direction.

- **A host-config failure does not abort the deploy.** By the time it runs the
  compose file is already pushed, so returning early would leave the VM holding
  a compose file that was never applied — drift created by the tool whose job
  is to prevent it. It is recorded and reported beside the health result.

- **`deploy/caddy/Caddyfile` stays `UNRECONCILED`, and its reason was
  rewritten rather than left.** It cited a mechanical blocker — no flattened
  staging name for a nested remote path — which `HOST_CONFIG_SET`'s loop now
  demonstrably solves. What remains is not mechanical: Caddy needs a reload
  rather than a restart, the two copies are still not byte-equal so a first
  push is a real content change to a live TLS terminator serving two production
  hostnames, and nobody has taken that decision. Leaving the old reason in
  place would have left a blocker that had silently expired.

- **A stale header claim in `check-drift.sh` was corrected too.** It said the
  `UNRECONCILED` array was empty as of 2026-09-26 and exit 3 therefore
  unreachable. The entry was right there below it; what got reconciled that day
  was the Caddyfile's *content*, not its entry. Two different claims collapsed
  into one, which is how a reader comes to treat a reachable exit code as dead.

## What the guard's own mutation proof changed

Eleven mutations, each aimed at one assertion. The first run found one with no
teeth: deleting the real `ssh_vm "sudo systemctl restart …"` left the guard
**green**, because the two `err "… sudo systemctl restart …"` lines that print
the rollback command also satisfied the needle. The assertion was reading its
own advice text as its subject — an ambiguous needle (#2246 Class D) inside a
guard written specifically to catch inert deploys.

The fix drops message emitters before looking for the execution, pins exactly
one site, and requires it to contain `ssh_vm`. It also asserts the prose is
both present and excluded, so a filter that stopped filtering breaks the
equality instead of quietly restoring the hole. Re-run: 11 of 11 with teeth,
including a new mutation that deletes the restart while keeping the prose, and
one that tries to neuter the filter by turning the restart into an `err` line.
