# 2026-11-15 — retire `prisma/rls-setup.sql` and `prisma/rls-fix.sql`

**Commit:** (this change)

Owner decision, 2026-11-15, closing #5423. Taken on the measurements below.

## Design

Two SQL "replay/repair" scripts described themselves as the canonical way to
re-apply row-level security. They were not: the migrations are the only apply
path, and the scripts had drifted to roughly a quarter of the estate while
still claiming to cover all of it.

Measured on this tree:

| | tables carrying a `tenant_isolation` policy |
| --- | --- |
| `prisma/migrations/**` | **226** |
| `prisma/rls-setup.sql` | 52 |
| `prisma/rls-fix.sql` | 7 |
| either script | 59 |
| isolated by a migration, named by neither script | **~167** |

(#5423 reported 220 / 52 / 7 / 58; the small difference in the first figure is
a broader pattern here that also matches `CREATE POLICY IF NOT EXISTS`. The
magnitude is the point and both readings agree on it.)

`rls-setup.sql`'s header said:

```
-- All tenant-scoped tables use:
```

False for about 167 of them — and the file was SILENT about those, which reads
identically to "nothing needed here". Every `CREATE POLICY` in it was preceded
by `DROP POLICY IF EXISTS`, so for the 59 it replaced and for the rest it did
nothing. An operator reaching for it mid-incident — which is what a repair tool
is for — would have got a quarter of the estate and no indication which quarter.

## Why deleted rather than completed or relabelled

Three things decided it:

- **Nothing runs them.** `tests/guardrails/rls-coverage.test.ts` said so in its
  own comment before this change: *"rls-setup.sql is no longer wired into any
  script; the migrations are the load-bearing apply path."* No npm script, no
  CI job, no deploy step, and no runbook instruction to run either file.
- **Completing them was the highest-risk option.** The 167 missing policies do
  not share one shape: a nullable `tenantId` needs a single asymmetric policy
  (see `UserSession` in `docs/epic-d-completeness.md`), and ownership-chained
  tables need an `EXISTS` form. Generating them would have produced a file that
  looked authoritative and could carry a weaker policy than the migration it
  claimed to reproduce — the exact failure #5241 and #5240 were.
- **Relabelling leaves the trap, politely.** An honest header on a 26% tool
  still invites somebody to run it during an incident.

Same call as the 2026-11-15 retirement of `scripts/codemods/`, and the
2026-08-05 retirement of 153 epic-named ratchets: an artefact that locks a
past state, kept past its usefulness, with a claim about itself that has since
gone false.

## Files

| file | role |
| --- | --- |
| `prisma/rls-setup.sql` | deleted (52 tables, the false "All tenant-scoped tables" header) |
| `prisma/rls-fix.sql` | deleted (7 tables) |
| `tests/guards/rls-replay-scripts-do-not-weaken-migrations.test.ts` | deleted — it existed only to police those two files |
| `tests/guardrails/rls-coverage.test.ts` | the three assertions that READ `rls-setup.sql` removed; the reset-path check and the detector's mutation proof KEPT, re-pointed at the migrations |
| `docs/epic-a-security.md` | the `allow_all` tripwire note now names the migration whose stopgaps left the residue, not the deleted script |

## Decisions

- **The reset-path check survives, re-anchored.** It asked "is every policy in
  `rls-setup.sql` also created by a migration". Its expectation is now
  `ORG_SCOPED_MODELS` — the curated list the rest of the file already asserts
  against, and a stronger anchor than a 26%-complete copy.
- **The mutation proof survives, re-pointed.** One case proved
  `hasCreatePolicy` can actually return false, by removing `org_isolation`
  from the scanned text. It mutated `rls-setup.sql`; it now mutates the
  migration text. Dropping it with the file would have left the surviving
  assertion able to pass vacuously if a future edit broke the regex — which is
  the failure that case was written for in the first place.
- **No DB-backed assertion changed.** Every behavioural RLS check in
  `rls-coverage.test.ts` (tenant and org isolation, `superuser_bypass`, FORCE
  ROW LEVEL SECURITY, the `allow_all` tripwire) reads `pg_policies` and is
  untouched. What went is a file comparison.
- **Migrations and implementation notes keep their references.** Migrations are
  immutable history and several mention the scripts in comments; the
  2026-11-12 note records the drift that led here. Both are correct about the
  past and were left alone.

## Change class

SIGNIFICANT, because the diff is RLS material — `scripts/check-significant-change-analysis.mjs`
classifies on what a change TOUCHES, not on what it does, which is the right
way round for a gate. The analysis the class requires, recorded here rather
than only in the pull request:

**Risk.** No policy is removed from any database. The deleted files were
applied by nothing — not `prisma migrate deploy`, not the Docker entrypoint,
not any npm script, CI job or runbook step — so no environment's RLS state
changes, on deploy or on reset. No behavioural check is weakened: every
DB-backed assertion in `rls-coverage.test.ts` reads `pg_policies` and is
untouched. Three file-comparison assertions went; the two worth keeping were
re-anchored to the migrations. No migration, schema, enum or dependency
change, and nothing ships to the product.

The residual risk is informational: somebody who had bookmarked
`rls-setup.sql` as a repair tool no longer finds it. That is the intended
effect, and `docs/epic-a-security.md` points at the migrations instead.

**Rollback.** `git revert` the single commit; it restores both SQL files, the
deleted guard and the previous assertions verbatim, the change being pure
deletion plus two re-anchored tests.

The policy's forward-fix doctrine asks: *if the app image is reverted without
reverting a migration, does the app still work?* Here, trivially yes — this
change contains no migration, nothing in it is applied to a database, so app
and schema cannot diverge because of it. There is no state to unwind and no
window in which a reverted app meets a migrated database, which is the
situation that doctrine exists for.

If the deletion later proves wrong because somebody genuinely wants a replay
tool, the route is not a revert but generating one from the migrations with a
set-equality guard (option 2 on #5423). Restoring a 26%-complete file
re-creates the defect this closed.
