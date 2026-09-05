/**
 * Job Schedules — BullMQ Repeatable Job Definitions
 *
 * Defines the cron patterns and repeatable options for every scheduled job.
 * These are registered once by `scripts/scheduler.ts` and then BullMQ
 * automatically enqueues jobs at the specified cadence.
 *
 * Schedule semantics (preserved from legacy cron docs/comments):
 *   - automation-runner:       every 15 min (control check scheduling)
 *   - daily-evidence-expiry:   daily at 06:00 UTC (sweep + outbox)
 *   - data-lifecycle:          daily at 03:00 UTC (purge + retention)
 *   - policy-review-reminder:  daily at 08:00 UTC (overdue review audit)
 *   - task-due-notification:   daily at 08:00 local (NOTIFICATIONS_TZ) (in-app task deadline reminders)
 *   - retention-sweep:         daily at 04:00 UTC (evidence archival)
 *   - notification-dispatch:   daily at 07:00 UTC (single-pass: monitors + digest dispatch)
 *
 * IMPORTANT: deadline-monitor, evidence-expiry-monitor, and vendor-renewal-check
 * are NOT scheduled independently. They run as part of notification-dispatch
 * to prevent duplicate database scans. They remain registered in the executor
 * registry for ad-hoc/CLI/API use.
 *
 * Times are UTC unless the entry sets a `tz`. BullMQ uses standard
 * cron syntax and evaluates the `pattern` in `tz` when supplied.
 *
 * Idempotency: do NOT rely on BullMQ's deterministic-jobId dedupe as the
 * exactly-once guarantee. `queue.ts` sets `removeOnComplete: 500`, so once a
 * completed job is evicted from the retained set its jobId is reusable and the
 * same logical occurrence CAN be enqueued twice — jobId dedupe holds only
 * WITHIN the retention window. Every job whose double-fire would be visible is
 * instead made durably idempotent at the work layer (e.g. the per-day
 * `dedupeKey` unique index on notification outbox rows, the conditional
 * `updateMany` claims in the schedulers). Any new scheduled job that must never
 * double-fire MUST carry its own durable idempotency key, not lean on the jobId.
 *
 * @module app-layer/jobs/schedules
 */
import type { JobName } from './types';
import { env } from '@/env';

export interface ScheduleDefinition {
    /** Job name — must match a key in JobPayloadMap */
    name: JobName;
    /** Cron pattern — evaluated in `tz` if set, otherwise UTC */
    pattern: string;
    /**
     * IANA timezone the cron `pattern` is evaluated in (DST-aware).
     * Omit for UTC. Passed straight into the BullMQ repeat options.
     */
    tz?: string;
    /** Human-readable description */
    description: string;
    /** Default payload for the repeatable job */
    defaultPayload: Record<string, unknown>;
    /** BullMQ repeat options */
    options?: {
        /** Timezone (default: UTC) */
        tz?: string;
        /** Max runs (undefined = forever) */
        limit?: number;
    };
}

/**
 * All scheduled jobs in the system.
 * Used by `scripts/scheduler.ts` to register repeatable jobs.
 */
