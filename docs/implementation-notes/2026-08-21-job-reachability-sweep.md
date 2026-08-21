# 2026-08-21 — Job reachability sweep

**Branch:** `chore/job-reachability-sweep` (investigation only — no source changed)

Three separate items in one night found a capability that exists, is tested, and
is called by nothing in production:

  - `reconcileIdentityAccountLinks` had no production caller, so
    `IdentityAccountLink.lastVerifiedAt` was never written and the leaver
    candidate set was permanently empty. A leaver pass shipped on top would have
    run, reported success, and disabled nobody. *(Since fixed —
    `src/app-layer/jobs/identity-sync.ts:121` now calls it.)*
  - `EntraIdDirectoryWriter.preflight()` — written, tested, called by nothing.
  - `av-rescan` — registered in the executor registry, enqueued by nothing.

Three is a pattern, so this is the sweep.

---

## Denominator statement — read this before the tables

**A sweep keyed on one marker reports full coverage of the things carrying that
marker and is silent about everything else.** That is the failure mode this
document is trying not to reproduce, so every population below is named with
the exact command that produced it, and the populations are diffed against each
other rather than trusted individually.

| # | Population | How it was enumerated | Count |
|---|---|---|---|
| E1 | Registry entries | `grep -oE "executorRegistry\.register\('[a-z0-9-]+'" src/app-layer/jobs/executor-registry.ts` | **54** |
| E2 | `JobPayloadMap` keys | `awk '/export interface JobPayloadMap/,/^}/' src/app-layer/jobs/types.ts` | **54** |
| E3 | `JOB_DEFAULTS` keys | `awk '/export const JOB_DEFAULTS/,0' src/app-layer/jobs/types.ts` | **54** |
| E4 | `SCHEDULED_JOBS` | `grep -oE "^\s+name: '[a-z0-9-]+'" src/app-layer/jobs/schedules.ts` | **31** |
| E5 | `enqueue()` targets | `grep -rn -A3 "enqueue(" src/ scripts/` + hand-reading every multi-line call | **18** |
| E6 | `runJob('...')` names | `grep -rn "runJob(" src/` | **24** |

The task brief said "for every job registered in `executor-registry.ts`". That
is E1, and **E1 is not the right denominator** — see the E6 diff below. The
tables that follow answer the brief's question over E1, and then a second
section answers the same question over E6 \ E1, which is where the worst finding
of the sweep lives.

### Diff between the enumeration methods

- **E1 ≡ E2 ≡ E3** — all three are exactly the same 54 names, both directions,
  no drift. That is a genuinely healthy result and it is *why* a registry-keyed
  sweep feels complete: three independent-looking lists agree perfectly. They
  agree because they are three views of one hand-maintained list, so their
  agreement measures internal consistency, not coverage.
- **E4 ⊂ E1** — all 31 scheduled names are registered; `E4 \ E1 = ∅`. The
  `scheduler.validateRegistrations()` helper checks exactly this direction, and
  it is itself never called in production (`grep -rn "validateRegistrations"
  src/ scripts/` → declaration only). It checks the direction that was already
  fine.
- **E5 ⊂ E1** — `E5 \ E1 = ∅`. 18 of the 54 registered jobs are dispatched by
  an `enqueue()` call somewhere; the other 36 are either scheduled (31) or not
  dispatched at all (5).
- **E6 \ E1 = 9 names.** This is the one that changes the answer:

  ```
  calendar-deadlines            evidence-stale-review-sweep
  library-sync-all              library-sync-one          library-sync-urn
  purge-expired-evidence        purge-soft-deleted        retention-sweep-all
  vendor-reassessment-reminder
  ```

  These are functions wrapped in the `runJob()` observability harness — they
  emit job metrics, they log as jobs, they read as jobs — but they carry no
  `JobPayloadMap` entry and no registry entry. **A sweep keyed on the registry
  cannot see them at all.** Three of the nine (`purge-*`, `retention-sweep-all`)
  are internal stages of the scheduled `data-lifecycle` job and are fine; one
  (`vendor-reassessment-reminder`) is called by the scheduled `vendor-monitoring`
  job and is fine; **five are not reachable in production** and are listed in
  the priority section.

