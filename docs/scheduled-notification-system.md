# Scheduled Notification System

End-to-end architecture for periodic background monitoring and grouped notification dispatch.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SCHEDULER LAYER                                   │
│  BullMQ Worker / Vercel Cron / node-cron / CLI                          │
│  scheduler.ts → executorRegistry.execute('notification-dispatch', {})    │
└─────────────────────┬───────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATION JOB                                    │
│  notification-dispatch.ts                                               │
│  Runs all monitors → feeds output to digest dispatcher                  │
└──────┬──────────────┬──────────────┬────────────────────────────────────┘
       │              │              │
       ▼              ▼              ▼
┌──────────┐  ┌──────────────┐  ┌──────────────┐
│ deadline │  │  evidence    │  │   vendor     │
│ monitor  │  │  expiry      │  │   renewal    │
│          │  │  monitor     │  │   check      │
│ Controls │  │ Evidence     │  │ Vendors      │
│ Policies │  │ retentionAt  │  │ contractAt   │
│ Tasks    │  │ expiredAt    │  │ nextReview   │
│ Risks    │  │              │  │              │
│ TestPlans│  │              │  │              │
└──────┬───┘  └──────┬───────┘  └──────┬───────┘
       │             │                 │
       └──────┬──────┘                 │
              │                        │
              ▼                        ▼
       ┌──────────────────────────────────┐
       │       DueItem[] (normalized)     │
       └──────────────┬───────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    DIGEST DISPATCHER                                     │
│  digest-dispatcher.ts                                                   │
│                                                                          │
│  1. Group DueItems by tenantId → ownerUserId                            │
│  2. Resolve owner emails (batch User query)                             │
│  3. Route unowned items to tenant admins                                │
│  4. Build digest template per owner                                     │
│  5. Enqueue via NotificationOutbox (with dedupeKey)                     │
└──────────────────────┬──────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 NOTIFICATION OUTBOX                                       │
│  NotificationOutbox table (Prisma)                                      │
│  status: PENDING → SENT | FAILED                                        │
│  dedupeKey: unique (prevents duplicate sends)                           │
│  processOutbox.ts claims due PENDING rows (with a lease) and sends via  │
│  sendEmail()                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

## Monitoring Jobs

| Job | Schedule | Entity Types | Date Fields |
|-----|----------|-------------|-------------|
| `deadline-monitor` | 07:00 UTC | Control, Policy, Task, Risk, TestPlan | `nextDueAt`, `nextReviewAt`, `dueAt` |
| `evidence-expiry-monitor` | 06:00 UTC | Evidence | `retentionUntil`, `expiredAt` |
| `vendor-renewal-check` | 07:00 UTC | Vendor | `nextReviewAt`, `contractRenewalAt` |
| `notification-dispatch` | 07:30 UTC | (orchestrator — runs all above) | — |

### Urgency Classification

All monitors classify items into three urgency levels:

| Urgency | Condition | Emoji |
|---------|-----------|-------|
| `OVERDUE` | `daysRemaining < 0` | 🔴 |
| `URGENT` | `daysRemaining ≤ 7` | 🟡 |
| `UPCOMING` | `daysRemaining ≤ 30` | 🟢 |

Detection windows are configurable via job payload:
```json
{ "windows": [30, 7, 1] }
```

## Owner-Grouping Rules

1. **Group by tenant** — all queries are tenant-isolated
2. **Group by ownerUserId** — items with the same owner become one digest
3. **Unowned items → tenant admins** — items without an `ownerUserId` are sent to users with `ADMIN` or `OWNER` role
4. **One email per owner per category per day** — deduplication prevents duplicate sends

### Recipient Resolution

```
DueItem.ownerUserId → User.email  (batch query)
                     ↓ if null
tenantId → TenantMembership(ADMIN|OWNER) → User.email
```

## Digest Categories & Templates

| Category | Template | Subject Pattern |
|----------|----------|-----------------|
| `DEADLINE_DIGEST` | `buildDeadlineDigestEmail` | "🔴 Compliance Deadline Digest: N item(s) need attention" |
| `EVIDENCE_EXPIRY_DIGEST` | `buildEvidenceExpiryDigestEmail` | "⚠️ Evidence Expiry Alert: N item(s) expiring" |
| `VENDOR_RENEWAL_DIGEST` | `buildVendorRenewalDigestEmail` | "🔴 Vendor Renewal Alert: N vendor(s) need attention" |

All templates:
- Render an HTML table with urgency badges, entity types, names, and reasons
- Include tenant-scoped links to the relevant dashboard page
- Escape all user-supplied content (XSS-safe)
- Include both HTML and plain-text versions

