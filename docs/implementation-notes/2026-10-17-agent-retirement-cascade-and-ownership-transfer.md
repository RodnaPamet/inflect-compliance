# 2026-10-17 — Agent retirement cascade and two-step ownership transfer

**Commit:** _(this PR)_ `feat(agentic): retirement cascade and two-step ownership transfer (2a-lifecycle)` — #3698, step 2a of the agentic IAM roadmap, items 3 and 4

## Design

Two changes to the agent register, both from step 0e of
`docs/agentic-iam-roadmap.md` ("The retirement cascade is one act under one key",
"Agent ownership transfer", "Rule order", "Retention classes").

**Retirement cascades.** `retireRegisteredAgent` used to refuse while any
proposal was `PENDING` and otherwise flip the status alone. It is now one
transaction under `admin.agent_registry`:

```
assertCanRetireAgent              canWrite + admin.agent_registry, nothing narrower
getLifecycleState                 notFound | conflict if already RETIRED
setStatus(RETIRED)                FIRST — takes the agent row lock
applyRetirementCascadeInTx        domain writes only, no audit
  TenantApiKey.revokedAt          every unrevoked key bound to the agent, expired ones too
  AgentHarnessScannerKey          revoked through its own seam file
  RegisteredAgentTool             deleted
  AgentProposal PENDING→EXPIRED   the expiry sweep's write; reviewedByUserId stays NULL
  AgentPolicyCard                 READ only: the freeze is a refusal, not a write
  AgentOwnershipTransfer          the open one CANCELLED by the retiring actor; a lapsed one EXPIRED
writeRetirementAuditRows          LAST — AGENT_RETIRED summary, then one row per effect
```

Triggers back every part an in-flight writer could race, each raising the
`AGENT_RETIRED:` prefix: for a retired agent, an insert of a `PENDING`
`AgentProposal`, an `AgentPolicyCardVersion`, an `AgentOwnershipTransfer`, an
unrevoked `TenantApiKey` (insert or re-bind) or `AgentHarnessScannerKey`, and a
`RegisteredAgentTool` grant — each takes `FOR SHARE` on the agent row — and any
status change out of `RETIRED`. The usecases refuse the same things first, with
typed errors, and map a trigger refusal back to that same error; the triggers
are what make the refusal hold for a write already in flight.

**Ownership moves in two steps.** `AgentOwnershipTransfer` (`agentic.prisma`)
holds one handover: `fromOwnerUserId`, `toOwnerUserId`, `initiatedByUserId`, a
TEXT status (`PENDING | COMPLETED | CANCELLED | EXPIRED`), a seven-day
`expiresAt`, and completion and cancellation stamps.

```
POST   …/ownership-transfer            step one   proposeAgentOwnershipTransfer
POST   …/ownership-transfer/complete   step two   completeAgentOwnershipTransfer
DELETE …/ownership-transfer?transferId cancel     cancelAgentOwnershipTransfer
GET    …/ownership-transfer            read       getAgentOwnershipTransfers
        every route: requirePermission('admin.tenant_lifecycle'), ruled above the
        /admin/agents(/.*)? catch-all
```

Step one reads the agent `FOR SHARE` before anything else, then asks whether
the recipient can reach step two: an active OWNER, or an active ADMIN whose
custom role carries the key. Step two asks, in order: is this the person who
started it (forbidden), is it the person it names (forbidden otherwise), is it
still `PENDING`, has it lapsed (stamp `EXPIRED`, commit, then refuse), is the
agent still there, not retired and still owned by `fromOwnerUserId`, and is the
completer still a recipient step one would accept. Then `moveOwner`
(conditional on all of that, on the agent row) and `claimCompletion`
(conditional on `PENDING`, unexpired and naming the caller), in that order.

The database holds every rule the usecase does: CHECKs for the four statuses,
`from <> to`, `initiator <> recipient`, the completion shape (and completer =
recipient) and the cancellation shape; a partial unique index for one `PENDING`
row per agent; a BEFORE UPDATE trigger refusing any change to a row that has left
`PENDING`; no DELETE for `app_user`; RLS with the canonical three policies and
`FORCE`.