### Blind spots of the enumeration that produced E5

A literal `enqueue('name')` grep is **not** sufficient. One call site passes the
job name as a variable:

```
src/app-layer/jobs/cloud-posture-collect-dispatch.ts:60
const POSTURE_JOB_BY_PROVIDER: Record<string, JobName> = {
    'aws-posture': 'aws-posture-collect',
    'azure-posture': 'azure-posture-collect',
    'gcp-posture': 'gcp-posture-collect',
};
```

so `aws-posture-collect` / `azure-posture-collect` / `gcp-posture-collect` have
**zero** literal `enqueue('…')` call sites and are nonetheless fully reachable.
A grep-only sweep would have filed three false positives. To bound this, I
enumerated every dynamic use of the `JobName` type
(`grep -rn "JobName" src/ scripts/` minus the jobs infrastructure files): there
are exactly two — the table above, and `scripts/worker.ts:203`
(`job.name as JobName`, the consumer side). So literal names **plus that one
table** is a complete enumeration of dispatch targets.

Other paths checked and found empty, so they are not hiding anything:

- `queue.add(...)` outside `queue.ts` — none.
- `scheduler.runOnce(...)` / `scheduler.runAll()` / `scheduler.tick()` — no
  production caller. There is no Vercel-cron route and no `src/app/api/cron/**`.
- A generic "run any job" admin route — none. The one manual trigger,
  `POST /api/t/[tenantSlug]/notification-settings/run-job`, accepts exactly two
  hard-coded `jobType` values (`processOutbox`, `dailySweep`) and calls the
  underlying functions directly, bypassing the registry entirely.
- Schedules are registered from **two** entry points (`scripts/scheduler.ts:112`
  and `scripts/worker.ts:169`), so a running worker implies the 31 repeatables
  exist. The scheduled column is not dependent on a deploy step being run.

---

## Classification — all 54 registered jobs

`SCHEDULED` = a `SCHEDULED_JOBS` entry in `schedules.ts`, registered as a BullMQ
repeatable at worker boot. `JOB→JOB` = enqueued by another job (the dispatcher
in every case is itself scheduled). `ROUTE` / `USECASE` = enqueued from a
request-driven path. `REGISTERED-ONLY` = the registry entry is never dispatched,
though the underlying function is called directly by something else.
`UNREACHABLE` = nothing in production reaches it by any route.

