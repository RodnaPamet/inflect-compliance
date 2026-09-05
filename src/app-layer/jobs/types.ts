/**
 * Job Types — Typed Payload Contracts
 *
 * Every async job in the system is defined here with a unique name,
 * a serialization-safe payload interface, and default queue options.
 *
 * Rules:
 *   1. Job names are string literals (no enums — easier to grep/trace)
 *   2. Payloads MUST be JSON-serializable (no Date objects, no functions, no classes)
 *   3. Each job name maps to exactly one payload type via JobPayloadMap
 *   4. Add new jobs by extending JobPayloadMap + registering a processor
 *
 * TENANT ISOLATION (CRITICAL):
 *   5. Every tenant-scoped payload MUST include `tenantId?: string`
 *   6. Executors MUST pass payload.tenantId to the service layer
 *   7. Services MUST apply tenantId to ALL Prisma where clauses
 *   8. NEVER use `_payload` (unused parameter) in executors — this silently
 *      drops tenantId and causes all-tenant scans
 *   9. Regression tests in `tests/unit/job-tenant-isolation-regression.test.ts`
 *      enforce these rules automatically
 *
 * @module app-layer/jobs/types
 */

// ─── Unified Job Run Result ───

/**
 * Universal result contract returned by every scheduled job executor.
 * Provides a consistent shape for observability, logging, and
 * downstream consumers (dashboards, audit logs, alerting).
 *
 * All fields are JSON-serializable.
 */
export interface JobRunResult {
    /** The job name that produced this result */
    jobName: string;
    /** Unique identifier for this particular execution */
    jobRunId: string;
    /** Whether the job completed without throwing */
    success: boolean;
    /** ISO timestamp of when execution started */
    startedAt: string;
    /** ISO timestamp of when execution finished */
    completedAt: string;
    /** Execution duration in milliseconds */
    durationMs: number;
    /** Number of items scanned/inspected during the run */
    itemsScanned: number;
    /** Number of items that triggered an action (e.g. notified, archived, purged) */
    itemsActioned: number;
    /** Number of items skipped (duplicate, already processed, etc.) */
    itemsSkipped: number;
    /** Optional error message if success=false */
    errorMessage?: string;
    /**
     * Set when a failure must NOT be retried by the queue.
     *
     * The queue defaults to `attempts: 3` with 5s exponential backoff, which is
     * right for a transient fault and actively harmful for two cases:
     *
     *   - a REVOKED CREDENTIAL, where three retries are pure delay for every
     *     other tenant behind this job in the fan-out;
     *   - a RATE LIMIT, where retrying the whole sync three times inside ~35s
     *     is precisely what the remote just asked us not to do, and can turn a
     *     soft throttle into a hard block.
     *
     * The worker converts this into BullMQ's `UnrecoverableError`. The job
     * still FAILS and is still recorded — it simply is not re-run before the
     * next scheduled tick.
     */
    noRetry?: boolean;
    /** Optional structured details (job-specific payload) */
    details?: Record<string, unknown>;
}

// ─── Normalized Due Item Output ───

/**
 * Entity types that can have due/expiring items.
 * Used for downstream notification grouping.
 */
export type MonitoredEntityType =
    | 'CONTROL'
    | 'EVIDENCE'
    | 'POLICY'
    | 'VENDOR'
    | 'TASK'
    | 'RISK'
    | 'TEST_PLAN'
    // Epic G-7 — treatment-plan target dates + milestone due dates
    // both flow through the deadline monitor so the digest pipeline
    // groups them by owner alongside other deadlines.
    | 'TREATMENT_PLAN'
    | 'TREATMENT_MILESTONE'
    // Both used to be filed under a borrowed bucket ('CONTROL' for cycles,
    // 'TASK' for findings) on the belief that entityType was "informational
    // only". It is not: the digest template drives BOTH the visible type label
    // AND the link href from it, so those reminders arrived labelled as the
    // wrong entity and linked to the wrong list page.
    | 'AUDIT_CYCLE'
    | 'FINDING';

/**
 * Urgency classification for due items.
 *   OVERDUE  — already past its deadline
 *   URGENT   — within 7 days
 *   UPCOMING — within 30 days
 */
export type DueItemUrgency = 'OVERDUE' | 'URGENT' | 'UPCOMING';

/**
 * Normalized due/expiring item — the universal output of all monitors.
 *
 * Designed for downstream consumption:
 *   - Group by tenantId + ownerUserId → per-user digest
 *   - Group by entityType → summary dashboards
 *   - All fields are JSON-serializable
 */