### Template Extensibility

To add a new digest category:
1. Add enum value to `EmailNotificationType` in `prisma/schema/enums.prisma`
2. Add payload interface + builder in `digest-templates.ts`
3. Add case to `buildDigestEmail()` in `digest-dispatcher.ts`
4. Add monitor job if scanning a new entity type

## Deduplication / Reminder Strategy

### Mechanism
- **Dedupe key format**: `{tenantId}:{category}:{email}:digest:{YYYY-MM-DD}`
- **Enforcement**: `NotificationOutbox.dedupeKey` has a unique constraint
- **Behavior**: The enqueue is `createMany({ skipDuplicates: true })` — `ON CONFLICT DO NOTHING` — so a digest already enqueued today is skipped without an error. It is never a caught `P2002`: inside an interactive transaction a unique violation aborts the whole transaction, so one duplicate would have rolled back every other write in it (#5061)

### Sending exactly once

`processOutbox` claims a row before sending it, and the claim is also a lease
(#5110): it requires `sendAfter <= now` and moves `sendAfter` forward by
`OUTBOX_CLAIM_LEASE_MS` (15 minutes), in the same conditional update that bumps
`attempts`. The drain only reads rows whose `sendAfter` has passed, so a row
mid-send is invisible to every other pass — the next scheduled tick or an admin
pressing "Process Outbox" — and refused by every other claim. Success marks the
row SENT; a failure puts `sendAfter` back to the value the pass read, so the row
is due again on the next pass, and that write is conditional on the attempts
value this pass's claim wrote, so it cannot release a lease another pass took
after this one's expired.

### Implications
- **Same day, same recipient, same category** → exactly one email
- **Next day** → new dedupe key → new email (daily reminder)
- **Re-running the scheduler** → safe (idempotent — duplicates are skipped)
- **Multiple scheduler instances** → safe (unique constraint is database-level)

### Customization Points
- To change reminder frequency: adjust the date granularity in `buildDigestDedupeKey()`

See [Future work](#future-work) for reminder suppression and per-user delivery preferences.

## File Map

```
src/app-layer/
├── jobs/
│   ├── types.ts                    # DueItem, JobPayloadMap, urgency types
│   ├── schedules.ts                # Cron schedules for all jobs
│   ├── executor-registry.ts        # Job dispatch registry
│   ├── deadline-monitor.ts         # Control/Policy/Task/Risk/TestPlan scanner
│   ├── evidence-expiry-monitor.ts  # Evidence retention/expiry scanner
│   ├── vendor-renewal-check.ts     # Vendor review/renewal scanner
│   └── notification-dispatch.ts    # Orchestrator: monitors → dispatcher
├── notifications/
│   ├── digest-templates.ts         # HTML/text templates for digest emails
│   ├── digest-dispatcher.ts        # Owner grouping + outbox enqueue
│   ├── enqueue.ts                  # Single-item outbox enqueue (existing)
│   ├── processOutbox.ts            # PENDING → SENT/FAILED processor (existing)
│   ├── settings.ts                 # Tenant notification settings (existing)
│   ├── templates.ts                # Single-item templates (existing)
│   └── index.ts                    # Barrel exports (existing)
└── services/
    └── vendor-renewals.ts          # Legacy vendor due detection (reused)

tests/
├── unit/
│   ├── periodic-monitors.test.ts   # 35 tests — monitor detection logic
│   ├── notification-dispatch.test.ts # 25 tests — dispatch + templates
│   └── scheduler-foundation.test.ts  # 31 tests — scheduler infra
└── integration/
    └── bullmq-scheduler.test.ts    # 10 tests — BullMQ integration
```

## Operational Visibility

Every job returns a typed `JobRunResult` with:
- `itemsScanned` / `itemsActioned` / `itemsSkipped`
- `durationMs`
- `details` with per-category breakdown

The `notification-dispatch` job logs:
```json
{
  "component": "notification-dispatch",
  "items": 12,
  "enqueued": 3,
  "skipped": 1
}
```

## Future work

These customization hooks are designed but not yet implemented in the dispatch
path — the backing tables exist (with RLS), but nothing in
`src/app-layer/notifications/` or `src/app-layer/jobs/` reads them yet:

- **Reminder suppression** — check `ReminderHistory` before enqueue to suppress
  repeat reminders entirely.
- **Per-user delivery preferences** — check `UserNotificationPreference.delivery`
  to honour per-user channel/opt-out choices.