| Job | Class | Production path |
|---|---|---|
| access-review-overdue-escalation | SCHEDULED | `schedules.ts` `15 4 * * *` |
| access-review-reminder | SCHEDULED | `schedules.ts` `0 4 * * *` |
| automation-event-dispatch | USECASE | `automation/bus-bootstrap.ts:58`; `usecases/automation-executions.ts:278`; `jobs/schedule-trigger-sweep.ts:213` |
| **av-rescan** | **UNREACHABLE** | — |
| automation-runner | SCHEDULED | `schedules.ts` `*/15 * * * *` |
| aws-posture-collect | JOB→JOB | `jobs/cloud-posture-collect-dispatch.ts:118` (via `POSTURE_JOB_BY_PROVIDER`) |
| azure-posture-collect | JOB→JOB | same |
| calendar-push-dispatch | SCHEDULED | `schedules.ts` `0 3 * * *` |
| calendar-push-tenant | JOB→JOB | `jobs/calendar-push.ts:81` |
| cloud-posture-collect-dispatch | SCHEDULED | `schedules.ts` `20 1 * * *` |
| compliance-digest | SCHEDULED | `schedules.ts` `0 8 * * 1` |
| compliance-posture-summary | JOB→JOB | `jobs/compliance-posture-summary.ts:107` |
| compliance-posture-summary-dispatch | SCHEDULED | `schedules.ts` `30 5 * * *` |
| compliance-snapshot | SCHEDULED | `schedules.ts` `0 5 * * *` |
| control-test-runner | JOB→JOB | `jobs/control-test-scheduler.ts:440` |
| control-test-scheduler | SCHEDULED | `schedules.ts` `*/5 * * * *` |
| daily-evidence-expiry | SCHEDULED | `schedules.ts` `0 6 * * *` |
| data-lifecycle | SCHEDULED | `schedules.ts` `0 3 * * *` |
| dau-mau-aggregator | SCHEDULED | `schedules.ts` `*/5 * * * *` |
| deadline-monitor | REGISTERED-ONLY | fn called by `jobs/notification-dispatch.ts:124` |
| evidence-expiry-monitor | REGISTERED-ONLY | fn called by `jobs/notification-dispatch.ts:163` |
| evidence-import | ROUTE | `api/t/[tenantSlug]/evidence/imports/route.ts:143` |
| exception-expiry-monitor | SCHEDULED | `schedules.ts` `30 4 * * *` |
| gcp-posture-collect | JOB→JOB | `jobs/cloud-posture-collect-dispatch.ts:118` (via table) |
| **health-check** | **UNREACHABLE** | — (diagnostic; see priority list) |
| hris-sync | JOB→JOB | `jobs/hris-sync.ts:81` |
| hris-sync-dispatch | SCHEDULED | `schedules.ts` `0 4 * * *` |
| identity-leaver-dispatch | SCHEDULED | `schedules.ts` `0 5 * * *` |
| identity-leaver-pass | JOB→JOB | `jobs/identity-leaver.ts:88` |
| identity-sync | JOB→JOB | `jobs/identity-sync.ts:166` |
| identity-sync-dispatch | SCHEDULED | `schedules.ts` `0 3 * * *` |
| incident-notification-deadlines | SCHEDULED | `schedules.ts` `0 * * * *` |
| key-rotation | ROUTE | `api/t/[tenantSlug]/admin/key-rotation/route.ts:35` |
| notification-dispatch | SCHEDULED | `schedules.ts` `0 7 * * *` |
| nvd-cve-sync | SCHEDULED | `schedules.ts` `0 1 * * *` |
| onboarding-abandonment-sweep | SCHEDULED | `schedules.ts` `0 5 * * *` |
| policy-review-reminder | SCHEDULED | `schedules.ts` `0 8 * * *` |
| report-delivery | SCHEDULED | `schedules.ts` `0 6 * * *` |
| retention-sweep | SCHEDULED | `schedules.ts` `0 4 * * *` |
| risk-appetite-monitor | SCHEDULED | `schedules.ts` `0 6 * * *` |
| risk-snapshot | SCHEDULED | `schedules.ts` `0 2 * * *` |
| rule-chain-dispatch | JOB→JOB | `jobs/automation-event-dispatch.ts:306`; self-recurses at `jobs/rule-chain-dispatch.ts:100` |
| schedule-trigger-sweep | SCHEDULED | `schedules.ts` `0 7 * * *` |
| sharepoint-delta-sync | JOB→JOB + ROUTE | `jobs/sharepoint-delta-sync.ts:138`; `api/t/[tenantSlug]/integrations/sharepoint/sync/route.ts:54` |
| sharepoint-delta-sync-dispatch | SCHEDULED | `schedules.ts` `0 */4 * * *` |
| sharepoint-policy-pull | ROUTE | `api/webhooks/sharepoint/route.ts:70` |
| sharepoint-subscription-renew | SCHEDULED | `schedules.ts` `0 2 * * *` |
| sla-monitor | SCHEDULED | `schedules.ts` `*/5 * * * *` |
| subflow-dispatch | USECASE | `automation/action-executor.ts:543` |
| sync-pull | USECASE | `integrations/sync-orchestrator.ts:544` ← `usecases/webhook-processor.ts:547` ← `api/integrations/webhooks/[provider]` |
| task-due-notification | SCHEDULED | `schedules.ts` `0 8 * * *` (tz `NOTIFICATIONS_TZ`) |
| tenant-dek-rotation | USECASE | `lib/security/tenant-key-manager.ts:568` ← `api/t/[tenantSlug]/admin/_lib/rotate-dek-handlers.ts` |
| vendor-monitoring | SCHEDULED | `schedules.ts` `0 2 * * *` |
| vendor-renewal-check | REGISTERED-ONLY | fn called by `jobs/notification-dispatch.ts:196` |

**Totals: 31 SCHEDULED · 18 dispatched (JOB→JOB / ROUTE / USECASE) · 3
REGISTERED-ONLY · 2 UNREACHABLE = 54.**