export interface DueItem {
    /** Entity type being monitored */
    entityType: MonitoredEntityType;
    /** Database ID of the entity */
    entityId: string;
    /** Tenant that owns this entity */
    tenantId: string;
    /** Human-readable name/title */
    name: string;
    /** Specific reason this item is flagged */
    reason: string;
    /** Urgency classification */
    urgency: DueItemUrgency;
    /** The date that drives this due item (ISO string) */
    dueDate: string;
    /** Days remaining (negative = overdue) */
    daysRemaining: number;
    /** Owner user ID (for notification routing), if known */
    ownerUserId?: string;
}

// ─── Job Payload Definitions ───

/** Health check / smoke test job */
export interface HealthCheckPayload {
    /** ISO timestamp of when the job was enqueued */
    enqueuedAt: string;
    /** Optional message for testing */
    message?: string;
}

/** Automation runner — executes scheduled control checks */
export interface AutomationRunnerPayload {
    tenantId?: string;
    dryRun?: boolean;
}

/** Daily evidence expiry — sweeps and notifies */
export interface DailyEvidenceExpiryPayload {
    tenantId?: string;
    skipOutbox?: boolean;
}

/** Data lifecycle — retention sweep and purge */
export interface DataLifecyclePayload {
    tenantId?: string;
    dryRun?: boolean;
}

/** Policy review reminder */
export interface AccessReviewReminderPayload {
    /** Optional: scope the scan to a single tenant. Omit for the
     *  system-wide nightly scan. */
    tenantId?: string;
}

/** NIS2 Article 23 deadline-clock job — flips PENDING→DUE→OVERDUE and
 *  fires notifications. Runs frequently (hourly) because a 24h deadline
 *  needs sub-day granularity. */
export interface IncidentNotificationDeadlinesPayload {
    /** Optional: scope the scan to a single tenant. Omit for the
     *  system-wide hourly scan. */
    tenantId?: string;
}

export interface PolicyReviewReminderPayload {
    tenantId?: string;
}

/**
 * Audit Coherence S7 (2026-05-24) — access review overdue
 * escalation. Sister job to `access-review-reminder` — same payload
 * shape (tenant-scope opt-in), separate job because the fan-out
 * recipients are tenant admins, not the campaign reviewer.
 */
export interface AccessReviewOverdueEscalationPayload {
    tenantId?: string;
}

/** Task-due notification — in-app deadline reminders (7d / 1d / due day) */
export interface TaskDueNotificationPayload {
    /** Optional: scope the scan to a single tenant. Omit for the
     *  system-wide nightly scan. */
    tenantId?: string;
}

/** Epic G-5 — exception expiry monitor */
export interface ExceptionExpiryMonitorPayload {
    /** Optional: scope the scan to a single tenant. Omit for the
     *  system-wide nightly scan. */
    tenantId?: string;
}

/**
 * Agent-proposal expiry sweep (OWASP ASI09) — moves PENDING proposals whose
 * review window has closed to the terminal EXPIRED status, and stamps a
 * deadline onto pre-`expiresAt` rows.
 *
 * Nothing is deleted: an expired proposal is the record of something an agent
 * asked for and no human agreed to. The sweep is BOOKKEEPING — the refusal to
 * approve past the deadline lives in the usecase and reads the clock, so a dead
 * worker costs tidiness rather than safety.
 */
export interface AgentProposalExpiryPayload {
    /** Optional: scope to a single tenant. Omit for the system-wide sweep. */
    tenantId?: string;
}

/**
 * Agent-proposal sample audit (OWASP ASI09) — draws a keyed random sample of
 * already-APPROVED proposals and opens a retrospective review on each, so the
 * disagreement rate is measurable. The only write seam for
 * `AgentProposalSampleAudit`; a human cannot open one by hand, or the sample
 * would stop being a sample.
 */
export interface AgentProposalSampleAuditPayload {
    /** Optional: scope to a single tenant. Omit for the system-wide sweep. */
    tenantId?: string;
}

/** Evidence retention sweep */
export interface RetentionSweepPayload {
    tenantId?: string;
    dryRun?: boolean;
}

/** Vendor renewal/review deadline monitor */
export interface VendorRenewalCheckPayload {
    tenantId?: string;
}

/** Continuous vendor posture monitor (breach/attestation/TLS sweep). */
export interface VendorMonitoringPayload {
    /** Scope to one tenant; absent = sweep all tenants. */
    tenantId?: string;
    /** Scope to one vendor (ad-hoc re-run); absent = all enabled monitors. */
    vendorId?: string;
}

/** Deadline monitor — controls, policies, tasks, risks, test plans */
export interface DeadlineMonitorPayload {
    tenantId?: string;
    /** Detection windows in days. Default: [30, 7, 1] */
    windows?: number[];
}

/** Evidence expiry monitor — expiring/expired evidence detection */
export interface EvidenceExpiryMonitorPayload {
    tenantId?: string;
    /** Detection windows in days. Default: [30, 7, 1] */
    windows?: number[];
}

