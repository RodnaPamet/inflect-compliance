# 2026-11-12 — The `VM apply` workflow: named changes to the production VM

**Commit:** see the `claude/vm-apply-workflow` branch (`feat(deploy): VM apply workflow …`),
stacked on `claude/capacity-c1` (#5324), whose `CADDY_RETIRE_HOSTS` and runbook it runs.

## Design

The owner decided (2026-11-12) that a Claude session changes production in one
of two ways. **Option 1:** the owner signs the session in to `gcloud` with their
own account, for that container's life. **Option 2:** a workflow the session
dispatches and the owner approves — durable, and no credential ever sits in a
session. This is Option 2, the write-side sibling of `VM check` (owner
decision 2026-11-10).

```
session ──dispatch (main, action=<choice>)──▶ VM apply ──▶ production env reviewer
                                                │
                       WIF: vars.GCP_WIF_PROVIDER / vars.GCP_VM_OPERATOR_SA
                                                │
                                deploy/vm-apply/vm.sh <action>
                       ┌────────────────────────┴──────────────────────────┐
           APPLY_PUBLIC_LOG=1 deploy/apply.sh                remote.sh as root on the VM
     (preflight, then the same mode with CONFIRM=1)   (retire-lab-containers, recreate-legacy-mcp-proving)
```

Twelve actions, each written out in `vm.sh`'s `case`:

| Action | Runs |
| --- | --- |
| `preflight` | `apply.sh` |
| `apply` | `apply.sh`, then `CONFIRM=1 apply.sh` |
| `caddy-preflight` / `caddy-apply` | the same with `CADDY_ONLY=1` |
| `retire-lab-vhosts-preflight` / `retire-lab-vhosts` | the same with `CADDY_ONLY=1` and `CADDY_RETIRE_HOSTS` = the lab's two hostnames, literals in `vm.sh` |
| `host-config-preflight` / `host-config-apply` | the same with `HOST_CONFIG_ONLY=1` |
| `rollback-preflight` / `rollback` | the same with `ROLLBACK=1` (new in `apply.sh`) |
| `retire-lab-containers` | `remote.sh`: `docker compose … rm --stop --force orangehrm-mcp orangehrm orangehrm-db`, or `docker rm --force` by compose service label when the VM has no overlay; volumes kept; counts before and after |
| `recreate-legacy-mcp-proving` | `remote.sh`: bundle and token present (yes/no), overlay validated with `config -q`, previous overlay kept as `.bak.<ts>` (mode 600), installed, `up -d --no-deps legacy-mcp-proving`, health and limits reported |

`apply.sh` changes, all keeping its interactive use as it was:

- **`APPLY_PUBLIC_LOG=1`.** Every stream `apply.sh` relays from the VM goes
  through `show <kind>`, which is `cat` at a terminal and a shape filter in a
  public log: `compose` keeps `<Kind> <name> <state>` resource lines and the
  NAME of a variable a `:?` guard found missing; `diagnostics` keeps
  error-shaped lines from caddy and the ops agent's engine, whose only input is
  a repository file; `none` keeps only the count. gcloud gets `--quiet`.
- **`ROLLBACK=1`.** The newest `docker-compose.prod.yml.bak.<timestamp>` whose
  hash differs from the live file: every CONFIRM apply backs the file up, also
  when it does not change it, so a retried apply leaves an identical newest
  backup in front of the one worth restoring. Identical ones are skipped and
  counted; when all are identical it refuses. Validated in place; with
  `CONFIRM=1` restored, `up -d`, health-verified.
- **The ssh key, made first.** A runner has no gcloud ssh key, and the first
  `gcloud compute ssh` makes one with ssh-keygen printing its banner and
  randomart on stdout, into whatever `$(ssh_vm …)` captures first (the
  rollback's backup path, a file's hash). `ssh_key_ready` makes the key with a
  throwaway ssh whose stdout is discarded, before any mode reaches the VM, and
  every hash capture keeps only a 64-hex word (`first_sha`).
- **The NODE_OPTIONS count** (C1 runbook step 3) joins the preflight's env-file
  report: `COUNT NODE_OPTIONS <n>`, and a warning when it is not 0.
- `scp_vm` and `health_verify` helpers, so the flag reaches every gcloud call
  and the apply and the rollback end the same way.
- **A fixed exit-code bug:** `caddy reload … | sed` on the VM reported sed's
  status, so a rejected reload looked successful and skipped the restore.

## Files

| File | Role |
| --- | --- |
| `.github/workflows/vm-apply.yml` | the workflow: dispatch only, main only, one choice input, `production`, OIDC + `contents: read`, 45-minute limit |
| `deploy/vm-apply/vm.sh` | runner half: the action list, the lab hostnames, the preflight-then-write helper, the stage for `remote.sh` |
| `deploy/vm-apply/remote.sh` | VM half: the lab teardown and the proving recreate |
| `deploy/apply.sh` | `APPLY_PUBLIC_LOG`, `ROLLBACK`, the NODE_OPTIONS count, the reload exit code |
| `tests/guards/vm-apply-workflow.test.ts` | the guard |
| `tests/guardrails/ci-checks-unreachable-before-merge.json`, `tests/guardrails/contended-json-format.test.ts` | the registry entry and its key-order digest |
| `CLAUDE.md`, `docs/deployment.md`, `docs/implementation-notes/2026-11-12-capacity-c1.md` | the two options; the action table; each runbook step's action |

## Decisions

- **A choice input, and nothing else.** The identity is root on production. A
  free-text command, path, host or compose argument would make every push to
  the repository a way to run anything there. Even the hostnames Caddy may stop
  serving are literals in `vm.sh`, and `vm.sh` clears every variable `apply.sh`
  reads before it sets the ones an action needs (the guard derives that list
  from `apply.sh`, so a new knob fails until `vm.sh` decides it).
- **Main only** (`if: github.ref == 'refs/heads/main'`). The compose file,
  Caddyfile and overlay pushed are the checkout's; dispatching from a branch
  would push unmerged structure, which is what repo-canonical exists to stop.
  The job-level `if` skips the run before it asks the reviewer.
- **That `if` is a convenience, not the boundary.** A dispatch runs the files
  of the ref it names, so a branch can delete the `if` and rewrite any action,
  and the Workload Identity condition reads the repository and the environment,
  not the ref. The boundary is the `production` environment: deployment
  branches limited to protected branches (only `main` is), and the owner, who
  is both the dispatcher and the sole reviewer, reading the run's branch before
  approving. Prevent self-review is therefore off on purpose. The owner
  confirmed both settings on 2026-11-12, and `docs/deployment.md` records them
  beside a ref term for the provider's condition, which is the owner's to add.
- **Preflight twice for a write.** The action runs the preflight-only
  invocation, and the `CONFIRM=1` invocation only if it exited 0. `apply.sh`
  then preflights again before it writes, as it always does. The first is the
  one a guard can pin and the one whose plan reads cleanly in the log; the
  second validates the state at write time. It costs a few minutes of ssh.
- **Its own concurrency group, not `vm-check`'s.** VM check only reads and
  stages in `$HOME/vm-check-stage`; this stages in `$HOME/vm-apply-stage` and
  under `/tmp` and `/opt/inflect` with per-second timestamps, so the two never
  touch the same path, and a check can watch the VM while an apply waits for
  approval. `Scanner VM` also writes to the compose project; the runbook orders
  the two and the owner approves each run, so they are not grouped.
- **Filter on the runner, before printing, not mask.** The relayed stream is
  piped into an allowlist filter; a line it does not recognise is counted and
  never printed. Docker compose's errors can quote `.env` lines (its dotenv
  parser names the "variable" it failed on), so compose output is never passed
  through as text. A failure the filter withholds is diagnosed with Option 1.
- **Rollback restores the compose file only**, like the command `apply.sh`
  prints: the other canonical files, the host config and the Caddyfile keep
  their own backups, and `caddy_apply` already restores its own on failure.
- **No action for C1 runbook step 8.** It deletes the lab's volumes and edits
  `.env.prod`, once, 30 days on. A destructive one-off is Option 1's.
- **The lab teardown is `rm --stop --force`, never `down`.** `down` removes the
  project's networks, `inflect_default` first, which production is on. No `-v`:
  the volumes are kept for the runbook's 30 days.
