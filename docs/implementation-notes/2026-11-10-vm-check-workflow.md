# 2026-11-10 — Read-only VM checks without a key in a session

## Design

Claude's cloud sessions had no lasting way to look at the production VM. The
environment's `CLOUDSDK_AUTH_ACCESS_TOKEN` is a placeholder, so `gcloud`
answered every call with "invalid authentication credentials". The only way in
was the owner signing a session in with their own Google account, which lasts
one container and carries their full access. The owner chose (2026-11-10) to
reach the VM through GitHub Actions instead:

```
session ──dispatch──▶ VM check (production env) ──reviewer approves──▶ runner
runner ──WIF──▶ scanner-vm-operator ──IAP ssh──▶ VM: sudo remote.sh <check>
session ◀──job log + step summary──
```

The identity is the one the `Scanner VM` and `VM capacity` workflows already
hold. `scanner-vm-operator` has no key: only this repository's workflow tokens,
in the `production` environment, can act as it. The checks are a fixed list:
`containers`, `library-sync`, `log-errors`, `access-review-dates` and `bcrypt`.
Each one was run against the VM before this landed, and each printed the table
it is meant to.

## Files

| File | Role |
| --- | --- |
| `.github/workflows/vm-check.yml` | Dispatch-only, a `choice` input, the `production` environment, WIF auth |
| `deploy/vm-check/vm.sh` | Runner half: stages `remote.sh` over IAP, runs it as root, removes the stage |
| `deploy/vm-check/remote.sh` | VM half: one `case` branch per check |
| `tests/guards/vm-check-workflow.test.ts` | Holds the workflow's and the scripts' shape |
| `tests/guardrails/ci-checks-unreachable-before-merge.json` | Registers the job as never reachable from a PR |
| `tests/guardrails/contended-json-format.test.ts` | Re-pins the registry's key-order digest |
| `CLAUDE.md`, `docs/deployment.md` | Say how a session reaches the VM |

## Decisions

- **A choice, not a command.** The service account holds `compute.osAdminLogin`,
  which makes it root on the VM. A free-text input would let anyone who can push
  to a branch, and dispatch from it, run anything on production after one click
  of Approve. A missing check is a pull request to `remote.sh`. The guard checks
  that the workflow's options, `vm.sh`'s accepted list and `remote.sh`'s branches
  are the same set.
- **Every run waits for the reviewer** (owner decision). The alternative, a
  reviewer-less environment admitted by the federation's attribute condition,
  would have let reviewed code on `main` reach a root identity unattended.
- **Public logs set the output contract.** The repository is public, so a run's
  log is too. Log output is only ever piped into `grep` and `awk`, which extract
  named counters (`library-sync`) or count lines per component or job
  (`log-errors`). A log line itself never reaches stdout. `docker inspect` names
  its fields (`.Image`, `.State.StartedAt`), so no container environment can
  surface. The guard holds all three properties.
- **The one query is read-only twice over.** It runs under
  `PGOPTIONS=-c default_transaction_read_only=on`, and the guard refuses a write
  keyword in the SQL.
- **Errors group by job when there is no component.** The worker's job-failure
  lines carry `jobName` and no `component`. Without the fallback, every one of
  them counted as `(none)`.