/**
 * Evidence stale-review sweep — flip past-due APPROVED evidence to NEEDS_REVIEW.
 *
 * Deliberately mirrors `EvidenceExpiryMonitorPayload`'s optional-tenant shape:
 * omitting `tenantId` sweeps every tenant in one `updateMany`, which is what the
 * cron does.
 */
export interface EvidenceStaleReviewSweepPayload {
    tenantId?: string;
}

/** Notification dispatch — monitor → grouped digest → outbox pipeline */
export interface NotificationDispatchPayload {
    tenantId?: string;
    /** Which categories to dispatch. Default: all */
    categories?: ('DEADLINE_DIGEST' | 'EVIDENCE_EXPIRY_DIGEST' | 'VENDOR_RENEWAL_DIGEST')[];
    /** Detection windows in days. Default: [30, 7, 1] */
    windows?: number[];
}

/** Daily compliance snapshot — KPI trend storage */
export interface ComplianceSnapshotPayload {
    tenantId?: string;
    /** Override snapshot date (ISO string). Default: today UTC */
    date?: string;
}

/** Automation Epic 5 — SLA breach sweep over RUNNING executions. */
export interface SlaMonitorPayload {
    /** Limit the sweep to one tenant (default: all). */
    tenantId?: string;
}

/** Automation Epic 7 — fire the next rule in a chain. */
export interface RuleChainDispatchPayload {
    tenantId: string;
    /** The next rule to run. */
    ruleId: string;
    /** The execution that triggered this chain step (lineage). */
    parentExecutionId: string;
    triggerEvent: string;
    data: Record<string, unknown>;
    /** Chain depth — a runtime cycle backstop (capped in the job). */
    depth: number;
}

/** VR-7 — sub-flow invocation: run a sub-flow group's entry rule, linked to
 * the invoking execution via parentExecutionId. */
export interface SubflowDispatchPayload {
    tenantId: string;
    /** The enclosing sub-flow group's ProcessNode.nodeKey (rules carry it as subFlowGroupId). */
    targetGroupId: string;
    /** The execution that invoked the sub-flow (lineage). */
    parentExecutionId: string;
    triggerEvent: string;
    data: Record<string, unknown>;
    /**
     * Recursion depth, mirroring `RuleChainDispatchPayload.depth`.
     *
     * Absent on the first hop (treated as 1). A sub-flow whose entry rule
     * invokes its OWN group recursed forever before this existed: unlike
     * rule-chain-dispatch, which has enforced `MAX_CHAIN_DEPTH` since Epic 7,
     * this dispatcher had no cap at all — and `targetGroupId` is a free-form
     * string with no self-reference check, so `G → G` was one field edit away.
     */
    depth?: number;
}

/** PR-E — global cron sweep that fires SCHEDULE rules whose target entity is
 * due. No payload (scans every tenant's enabled SCHEDULE rules). */
export type ScheduleTriggerSweepPayload = Record<string, never>;

/** Weekly compliance digest — executive summary email */
export interface ComplianceDigestPayload {
    tenantId?: string;
    /** Override recipient emails (default: tenant ADMIN/OWNER members) */
    recipientOverrides?: string[];
    /** Number of days to include in trend summary (default: 7) */
    trendDays?: number;
}

/**
 * Epic B.3 — Master-KEK rotation, per-tenant scope.
 *
 * Enqueued by the tenant admin API after an operator has staged
 * `DATA_ENCRYPTION_KEY_PREVIOUS` alongside the new
 * `DATA_ENCRYPTION_KEY`. The job:
 *   1. Re-wraps the tenant's `encryptedDek` under the primary KEK.
 *   2. Re-encrypts every v1 ciphertext belonging to this tenant
 *      under the primary KEK.
 *
 * Idempotent — the dual-KEK fallback transparently decrypts whatever
 * state the row is in, so a re-run after a crash continues from
 * wherever the last batch stopped.
 */
export interface KeyRotationPayload {
    tenantId: string;
    /** User who initiated — attribution on audit-log entries. */
    initiatedByUserId: string;
    /** Upstream request id for log correlation. */
    requestId?: string;
}

/**
 * Per-tenant DEK rotation re-encrypt sweep.
 *
 * Enqueued by `rotateTenantDek` after the atomic DEK swap. The job:
 *   1. Walks every (model, field) in the encrypted-fields manifest
 *      that has a `tenantId` column.
 *   2. For each row carrying a v2 ciphertext, decrypts under the
 *      previous DEK and re-encrypts under the new primary DEK.
 *   3. On completion, clears `Tenant.previousEncryptedDek` to NULL
 *      and invalidates the previous-DEK cache for that tenant.
 *
 * Idempotent — the dual-DEK fallback in the encryption middleware
 * means rows already rewritten under the new primary stay readable
 * if the job re-runs after a crash. The job's own decrypt path uses
 * the previous DEK directly (not the fallback) because rows that
 * primary-decrypt successfully are by definition NOT what we're
 * sweeping for.
 *
 * Mid-flight reads remain correct via the middleware's
 * `decryptWithKeyOrPrevious` fallback (the previous DEK stays
 * resolvable until the final UPDATE clears `previousEncryptedDek`).
 */
