# 2026-08-20 — the leaver pass: giving five rails a caller

**Commit:** `(this PR)` feat(jml): wire the leaver pass, clamped at DRY_RUN

## What this is

The code path from *"the HR feed says this person has left"* to the five safety
rails that were built before it. Until now nothing constructed a
`DirectoryWriter` and nothing assembled a batch: the ladder, the breaker, the
link model, the write-target derivation, the journal, both provider writers and
the orchestration all existed with no caller.

It ships **clamped at `DRY_RUN`** and cannot move a tenant past its rung.

## The finding that had to be fixed first

`reconcileIdentityAccountLinks` also had no caller (fixed separately, #2044).
That mattered more than it looks: it is the only writer of
`IdentityAccountLink.lastVerifiedAt`, and `findLeaverCandidates` requires that
column fresh. So the candidate set was **permanently empty** — a leaver pass
shipped on top would have run, reported success, and disabled nobody.

An offboarding that silently does nothing is indistinguishable from one that
works. That is the failure this subsystem is most prone to, and it is why the
pass reports `NO_FRESH_LINKS` as its own named refusal rather than as a quiet
`PASSED` with zero results.

## Design

### DRY_RUN reads a snapshot, not the directory

`decideAndDisable` calls `writer.readState()` **before** it reaches the `DRY_RUN`
branch — the mode decides whether to *write*, not whether to *look*. So a naive
factory has to construct a live writer just to observe, and the Entra writer's
constructor refuses unless `writesEnabled === true`.

That flag exists so a setup-guide edit alone cannot upgrade a read-only tenant.
Requiring it in order to run the *observation* rung inverts the ladder: a tenant
would have to grant standing power to disable accounts before it could watch what
disabling would do. Forcing the flag on inside the factory is worse — it routes
around a control by pretending to satisfy it.

So the observation rung reads the last confirmed-complete enumeration this
product already stores. That is not an approximation:

| provider | what the sync records | where |
| --- | --- | --- |
| Entra ID | `accountEnabled === false ? 'SUSPENDED' : 'ACTIVE'` | `providers/entra-id/index.ts:119` |
| Active Directory | `userAccountControl & ACCOUNTDISABLE ? 'SUSPENDED' : 'ACTIVE'` | `providers/active-directory/index.ts:326` |

so `enabled === (status === 'ACTIVE')` reproduces what a live `readState` would
have returned as of that pass. `DEPROVISIONED` reads as not-enabled too, matching
the live Entra writer, which *resolves* a 404 rather than throwing.

Three problems dissolve at once: no consent is needed to observe, no Graph token
is minted (so a dry run can never be mistaken for evidence that
`User.EnableDisableAccount.All` was granted), and a transient network failure
during the read cannot produce a `FAILED` outcome — which the notification layer
would turn into a mail telling IT an account is still live.

### …and snapshot evidence must not settle the journal

The already-disabled branch doubles as the reconciler for a write whose result
was never confirmed: *"it is disabled now, and the only write anyone made was
ours, so ours landed."*

That inference is sound against the directory and **unsound against stored
observation**. An account an admin re-enabled this morning still reads disabled
in last night's enumeration — so a snapshot-backed pass would settle the journal
row `APPLIED` and report `ALREADY_DISABLED` for an account that is live,
mis-resolving the one ambiguity the journal exists to hold open, and telling an
operator comparing the dry run against reality that nothing needed doing for
exactly the person who did.

The reader marks its own evidence `staleEvidence: true` and the orchestration
honours it. The decision is deliberately **not** keyed on the mode: a future
caller could read stale data in any mode, and the property belongs with the
evidence rather than with the rung.

**`DRY_RUN` is therefore not literally read-only** — it writes no journal row for
a disable, but before this guard it could still settle a pre-existing one. Worth
stating plainly, because "dry run writes nothing" is the kind of claim that gets
repeated until someone relies on it.

### Link freshness *is* the completeness gate

Workday reports no completeness signal, so a termination inferred from absence
must never act. The pass never infers — it reads employees the feed explicitly
marks `TERMINATED`.

The directory side has the same problem, solved upstream: links are stamped
`lastVerifiedAt` only by the reconciler, which runs only after a sync that
returned `PASSED`. So requiring a fresh link **is** requiring that a complete
directory read happened recently. There is deliberately no second completeness
check in the pass — one gate, held where the evidence is produced, cannot drift
from a copy of itself.

### The unit is (tenant, provider)

Not per connection. `ConnectedIdentityAccount` carries no `connectionId`, so with
two enabled connections for one provider there is no way to say which directory
an account came from. The factory refuses that outright rather than addressing a
disable at a forest the account may not live in — and the dispatcher dedupes to
distinct `(tenantId, provider)` so the refusal is produced once, not twice.

## Files

| file | role |
| --- | --- |
| `integrations/identity-writer-factory.ts` | the one seam from a connection to a writer; the snapshot reader; six named refusals |
| `usecases/identity-leaver-pass.ts` | the gates, cheapest first, and the `DRY_RUN` clamp |
| `jobs/identity-leaver.ts` | the per-unit job and the daily fan-out |
| `jobs/types.ts` | payloads + `JOB_DEFAULTS` with `attempts: 1` |
| `jobs/executor-registry.ts`, `jobs/schedules.ts` | runtime wiring |
| `usecases/identity-disable-account.ts` | the stale-evidence guard |
| `lib/observability/integration-metrics.ts` | `identity.leaver.pass` |

## Decisions

- **`attempts: 1` is a correctness constraint, not rate-limit courtesy.** The
  journal's `INDETERMINATE` handling assumes one dispatch per decision. BullMQ's
  default of three would run the same pass three times in ~35 seconds, each
  minting fresh journal rows, and the second and third could not tell their own
  predecessors' rows from a real unconfirmed write. Retrying destroys the
  evidence the retry would need. Tomorrow's dispatch picks it up.

- **`close()` is on every arm of the resolution type**, including the two that do
  not need it. A caller's `finally` is then unconditional and typechecked, rather
  than a `'close' in writer` narrowing somebody eventually forgets. The AD writer
  holds an LDAP socket and a leaked bind outlives the process that made it.

- **The clamp is a constant, not a setting.** Raising it must be a diff somebody
  reviews. A tenant configured at `PROPOSE` or `AUTOMATIC` today reached that rung
  by *elapsed days* — the ladder counts time since `dryRunSince`, and no pass has
  ever run — so its configured mode is a statement about waiting, not about
  anything anyone observed.

- **The metric fires on every terminal path**, including `mode_disabled` and
  `no_terminated`. Every other identity counter fires only when work happens, so
  a scheduler that stopped dispatching would look exactly like a quiet week.

- **05:00 UTC, after the 03:00 sync.** The pass acts only on links a complete sync
  re-observed; running it first would read yesterday's evidence and refuse for the
  wrong reason.

## What is still not wired

`protectedAccountIds` has no producer, so the break-glass rail stays inert — a
service account named in it would still be reported as would-be-disabled. That is
tolerable while the clamp holds and must be closed before any tenant is promoted.
