# 2026-09-06 — Make the agent-proposal diff real (ASI09, automation bias)

**Commit:** `<pending> feat(agentic): render a real diff before a proposal can be approved`

## Design

The propose-not-commit queue is the product's whole safety story for agentic
writes: an agent never mutates a record, it queues an `AgentProposal` and a human
approves it. That control is correct in design and it is worth exactly what the
human sees. Until this change the review page rendered

```tsx
<pre>{JSON.stringify(JSON.parse(p.payloadJson), null, 2)}</pre>
```

with an Approve button beside it. **Approving an opaque payload is not
oversight** — it is the mechanism by which automation bias operates (OWASP ASI09
Human-Agent Trust Exploitation): under volume the reviewer defaults to trusting
the proposer, the click still writes a hash-chained audit row saying a human
approved it, and the queue has manufactured a record of consent nobody gave. A
rubber-stamped queue is worse than no queue.

Three things changed, and they are one mechanism.

**1. A proposal now says WHAT it would do.** `AgentProposal` gains
`operation` (`CREATE` | `UPDATE`, defaulted) and `targetEntityId`. Stored, never
inferred from payload shape: the UI's whole job is to choose between "full
proposed content" and "field-level before/after against a base", and a guess in
front of the human-oversight gate is not a guess worth making. A database CHECK
(`AgentProposal_update_requires_target`) refuses an UPDATE row with no target —
an update naming no target cannot be diffed, so it must not be storable.

**2. The diff is computed server-side, against a base read AT REVIEW TIME.**

```
page.tsx (server)
  listAgentProposals ──► buildProposalDiffs(ctx, proposals)
                              │  one query per KIND (never per proposal)
                              │  soft-deleted rows are invisible ⇒ TARGET_MISSING
                              ▼
                         computeProposalDiff  (pure, five statuses)
                              ▼
  ProposalRow.diff ──► AgentProposalsClient ──► ProposalDiffPanel
                                                   └─ approveAction slot
```

There is deliberately no snapshot column. A base captured when the proposal was
queued answers "what was true when the agent looked"; the reviewer is being asked
"what will this do if I approve it now". Those diverge exactly when it matters —
a busy record edited between proposal and review — and the stored answer is the
one that is confidently wrong. `payloadJson` is no longer sent to the client at
all, so the old `<pre>` cannot return one `JSON.stringify` later.

**3. The approval is BOUND to the diff that was read.** `computeProposalDiff`
returns a `baseDigest` — `sha256` over the (field, before) pairs actually
rendered. The client sends it back on approve; `approveAgentProposal` recomputes
the diff and refuses on any of three conditions, which are one check:

| condition | refusal |
| --- | --- |
| no digest supplied on an UPDATE | 400 — the reviewer read no diff |
| `!isDiffReviewable(diff)` | 400 naming the status — no diff *could* be read |
| digest ≠ recomputed digest | **409 `STALE_DATA`** — the base moved since |

CREATE is exempt because it has no base; `baseDigest` is `null` for one, and
demanding a token would be theatre.

### The five statuses, and why "empty" and "unknown" are not the same

The interesting failure is not "no diff". It is a diff that RENDERS while being
empty or wrong. Three of these exist so that cannot happen silently:

| status | meaning | approvable |
| --- | --- | --- |
| `CREATE` | no prior state; the full content IS the diff | yes |
| `UPDATE` | a base was read and at least one field differs | yes |
| `NO_CHANGES` | a base was read and nothing differs — a real answer | **yes** |
| `TARGET_MISSING` | the row is gone (deleted, or not this tenant's) | no |
| `PAYLOAD_UNREADABLE` | the stored payload is not a JSON object | no |

`NO_CHANGES` and the two refusals get different testids, different copy,
different tone and — the load-bearing part — different answers from
`isDiffReviewable`, so the approve control is present for one and absent for the
others. Reject stays available for all five: refusing something you cannot read
is always safe, and it is the only way to clear an orphaned row.

### The approve control is a CHILD of the diff, not a sibling

`ProposalDiffPanel` takes `approveAction` as a slot and renders it from exactly
one place: inside the branch that has already rendered a diff body. A button in
the card header satisfies every "is Approve present" assertion ever written and
is precisely the problem restated. The rendered test asserts this structurally —
every `[data-testid^="proposal-approve-"]` must have a `closest('[data-diff-status]')`
that contains a non-empty diff body — so hoisting the button out of the panel
turns CI red.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/enums.prisma` | `AgentProposalOperation` (CREATE / UPDATE) |
| `prisma/schema/agentic.prisma` | `AgentProposal.operation` + `.targetEntityId` |
| `prisma/migrations/20260906120000_agent_proposal_operation/migration.sql` | New enum type, two columns, the update-requires-target CHECK |
| `src/lib/agentic/proposal-diff.ts` | The pure decision table: five statuses, value rendering, `baseDigest`, `isDiffReviewable` |
| `src/app-layer/usecases/agent-proposal-diff.ts` | The only DB read: batched per kind, missing row ⇒ explicit null |
| `src/app-layer/usecases/agent-proposals.ts` | Propose accepts UPDATE (partial schema, target must exist); approve binds to `baseDigest` and applies via the real update-usecase |
| `src/app/api/t/[tenantSlug]/agent-proposals/[id]/approve/route.ts` | Forwards `baseDigest`; never invents one |
| `src/app/t/[tenantSlug]/(app)/agent-proposals/ProposalDiffPanel.tsx` | The rendering, and the sole home of the approve control |
| `src/app/t/[tenantSlug]/(app)/agent-proposals/AgentProposalsClient.tsx` | Card chrome, reject, rationale; sends the digest back on approve |
| `src/app/t/[tenantSlug]/(app)/agent-proposals/page.tsx` | Computes the diffs server-side; stops forwarding `payloadJson` |
| `messages/{en,bg}.json` | `agents.proposals.diff.*` |

## Decisions

- **`operation` is a column, not an inference.** "This payload happens to carry
  an id, so it is probably an update" is a guess, and a guess deciding whether a
  human sees a before-column is the wrong place for one. `CREATE` is the default
  because every pre-existing row was one.

- **POLICY cannot be updated by proposal, and the omission is the feature.**
  There is no `UpdatePolicySchema`: policy content moves through versions and
  approvals, and a flat field merge approved here would bypass the version chain
  that makes policy history auditable. `UPDATE_SCHEMA_BY_KIND` has three keys and
  the propose boundary refuses the fourth by name.

- **A missing target renders the proposed values with NO before-column, under an
  explicit refusal.** Showing them beside a column of blanks would read as "this
  creates all of these", which is the wrong story about a record that no longer
  exists. The values are still listed so an operator can triage *what* was
  proposed; the status is what makes it unapprovable.

- **`baseDigest` covers only the fields shown, not the whole row.** The reviewer
  read a before-column, and that column is what the approval is bound to.
  Including untouched columns would invalidate a diff that is still exactly true
  whenever anything else on the record moved — which trains reviewers to retry
  past the warning, and a warning people are trained to retry past is not a
  control.

- **Object keys are sorted before stringifying a value.** Two structurally equal
  values must not differ only by key order. A diff that reports a non-change
  cries wolf, and a queue whose diffs cry wolf is a queue that gets
  rubber-stamped — the failure this whole change exists to prevent, arriving by
  a side door.

- **Approve-time re-check, not just render-time.** The UI gate is a convenience;
  `approveAgentProposal` re-derives the diff and re-evaluates `isDiffReviewable`
  itself, so a direct API call, a script, or a future bulk action cannot reach
  the write path the UI withholds.

- **There is a residual TOCTOU window** between the approve-time freshness check
  and the update it guards — they are separate transactions. It is narrow (both
  are in one request) and it is not what the check is for: the failure being
  closed is a human reading a diff minutes or hours before clicking, not two
  writes racing inside one request. Closing it fully would need the base's
  fingerprint in the update's own `where`, which is not expressible through the
  entity update-usecases, and routing around them to get it would give up the
  validation, sanitisation, cache invalidation and audit event those usecases
  carry — a worse trade.

- **The propose boundary also refuses a CREATE that names a target.** Not a
  harmless extra field: it is a caller that believes it is proposing an edit, and
  approving it would silently create a SECOND record beside the one it meant to
  change.

- **Audit fields are spelled as member reads (`proposal.operation`), not as the
  locals holding the same values.** A bare identifier at a sink is a name
  `local/no-raw-prompt-logging` cannot resolve, so it is counted as a hole in
  that rule's denominator; written this way the change adds zero holes and
  `MEASURED_HOLES` stays where it was measured. Both new fields are a fixed token
  and an opaque id — no payload content joins them.

- **Rolling-deploy safety.** A NEW enum type (never `ALTER TYPE` on an existing
  one, so an old container that has never heard of `AgentProposalOperation` reads
  and writes `AgentProposal` exactly as before); `ADD COLUMN NOT NULL DEFAULT`,
  which is metadata-only on PG 11+; and a CHECK every existing row satisfies by
  construction, since they are all `operation = 'CREATE'`.