export interface TenantDekRotationPayload {
    tenantId: string;
    /** User who initiated — attribution on audit-log entries. */
    initiatedByUserId: string;
    /** Upstream request id for log correlation. */
    requestId?: string;
    /** Override SELECT batch size per (model, field). Default 500. */
    batchSize?: number;
}

/**
 * Automation event dispatch — one job per emitted domain event.
 *
 * The bus stamps `tenantId` and `emittedAt` on the event; the
 * dispatcher serializes the event through this payload to Redis.
 * Dates are ISO strings because BullMQ payloads are JSON-only.
 *
 * The worker (see `jobs/automation-event-dispatch.ts`):
 *   1. Loads enabled rules for `event.tenantId + event.event`.
 *   2. For each rule whose filter matches `event.data`, inserts a
 *      PENDING `AutomationExecution` row. The unique
 *      (tenantId, idempotencyKey) index is the dedupe lock — retries
 *      that compute the same key collide and the runner skips.
 *   3. Advances each claimed execution through RUNNING →
 *      SUCCEEDED / FAILED. Action handlers are out of scope for
 *      Epic 60 foundation; the outcome records what *would* have
 *      fired so the next epic can plug handlers in.
 */
export interface AutomationEventDispatchPayload {
    /** Required for tenant-safe rule lookup and RLS set_config. */
    tenantId: string;
    event: {
        event: string;
        tenantId: string;
        entityType: string;
        entityId: string;
        actorUserId: string | null;
        /** ISO string — bus Date serialized for Redis. */
        emittedAt: string;
        stableKey?: string;
        data: Record<string, unknown>;
    };
    /**
     * Epic 6 — manual re-trigger of a SINGLE rule. When set, only this rule
     * is considered (instead of every rule matching the event), and the
     * execution row records the given `triggeredBy` (default 'event').
     */
    targetRuleId?: string;
    triggeredBy?: string;
}

/**
 * Bulk-import evidence from a tenant-scoped staged ZIP archive.
 *
 * The HTTP layer stages the upload to storage (domain
 * `evidence-import-staging`) and enqueues this job; the worker
 * extracts, validates each entry against the safety bounds, and
 * funnels accepted entries through the canonical
 * `uploadEvidenceFile` usecase so business rules (MIME allowlist,
 * size cap, dedup, audit trail) stay identical to the single-file
 * upload path.
 *
 * Payload is JSON-serialisable per the JobPayloadMap rule — no Date
 * objects, no Buffers, no functions. The actual ZIP bytes live in
 * storage at `stagingPathKey`; the worker streams them back.
 */
export interface EvidenceImportPayload {
    /** Tenant whose evidence will be enriched. Required for isolation. */
    tenantId: string;
    /** User who uploaded the bundle — used for actor attribution + perm gate. */
    initiatedByUserId: string;
    /** Storage key of the staged ZIP (under `evidence-import-staging`). */
    stagingPathKey: string;
    /** Storage `FileRecord.id` of the staging upload, deleted on success. */
    stagingFileRecordId: string;
    /** Optional control to attach every extracted evidence to. */
    controlId?: string | null;
    /** Optional retention date applied to every extracted evidence. */
    retentionUntilIso?: string | null;
    /** Optional category tag applied to every extracted evidence. */
    category?: string | null;
    /** Optional folder label applied to every extracted evidence. */
    folder?: string | null;
    /** Optional log-correlation id from the upstream HTTP request. */
    requestId?: string;
}

/**
 * Epic G-2 — Control Test Automation Scheduler.
 *
 * Repeatable BullMQ job that scans `ControlTestPlan` rows for due
 * scheduled runs and enqueues per-plan `control-test-runner` jobs.
 * Tenant-scopable for ad-hoc / CLI invocations; left unset for the
 * default cron tick (scans all tenants).
 *
 * `now` lets tests inject a deterministic clock; production callers
 * leave it unset so the executor uses real time.
 */
export interface ControlTestSchedulerPayload {
    tenantId?: string;
    /** ISO timestamp override — for deterministic tests + CLI replay. */
    nowIso?: string;
    /** When true, scan + log but do not enqueue or update plans. */
    dryRun?: boolean;
}