export const SCHEDULED_JOBS: ScheduleDefinition[] = [
    {
        name: 'automation-runner',
        pattern: '*/15 * * * *',  // every 15 minutes
        description: 'Execute scheduled automation/integration checks for controls',
        defaultPayload: {},
    },
    {
        name: 'sla-monitor',
        pattern: '*/5 * * * *',   // every 5 minutes
        description: 'Detect automation executions that breached their rule SLA window and fire the breach action',
        defaultPayload: {},
    },
    {
        name: 'sharepoint-delta-sync-dispatch',
        pattern: '0 */4 * * *',   // every 4 hours
        description: 'Fan out a SharePoint delta sync per enabled connection (auto-import changed evidence files)',
        defaultPayload: {},
    },
    {
        name: 'sharepoint-subscription-renew',
        pattern: '0 2 * * *',     // daily at 02:00 UTC
        description: 'Renew active SharePoint policy Graph change-notification subscriptions before they expire',
        defaultPayload: {},
    },
    {
        name: 'cloud-posture-collect-dispatch',
        // 01:20 UTC, and each part of that is load-bearing:
        //   - BEFORE daily-evidence-expiry (06:00) and notification-dispatch
        //     (07:00), so a batch is consumed the same day rather than waiting
        //     ~21h;
        //   - OUTSIDE 02:00-06:00, already carrying sharepoint-subscription-
        //     renew, risk-snapshot, vendor-monitoring, identity-sync,
        //     hris-sync and retention-sweep;
        //   - OFF the hour, dodging the hourly job, the `0 */4` SharePoint
        //     fan-out and the `*/15` automation tick.
        pattern: '20 1 * * *',
        tz: 'UTC',
        description: 'Fan out a cloud-posture collect per enabled AWS / Azure / GCP posture connection (Powerpipe benchmark → rolling Evidence). Daily because a run spawns an external Powerpipe process per connection; the evidence it writes carries a 30-day nextReviewDate.',
        defaultPayload: {},
    },
    {
        name: 'identity-sync-dispatch',
        pattern: '0 3 * * *',     // daily at 03:00 UTC
        description: 'Fan out an identity-sync per enabled Okta / Google Workspace / Entra ID / Active Directory connection (directory → ConnectedIdentityAccount)',
        defaultPayload: {},
    },
    {
        name: 'identity-leaver-dispatch',
        pattern: '0 5 * * *',     // daily at 05:00 UTC
        // AFTER identity-sync-dispatch (03:00) on purpose: the pass acts only on
        // links a COMPLETE sync re-observed, so running it before the sync would
        // read yesterday's evidence and refuse for the wrong reason.
        // NOT clamped at DRY_RUN any more. This description asserted "writes
        // nothing to any directory" for the four days after #2187 raised
        // LEAVER_MAX_MODE to AUTOMATIC (2026-08-30), which is the shape of
        // safety claim that is worst to leave stale: an operator reading job
        // config to decide whether this job can act on a real directory got the
        // wrong answer from the field named `description`. What bounds the
        // blast radius is the per-tenant ladder, not a clamp.
        description: 'Fan out a leaver pass per (tenant, writable directory provider). What each pass may do is the tenant\'s own identityLeaverMode: DRY_RUN decides and records what a disable WOULD do; AUTOMATIC performs it. Tenants default to DISABLED.',
        defaultPayload: {},
    },
    {
        name: 'calendar-push-dispatch',
        pattern: '0 3 * * *',     // daily at 03:00 UTC
        // NO `tz`. The bucket guard's parser reads only `pattern` and ignores
        // tz, while dispatchJobId floors on UTC boundaries — so a zoned cron
        // puts two firings 23h apart on the DST spring-forward day, which can
        // land in one UTC bucket and silently skip a run.
        description: 'Fan out a per-tenant calendar push per tenant with a live user calendar connection',
        defaultPayload: {},
    },
    {
        name: 'hris-sync-dispatch',
        pattern: '0 4 * * *',     // daily at 04:00 UTC
        description: 'Fan out an hris-sync per enabled HRIS connection — BambooHR, Workday (roster → Employee)',
        defaultPayload: {},
    },
    {
        name: 'risk-appetite-monitor',
        pattern: '0 6 * * *',     // daily at 06:00 UTC
        description: 'Scan every tenant portfolio for risk-appetite threshold breaches (RQ-2)',
        defaultPayload: {},
    },
    {
        name: 'risk-snapshot',
        pattern: '0 2 * * *',     // daily at 02:00 UTC
        description: 'Capture daily per-risk + portfolio snapshots for trend/velocity analytics (RQ-9)',
        defaultPayload: {},
    },
    {
        name: 'dau-mau-aggregator',
        pattern: '*/5 * * * *',   // every 5 minutes
        description: 'Refresh the DAU/MAU active-user snapshot the business.tenant.active gauges report',
        defaultPayload: {},
    },
    {
        name: 'onboarding-abandonment-sweep',
        pattern: '0 5 * * *',     // daily at 05:00 UTC
        description: 'Emit business.onboarding.abandoned for tenants idle ≥7 days on an onboarding step',
        defaultPayload: {},
    },
    {
        name: 'report-delivery',
        pattern: '0 6 * * *',     // daily at 06:00 UTC
        description: 'Generate + deliver due scheduled risk reports (RQ-10)',
        defaultPayload: {},
    },
    {
        name: 'schedule-trigger-sweep',
        pattern: '0 7 * * *',     // daily at 07:00 UTC
        description: 'Fire SCHEDULE automation rules whose target entity is N days from its due date',
        defaultPayload: {},
    },
    {
        name: 'daily-evidence-expiry',
        pattern: '0 6 * * *',     // daily at 06:00 UTC
        description: 'Sweep expiring evidence at 30/7/1 day thresholds + flush outbox',
        defaultPayload: {},
    },
    {
        name: 'data-lifecycle',
        pattern: '0 3 * * *',     // daily at 03:00 UTC
        description: 'Purge soft-deleted records, expired evidence, and run retention sweep',
        defaultPayload: { dryRun: false },
    },
    {
        name: 'vendor-monitoring',
        pattern: '0 2 * * *',     // daily at 02:00 UTC (after NVD sync, before the morning digest)
        description:
            'Continuous vendor posture sweep — re-check breach feeds, SOC 2 / cert attestation expiry, and public TLS grade for every enabled monitor; flip stale assessments into reassessment-due, record the posture timeline, and (opt-in) materialise vendor findings + notify owners. No-op when VENDOR_MONITOR_ENABLED=0.',
        defaultPayload: {},
    },
    {
        name: 'nvd-cve-sync',
        pattern: '0 1 * * *',     // daily at 01:00 UTC (before the morning monitors)
        description: 'Ingest recent CVEs from the NIST NVD 2.0 API into the global catalog, then match against tenant asset CPE data. No-op when NVD_SYNC_ENABLED=0.',
        defaultPayload: {},
    },
    {
        name: 'policy-review-reminder',
        pattern: '0 8 * * *',     // daily at 08:00 UTC
        description: 'Find overdue policies and emit audit events / notifications',
        defaultPayload: {},
    },
    {
        name: 'task-due-notification',
        // Daily at 08:00 in the configured local zone (NOTIFICATIONS_TZ,
        // default Europe/London) — the start of the working day, and
        // the same zone the windows are classified in so a task due
        // near local midnight is bucketed by the local calendar day.
        // Creates one in-app TASK_DUE notification per task at each of
        // three reminder windows: one week before, one day before, and
        // on the day the task's `dueAt` falls. Idempotent by local-tz
        // day — re-running is safe (dedupeKey unique index absorbs
        // repeats).
        pattern: '0 8 * * *',
        tz: env.NOTIFICATIONS_TZ,
        description:
            'Create in-app TASK_DUE notifications for tasks one week before, one day before, and on their due date.',
        defaultPayload: {},
    },
    {
        name: 'access-review-reminder',
        // Daily at 04:00 UTC — chosen so reminders land at the start
        // of the European workday and a few hours before
        // policy-review-reminder so the dedupe outbox isn't competing
        // for the per-tenant rate-limit token bucket. Idempotent
        // by-day, so re-running this is safe.
        pattern: '0 4 * * *',
        description:
            'Nudge access-review reviewers when their campaign deadline is approaching and decisions are still pending.',
        defaultPayload: {},
    },
    {
        name: 'access-review-overdue-escalation',
        // Daily at 04:15 UTC — sits between G-4's 04:00 reviewer
        // reminder and the 04:30 exception monitor. Each campaign
        // already got its reviewer-targeted nudge fifteen minutes
        // earlier; this job adds the admin-fan-out for the subset
        // that's past the grace tail. Idempotent by-day via the
        // outbox dedupe key. (Audit Coherence S7, 2026-05-24)
        pattern: '15 4 * * *',
        description:
            'Escalate severely overdue access-review campaigns to tenant ADMIN/OWNERs so they can reassign, force-close, or chase.',
        defaultPayload: {},
    },
    {
        name: 'exception-expiry-monitor',
        // Daily at 04:30 UTC — chosen to land between the 04:00
        // access-review reminder (G-4) and the 05:00 compliance-
        // snapshot, with idle DB capacity. Calendar-day-based
        // trigger means time-of-day drift doesn't move the window.
        pattern: '30 4 * * *',
        description:
            'Flag control exceptions approaching their `expiresAt` deadline at 30 / 14 / 7 day windows + emit reminder notifications.',
        defaultPayload: {},
    },
    {
        name: 'retention-sweep',
        pattern: '0 4 * * *',     // daily at 04:00 UTC
        description: 'Archive evidence with elapsed retention periods',
        defaultPayload: {},
    },
    {
        name: 'evidence-stale-review-sweep',
        pattern: '30 6 * * *',    // daily at 06:30 UTC (before notification-dispatch at 07:00)
        description: 'Transition APPROVED evidence past its nextReviewDate to NEEDS_REVIEW, so the 07:00 dispatch tells the owner the same morning',
        // Empty: no tenantId means sweep every tenant in one updateMany.
        defaultPayload: {},
    },
    {
        name: 'notification-dispatch',
        pattern: '0 7 * * *',     // daily at 07:00 UTC (single-pass: runs monitors internally)
        description: 'Single-pass pipeline: run all monitors → group by owner → dispatch digest notifications. Replaces separate monitor+dispatch schedule to prevent duplicate DB scans.',
        defaultPayload: {},
    },
    {
        name: 'compliance-snapshot',
        pattern: '0 5 * * *',     // daily at 05:00 UTC (before dashboard traffic)
        description: 'Generate daily ComplianceSnapshot for trend reporting. Idempotent — safe to re-run.',
        defaultPayload: {},
    },
    {
        name: 'compliance-posture-summary-dispatch',
        pattern: '30 5 * * *',    // daily at 05:30 UTC (after the compliance snapshot, before dashboard traffic)
        description: 'Fan out the AI compliance-posture summary per active tenant (dashboard hero). Idempotent — upserts one cached row per tenant.',
        defaultPayload: {},
    },
    {
        name: 'compliance-digest',
        pattern: '0 8 * * 1',     // weekly Monday at 08:00 UTC
        description: 'Send weekly compliance digest email to tenant admins. Reuses snapshot data — no live aggregation.',
        defaultPayload: {},
    },
    {
        name: 'control-test-scheduler',
        pattern: '*/5 * * * *',   // every 5 minutes
        description:
            'Epic G-2 — scan ACTIVE ControlTestPlan rows whose nextRunAt is due (or NULL, for bootstrap) — regardless of automationType — and enqueue per-plan control-test-runner jobs.',
        defaultPayload: {},
    },
    {
        name: 'agent-proposal-expiry',
        // 00:40 UTC daily. Off the hour and ahead of the 01:00 NVD sync, so it
        // does not share a tick with anything; the work is two statements plus
        // a bounded loop of audit appends, and the audit chain serialises on an
        // advisory lock that other jobs also want.
        //
        // NO ORDERING RELATIONSHIP with `agent-proposal-sample-audit`, and that
        // is worth stating because CLAUDE.md warns that declaration order here
        // is not execution order. The two act on DISJOINT populations — this
        // one on PENDING proposals, the sampler on already-approved ones — so
        // neither reads what the other writes and they can run in either order.
        pattern: '40 0 * * *',
        description:
            'OWASP ASI09 — close the review window on stale agent proposals. Moves PENDING proposals past their expiresAt to the terminal EXPIRED status and stamps a deadline onto rows written before the column existed. Deletes nothing: an expired proposal is the record of something an agent asked for and no human agreed to. Bookkeeping only — approveAgentProposal refuses a closed window by reading the clock, so a missed run cannot let a stale proposal be approved.',
        defaultPayload: {},
    },
    {
        name: 'agent-proposal-sample-audit',
        // WEEKLY, Monday 09:30 UTC, and the cadence is the calibration rather
        // than an arbitrary slot. A candidate is any approved proposal in the
        // last 30 days that has NOT already been sampled, so a DAILY draw of
        // ~10% of the remainder converges on re-reviewing nearly every
        // approval within the month — which turns a sample into a second full
        // review queue, i.e. reinvents the depth problem this whole subsystem
        // exists to bound. Weekly keeps the retrospective review a sample.
        //
        // Monday morning because the output is a human queue, not a machine
        // one: it wants to land at the start of a working week rather than in
        // the small hours beside the other sweeps.
        pattern: '30 9 * * 1',
        description:
            'OWASP ASI09 — draw a keyed random sample of already-APPROVED agent proposals and open a retrospective review on each, so the disagreement rate is measurable. Every other signal describes the SHAPE of the review behaviour; this one is the only measure of whether approvals were RIGHT. The draw is HMAC-keyed per tenant and rank-based over a population that includes later approvals, so it is reproducible from (seed, epoch, candidates) and unpredictable to a reviewer at approval time. Idempotent by the (tenantId, proposalId) unique index.',
        defaultPayload: {},
    },
    {
        name: 'incident-notification-deadlines',
        pattern: '0 * * * *',     // hourly — a 24h Article 23 deadline needs sub-day granularity
        description:
            'NIS2 Article 23 deadline clock — flip incident notification deadlines PENDING→DUE→OVERDUE and fire owner + admin alerts. Runs hourly because a 24h early-warning deadline needs sub-day granularity.',
        defaultPayload: {},
    },
];

