# 2026-10-18 — Per-agent evidence that retiring an agent withdraws (#3700, `2a-evidence`)

**Commit:** `feat(agentic): per-agent evidence that retiring an agent withdraws (2a-evidence)`

## Design

#3698's retirement cascade could withdraw no evidence artefact: every
`AgenticEvidenceArtefact` was a tenant-wide monthly aggregate keyed
`(tenant, control, kind, period)`, storing only a count and a digest, so the
population could not be split by agent afterwards. It recorded
`evidenceBasis: 'POPULATION_LEVEL_ONLY'`. The owner then decided (2026-10-18,
decision 13 in `docs/agentic-iam-roadmap.md`) to add per-agent evidence that a
retirement can withdraw, as its own step. This is that step.

```
            the month's receipts (one read, +1 past the cap)      the month's decisions (one read)
                 │  facts (unchanged)   mcpKeyId (beside)               │ facts (unchanged)  agentId (beside)
                 ▼                                                     ▼
 tenant-wide  AGENT_ACTION_RECEIPTS  ── ASI02, ASI04        AI_DECISION_RECORDS ── ASI09, Art.12   (agentId NULL)
                 │ keyId → TenantApiKey.agentId                        │
                 ▼ partition in memory                                 ▼ partition in memory
 per agent    AGENT_ACTION_RECEIPTS_PER_AGENT ── ASI02, ASI04  AI_DECISION_RECORDS_PER_AGENT ── ASI09, Art.12
              one row per (control, period, agent) for every registered, non-retired agent with ≥1 record

 retireRegisteredAgent ─ status RETIRED (agent row locked) ─ … ─ withdrawRetiredAgentEvidenceInTx
      per-agent rows of this agent, CURRENT, periodEnd > now  →  WITHDRAWN 'AGENT_RETIRED', Evidence archived + notice
```

Two kinds, not one: they evidence different obligations with different bodies,
exactly as their tenant-wide twins do, and `EVIDENCE_TARGETS` gives each the same
obligations as its twin so the per-agent rows land on the same controls and the
withdrawal sweep unmaps them together.

The per-agent artefacts are emitted by the existing 06:30 UTC
`agentic-evidence-emission` pass against the same targets, from the same read.
An agent gets a per-agent artefact of a kind in a month once at least one of its
records of that kind falls in it. The body is the tenant-wide builder's body over
the agent's facts, under a preamble naming the agent (register id only) and the
attribution basis, and a `BOUNDED` line when the tenant's month exceeded the
read cap.

Retirement withdraws, inside its transaction, the agent's per-agent artefacts
whose period is still open, with the new reason `AGENT_RETIRED`; it deletes none
and leaves closed periods and every tenant-wide artefact alone.
`RETIREMENT_EVIDENCE_BASIS` is now `PER_AGENT_OPEN_PERIODS`, the summary carries
the real count, and an `AGENT_RETIREMENT_EVIDENCE_WITHDRAWN` row lists the ids.

## Files