/**
 * Epic G-2 — Per-plan automation runner. The scheduler enqueues
 * one of these per claimed due plan; the runner (built in the next
 * G-2 prompt) executes the SCRIPT or INTEGRATION handler and links
 * the result evidence back to a fresh `ControlTestRun`.
 *
 * `scheduledForIso` is the `nextRunAt` value the scheduler stamped
 * when claiming the plan. It doubles as the dedupe key fragment in
 * the BullMQ jobId so two scheduler ticks racing on the same plan
 * cannot enqueue twice for the same intended execution instant.
 */
export interface ControlTestRunnerPayload {
    tenantId: string;
    testPlanId: string;
    scheduledForIso: string;
    /** Optional log-correlation id from the upstream scheduler invocation. */
    schedulerJobRunId?: string;
}

/** Webhook-driven sync pull */
export interface SyncPullPayload {
    ctx: {
        tenantId: string;
        userId: string;
        requestId: string;
        role: string;
        permissions: {
            canRead: boolean;
            canWrite: boolean;
            canAdmin: boolean;
            canAudit: boolean;
            canExport: boolean;
        };
    };
    mappingKey: {
        tenantId: string;
        provider: string;
        connectionId?: string;
        localEntityType: string;
        localEntityId: string;
        remoteEntityType: string;
        remoteEntityId: string;
    };
    remoteData: Record<string, unknown>;
    remoteUpdatedAtIso: string;
}

// ─── Job Name → Payload Map ───

/**
 * Central registry of all job names and their corresponding payload types.
 * This is the single source of truth for job typing across the system.
 *
 * To add a new job:
 *   1. Define a payload interface above
 *   2. Add an entry to this map
 *   3. Register a processor in the worker
 */
/** SP-3 — delta sync for one SharePoint connection. */
export interface SharePointDeltaSyncPayload {
    tenantId: string;
    connectionId: string;
    /** Member to attribute the re-imports to (an admin of the tenant). */
    actorUserId: string;
    triggeredBy: 'scheduled' | 'manual';
    requestId?: string;
}

/** SP-3 — fan-out cron: enqueue a delta sync per enabled SharePoint connection. */
export interface SharePointDeltaSyncDispatchPayload {
    requestId?: string;
}

/** SP-4 — pull a changed policy from SharePoint (enqueued by the Graph webhook). */
export interface SharePointPolicyPullPayload {
    tenantId: string;
    policyId: string;
    requestId?: string;
}

/** SP-4 — daily cron: renew every active policy Graph subscription (cross-tenant). */
export interface SharePointSubscriptionRenewPayload {
    requestId?: string;
}

/** RQ-2 — daily cron: scan every tenant's portfolio for appetite breaches (cross-tenant). */
export interface RiskAppetiteMonitorPayload {
    requestId?: string;
}

/** RQ-9 — daily cron: snapshot every tenant's risk + portfolio metrics (cross-tenant). */
export interface RiskSnapshotPayload {
    requestId?: string;
}

/** RQ-10 — daily cron: generate + deliver due scheduled reports (cross-tenant). */
export interface ReportDeliveryPayload {
    requestId?: string;
}

/** Business-KPI — 5-min cross-tenant DAU/MAU aggregation → gauge snapshot. */
export interface DauMauAggregatorPayload {
    requestId?: string;
}

/** Business-KPI — daily cross-tenant onboarding-abandonment sweep. */
export interface OnboardingAbandonmentPayload {
    requestId?: string;
}

/** NVD CVE sync — daily global CVE catalog ingestion + asset matching. */
export interface NvdCveSyncPayload {
    /** Override the first-run backfill window on an empty catalog (days). */
    backfillDays?: number;
}

/** Per-tenant AI compliance-posture summary regeneration (daily). */
export interface CompliancePostureSummaryPayload {
    tenantId: string;
}

/** Daily cross-tenant fan-out: enqueue a posture summary per active tenant. */
export interface CompliancePostureDispatchPayload {
    requestId?: string;
}

/**
 * `av-rescan` — bounded, operator-triggered catch-up scan of FileRecords
 * stuck at `scanStatus: 'PENDING'`.
 *
 * Single-tenant on purpose: each row costs a full object read plus a clamd
 * round trip, so this is never a cross-tenant sweep and never a cron. The
 * job clamps `limit` to its own hard ceiling — the payload cannot widen the
 * blast radius past what the job allows.
 */
export interface AvRescanPayload {
    /** REQUIRED — the sweep is deliberately scoped to one tenant. */
    tenantId: string;
    /** Operator who triggered the run; the actor on every audit row. */
    initiatedByUserId: string;
    /** Rows to examine this run. Clamped by the job to its hard cap. */
    limit?: number;
    requestId?: string;
}

