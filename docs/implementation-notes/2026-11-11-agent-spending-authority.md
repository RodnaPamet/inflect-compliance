# 2026-11-11 — Spending authority on the agent register (Agent Pay Phase 1)

**Commit:** `feat(agentic): declared, four-eyes-reviewed spending authority on the agent register`

Phase 1 of `docs/ai-architecture/mastercard-agent-pay.md`, under owner decisions
D-L1-8 (Inflect never holds a payment credential) and D-L1-9 (spending authority
is a declared, reviewed privilege on the register). This is a SIGNIFICANT change:
it carries a schema migration and a new trigger on `RegisteredAgent`.

## Design

```
declare / widen ──► AgentSpendingAuthority (DECLARED, declaredBy, ownerAtDeclaration)
                         │  activation refused: usecase SPENDING_AUTHORITY_UNREVIEWED
                         │                      + trigger on RegisteredAgent
                         │  declared on an ACTIVE agent ──► HIGH finding (no suspension)
review (2nd person) ─────▼
                     REVIEWED ── narrow (1 person, stays REVIEWED; trigger refuses wider)
                         │       withdraw (1 person) ──► WITHDRAWN
AGENT-scope kill / ──────▼
orphan containment   SUSPENDED_REQUESTED  + task "suspend the token at <requestor>"
                         │                  (after commit, as the tenant SYSTEM user)
lifting the kill ────────┘ reverses nothing; re-declaring starts at DECLARED again
```

The envelope is one row per agent per rail: per-transaction limit and period
budget (minor units, `BigInt`), period, currency, merchant domains and MCCs
(both empty = UNRESTRICTED), expiry, the consenting member, the token requestor
(agent platform) and its own reference for the token. It is a declaration to
review, never a grant Inflect enforces at payment time.

Each rule is held twice, usecase first and database behind it:

| Rule | Usecase | Database |
| --- | --- | --- |
| Reviewer is a second person | `REVIEWER_IS_DECLARER`, `REVIEWER_IS_OWNER` (then or now), `REVIEWER_NOT_A_PERSON` (API key, agent, job) | CHECK `AgentSpendingAuthority_not_self_reviewed` (declarer, owner at declaration) |
| A reviewed envelope widens only by a new declaration | `narrow…` refuses `NOT_A_NARROWING` naming the fields | trigger `agent_spending_authority_lifecycle` refuses `SPENDING_AUTHORITY_WIDENING_NEEDS_REVIEW` |
| A review approves exactly the declaration it read | compare-and-swap on status, stamps and every envelope field; no match is `DECLARATION_CHANGED` | the envelope's row lock, and the predicate re-evaluated under READ COMMITTED |
| No activation while unreviewed (DECLARED, or SUSPENDED_REQUESTED never reviewed) | `assertActivatable` refuses `SPENDING_AUTHORITY_UNREVIEWED` with the rails | trigger `registered_agent_spending_authority_reviewed` |
| No card number in a free-text value | `IDENTIFIER_CARRIES_CARD_NUMBER` for both identifiers and every merchant domain, plus `looksLikeSecret` on the identifiers | CHECKs `AgentSpendingAuthority_identifiers_carry_no_card_number`, `AgentSpendingAuthority_merchant_domains_carry_no_card_number` |
| Never for a retired agent | `AGENT_RETIRED` | insert trigger, FOR SHARE, `AGENT_RETIRED:` prefix |

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma`, `enums.prisma`, `auth.prisma` | The model, three enums, back-relations |
| `prisma/migrations/20261111230000_agent_spending_authority/migration.sql` | Table, CHECKs, two triggers, grants, RLS |
| `src/lib/agentic/spending-authority.ts` | Pure: input schema, `wideningsOf`, `carriesCardNumberShape` (client-safe) |
| `src/app-layer/usecases/agent-spending-authority.ts` | The only writer: declare, narrow, review, withdraw, list; activation read; kill hook and suspension tasks |
| `src/app-layer/usecases/agent-registry.ts` | `assertActivatable` asks the new precondition |
| `src/app-layer/usecases/agent-kill-switch.ts` | AGENT-scope kill and OWNER_DEPARTED kill move envelopes and open tasks |
| `tests/guards/agent-harness-single-write-seam.test.ts` | One write seam for the new table |
| `tests/guardrails/tenant-isolation-forward-lock.test.ts` | `ISOLATION_TESTED` entry; the integration test carries the two-tenant cases |
| `tests/guardrails/schema-index-coverage.test.ts` | Layer C triage entry |
| `docs/data-retention.md` | Inventory row (Business record) |

## Decisions

- **One row per agent per rail, not a version table.** A widening re-stamps the
  declaration on the same row and clears the review; history lives in the
  hash-chained `SPENDING_AUTHORITY_*` audit rows. A version table (the
  agent-profile shape) would make "the envelope in force" a pointer chase for
  every reader for no gain: the envelope has no run that pins it.
- **The reviewer names the declaration it read** (`declaredAt`), the profile
  approval's hash idea, so a review never lands on an envelope re-declared
  while the reviewer was reading (`DECLARATION_CHANGED`). Checking that against
  a plain read is not enough: the agent lock is `FOR SHARE`, which a concurrent
  re-declaration also takes, so the two never serialise on it, and an
  `UPDATE … WHERE id` that waited on the re-declaration's row lock would apply
  to the committed, wider row. So the review's write is a compare-and-swap
  (`updateMany`) on the status, the declaration stamps and every envelope field
  as read; after the wait Postgres re-evaluates that predicate against the new
  row version, it matches nothing, and the review writes nothing. Matching the
  envelope and not only `declaredAt` covers a re-declaration in the same
  millisecond. The integration test holds a re-declaration's row lock open
  while the review queues behind it.
- **What counts as a narrowing** is defined once in `wideningsOf` and mirrored by
  the trigger: no larger amount, no later expiry, the same currency, period,
  consenter, token requestor and reference, and a merchant scope inside the old
  one. Clearing a restricted scope is a WIDENING (empty means unrestricted).
  Changing the period is always a widening, because the two are not comparable.
- **The card-number rule here is a digit-run rule, not a Luhn check.** Phase 0
  adds the Luhn card-number shape to `firstSecretShapedMember` on a parallel
  branch, and this change does not duplicate it. The two identifiers are names
  and references and never need 13 digits in a row, so any run of 13+
  (separators ignored) is refused, Luhn-valid or not. The merchant domains are
  free text too (a host-name label may be all digits), so each is held to the
  same rule; their CHECK joins the array with a letter, which survives the
  separator strip, so digits ending one domain and starting the next are not
  read as one run. The usecase also calls
  the harness contract's `looksLikeSecret`, so a credential shape is refused
  today, and the Luhn card shape too if Phase 0 places it in `looksLikeSecret`.
- **The token reference is never in an audit row.** It is an identifier at a
  third party and the audit trail streams to the tenant's SIEM. It IS in the
  suspension task, because naming it is the task's whole purpose; the task
  description is encrypted at rest.
- **Activation race.** The declaration takes `FOR SHARE` on the agent row (the
  usecase's `lockLifecycleStateForShare` and the insert trigger), so a
  concurrent activation's UPDATE waits and its trigger then reads the committed
  DECLARED row. In the other order the declaration reads ACTIVE and raises the
  HIGH finding. No interleaving leaves an ACTIVE agent with an unreviewed
  envelope and no finding.
- **A TENANT-scope kill moves no envelope.** It names no agent, and fanning it
  out to every envelope in the workspace is a decision nobody has taken. The
  suspension task is opened after the kill commits, as the tenant SYSTEM user
  (#4400), assigned to the agent's owner and falling back to no assignee; a
  task failure never fails the kill.
- **The review or a withdrawal closes the widened-on-active finding.** Each
  is positive evidence that the condition the finding names — unreviewed
  authority on an agent in service — has ended. A narrowing does not close it
  (a narrowed DECLARED envelope is still unreviewed), and neither does a kill:
  the kill only REQUESTS that a person suspend the token, so until the
  envelope is withdrawn or re-declared and reviewed the authority may still be
  live.
- **A kill does not launder an unreviewed envelope.** A kill moves DECLARED and
  REVIEWED envelopes to SUSPENDED_REQUESTED, and lifting it reverses nothing.
  Read as "only DECLARED is unreviewed", that let one person who holds both the
  register and the kill-switch keys declare, kill, lift and activate. So the
  activation precondition and its trigger read "unreviewed" as DECLARED, or
  SUSPENDED_REQUESTED with no review stamp (`reviewedAt IS NULL`); the way out
  is to withdraw it, which one person may always do. A reviewed envelope a kill
  suspended does not hold activation back: two people agreed to it.
- **Audit payloads are named at the sink.** The envelope is written out field
  by field in each `logEvent` rather than spread from a helper, so
  `local/no-raw-prompt-logging` can read every name reaching the hash-chained
  trail, and this file adds no unanalysable position to that guard's census.

## Risk assessment

- **Hot-table trigger.** `registered_agent_spending_authority_reviewed` fires
  on `UPDATE OF status` on `RegisteredAgent` only, and runs an indexed EXISTS
  only when the new status is ACTIVE and the old one was not. No other update
  of the table pays for it.
- **Rolling deploy.** Forward-only and additive: three new enum types, one new
  table, one new trigger. The previous image never writes the new table, so for
  it the new trigger can never fire. No enum value is added to an existing type.
- **Kill-switch path change.** `engageKillSwitch` and `engageOwnerDepartedKill`
  now update the new table inside the kill's transaction. For an agent with no
  envelope that is one indexed read returning nothing. Their existing
  integration suites (`agent-kill-switch`, `agent-owner-orphan-pass`) pass.
- **Activation path change.** One more indexed read in `assertActivatable`;
  agents with no envelope are unaffected (`auditor-independence`,
  `agent-risk-tier-gates`, `agent-registration-intake`,
  `agent-retirement-cascade` suites pass).
- **PCI scope.** No column can hold a PAN or a token value; the change keeps
  Inflect outside cardholder-data scope (D-L1-8).

## Rollback plan

- **Application:** redeploy the prior image. The prior image never reads or
  writes `AgentSpendingAuthority`. The one behaviour that survives an app
  rollback is the trigger on `RegisteredAgent`, which can refuse an activation
  only while an unreviewed row (DECLARED, or SUSPENDED_REQUESTED never
  reviewed) exists; no row can exist unless this image wrote
  one, and a person can still withdraw it directly.
- **Database:** forward-fix, never revert (`docs/change-management-policy.md`).
  If the trigger on `RegisteredAgent` misbehaves, the forward fix is a migration
  that runs `DROP TRIGGER IF EXISTS registered_agent_spending_authority_reviewed
  ON "RegisteredAgent"`; the table can stay, inert, until the next release.

## Not built in this slice

- **1.4** — the recertification pack's spending-authority section and a
  narrowing that proposes reducing or withdrawing the envelope.
- **1.6** — the governance pack inventory row (the retention row is written).
- The API routes and the register page section that call the writer; routes
  would sit under `/api/t/:slug/admin/agents/[agentId]/spending-authority` with a
  literal `requirePermission('admin.agent_registry')`.
- The retirement cascade does not yet touch envelopes (the insert trigger
  refuses a new one on a RETIRED agent); a declaration while an AGENT kill is
  already in force is accepted as DECLARED rather than immediately
  SUSPENDED_REQUESTED.