| File | Role |
|---|---|
| `prisma/migrations/20261018140000_agentic_evidence_per_agent/migration.sql` | `agentId` + FK + index; kind CHECK re-listing all six kinds; `agent_scope` CHECK; the identity re-created as five columns `NULLS NOT DISTINCT`; reason CHECK re-listing all four reasons; `AGENT_RETIRED` per-agent-only CHECK; the retired-agent trigger; `AiDecisionLog.agentId` and the append-only trigger re-created with it |
| `prisma/schema/agentic.prisma` | `AgenticEvidenceArtefact.agentId`, the agent relation, the five-column `@@unique`, `@@index([tenantId, agentId])`; `RegisteredAgent.evidenceArtefacts` |
| `prisma/schema/automation.prisma` | `AiDecisionLog.agentId` (no relation) |
| `src/lib/agentic/evidence-artefact.ts` | the two kinds, `PER_AGENT_ARTEFACT_KINDS`, `isPerAgentKind`, their targets, `AGENT_RETIRED`, `ARTEFACT_WITHDRAWAL_REASONS`, `perAgentPopulationDigest`, the per-agent builders, the agent line in the withdrawal notice |
| `src/app-layer/usecases/agentic-evidence-emission.ts` | attributed population reads, `planPerAgentArtefacts`, the locked and refusable `writePlannedArtefactInTx`, the sweep's `AGENT_RETIRED` question, `withdrawRetiredAgentEvidenceInTx` |
| `src/app-layer/ai/decision-log/index.ts` | stamps `agentId: ctx.agentId ?? null` |
| `src/lib/agentic/agent-retirement.ts`, `src/app-layer/usecases/agent-retirement-cascade.ts`, `src/app-layer/usecases/agent-registry.ts` | the evidence effect, its summary figure and audit row, the new basis |
| `src/app-layer/jobs/agentic-evidence-emission.ts` | counts `perAgentRefused` |
| `tests/guards/ai-decision-log.test.ts` | the model read bound to its braces instead of a 2,000-character window the new column pushed the indexes out of |

## Decisions

- **New kinds with an agent column, not an `agentId` on the existing kinds.**
  Both satisfy the issue; the kinds win on a rolling deploy. A container built
  before this change looks an artefact up with `findUnique` on the four-column
  identity, which Prisma sends as a plain `WHERE` on those four columns. With the
  agent on a shared kind, that lookup could return a per-agent row, and the old
  container would rewrite it with the whole tenant's counts. With per-agent
  kinds it can only ever match the tenant-wide row of a kind it knows, and its
  withdrawal sweep skips kinds it does not know. The kinds also make the
  structural invariant expressible as a CHECK (`agent_scope`): a per-agent kind
  always has an agent and a tenant-wide kind never does. That is what lets a
  second CHECK refuse `AGENT_RETIRED` on any row without an agent, so "retirement
  leaves tenant-wide artefacts alone" is a property of the data.
- **The identity is `(tenant, control, kind, period, agent)` `NULLS NOT
  DISTINCT`, not a pair of partial unique indexes.** Postgres treats NULLs as
  distinct in a unique index by default, so with tenant-wide rows at `agentId
  NULL` the widened index would admit a second tenant-wide row per identity, the
  duplication the identity exists to prevent. `NULLS NOT DISTINCT` needs
  Postgres 15; production runs `postgres:16-alpine` and the test database is 16.
  A partial-index pair would say the same thing in two objects, neither visible
  to Prisma. Prisma cannot spell `NULLS NOT DISTINCT` either, but its schema
  diff does not model the clause, so `npm run db:check-schema-drift` reports no
  new drift. The compound unique input types `agentId` as a non-null string, so
  lookups are `findFirst`, which the index keeps to at most one row. The index
  is named explicitly (`AgenticEvidenceArtefact_identity_key`) because Prisma's
  default name would pass Postgres's 63-character limit.