The one-step bypass is closed: `UpdateRegisteredAgentSchema` refuses
`ownerUserId` by name, `RegisteredAgentRepository.update` excludes it by type,
and the amend modal shows the owner read-only with a sentence saying how it
moves. Registration still sets the first owner.

## Files

| File | Role |
|---|---|
| `prisma/schema/agentic.prisma`, `auth.prisma` | `AgentOwnershipTransfer` and its two back-relations |
| `prisma/migrations/20261017235800_agent_retirement_cascade_and_ownership_transfer/migration.sql` | The four `AGENT_RETIRED` triggers; the transfer table, CHECKs, partial unique index, one-way trigger, privileges and RLS |
| `src/lib/agentic/agent-retirement.ts` | Caps, the evidence basis constant, `isAgentRetiredDbRefusal`, the effect and summary types |
| `src/lib/agentic/ownership-transfer.ts` | Statuses, the TTL, `effectiveTransferStatus`, the one-way trigger's prefix, `TRANSFER_RECIPIENT_MEMBERSHIP_ROLES` |
| `src/app-layer/usecases/agent-retirement-cascade.ts` | The effects and their audit rows |
| `src/app-layer/usecases/agent-registry.ts` | `retireRegisteredAgent` rewritten with its docstring; terminal `RETIRED` for activate and suspend; the owner write removed from the amend |
| `src/app-layer/usecases/agent-ownership-transfer.ts` | Propose, complete, cancel, read |
| `src/app-layer/repositories/AgentOwnershipTransferRepository.ts` | Every transfer query, each conditional on `PENDING` where it writes |
| `src/app-layer/repositories/RegisteredAgentRepository.ts` | `setStatus` refuses a retired row; `getLifecycleState` and its `FOR SHARE` twin `lockLifecycleStateForShare`; `moveOwner`; the retire preview `_count` |
| `src/app-layer/repositories/RegisteredAgentToolRepository.ts` | `revokeAllForAgent` |
| `src/app-layer/usecases/agent-harness-scanner-keys.ts` | `revokeScannerKeysForAgentInTx`, inside the table's seam file |
| `src/app-layer/usecases/agent-policy-card.ts`, `agent-proposals.ts`, `agent-tool-exposure.ts`, `api-keys.ts` | The card freeze at its write seam; each insert trigger's refusal mapped to the usecase's own typed error; retired-agent copy |
| `src/app-layer/schemas/agent-ownership-transfer.schemas.ts`, `agent-registry.schemas.ts` | `.strict()` transfer bodies; the named `ownerUserId` refusal |
| `src/app/api/t/[tenantSlug]/admin/agents/[agentId]/ownership-transfer/route.ts`, `…/complete/route.ts` | The two routes |
| `src/lib/security/route-permissions.ts` | The `admin.tenant_lifecycle` rule above the catch-all |
| `src/lib/permissions.ts` | `permissionsForMembership`, for predicting another member's permissions |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OverviewTab.tsx`, `AgentAmendModal.tsx`, `messages/*.json` | Cascade preview in the retire dialog, no Activate for a retired agent, read-only owner |
| `docs/data-retention.md` | The `AgentOwnershipTransfer` row; the cascade's effects on six existing rows |

## Decisions

