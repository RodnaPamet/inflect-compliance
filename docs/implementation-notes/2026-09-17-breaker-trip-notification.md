# 2026-09-17 — A circuit-breaker trip tells somebody (#2562)

**Commit:** `<pending>` feat(agentic): ring the agent owner's bell when its circuit breaker trips

## Design

The behavioural circuit breaker is the only control in the agentic subsystem
that stops an agent with no human in the loop. Until this change it was also
the only one that announced nothing: `applyVerdict` in
`src/lib/agentic/circuit-breaker-store.ts` flipped the latch to `OPEN`, wrote
`trippedAt` / `trippedWindow` / `trippedSignals`, and returned. No
notification, and no `AuditLog` row either — while the human UN-trip
(`closeAgentCircuitBreaker`) is both audited (`AGENT_CIRCUIT_BREAKER_CLOSED`)
and metered.

That asymmetry matters because of where breaker state is rendered: one tab on
one agent's detail page, whose selection is local `useState`, reached from a
register that carries no breaker column and offers no deep link. So a latched
agent was visible only to somebody who had already opened that agent and
clicked to that tab — and the whole design premise of a manual un-trip is that
a human learns about the trip.

Almost none of this is new machinery. `src/app-layer/notifications/agentic.ts`
already had the emitter, the dedupe key, the recipient resolver and the
`createMany({skipDuplicates}) + publishNotificationEvent` bell/SSE path, with
two callers on it. This adds a third `NotificationType` member, its `COPY`
entry, and the call at the single trip site.

```
recordAuthorizedCall → evaluateWindow → applyVerdict
                                          │
                                          ├─ updateMany(where state:'CLOSED') → count
                                          │
                                          └─ count > 0 ? notifyBreakerTrip : nothing
                                                          │
                                                          ├─ resolveAgenticRecipients (agent's ownerUserId)
                                                          └─ createAgenticNotification(…, now)
```

Three things the shape is load-bearing about:

- **The gate is the UPDATE's `count`, not the verdict.** The latch write is
  conditional on `state: 'CLOSED'` so that a human close landing between the
  read and the write is not undone. That predicate means a real `TRIP` verdict
  can write zero rows — and a bell announcing a stop that did not happen is
  precisely the wrong thing to send about a stop control.
- **There is no actor.** `AgenticNotificationTarget.actorUserId` widened to
  `string | null`; the emitter's "never notify the actor" filter then excludes
  nobody. A sentinel string would have to be one no real `User.id` can equal.
- **`now` is threaded through** rather than left to the emitter's default, so
  the UTC day in the dedupe key is the day of `trippedAt`. With `entityId` set
  to the agent, day-granular dedupe plus the latch gives at most one bell per
  trip cycle: `recordAuthorizedCall` returns early while the latch is OPEN, so
  the next trip can only follow a human close.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/enums.prisma` | `AGENT_CIRCUIT_BREAKER_TRIPPED`, beside the other two agentic members |
| `prisma/migrations/20260917150000_agent_breaker_tripped_notification/migration.sql` | `ADD VALUE IF NOT EXISTS`, rolling-deploy safe; the schema/migration pair is what the fresh-DB drift gate checks |
| `src/app-layer/notifications/agentic.ts` | The kind, the `COPY` entry, and two widenings: `linkPath(slug, entityId)` and `actorUserId: string \| null` |
| `src/lib/agentic/circuit-breaker-store.ts` | `notifyBreakerTrip`, called from the TRIP branch only when the latch actually flipped |
| `tests/integration/agent-circuit-breaker-isolation.test.ts` | The bell assertions, and the fixture fix that makes the recipient one provable |

## Decisions

- **The link goes to the agent's detail page, not to the register.** The
  kill-switch bell links to `/t/{slug}/agents` because that is where you lift
  a kill switch. Breaker state appears nowhere on the register, so the same
  destination would land the recipient on a page that says nothing about what
  they were just told. `AgenticCopy.linkPath` therefore takes the entity id as
  well as the slug; the two existing entries ignore it.
- **The store looks the tenant slug up.** It runs at the MCP tool boundary and
  has no `RequestContext`, which is where the other two emitters get their
  slug. A miss yields a bell with no link rather than one pointing at
  `/t/undefined/agents/…`.
- **The body names the firing signals**, via a new optional `detail` on the
  target. `TOOL_MIX` is described in `integration-metrics.ts` as the
  rogue-agent shape; a bell that says only "something stopped" spends the
  recipient's trip to the page on finding out what.
- **The log fields at the catch are member reads, not bare identifiers**, and
  that is why `notifyBreakerTrip` takes an object. `local/no-raw-prompt-logging`
  counts a bare identifier at a value position as a HOLE in its own
  denominator, and `tests/guards/no-raw-prompt-logging.test.ts` ratchets that
  count downward with no allowance — the first draft of this function raised
  it from 143 to 145.
- **The fixture had to be fixed before the test could fail.** The suite's
  agent owner and its tenant's only ACTIVE `OWNER` were the same user, so both
  arms of `resolveAgenticRecipients` produced an identical recipient list and
  any assertion about who was told would have passed under either. Each tenant
  now seeds two people and the agent is owned by the EDITOR.
- **No i18n, and no new preference surface.** Notification titles and bodies
  are English literals written at emit time and stored on the row, and
  `/admin/notifications` derives its in-app catalogue from this module's own
  `COPY` (#2564) while the PUT validates against `z.nativeEnum(NotificationType)`
  — so the new type reaches the preference page and the mute list by the same
  edit, with no client change.
- **Not folded in:** `recordAgentBreakerTrip` in
  `src/lib/observability/integration-metrics.ts` still has no call site, so the
  critical alert on `circuit_breaker.trip` that `tests/unit/epic19-coherence.test.ts`
  documents still cannot fire. It is a one-liner at this same site and a
  distinct defect; #2562 scopes this change to the notification.