export interface JobPayloadMap {
    'health-check': HealthCheckPayload;
    'nvd-cve-sync': NvdCveSyncPayload;
    'automation-runner': AutomationRunnerPayload;
    'daily-evidence-expiry': DailyEvidenceExpiryPayload;
    'data-lifecycle': DataLifecyclePayload;
    'policy-review-reminder': PolicyReviewReminderPayload;
    'exception-expiry-monitor': ExceptionExpiryMonitorPayload;
    'retention-sweep': RetentionSweepPayload;
    'vendor-renewal-check': VendorRenewalCheckPayload;
    'vendor-monitoring': VendorMonitoringPayload;
    'deadline-monitor': DeadlineMonitorPayload;
    'evidence-expiry-monitor': EvidenceExpiryMonitorPayload;
    'evidence-stale-review-sweep': EvidenceStaleReviewSweepPayload;
    'notification-dispatch': NotificationDispatchPayload;
    'sync-pull': SyncPullPayload;
    'compliance-snapshot': ComplianceSnapshotPayload;
    'sla-monitor': SlaMonitorPayload;
    'rule-chain-dispatch': RuleChainDispatchPayload;
    'subflow-dispatch': SubflowDispatchPayload;
    'schedule-trigger-sweep': ScheduleTriggerSweepPayload;
    'compliance-digest': ComplianceDigestPayload;
    'automation-event-dispatch': AutomationEventDispatchPayload;
    'key-rotation': KeyRotationPayload;
    'tenant-dek-rotation': TenantDekRotationPayload;
    'evidence-import': EvidenceImportPayload;
    'control-test-scheduler': ControlTestSchedulerPayload;
    'control-test-runner': ControlTestRunnerPayload;
    'access-review-reminder': AccessReviewReminderPayload;
    'access-review-overdue-escalation': AccessReviewOverdueEscalationPayload;
    'task-due-notification': TaskDueNotificationPayload;
    'sharepoint-delta-sync': SharePointDeltaSyncPayload;
    'sharepoint-delta-sync-dispatch': SharePointDeltaSyncDispatchPayload;
    'sharepoint-policy-pull': SharePointPolicyPullPayload;
    'sharepoint-subscription-renew': SharePointSubscriptionRenewPayload;
    'risk-appetite-monitor': RiskAppetiteMonitorPayload;
    'risk-snapshot': RiskSnapshotPayload;
    'report-delivery': ReportDeliveryPayload;
    'dau-mau-aggregator': DauMauAggregatorPayload;
    'onboarding-abandonment-sweep': OnboardingAbandonmentPayload;
    'incident-notification-deadlines': IncidentNotificationDeadlinesPayload;
    'aws-posture-collect': AwsPostureCollectPayload;
    'compliance-posture-summary': CompliancePostureSummaryPayload;
    'compliance-posture-summary-dispatch': CompliancePostureDispatchPayload;
    'identity-sync': IdentitySyncPayload;
    'identity-sync-dispatch': IdentitySyncDispatchPayload;
    'identity-leaver-pass': IdentityLeaverPassPayload;
    'identity-leaver-dispatch': IdentityLeaverDispatchPayload;
    'cloud-posture-collect-dispatch': CloudPostureCollectDispatchPayload;
    'azure-posture-collect': AzurePostureCollectPayload;
    'gcp-posture-collect': GcpPostureCollectPayload;
    'calendar-push-dispatch': CalendarPushDispatchPayload;
    'calendar-push-tenant': CalendarPushTenantPayload;
    'hris-sync': HrisSyncPayload;
    'hris-sync-dispatch': HrisSyncDispatchPayload;
    'av-rescan': AvRescanPayload;
    'agent-proposal-expiry': AgentProposalExpiryPayload;
    'agent-proposal-sample-audit': AgentProposalSampleAuditPayload;
}

/** aws-posture connector — run one tenant connection's benchmark + collect evidence. */
export interface AwsPostureCollectPayload {
    tenantId: string;
    connectionId: string;
}

/** azure-posture connector — run one tenant connection's benchmark + collect evidence. */
export interface AzurePostureCollectPayload {
    tenantId: string;
    connectionId: string;
}

/** gcp-posture connector — run one tenant connection's benchmark + collect evidence. */
export interface GcpPostureCollectPayload {
    tenantId: string;
    connectionId: string;
}

/** hris-sync — sync one BambooHR connection's roster into Employee. */
export interface HrisSyncPayload {
    tenantId: string;
    connectionId: string;
}

/** hris-sync-dispatch — fan out an hris-sync per enabled HRIS connection. */
export interface HrisSyncDispatchPayload {
    _?: never;
}

/** identity-sync — sync one Okta / Google Workspace connection's directory. */
export interface IdentitySyncPayload {
    tenantId: string;
    connectionId: string;
}