- **Evidence: withdraw nothing, and say so.** No `AgenticEvidenceArtefact` is
  attributable to one agent. An artefact is keyed `(tenant, control, kind,
  period)` with no agent column, and `loadReceiptFacts` / `loadDecisionFacts`
  select the whole tenant's month; only a digest and a count are stored, so the
  population cannot be split afterwards. Withdrawing would need a new
  `withdrawnReason` (the CHECK admits `CONTROL_REMOVED | SOURCE_UNVERIFIABLE |
  OBLIGATION_UNMAPPED`), would be undone for the current month by the next 06:30
  UTC emission, and would retract true evidence about every other agent and about
  the retired agent's own past actions. So the cascade writes nothing and the
  `AGENT_RETIRED` row records `evidenceArtefactsWithdrawn: 0` and
  `evidenceBasis: 'POPULATION_LEVEL_ONLY'`. The 0e cascade table is amended to
  match. **Owner decision (2026-10-18): retirement withdraws no evidence
  artefact**, as built. Per-agent evidence that a retirement can withdraw is its
  own future roadmap step — a follow-up step that would add an
  agent-attributable artefact kind, per-agent emission and a withdrawal reason
  for it; none is invented here, and this cascade must not be "completed" by
  withdrawing tenant-wide artefacts in the meantime.
- **Status first.** The status UPDATE holds the agent row's lock; the insert
  triggers take `FOR SHARE` on it. A concurrent insert either committed before
  the UPDATE (and the cascade then sees it) or waits and reads `RETIRED`. That
  also keeps each effect's id list and its write in agreement: nothing for the
  agent can commit between the two statements. `idsTruncated` is set whenever a
  list is shorter than its write's count, not only when the cap cut it.
- **Audit last.** `logEvent` appends on its own connection, outside the
  transaction; a row written before an effect that then threw would describe a
  retirement that rolled back.
- **Effects written directly, never through the standalone verbs.** 0e decided
  retirement takes `admin.agent_registry` alone. `revokeApiKey`,
  `revokeAgentTool` and `updateAgentPolicyCard` each carry a narrower gate that
  would join retirement silently.
- **One audit row per effect KIND, not per entity.** Per-entity rows would be up
  to hundreds of hash-chain appends; each row lists its ids, bounded, and says
  when the list was cut. An effect that changed nothing writes no row — its zero
  is on the summary once.
- **The card is frozen by refusal, not by a write.** Writing the card head from
  the cascade would take its row lock while an edit in flight already holds it
  and waits on the agent row. The refusal sits in `createAgentPolicyCard` and
  `updateAgentPolicyCard`, not in the shared `assertAgentCardable`, so the read
  keeps working.