`sync-pull` deserves a footnote: it is reachable only through an inbound webhook
for a provider whose bundle declares an `orchestratorClass`, and
`integrations/bootstrap.ts:97` shows **GitHub is the only one**. Reachable, but
by exactly one provider.

The three REGISTERED-ONLY entries are documented as intentional —
`schedules.ts:17` says in writing that `deadline-monitor`,
`evidence-expiry-monitor` and `vendor-renewal-check` are deliberately not
scheduled independently (they run inside `notification-dispatch` to avoid
duplicate DB scans) and "remain registered in the executor registry for
ad-hoc/CLI/API use". The ad-hoc/CLI/API surface they were kept for does not
exist — there is no route or script that can execute a registry entry by name —
so those three entries are dead weight rather than a dead capability. Filed low.

---

## The same question, one step further: exported functions with no non-test caller

Sampled the two subsystems where the three known instances live: **identity/JML**
(9 usecase files + the Entra writer) and **evidence/AV** (6 usecase/job files).
Method: extract `export (async function|function|const|class) NAME`, then grep
`src/` + `scripts/` for `\bNAME\b` excluding the declaring file and excluding
lines whose first non-space characters are `//`, `*` or `/*`.

**The comment filter is load-bearing and I got this wrong on the first pass.**
Without it, `listUnsettledWrites` and `findRestorableState` both looked reachable
— every "caller" was a doc-comment in `entra-id/writer.ts`,
`active-directory/writer.ts` and `identity-disable-account.ts` explaining what
they do. A name-grep counts *mentions*, not *calls*.

The filtered pass then produced 6 false positives of its own (symbols used only
*within* their declaring file, which the script excludes): `disableAccount`,
`MAX_DISABLES_PER_RUN`, `MAX_DISABLE_SHARE`, `SHARE_RULE_FLOOR`,
`LEAVER_MAX_MODE`, `LINK_FRESHNESS_MS`, `MAX_REPORTED_DECISIONS`. All are
exported for their unit tests and consumed in-file. Hand-checked and dismissed.

Genuine results after both corrections:

| Symbol | File | State |
|---|---|---|
| `runEvidenceStaleReviewSweep` | `usecases/evidence-stale-review-sweep.ts:49` | no caller anywhere in `src/` or `scripts/` |
| `reconcileUnlinkedEvidence` | `usecases/evidence-maintenance.ts:18` | no caller |
| `cleanupFailedOrPendingUploads` | `usecases/evidence-maintenance.ts:64` | no caller |
| `detectBrokenEvidence` | `usecases/evidence-maintenance.ts:101` | no caller |
| `assertNotArchived` | `usecases/evidence-retention.ts:308` | no caller |
| `listUnsettledWrites` | `usecases/identity-write-journal.ts:211` | no caller |
| `findRestorableState` | `usecases/identity-write-journal.ts:164` | no caller |
| `assertDisableInput` | `usecases/identity-disable-account.ts:740` | no caller, no test either |
| `syncAllLibraries` / `syncLibraryByUrn` / `syncLibraryByFile` / `previewSync` | `usecases/library-sync.ts:99/217/201/…` | no caller |
| `runCalendarDeadlineJob` | `jobs/calendar-deadlines.ts:353` | test-only caller |
| `EntraIdDirectoryWriter.preflight()` | `integrations/providers/entra-id/writer.ts:770` | test-only caller (confirms known instance) |
| `scheduler.validateRegistrations()` | `jobs/scheduler.ts:342` | test-only caller |

Not a finding, listed so nobody re-files it: `dsar-export.ts` / `dsar-erasure.ts`
are unreachable **by design** — they are documented Stage-1 reservations that
throw unconditionally, and `usecases/dsar-register.ts:7` says so.

---

## Prioritised: what is genuinely unreachable

### P1 — a compliance state transition that never fires

**`runEvidenceStaleReviewSweep`** (`src/app-layer/usecases/evidence-stale-review-sweep.ts:49`).