export interface IdentityLeaverPassPayload {
    tenantId: string;
    /**
     * The DIRECTORY, not the connection.
     *
     * `ConnectedIdentityAccount` carries no connectionId, so a pass is scoped to
     * a (tenant, provider) — the writer factory refuses outright when that pair
     * has more than one enabled connection, rather than addressing a disable at
     * a forest the account may not live in.
     */
    provider: string;
}

/**
 * No tenantId, deliberately — this is the cross-tenant fan-out, and the tenant
 * is what it DISCOVERS. Its child `IdentityLeaverPassPayload` carries one and is
 * not exempt from the isolation audit.
 */
export interface IdentityLeaverDispatchPayload {
    [key: string]: never;
}

/** identity-sync-dispatch — fan out an identity-sync per enabled connection. */
/** calendar-push-dispatch — cron fan-out, one child per tenant with a connection. */
export interface CalendarPushDispatchPayload {
    // no fields — cron-triggered global fan-out
    _?: never;
}

/** calendar-push-tenant — one tenant's connected users, visited in process. */
export interface CalendarPushTenantPayload {
    tenantId: string;
}

export interface IdentitySyncDispatchPayload {
    // no fields — cron-triggered global fan-out
    _?: never;
}

/** cloud-posture-collect-dispatch — fan out a posture collect per enabled connection. */
export interface CloudPostureCollectDispatchPayload {
    // no fields — cron-triggered global fan-out
    _?: never;
}

/** Union of all valid job names */
export type JobName = keyof JobPayloadMap;

/** Extract the payload type for a given job name */
export type JobPayload<T extends JobName> = JobPayloadMap[T];

// ─── Default Queue Options ───