- **Attribution is a server-side binding.** A receipt belongs to the agent its
  submitting key is bound to (`mcpKeyId` → `TenantApiKey.agentId`). That
  binding is ours and write-once in practice (no usecase re-binds a key; the
  retirement migration's trigger refuses a re-bind onto a retired agent), and it
  reaches every receipt already stored, so receipts needed no new column. A
  future re-bind verb would move past receipts' attribution with it, so it would
  have to stamp receipts at ingest first. Pipelock's own
  `agent_id` is not used: it is in the mediator's namespace, falls back to a run
  nonce, and on an unverified receipt, which the artefacts count, it is whatever
  the sender typed. Decisions carried nothing server-side that names an agent:
  `sessionRef` joins only runs, and the agent-proposal path's `inputDigest`
  collides when two agents propose the same payload. So `logAiDecision` stamps
  `ctx.agentId ?? null`, the convention every agentic write seam already uses,
  and the append-only trigger now includes the column, so a decision cannot be
  re-attributed. Rows written before this deploy stay unattributed, and the
  per-agent decision artefact for the deploy month counts from then.
- **`AiDecisionLog.agentId` has no foreign key.** The table survives a tenant
  purge and is in `NEVER_DML`. An FK to the purgeable register would either block
  the purge (NO ACTION) or need to rewrite a row the trigger keeps immutable (SET
  NULL), the bind `AiDecisionLog.aiSystemId` is already in. The kill-switch
  drill's synthetic agent id can also land there; the emitter plans only for ids
  the register holds. `AgenticEvidenceArtefact.agentId` does have a composite FK,
  CASCADE like the table's two other parents: no usecase hard-deletes a register
  row, and a tenant purge deletes the `Evidence` these rows are anyway.
- **One read, cut in memory.** The per-agent populations are partitions of the
  tenant-wide read, which now reads one row past its cap to know when it was
  bounded, then keeps the first `POPULATION_CAP` exactly as before. The
  attribution columns are read beside each fact and never put into one, and the
  facts are built member by member so a selected column cannot ride in through a
  spread. The unit suite pins the tenant-wide digests and body hashes to the
  values the pre-change builders produced on e81c933b2.
- **An agent gets an artefact when it has records, not for every register
  row.** Sources are append-only and a key's binding is write-once, so within a
  period the set of agents with records only grows. A zero artefact for every
  agent in the register would put register-size rows on every target control
  each month, and those rows would say nothing the tenant-wide zero does not.
- **Three refusals hold "nothing CURRENT for a retired agent".** The emitter
  plans in one transaction and writes each artefact in its own, so a retirement
  can commit in between. Without a guard, a write in that gap would either
  create a current artefact the cascade never saw or, on a changed digest, revive
  the row it had just withdrawn: the update branch revives a withdrawn artefact
  whose basis holds again. The refusals are:
  1. The plan skips RETIRED agents.
  2. Each per-agent write takes `FOR SHARE` on the agent row first and refuses a
     RETIRED or removed agent, the lock the retirement migration's triggers
     take. It comes before any Evidence row is touched, so the lock order
     matches retirement (agent, then artefact and Evidence) and the two cannot
     deadlock.
  3. A trigger refuses a CURRENT write of a per-agent row for a retired agent,
     from any writer.

  `AGENT_RETIRED` is also terminal in the write path, and the withdrawal sweep
  asks `AGENT_RETIRED` for open periods. That covers a retirement run by a
  rolled-back build that did not know the kinds, and any open-period rows beyond
  the cascade's 500-row cap.
- **"Open" means `periodEnd > now`** at the retirement instant. For monthly kinds
  that is the current month. The previous month's per-agent artefact is closed
  and stays as last emitted, the same staleness the tenant-wide kinds already
  have between a month's last tick and its end.
- **Withdrawal writes Evidence, then the artefact**, per row: the order the
  withdrawal sweep and the emitter's update branch take, so none of them can
  deadlock another on one row.
- **The emitter's file stays the only writer of the table.**
  `withdrawRetiredAgentEvidenceInTx` lives in `agentic-evidence-emission.ts` and
  carries no gate. Retirement is one act under `admin.agent_registry` (0e), and
  the emitter's `assertCanWrite` would add a gate nobody decided on.
- **Housekeeping item 4 was already done.** The unreachable second
  `return rows.map(...)` in `loadDecisionFacts` was removed by #3702
  (e1f80bae1) before this branch; the function is now `loadDecisionPopulation`
  and has one return.
- **Not changed: audit procedure E3** (`docs/agentic-audit-procedures.md`,
  adopted catalogue v1) recomputes `sourceDigest` with `sourcePopulationDigest`.
  For a per-agent artefact the recomputation is `perAgentPopulationDigest` over
  the facts attributed to its agent. Amending an adopted procedure is left to
  its owner. The pull request records it as an open question.