APPROVED evidence past its `nextReviewDate` is supposed to flip to
`NEEDS_REVIEW`. The sweep is written, tested (11 assertions), and called by
nothing. Its own header says *"the BullMQ cron sweeps all tenants by passing
`undefined`"* — there is no such cron. The name `evidence-stale-review-sweep`
appears in **no** `JobPayloadMap`, **no** `JOB_DEFAULTS`, **no** registry entry
and **no** schedule; it exists only as the label passed to `runJob()`. So
evidence silently ages past its review date while still reading `APPROVED`, and
readiness scoring keeps counting it as fresh — the exact failure its header
describes as the reason it was written.

This is the single strongest argument in this document for not keying the sweep
on the registry: **a registry-keyed sweep reports 54/54 accounted for and never
sees this job.**

Two independent places in the repo describe it as a running cron and neither is
in a position to notice it is not one: its own module header, and the
`no-direct-prisma.test.ts:166` allowlist entry, which opens *"daily cron that
sweeps APPROVED evidence past its `nextReviewDate`"* and grants the file a
carve-out on that basis. Both are prose, and prose is exactly where a
never-scheduled job survives longest.

It is also the sharpest instance of a shape ratchet certifying a capability that
does not run. `tests/guardrails/audit-s3-evidence-mgmt.test.ts:85-113` asserts
the file exports the function, issues an `updateMany` against APPROVED +
past-due rows, writes `NEEDS_REVIEW`, scopes by `tenantId`, and runs under
`runJob`. Every assertion is true. Every one of them is about the source text.
None of them would go red if the job never executed — which is the state we are
in.

**Fix shape:** add a `JobPayloadMap` entry + `JOB_DEFAULTS` entry + registry
entry + a `SCHEDULED_JOBS` row (daily, alongside the other evidence sweeps), and
add a positive assertion that the schedule set contains it — not another
source-text assertion.

### P2 — the JML write-journal recovery rail is invisible and un-actionable

**`listUnsettledWrites`** (`usecases/identity-write-journal.ts:211`) and
**`findRestorableState`** (`:164`).

These are the two read verbs of the capture-before-write rail: the first finds
directory writes stuck at PENDING/INDETERMINATE (we crashed before reporting, or
the call never reported back — either way the directory may or may not have
changed), the second finds the prior state needed to undo an APPLIED write.
Neither has a production caller.

The compounding detail is worth stating precisely, because it is the same defect
recurring one level up. `src/lib/observability/integration-metrics.ts:259` says:

> `listUnsettledWrites` existed with NO caller, which made the whole
> capture-before-write rail invisible in production — a rail nobody can see is
> one nobody acts on.

and defines `recordIdentityWritesUnsettled` to fix it. But that metric is
emitted **from inside `listUnsettledWrites`** (`identity-write-journal.ts:238`),
so it fires only when the uncalled reader is called. `grep -rn
"recordIdentityWritesUnsettled(" src/ scripts/ tests/` returns the declaration
and that one emit site — nothing else. **The remedy for the unreachable
capability is itself unreachable**, and the counter it wrote
(`identity.write.unsettled`, annotated "ALERT ON — a sustained non-zero") can
never be non-zero, which reads in a dashboard exactly like "no unsettled
writes".

This is currently latent — the leaver pass is clamped at `DRY_RUN` and writes
nothing — but it is precisely the rail that has to work on the day the clamp
comes off.

**Fix shape:** a scheduled sweep that calls `listUnsettledWrites` per tenant on
a cutoff and notifies. Assert the *schedule* contains it, and assert the counter
is emitted with a non-zero count from a seeded row.

### P3 — a guard that exists for a call site that does not call it

**`assertNotArchived`** (`usecases/evidence-retention.ts:308`). Its doc says
*"Use before linking evidence."* `linkEvidenceToControl`
(`usecases/evidence.ts:294`) checks that the evidence exists and that the control
is in-tenant, and does **not** check `isArchived`. So archived evidence can be
linked to a control today.

Scope of what I verified: the *download* path does gate on `isArchived`
(`evidence.ts:1354`), so this is not an exposure of archived bytes — it is an
integrity gap in the coverage graph. I checked `linkEvidenceToControl` only; the
other write paths that create `EvidenceControlLink` rows
(`scanner-ingestion.ts:327`, `aws-posture.ts:148`, `cloud-posture.ts:129`,
`integrations.ts:402`, `webhook-processor.ts:490`) are machine-generated links
against `isArchived: false` queries and were not individually audited.