- **Triggers on `TenantApiKey`, `AgentHarnessScannerKey` and
  `RegisteredAgentTool` too.** The first draft had none, reasoning that only
  human usecases write those rows and all of them refuse a retired agent. The
  human usecases ARE the in-flight writers: each reads the status unlocked and
  then inserts, the insert's FK check takes `FOR KEY SHARE`, which does not
  conflict with the status UPDATE's `FOR NO KEY UPDATE`, and the cascade's
  UPDATE cannot see an uncommitted row — so a key minted at the moment of
  retirement survived it, unrevoked, and authenticated (REST key auth does not
  read the agent's status). A revoked key or scanner key is admitted: it confers
  nothing. The `agentic-reports.test.ts` fixture that models an agent retired
  before the cascade existed now seeds its grant first and retires it after.
- **`RETIRED` is terminal.** Reactivation would hand back a register row whose
  credentials, grants and card had been taken apart, and lift the freeze. SUSPEND
  remains the reversible stop.
- **The RETIRED asymmetry is resolved by option 1** of the open question in
  `2026-09-10-suspension-is-a-boundary-control.md`: retiring an agent now revokes
  its keys, so no credential reaches a retired agent. That holds for agents
  retired from now on; agents retired earlier keep whatever keys and grants they
  held, which is why their population is to be counted before merging.
- **Scanner keys are in the cascade**, though 0e's table omitted them: ingest
  trusts every unrevoked key, so a retired scanner's key would keep verifying
  reports. The table is amended.
- **An open transfer is closed by retirement**, rather than left to lapse: a
  retired agent can never be completed into. A live one is CANCELLED,
  attributed to the retiring actor; a lapsed one is stamped `EXPIRED` with no
  actor, as any request finding it would, because it had ended on its own. A
  retired agent therefore holds no `PENDING` transfer.
- **Lock order is agent row, then transfer row, on every path that takes
  both.** Step one reads the agent `FOR SHARE` (`lockLifecycleStateForShare`)
  before it stamps a lapsed transfer; completion calls `moveOwner` before
  `claimCompletion`; retirement writes the status before it closes the transfer.
  The first draft read the agent plainly in step one, so the stamp locked the
  transfer row and the insert trigger then waited on the agent row — the reverse
  order. With a row whose deadline fell between a retirement's clock and the
  proposal's, each waited on the other and Postgres aborted one with 40P01; the
  draft papered over it by having retirement skip lapsed rows, and the same
  cycle remained with completion. A lost claim throws inside the transaction and
  rolls the move back.
- **Both transfer steps take `admin.tenant_lifecycle`**, so a recipient must hold
  it: with built-in roles only an OWNER can receive an agent. The owner accepted
  this narrowing in 0e. The current owner's membership is NOT checked, so a
  transfer away from a departed owner (2b's remedy) works.
- **A recipient's BUILT-IN membership role must be OWNER or ADMIN**, narrower
  than 0e's wording ("a member an OWNER has given a custom role carrying the
  key"). Step one refuses a recipient who could never pass step two, and step
  two meets the edge middleware before the route: under `/api/t/:slug/admin/`
  it answers 403 "Admin access required", writing no `AUTHZ_DENIED` row, unless
  the session's built-in role is ADMIN or OWNER, and `assignCustomRole` never
  changes that role. The first draft accepted a READER with such a custom role —
  and its test called the usecase directly, proving a path production refuses;
  the offer would have held the agent's one open slot for seven days.
  `tests/unit/agent-ownership-transfer-edge-gate.test.ts` runs the real
  middleware for every built-in role and fails if
  `TRANSFER_RECIPIENT_MEMBERSHIP_ROLES` and the edge disagree. Admitting a
  READER-based custodian would mean widening the edge gate for these paths — a
  security-middleware change this PR does not make. **Owner decision
  (2026-10-18): the narrow recipient set is the accepted interim state.** A new
  built-in `AI_ADMIN` role will widen who can receive an agent, in its own pull
  request; until then an OWNER, or an ADMIN whose custom role carries
  `admin.tenant_lifecycle`, is the whole population.
- **The edge gate's primary-membership limitation is documented, not fixed
  here** (owner decision, 2026-10-18). The edge reads the session's PRIMARY
  (oldest) membership role, not the role in the tenant being called, so an
  OWNER here whose oldest membership elsewhere is READER is refused on every
  admin route, this one included. It fails closed, it predates this change, and
  fixing it is a security-middleware change of its own.
- **The usecase uses `assertCanRead` plus the key**, not `assertCanWrite`: the
  coarse tier comes from a custom role's BASE role, so an ADMIN membership with
  a READER-based custom role carrying the key resolves `canWrite: false` and is
  still a legitimate recipient.
- **The completer names the transfer by id.** "Accept whatever is open for this
  agent" would let a cancel and a fresh proposal swap what they accept.
- **Lazy expiry, no sweep and no audit row.** Nobody acted when a proposal
  lapsed; the row's status and `expiresAt` are the record. An expired completion
  stamps the row and commits before refusing.
- **TEXT + CHECK for the status**, not an enum, so a later state is a CHECK
  change in one forward migration (the `PROPOSE` rung lesson).
- **No user FKs on the transfer.** The agentic precedent: it is history, and
  removing a user must neither be blocked by it nor cascade into it.
- **The PATCH refuses `ownerUserId` with a 400** instead of stripping it: the
  update schema is not `.strict()`, and a stripped field answers 200 with the
  owner unchanged.
- **`AiSystem.ownerUserId` is not moved** by a transfer. It is recorded on the
  completion audit row so a divergence is visible; whether the two should stay
  in step is a separate question.
- **API-only.** No page proposes or accepts a transfer, and the recipient is not
  notified; both routes are registered in `AGENTIC_API_ROUTES` with that reason.
