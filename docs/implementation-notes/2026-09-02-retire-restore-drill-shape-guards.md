# 2026-09-02 — retiring two guards that certified the shape of a drill that never ran

**Commit:** `<pending>` fix(dr): tell the truth about backups, and watch the drill that actually runs

## Design

Two guards were deleted, and the reasoning is the same for both: each asserted
the SHAPE of an AWS restore posture that was never provisioned, and each stayed
green for the whole period the thing it guarded was failing.

**`tests/guards/oi-3-backup-restore.test.ts`** — 39 assertions over
`infra/scripts/restore-test.sh`, `.github/workflows/restore-test.yml` and
`infra/terraform/**`: strict mode, a cleanup trap, `--skip-final-snapshot`,
`--no-publicly-accessible`, a timestamped instance id, `backup_retention_days
>= 7` in production tfvars. Every one of them was TRUE. None of them was a
statement that a restore had ever happened, and the workflow they described
failed six consecutive scheduled runs across five months while they passed.

**`tests/guardrails/dr-snapshot-coverage.test.ts`** — 10 assertions that the
cross-region snapshot-copy wiring exists in the database module. Its own
docstring says *"a snapshot copied to a second region but never restored is not
a verified backup"*, which is precisely the state it certified: the copy was
`count`-gated off (`db_dr_region = ""` → zero DR resources) and the terraform
was never applied at all.

Both were deleted rather than rewritten against GCP. The artefacts they read are
going away — `restore-test.sh` and `restore-test.yml` in this change,
`infra/terraform/` in the follow-up — and a shape guard pointed at the
replacement would reproduce the same error one cloud later.

## Files

| file | role |
| --- | --- |
| `tests/guards/oi-3-backup-restore.test.ts` | deleted — 39 shape assertions over a never-applied estate |
| `tests/guardrails/dr-snapshot-coverage.test.ts` | deleted — 10 assertions over `count`-gated-off DR wiring |
| `tests/guards/oi-3-runbook-and-slos.test.ts` | four PROSE assertions retired; the two section-existence checks kept |
| `.github/workflows/restore-drill-freshness.yml` | new — asks another repository whether a restore actually succeeded |
| `tests/guards/restore-drill-freshness.test.ts` | new — the tripwire on the tripwire; asserts shape only, and says so |

## Decisions

- **Shape and conduct need different instruments, and the split is now
  explicit.** The new guard asserts the freshness workflow exists, is scheduled,
  names the right repo/workflow/matrix leg and has a notifier wired to its
  failure — all structure, all knowable from the source tree. Whether a restore
  succeeded is a claim about the world; only the workflow can make it. The new
  guard carries a test named *"does not pretend to verify a restore itself"*
  that fails if a future edit starts asserting conduct from a source read.

- **The prose assertions were worse than merely false, and one detail proves
  it.** `oi-3-runbook-and-slos.test.ts` required `docs/slos.md` to contain
  `/Maximum\s+1\s+hour\s+of\s+data\s+loss/`, `restore-test.sh`, `helm rollback`
  and `restore-db-instance`. After the live text was corrected, TWO of those
  four still passed — satisfied by a dated 2026-04-27 row in the document's own
  CHANGELOG TABLE. A grep cannot distinguish a present-tense commitment from a
  historical note, which is the whole of CLAUDE.md's "never gate CI on prose".

- **Not replaced with corrected greps.** Requiring the doc to say "24 hours"
  would rebuild the trap one rewrite later. Doc truth is `docs-accuracy` plus
  human review.

- **`sub-processor-coverage` caught a real omission in this very change**, and
  is kept. Rewriting the sub-processor inventory dropped the only references to
  `S3_*`, `DATABASE_READ_URL` and `UPSTASH_*`, leaving eight env vars in
  `src/env.ts` untriaged. That guard reads CODE and compares it to the doc, so
  it fails when the doc stops describing something that still exists — the
  opposite of a prose grep, and the reason it survives while the others do not.
  The fix was an "optional external services this deployment does not use"
  section, which is a better answer than an allowlist: it keeps the inventory a
  complete triage of `src/env.ts` rather than a list of what happens to be on.

- **The census registry lost three keys and gained two.** `restore-test.yml`'s
  three jobs are gone; `restore-drill-freshness.yml` contributes `freshness`
  and `notify-on-failure`, both schedule-only and therefore PR-unreachable by
  construction. The `freshness` entry's `coveredBy` records the split above
  rather than claiming PR-time coverage it does not have.