### P4 — `av-rescan`, registered and un-triggerable

**`src/app-layer/jobs/av-rescan.ts`** — confirms the known instance. Its header
describes it as *"the bounded, one-off catch-up sweep for evidence stuck at
`scanStatus: 'PENDING'`"*, i.e. deliberately operator-triggered rather than
scheduled. That is a defensible design — but no operator surface exists: no
admin route, no CLI script, and the registry cannot be driven by name from
anywhere. Files uploaded before the inline upload scan landed stay PENDING and
un-previewable forever, which is the condition the job was written to clear.

Given the header's very deliberate reasoning about why unattended bulk verdict
writes are the most dangerous shape in the AV subsystem, **a route is the right
fix, not a schedule** — an OWNER/ADMIN-gated `POST` with the existing
`MINUTE_MS` dispatch-id collapse, which is what `fan-out.ts` already provides
for manual triggers.

### P5 — `library-sync`, an orchestration surface with no entry point

`usecases/library-sync.ts` exports four entry points (`syncAllLibraries`,
`syncLibraryByUrn`, `syncLibraryByFile`, `previewSync`) and its header states it
is *"called by: Scripts/CLI commands, Admin API routes, Seed processes"*. A
repo-wide grep finds **zero** of the three — the only references outside the file
are in `tests/unit/library-sync-lifecycle.test.ts`. Framework/mapping-set
libraries therefore cannot be re-synced from YAML by any shipped path. Low
urgency (libraries change rarely and installation has other paths), but the
header is inaccurate and should either gain a CLI script or be corrected.

### P6 — dead weight, no behavioural consequence

- `health-check` — registered, never enqueued, never scheduled. Harmless
  diagnostic; either wire it into a readiness probe or drop the entry.
- `deadline-monitor` / `evidence-expiry-monitor` / `vendor-renewal-check`
  registry entries — kept "for ad-hoc/CLI/API use" that does not exist.
- `runCalendarDeadlineJob` (`jobs/calendar-deadlines.ts:353`) — the `runJob`
  wrapper is test-only; the underlying `runCalendarDeadlineMonitor` **is**
  reachable via `notification-dispatch.ts:121`, so no capability is lost.
- `scheduler.validateRegistrations()` — never called, and checks the one
  direction (schedule → registry) that is already sound.
- `assertDisableInput` (`identity-disable-account.ts:740`) — no caller and no
  test; delete it or call it from `disableAccountsForLeaver`.
- `evidence-maintenance.ts` — all three exports (`reconcileUnlinkedEvidence`,
  `cleanupFailedOrPendingUploads`, `detectBrokenEvidence`) unreachable; the
  whole module is dead in production despite 40+ test assertions across the
  three. The header calls them "background/cron operations"; no cron references
  them.

---

## What would have caught these, and what would not

- **Would not:** any assertion over source text. `audit-s3-evidence-mgmt.test.ts`
  pins five true facts about `evidence-stale-review-sweep.ts` and is green while
  the sweep never runs. `no-direct-prisma.test.ts:174` lists the same file in an
  allowlist, which likewise says nothing about execution.
- **Would not:** `scheduler.validateRegistrations()`. It asserts every *schedule*
  has an executor. Nothing asserts every *executor* has a dispatcher, and that is
  the direction all four failures live in.
- **Would:** a structural ratchet over `E1 \ (E4 ∪ E5)` with a written-reason
  allowlist — the same shape as `LIST_MODELS_TENANT_INDEX_SUFFICIENT` in the
  index guardrails. A registered job with no schedule and no `enqueue` call site
  must either gain one or be listed with a reason. That catches P4 and P6.
- **Would only partly:** the above does **not** catch P1, because
  `evidence-stale-review-sweep` is not in E1. Catching that one needs the
  ratchet keyed on **E6 (`runJob('…')` names)** rather than on the registry —
  every `runJob` label must be in `SCHEDULED_JOBS`, be an `enqueue` target, or
  be listed as an internal stage with a reason. That is the concrete lesson of
  this sweep: **the marker that defines the population is the thing to be
  suspicious of, and the cheapest correction is to enumerate a second way and
  diff.**
