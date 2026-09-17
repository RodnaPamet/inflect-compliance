# 2026-09-17 — the agentic bell for a risk assessment going stale

**Issue:** #2563 — "A risk assessment going stale tells nobody — the transition
writes an audit row and stops."

The fifth and last of the five agentic notification types the AGENTIC UI 1/4
prompt named. `AGENT_KILL_SWITCH_ENGAGED` and `AGENT_PROPOSAL_QUARANTINED`
shipped with #2477, `AGENT_CIRCUIT_BREAKER_TRIPPED` with #2583 and
`AGENT_TOOL_MANIFEST_PIN_CHANGED` with #2591. This is the third member added in
one day, so the procedure is settled rather than discovered — the two migrations
beside this one are the worked examples it follows.

## Design

`reassessAgentAfterChangeInTx` already isolates the exact event. It runs inside
the transaction of every amendment and every tool grant, re-scores the tier from
the answers on file, stamps or clears `staleAt`, and then — guarded by
`verdict.stale && !alreadyStale` — writes an `AGENT_ASSESSMENT_STALE` audit row.
That branch is the TRANSITION into staleness, and it was the whole response to
it. A grep for `/notif/i` over the file returned nothing.

Everything a notification needs was already computed at that point: the verdict
carries one human-readable line per trigger (`dataAccessScope READ_TENANT_DATA →
EXTERNAL_EGRESS`), `RegisteredAgent.ownerUserId` is NOT NULL behind a real FK,
and `resolveAgenticRecipients` is the helper that reads it. So the change is one
enum member, one `COPY` entry and an emit at a branch that already existed.

```
updateRegisteredAgent / grantAgentTool          (already in a tenant tx)
  └─ reassessAgentAfterChangeInTx
       ├─ rescoreAgainstStandingAnswers          tier narrows NOW
       ├─ setStaleness(staleAt, triggers)
       └─ if (verdict.stale && !alreadyStale)    ← the transition
            ├─ logEvent  AGENT_ASSESSMENT_STALE  (was the only response)
            └─ try { createAgenticNotification } catch { logger.warn }   ← new
```

**What the bell claims is deliberately narrow.** The tier is re-scored in the
same transaction, so the ceiling has already narrowed and nothing is running at
an authority a fresh score would refuse. What may no longer hold are the twenty
questionnaire ANSWERS — a judgement a human made about a narrower agent than the
one now registered. The bell WARNS; it never denies. That is also why the link
is the agent's own detail page: the stale notice, the triggers and the re-assess
action are all on its Risk tab, and the register carries no staleness column.

**Best-effort, inside the tenant transaction**, the same shape and the same
reasoning as `agent-kill-switch.ts` and `mcp-tool-manifest.ts`. `Notification`
is RLS-scoped so the write needs the bound client; `createMany({ skipDuplicates:
true })` is the one write shape that cannot throw P2002 and poison an open
transaction; the catch is unconditional because an amendment that failed on a
bell being down is the wrong failure mode for a warning.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/enums.prisma` | `AGENT_RISK_ASSESSMENT_STALE`, declared before `GENERAL` beside the other four agentic members |
| `prisma/migrations/20260917170000_agent_risk_assessment_stale_notification/migration.sql` | `ADD VALUE IF NOT EXISTS … BEFORE 'GENERAL'` |
| `src/app-layer/notifications/agentic.ts` | fifth `AgenticNotificationKind`, fifth `COPY` entry, module docblock |
| `src/app-layer/usecases/agent-risk-assessment.ts` | the emit, inside the existing transition branch |
| `tests/guardrails/enum-member-order-matches-migrations.test.ts` | the member added to both pinned `NotificationType` sequences |
| `tests/integration/agent-widening-reassessment.test.ts` | a second seeded user, and four cases over the real database |

## Decisions

- **`BEFORE 'GENERAL'`, not a plain `ADD VALUE`.** Plain `ADD VALUE` appends LAST
  in migration order while the schema declares the member mid-list, which puts
  one member in two slots and widens `NotificationType`'s signed-off drift.
  Mutation-proved: strip the `BEFORE` clause and
  `enum-member-order-matches-migrations` goes red naming exactly this member,
  `- "AGENT_RISK_ASSESSMENT_STALE"` before `GENERAL` against
  `+ "AGENT_RISK_ASSESSMENT_STALE"` at the end.

- **The `SIGNED_OFF` snapshot is EXTENDED, not the registry.** Both arrays are
  verbatim pins, so a legitimately placed member has to appear in both in the
  slot the statement gives it. That is maintenance of an existing entry — not
  signing off a new enum, which the guard's docblock rules out in terms.

- **`entityId` is the AGENT, not the assessment run.** It is what the link
  resolves to, and it is the right thing for the day-granular dedupe key to
  collapse on. The cost is named rather than hidden: an operator who re-assesses
  and re-widens the same agent on the same UTC day is told once.

- **The transition guard and the dedupe key OVERLAP, and the test says so.**
  Within one UTC day, dropping `&& !alreadyStale` writes no second row anyway —
  the dedupe key collapses it. So a second widening asserted naively is green
  whether the guard is there or not. The case ages the stored row's dedupe key
  by a day first, which is exactly the state the database is in after midnight,
  and only then is the guard the thing under test. Measured: unaged the mutation
  survives; aged it reddens, and reddens nothing else.

- **The suite needed a SECOND person before any of this was provable.** `USER`
  was the actor, the agent's owner and the workspace's only ACTIVE OWNER, so
  both recipient arms resolved to the actor, the actor was filtered out, and
  every assertion about who was told passed with the emitter deleted. The agent
  is now owned by an EDITOR, so a bell addressed there could only have come from
  the accountable-owner arm.

- **The mute is asserted THROUGH the derivation, not around it.**
  `listInAppNotificationTypes()` derives the `/admin/notifications` catalogue
  from this module's own `COPY`, so a test that fixtures that catalogue agrees
  with production by construction and proves nothing. What is asserted instead
  is that a stored mute stops the WRITE — with an unmuted positive control in
  the same case, because a zero is satisfied by an emitter that never fires.

- **No `/admin/notifications` change, and no i18n change.** The preference page
  picks the type up with no client edit because its catalogue is derived from
  `COPY`. The bell's `title`/`message` are stored English literals written at
  emit time, which `next-intl` cannot reach at render, and the i18n ratchet's
  scope excludes `src/app-layer` entirely.

- **No enum-presence guard was added.** The shape used by
  `tests/guards/notif-assignment-alerts-wiring.test.ts` reads the schema whole
  and slices it, which books an interior span against the span-reach ratchet and
  a whole-file read against the needle-uniqueness ratchet — both at
  `DRIFT_ALLOWANCE` 0. The migration is proof the member exists; the integration
  cases are proof it is emitted. All eight zero-allowance budgets come out
  unchanged: 1428 / 239 / 1448 / 147 / 332 / 57 / 379 / 289.