/** Default retry/backoff settings per job */
export const JOB_DEFAULTS: Record<JobName, {
    attempts: number;
    backoff: { type: 'exponential' | 'fixed'; delay: number };
    removeOnComplete: number | boolean;
    removeOnFail: number | boolean;
}> = {
    'health-check': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 200,
    },
    'nvd-cve-sync': {
        // One attempt — the incremental cursor (max lastModifiedAt) means the
        // next daily run resumes from where this one stopped, so a transient
        // failure self-heals without retry storms against NVD's rate limit.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'aws-posture-collect': {
        // One attempt — a posture run shells out to Powerpipe against live AWS
        // (slow, rate-limited); a transient failure is picked up by the next
        // scheduled run rather than retried in a storm.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'calendar-push-dispatch': {
        // One attempt. The dispatcher only enqueues; a transient Redis failure
        // is picked up by tomorrow's run, and retrying a fan-out is how one
        // blip becomes a second pass over everyone's calendar.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'calendar-push-tenant': {
        // One attempt. This entry USED to be load-bearing for a second reason
        // that no longer holds: JOB_DEFAULTS was inert for cron-scheduled jobs
        // (registerSchedules passed no opts, so BullMQ fell back to the queue
        // default of 3 exponential attempts), and this job got its 1 only
        // because it arrives via enqueue(). registerSchedules now passes opts,
        // so both paths honour this entry and the asymmetry is gone.
        //
        // One is also the right number on its own merits: runUserPushGuarded
        // converts every failure into a recorded outcome and returns, so
        // nothing reaches the queue to retry; and the sweep is idempotent by
        // contentHash, with FAILED rows re-pushed and PENDING_DELETE rows
        // re-deleted, so the next scheduled run IS the retry.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'identity-leaver-pass': {
        // ONE attempt, and this is a correctness constraint rather than
        // rate-limit courtesy. The journal's INDETERMINATE handling assumes one
        // dispatch per decision: a write whose result was never confirmed leaves
        // a row a LATER pass reconciles by re-reading the account. Three
        // attempts in ~35 seconds would mint a fresh set of journal rows per
        // try, and the second and third could not tell their own predecessors'
        // rows from a real unconfirmed write. Retrying here destroys the
        // evidence the retry would need. Tomorrow's dispatch picks it up.
        attempts: 1,
        backoff: { type: 'fixed', delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
    'identity-leaver-dispatch': {
        // The dispatcher only enqueues, and its job ids are deterministic per
        // (tenant, provider, UTC day) — so a retry cannot double-dispatch.
        attempts: 1,
        backoff: { type: 'fixed', delay: 1000 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'identity-sync': {
        // One attempt — a directory pull hits a rate-limited vendor API; a
        // transient failure is picked up by the next scheduled fan-out.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'identity-sync-dispatch': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 20,
        removeOnFail: 50,
    },
    'cloud-posture-collect-dispatch': {
        // One attempt. A failed fan-out is picked up by tomorrow's run, and a
        // retry would re-enqueue collects that the first attempt already
        // queued — duplicated Powerpipe runs are the expensive kind of
        // duplicate.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'azure-posture-collect': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'gcp-posture-collect': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'hris-sync': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'hris-sync-dispatch': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 20,
        removeOnFail: 50,
    },
    'av-rescan': {
        // No auto-retry. The job is idempotent — a row that got a verdict is
        // no longer PENDING and is no longer selected — so a retry is safe
        // but pointless: the interesting failures here (scanner down, storage
        // unreadable) are exactly the ones a 5-second backoff will not have
        // fixed, and every attempt re-reads every object. The operator reads
        // the counters and re-enqueues.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 100,
    },
    'automation-runner': {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
    },
    'sla-monitor': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'rule-chain-dispatch': {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
    },
    'subflow-dispatch': {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
    },
    'schedule-trigger-sweep': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'daily-evidence-expiry': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'data-lifecycle': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'policy-review-reminder': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'access-review-reminder': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'access-review-overdue-escalation': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'task-due-notification': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'sharepoint-delta-sync': {
        // One retry on a transient Graph/storage blip; delta tokens make a
        // re-run idempotent (already-imported eTags are skipped).
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'sharepoint-delta-sync-dispatch': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'sharepoint-policy-pull': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'sharepoint-subscription-renew': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'risk-appetite-monitor': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'risk-snapshot': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'report-delivery': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'dau-mau-aggregator': {
        // Idempotent snapshot refresh — a failed run is harmless; the
        // next 5-min run recomputes from scratch. No retry needed.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 20,
        removeOnFail: 50,
    },
    'onboarding-abandonment-sweep': {
        // Fire-once window means a retry could double-count; keep at 1.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 20,
        removeOnFail: 50,
    },
    'incident-notification-deadlines': {
        // Idempotent (status transitions + dedupeKey'd notifications),
        // so a retry is safe.
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'exception-expiry-monitor': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'retention-sweep': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'vendor-renewal-check': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'vendor-monitoring': {
        // One attempt — the sweep is idempotent (posture events dedupe by
        // fingerprint, findings by sourceRef) and re-runs daily, so a
        // transient failure self-heals on the next cycle without a retry storm
        // against the public breach / TLS feeds.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
    'deadline-monitor': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'evidence-expiry-monitor': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'evidence-stale-review-sweep': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'notification-dispatch': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'sync-pull': {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100, // Important for dedupe: allow same id after completion
        removeOnFail: 500,
    },
    'compliance-snapshot': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'compliance-digest': {
        attempts: 2,
        backoff: { type: 'exponential', delay: 15000 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
    'automation-event-dispatch': {
        // Fire-and-forget per event: a failed dispatch tries a couple
        // of times (transient DB/Redis blips) before landing on the
        // dead-letter list. Aggressive removeOnComplete keeps the
        // queue from filling up under event-heavy tenants.
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 2000,
    },
    'key-rotation': {
        // Do NOT auto-retry: a partial rotation needs operator review.
        // The job is idempotent, so the operator can re-enqueue after
        // investigating; we'd rather they see "this one failed" in the
        // completed-with-errors state than have the queue silently
        // retry and potentially compound the problem.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
    'tenant-dek-rotation': {
        // Same posture as key-rotation: a partial sweep means
        // `Tenant.previousEncryptedDek` is still populated and reads
        // continue working via the dual-DEK fallback. The operator
        // re-enqueues manually after investigating any failure;
        // silent auto-retry could compound a partial-progress bug.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
    'evidence-import': {
        // No auto-retry: an import that hits a safety-bound (zip-bomb,
        // path-traversal, oversize) is a hard reject — auto-retrying
        // would just hammer the same archive against the same checks.
        // Transient failures (storage flakes) leave the staged ZIP
        // intact for the operator to re-enqueue manually after
        // investigating.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 200,
        removeOnFail: 1000,
    },
    'control-test-scheduler': {
        // Tick is a pure read-then-claim — DB optimistic-lock guards
        // against duplicate claims if a tick crashes mid-flight and
        // BullMQ retries. Two attempts gives one retry on a transient
        // Redis/DB blip; beyond that the next 5-minute tick will
        // catch up so further retries just add log noise.
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'control-test-runner': {
        // Per-plan execution. Two attempts handles a transient
        // integration / DB blip; the jobId is keyed to the
        // `scheduledForIso` instant so a retry that completes after
        // the next scheduler tick has already enqueued the next
        // window's job will not overlap.
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
    },
    'compliance-posture-summary': {
        // Idempotent upsert of one cached row — a failed run self-heals on
        // the next daily fan-out, so no retry storm against the (optional) LLM.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
    'compliance-posture-summary-dispatch': {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
};

/** The single queue name used for all jobs (BullMQ supports named jobs within a queue) */
export const QUEUE_NAME = 'inflect-jobs';
