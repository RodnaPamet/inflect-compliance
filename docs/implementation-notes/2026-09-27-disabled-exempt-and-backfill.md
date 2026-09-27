# 2026-09-27 — DISABLED has no observation window, and existing connections keep their reach (#2861)

**Commit:** `<pending> feat(agentic): exempt DISABLED from the dwell, backfill existing connections`

## Design

Two owner decisions taken on 2026-09-27, and they are a pair — the second is only
deployable because of the first.

**The rung will govern every call, not just writes.** The owner chose the
strongest of three options for what the ladder gates: not "tools the server
declares as writes" and not "tools a human marked as writes", but *whether an
agent may call this connection at all*. Reads included.

That reading needs stating precisely, because the obvious one is wrong. It cannot
mean each rung's WRITE semantics apply to reads — `DRY_RUN` would then record a
read and send nothing, and `PROPOSE_ONLY` would queue a read for human approval,
so reads would only work at `AUTOMATIC`, behind the full dwell. That would put
#2859's proven read capability behind the highest write authority. It means the
rung is a per-connection gate: `DISABLED` permits no calls, `DRY_RUN` and above
permit reads, and the rung continues to govern writes above that.

**DISABLED is exempt from the observation window.** The dwell exists so that what
a rung RECORDS can be read before a wider one acts on it, and `DISABLED` records
nothing by construction — `MODE_MIN_EVIDENCE` already exempted it on the evidence
axis for exactly that reason, and the elapsed-days axis had not caught up. What
that cost: a connection never set has no `modeSince`, so its FIRST widen was
refused and the operator was sent to re-select `DISABLED` as a no-op and then wait
seven days at a rung that observes nothing.

**The two compose.** With the rung gating every call, seven days at `DISABLED` is
seven days of outage for any connection that needs widening. The exemption is what
makes the gate shippable.

## Files

| file | role |
| --- | --- |
| `src/lib/integrations/external-write-ladder.ts` | `refusalForMove` exempts `DISABLED` from `modeSince` and the dwell |
| `prisma/migrations/20260927170000_backfill_.../migration.sql` | existing `mcp-server` connections → `DRY_RUN` |
| `tests/unit/external-write-ladder.test.ts` | 6 assertions, each paired with one proving the exemption did not leak |
| `tests/integration/external-write-policy.test.ts` | the flipped behaviour + the backfill predicate |

## Decisions

- **The exemption is bounded to `DISABLED` and every assertion is paired.** Six
  new unit tests: three that `DISABLED` is exempt, three that `DRY_RUN` is not —
  null `modeSince`, unserved dwell, missing evidence. An exemption whose blast
  radius is untested is an exemption that has quietly become general.

- **The one-rung rule is untouched.** `DISABLED → PROPOSE_ONLY` is still refused.
  The exemption is about the window, not about skipping levels.

- **Narrowing then re-widening is now permitted, and the property that mattered
  survives.** The old test asserted that narrowing to `DISABLED` and re-widening
  immediately was refused. It no longer is — and it should not be, because
  `DRY_RUN` sends nothing, so nothing is granted that was not already there. What
  still bites is that the RE-ENTERED `DRY_RUN` carries a fresh window, so the rung
  above it is refused on a dwell starting from zero rather than inheriting the
  days the first stay accrued. The test now asserts that instead.

- **The backfill grants nothing.** `DRY_RUN` is where these connections already
  sat in every sense that mattered — tools approved against a pinned manifest,
  granted per agent, cleared for `EXTERNAL_EGRESS`, scanned on egress. The rung is
  a NEW term in that conjunction, so setting it to the value that preserves the
  conjunction is the identity operation on authority. Leaving them `DISABLED` is
  stricter only in the sense that a service interruption is stricter.

- **It supersedes the reasoning in `20260927150000`, which is left unedited.**
  That migration argued at length that no backfill was needed because "NULL
  coerces to DISABLED, which is exactly what every existing connection should read
  as". True while the rung governed nothing; wrong under this decision. It is not
  edited because it is already applied and its checksum is load-bearing — the new
  migration carries the correction instead.

- **Verified against production before shipping: the predicate matches exactly ONE
  row.** `Entra MCP`, the connection that produced the proving run and the one that
  would otherwise go dark. The `active-directory` and `entra-id` connections are
  outside `provider = 'mcp-server'`.

## The Class A defect, met and proved

The backfill's assertions read `migration.sql`, and that file is four-fifths
comment — it argues about `DRY_RUN`, about NULL coercion, about provider scope.
`raw-source-assertion-ratchet` caught the read as unmasked, which is its whole
purpose: *"Delete the status chip, leave a JSX comment naming its `data-testid`,
and the guard stays 20/20 green."*

Masked at the read seam with `sqlCodeOf`, which converts every assertion in the
file at once. Then proved rather than assumed — deleting the `UPDATE` while leaving
every word of the header turns all four assertions RED, with `DRY_RUN` still
appearing four times in the surviving prose. Unmasked they would have stayed green.

## Risk assessment and rollback

STANDARD, with one caveat worth naming. The ladder change is a REFUSAL being
lifted, which is a widening of what an operator may do — bounded to a rung that
dispatches nothing and paired with tests proving it did not leak. The backfill
writes one row in production and is idempotent by its `IS NULL` guard.

Rollback: revert the ladder change and the first widen on a new connection is
refused again, which is inconvenient rather than unsafe. The backfilled row would
need setting back to NULL by hand if the gate is abandoned entirely; while the gate
exists, `DRY_RUN` is the value that keeps it working.
