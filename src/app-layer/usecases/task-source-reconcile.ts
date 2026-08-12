/**
 * Task → source reconciliation (Tasks roadmap TP-3).
 *
 * Auto-created tasks are one-way today: a control-test failure, an
 * asset vulnerability, or an audit finding spawns a remediation Task,
 * but COMPLETING that task writes only the task's own row — the source
 * that raised it stays silently open. That is a compliance-correctness
 * bug: an auditor reading the control / vulnerability / finding sees a
 * gap that was, in fact, remediated.
 *
 * `reconcileTaskSource` closes the loop. It is called from
 * `setTaskStatus` + `bulkSetTaskStatus` AFTER the task's own status
 * write + audit, ONLY when the task reaches a terminal RESOLVED/CLOSED
 * state (NOT CANCELED — a cancelled task did not fix anything, so its
 * source must stay open).
 *
 * Every reconciler writes directly on the SAME tenant transaction
 * (`db` from the caller's `runInTenantContext`) so the source mutation
 * commits atomically with the task close, and audits its write via
 * `logEvent`. None of them re-enter `runInTenantContext` (that would
 * open a second, non-atomic transaction).
 *
 * ─── Dispatch model: POINTER-DRIVEN, not provenance-driven ──────────
 *
 * `Task.source` (TaskSource) is NOT the discriminator, and this file
 * deliberately does not pretend otherwise. It CANNOT be, as the schema
 * stands:
 *
 *   • The enum has seven members — MANUAL, TEMPLATE, POLICY_REVIEW,
 *     AUDIT, INTEGRATION, EVIDENCE_EXPIRY, RISK_MONITOR — and there is
 *     no member for a vulnerability remediation or a control gap.
 *   • `RISK_MONITOR` is ambiguous: BOTH the risk-appetite-breach
 *     reconciler and the KRI-breach reconciler would claim it.
 *   • The real vulnerability producer (`usecases/vulnerability.ts`,
 *     `openVulnerabilityRemediationTask`) writes `source: 'MANUAL'`.
 *     Dispatching vulnerabilities on `source` would silently stop
 *     reconciling every vulnerability task, past and future.
 *
 * So the authoritative signal is the POINTER that ties a task to its
 * source, and there are two kinds:
 *
 *   1. EXCLUSIVE back-pointers — `AssetVulnerability.remediationTaskId`,
 *      `RiskAppetiteBreach.remediationTaskId`,
 *      `KriReading.remediationTaskId`, `Task.findingId`. A row only ever
 *      points at the one task raised to fix it, so the pointer's
 *      existence IS the provenance. These reconcilers take NO further
 *      discriminator. Cost: the three back-pointer lookups are a
 *      by-table probe per terminal close — inherent to storing the
 *      pointer on the source side rather than on Task.
 *
 *   2. NON-EXCLUSIVE associations — `Task.controlId` and `TaskLink`
 *      rows. A task may be linked to a control/policy/evidence for any
 *      reason (a "reword this policy" task is linked to that policy but
 *      must NOT reset its review clock). These need a second
 *      discriminator, and that is the ONLY job `Task.type` /
 *      `Task.source` do here: `type === 'CONTROL_GAP'`,
 *      `source === 'POLICY_REVIEW'`, `source === 'EVIDENCE_EXPIRY'`.
 *
 * Making `source` authoritative across the board would need new enum
 * members, a data backfill of every existing task row, and a producer
 * audit — a schema change, not a dispatch change.
 *
 * ─── Every exit is observable ───────────────────────────────────────
 *
 * A reconciler that finds nothing used to `return;` with no log, no
 * metric, and no trace on the response — so closing a policy-review task
 * whose policy had been purged reported full success. Every one of the
 * twelve early exits now goes through `recordSkip`, which logs, counts
 * (in-process + OTel), and records the skip on the returned
 * `ReconcileOutcome`. `MISSING_TARGET` skips (provenance says this
 * reconciler applies, but the target could not be reconciled) log at
 * WARN and are the alertable signal; `NOT_APPLICABLE` skips (this
 * reconciler simply does not apply to this task) log at DEBUG so they
 * do not drown the WARNs — they are still counted and still returned.
 */
import { metrics } from '@opentelemetry/api';
import { RequestContext } from '../types';
import type { PrismaTx } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability/logger';
import { computeNextDueAt } from '../utils/cadence';
import { applyPolicyReviewed } from './policy';

/** The statuses that trigger source reconciliation. CANCELED is
 *  deliberately excluded — cancelling a task did not remediate. */
const RECONCILE_STATUSES = new Set(['RESOLVED', 'CLOSED']);

type TaskMetadata = { testPlanId?: string; testRunId?: string; findingId?: string } | null;

/** The reconcilers, plus the dispatcher itself for its own two exits. */
export type ReconcilerName =
    | 'dispatch'
    | 'control_gap'
    | 'vulnerability'
    | 'finding'
    | 'risk_appetite_breach'
    | 'kri_breach'
    | 'policy_review'
    | 'evidence_expiry';

/**
 * One entry per early exit in this file. The union is exhaustive by
 * construction: adding a `return` without adding a reason here is a type
 * error at the `recordSkip` call site.
 */
export type ReconcileSkipReason =
    | 'status_not_terminal'
    | 'task_not_found'
    | 'control_missing_or_not_applicable'
    | 'vulnerability_pointer_absent'
    | 'vulnerability_not_active'
    | 'finding_missing_or_already_closed'
    | 'appetite_breach_pointer_absent'
    | 'kri_reading_pointer_absent'
    | 'policy_link_absent'
    | 'policy_missing'
    | 'evidence_link_absent'
    | 'evidence_missing';

/**
 * MISSING_TARGET — the pointer/provenance says this reconciler applies,
 * but the source could not be reconciled (purged, foreign, or already
 * closed). This is the drift the reconciler exists to prevent, so it is
 * a WARN and worth alerting on.
 *
 * NOT_APPLICABLE — this reconciler does not apply to this task, or the
 * target is deliberately left alone. Expected on the common path (every
 * ordinary task close probes the three back-pointer tables and finds
 * nothing), so DEBUG — still counted, still on the outcome.
 */
export const SKIP_SEVERITY: Readonly<Record<ReconcileSkipReason, 'MISSING_TARGET' | 'NOT_APPLICABLE'>> = {
    status_not_terminal: 'NOT_APPLICABLE',
    task_not_found: 'MISSING_TARGET',
    control_missing_or_not_applicable: 'MISSING_TARGET',
    vulnerability_pointer_absent: 'NOT_APPLICABLE',
    vulnerability_not_active: 'NOT_APPLICABLE',
    finding_missing_or_already_closed: 'MISSING_TARGET',
    appetite_breach_pointer_absent: 'NOT_APPLICABLE',
    kri_reading_pointer_absent: 'NOT_APPLICABLE',
    policy_link_absent: 'MISSING_TARGET',
    policy_missing: 'MISSING_TARGET',
    evidence_link_absent: 'MISSING_TARGET',
    evidence_missing: 'MISSING_TARGET',
} as const;

export interface ReconcileSkip {
    reconciler: ReconcilerName;
    reason: ReconcileSkipReason;
    severity: 'MISSING_TARGET' | 'NOT_APPLICABLE';
}

/** What the close actually did. Callers may ignore it; the audit trail
 *  and metrics carry the same information. */
export interface ReconcileOutcome {
    taskId: string;
    /** Reconcilers that wrote to their source. */
    applied: ReconcilerName[];
    /** Every early exit taken, with its reason. Never silently empty. */
    skipped: ReconcileSkip[];
}

// ─── Counters ───────────────────────────────────────────────────────
//
// OTel counters for production alerting, plus an in-process tally the
// behavioural tests read back (an OTel counter is write-only without a
// configured exporter).

const METER_NAME = 'inflect-compliance';
let _skipCounter: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | null = null;
let _appliedCounter: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | null = null;

function skipCounter() {
    if (!_skipCounter) {
        _skipCounter = metrics.getMeter(METER_NAME).createCounter('task.source_reconcile.skip', {
            description: 'Task→source reconciliation early exits, by reconciler and reason',
        });
    }
    return _skipCounter;
}

function appliedCounter() {
    if (!_appliedCounter) {
        _appliedCounter = metrics.getMeter(METER_NAME).createCounter('task.source_reconcile.applied', {
            description: 'Task→source reconciliation writes, by reconciler',
        });
    }
    return _appliedCounter;
}

const _tally = new Map<string, number>();

function bump(key: string): void {
    _tally.set(key, (_tally.get(key) ?? 0) + 1);
}

/** In-process reconciliation tally, keyed `skip:<reconciler>:<reason>`
 *  and `applied:<reconciler>`. Read by the behavioural tests. */
export function readReconcileTally(): Record<string, number> {
    return Object.fromEntries(_tally);
}

/** Reset the in-process tally. Test-only. */
export function resetReconcileTally(): void {
    _tally.clear();
}

/**
 * The single exit point for every early return in this file. Logs,
 * counts, and records the skip on the outcome — there is no way to leave
 * a reconciler without a trace.
 */
function recordSkip(
    out: ReconcileOutcome,
    reconciler: ReconcilerName,
    reason: ReconcileSkipReason,
    fields: Record<string, unknown> = {},
): void {
    const severity = SKIP_SEVERITY[reason];
    out.skipped.push({ reconciler, reason, severity });
    bump(`skip:${reconciler}:${reason}`);
    skipCounter().add(1, { reconciler, reason, severity });

    const msg = `task-source-reconcile: ${reconciler} skipped (${reason})`;
    const payload = { taskId: out.taskId, reconciler, reason, severity, ...fields };
    if (severity === 'MISSING_TARGET') logger.warn(msg, payload);
    else logger.debug(msg, payload);
}

function recordApplied(out: ReconcileOutcome, reconciler: ReconcilerName): void {
    out.applied.push(reconciler);
    bump(`applied:${reconciler}`);
    appliedCounter().add(1, { reconciler });
}

/**
 * Dispatch a terminal task close to its per-source reconciler. Safe to
 * call for any task/status — it no-ops unless the status is terminal
 * (RESOLVED/CLOSED) and the task actually points at a reconcilable source.
 * See the dispatch model in the file header: the POINTER decides, and
 * `type` / `source` only disambiguate non-exclusive associations.
 *
 * NOT fail-open. This function has no try/catch, and that is deliberate: it
 * runs INSIDE the caller's tenant transaction (see `setTaskStatus`), so a
 * reconciler failure rolls the status change back with it. The alternative —
 * swallowing the error — would leave a task closed while its source still
 * shows the gap open, which is precisely the drift the reconciler exists to
 * prevent. A missing or foreign source is not an error: it no-ops, but it is
 * logged, counted, and reported on the returned outcome.
 */
export async function reconcileTaskSource(
    db: PrismaTx,
    ctx: RequestContext,
    taskId: string,
    status: string,
): Promise<ReconcileOutcome> {
    const out: ReconcileOutcome = { taskId, applied: [], skipped: [] };

    // [exit 1/12]
    if (!RECONCILE_STATUSES.has(status)) {
        recordSkip(out, 'dispatch', 'status_not_terminal', { status });
        return out;
    }

    // Load only the reconciliation-relevant fields. RLS + the explicit
    // tenantId filter keep this scoped to the caller's tenant.
    const task = await db.task.findFirst({
        where: { id: taskId, tenantId: ctx.tenantId },
        select: {
            id: true,
            type: true,
            source: true,
            controlId: true,
            findingId: true,
            metadataJson: true,
        },
    });
    // [exit 2/12]
    if (!task) {
        recordSkip(out, 'dispatch', 'task_not_found');
        return out;
    }
    const metadata = (task.metadataJson ?? null) as TaskMetadata;

    // ── Exclusive back-pointers: the pointer IS the provenance ──
    //
    // Reconciler 2 — vulnerability, keyed on
    // `AssetVulnerability.remediationTaskId`. Deliberately NOT gated on
    // `task.source`: the producer writes `source: 'MANUAL'`.
    await reconcileVulnerability(db, ctx, out);

    // Reconciler 4 — risk-appetite breach, keyed on
    // `RiskAppetiteBreach.remediationTaskId`. Not gated on `source`:
    // 'RISK_MONITOR' cannot separate this from the KRI reconciler below.
    await reconcileRiskAppetiteBreach(db, ctx, out);

    // Reconciler 5 — KRI breach, keyed on `KriReading.remediationTaskId`.
    await reconcileKriBreach(db, ctx, out);

    // Reconciler 3 — close the linked Finding, keyed on the `Task.findingId`
    // FK (with a metadataJson fallback for legacy rows). BOTH audit
    // AUDIT_FINDING tasks AND NIS2 CONTROL_GAP tasks carry a findingId, and
    // both must close their finding — which is exactly why `type` is not the
    // discriminator here.
    const findingId = task.findingId ?? metadata?.findingId ?? null;
    if (findingId) await reconcileFinding(db, ctx, out, findingId);

    // ── Non-exclusive associations: pointer + a disambiguator ──
    //
    // Reconciler 1 — CONTROL_GAP → reflect a re-check on the control.
    // `Task.controlId` alone is not enough (a task may reference a control
    // for any reason), so `type === 'CONTROL_GAP'` disambiguates.
    // NB NIS2 gap-lifecycle plain-TASK remediations are type='CONTROL_GAP'
    // with controlId=null (no CONTROL_LINK approval): they intentionally
    // DO NOT reconcile here — the gap self-assessment answer is the
    // source of truth, and closing the nudge task must not silently flip
    // an unanswered self-assessment. Only NIS2 CONTROL_LINK remediations
    // (real controlId) re-attest their control below.
    if (task.type === 'CONTROL_GAP' && task.controlId) {
        await reconcileControlGap(db, ctx, out, task.controlId, metadata);
    }

    // Reconciler 6 — policy-review reminder. A POLICY TaskLink is not
    // exclusive (a "reword this policy" task carries one too and must NOT
    // reset the review clock), so `source === 'POLICY_REVIEW'` is the
    // disambiguator that says "this task IS the review reminder".
    if (task.source === 'POLICY_REVIEW') {
        await reconcilePolicyReview(db, ctx, out);
    }

    // Reconciler 7 — evidence-expiry reminder. Same shape as policy
    // review: EVIDENCE TaskLink + `source === 'EVIDENCE_EXPIRY'`.
    if (task.source === 'EVIDENCE_EXPIRY') {
        await reconcileEvidenceExpiry(db, ctx, out);
    }

    return out;
}

// ─── Reconciler 1 — CONTROL_GAP → control re-check ──────────────────
//
// Closing a control-gap task must not leave the control silently
// "failed forever". Controls carry NO stored verdict — effectiveness
// is computed live from ControlTestRun rows + Control.lastTested. We
// REFLECT the gap closure observably WITHOUT fabricating a PASS
// (closing a task ≠ the control passing):
//
//   • Always stamp the control as re-attested — advance
//     `lastTested = now` + roll `nextDueAt` — so the freshness the
//     health summary / readiness scoring reads moves forward. This
//     mirrors the sanctioned `attestControlTested` helper.
//   • If the originating test plan is automated (has an
//     integration/automation binding), ALSO queue a fresh PLANNED
//     ControlTestRun so the real automated check re-executes and
//     records its own genuine result — a real re-run, not a
//     synthesised verdict.

async function reconcileControlGap(
    db: PrismaTx,
    ctx: RequestContext,
    out: ReconcileOutcome,
    controlId: string,
    metadata: TaskMetadata,
): Promise<void> {
    const taskId = out.taskId;
    const control = await db.control.findFirst({
        where: { id: controlId, tenantId: ctx.tenantId },
        select: { id: true, frequency: true, applicability: true },
    });
    // NOT_APPLICABLE controls (or a foreign/missing control) get no
    // re-attestation — nothing to reflect.
    // [exit 3/12]
    if (!control || control.applicability === 'NOT_APPLICABLE') {
        recordSkip(out, 'control_gap', 'control_missing_or_not_applicable', {
            controlId,
            found: Boolean(control),
            applicability: control?.applicability ?? null,
        });
        return;
    }

    // Is the originating plan automated? Look it up from the task's
    // metadata pointer. Absent plan / manual plan → attestation only.
    let automated = false;
    let planId: string | null = null;
    if (metadata?.testPlanId) {
        const plan = await db.controlTestPlan.findFirst({
            where: { id: metadata.testPlanId, tenantId: ctx.tenantId },
            select: { id: true, method: true, automationType: true },
        });
        if (plan) {
            planId = plan.id;
            automated = plan.automationType !== 'MANUAL' || plan.method === 'AUTOMATED';
        }
    }

    const now = new Date();
    await db.control.update({
        where: { id: control.id },
        data: { lastTested: now, nextDueAt: computeNextDueAt(control.frequency, now) },
    });

    let requeuedRunId: string | null = null;
    if (automated && planId) {
        const run = await db.controlTestRun.create({
            data: {
                tenantId: ctx.tenantId,
                controlId: control.id,
                testPlanId: planId,
                status: 'PLANNED',
                createdByUserId: ctx.userId,
                requestId: ctx.requestId,
            },
            select: { id: true },
        });
        requeuedRunId = run.id;
    }

    await logEvent(db, ctx, {
        action: 'CONTROL_GAP_TASK_RECONCILED',
        entityType: 'Control',
        entityId: control.id,
        details: requeuedRunId
            ? `Control re-check queued (automated) on gap-task close`
            : `Control re-test attestation recorded on gap-task close`,
        detailsJson: {
            category: 'custom',
            event: 'control_gap_task_reconciled',
            automated,
        },
        metadata: { taskId, controlId: control.id, requeuedRunId, testPlanId: planId },
    });

    recordApplied(out, 'control_gap');
    logger.info('task-source-reconcile: control gap reflected', {
        taskId,
        controlId: control.id,
        automated,
        requeuedRunId,
    });
}

// ─── Reconciler 2 — vulnerability → advance the AssetVulnerability ──

async function reconcileVulnerability(
    db: PrismaTx,
    ctx: RequestContext,
    out: ReconcileOutcome,
): Promise<void> {
    const taskId = out.taskId;
    const vuln = await db.assetVulnerability.findFirst({
        where: { remediationTaskId: taskId, tenantId: ctx.tenantId },
        select: { id: true, status: true },
    });
    // [exit 4/12]
    if (!vuln) {
        recordSkip(out, 'vulnerability', 'vulnerability_pointer_absent');
        return;
    }
    // Only advance from an active state — never regress ACCEPTED /
    // FALSE_POSITIVE / already-MITIGATED.
    // [exit 5/12]
    if (vuln.status !== 'OPEN' && vuln.status !== 'MITIGATING') {
        recordSkip(out, 'vulnerability', 'vulnerability_not_active', {
            vulnerabilityId: vuln.id,
            status: vuln.status,
        });
        return;
    }

    const updated = await db.assetVulnerability.update({
        where: { id: vuln.id },
        data: { status: 'MITIGATED' },
    });

    await logEvent(db, ctx, {
        action: 'ASSET_VULNERABILITY_UPDATED',
        entityType: 'AssetVulnerability',
        entityId: vuln.id,
        details: `Vulnerability status ${vuln.status} → ${updated.status} on remediation-task close`,
        detailsJson: {
            category: 'status_change',
            entityName: 'AssetVulnerability',
            fromStatus: vuln.status,
            toStatus: updated.status,
        },
        metadata: { taskId, from: vuln.status, to: updated.status },
    });

    recordApplied(out, 'vulnerability');
    logger.info('task-source-reconcile: vulnerability mitigated', {
        taskId,
        vulnerabilityId: vuln.id,
    });
}

// ─── Reconciler 3 — AUDIT_FINDING → close the Finding ───────────────

async function reconcileFinding(
    db: PrismaTx,
    ctx: RequestContext,
    out: ReconcileOutcome,
    findingId: string,
): Promise<void> {
    const taskId = out.taskId;
    const finding = await db.finding.findFirst({
        where: { id: findingId, tenantId: ctx.tenantId },
        select: { id: true, status: true },
    });
    // [exit 6/12]
    if (!finding || finding.status === 'CLOSED') {
        recordSkip(out, 'finding', 'finding_missing_or_already_closed', {
            findingId,
            found: Boolean(finding),
            status: finding?.status ?? null,
        });
        return;
    }

    const now = new Date();
    await db.finding.update({
        where: { id: finding.id },
        data: {
            status: 'CLOSED',
            verifiedBy: ctx.userId,
            verifiedAt: now,
        },
    });

    await logEvent(db, ctx, {
        action: 'STATUS_CHANGE',
        entityType: 'Finding',
        entityId: finding.id,
        details: `${finding.status} → CLOSED on remediation-task close`,
        detailsJson: {
            category: 'status_change',
            entityName: 'Finding',
            fromStatus: finding.status,
            toStatus: 'CLOSED',
        },
        metadata: { taskId, from: finding.status, to: 'CLOSED' },
    });

    recordApplied(out, 'finding');
    logger.info('task-source-reconcile: finding closed', {
        taskId,
        findingId: finding.id,
    });
}

// ─── Reconciler 4 — risk-appetite breach → resolve the breach ───────
//
// A RISK_MONITOR remediation task raised from a RiskAppetiteBreach pins
// itself on `breach.remediationTaskId`. Closing that task means the
// breach was worked, so stamp `resolvedAt` — the admin breach table +
// telemetry then read the breach as closed instead of silently-open.
// Never regress an already-resolved breach.

async function reconcileRiskAppetiteBreach(
    db: PrismaTx,
    ctx: RequestContext,
    out: ReconcileOutcome,
): Promise<void> {
    const taskId = out.taskId;
    const breach = await db.riskAppetiteBreach.findFirst({
        where: { remediationTaskId: taskId, tenantId: ctx.tenantId, resolvedAt: null },
        select: { id: true, breachType: true },
    });
    // [exit 7/12]
    if (!breach) {
        recordSkip(out, 'risk_appetite_breach', 'appetite_breach_pointer_absent');
        return;
    }

    const now = new Date();
    await db.riskAppetiteBreach.update({
        where: { id: breach.id },
        data: { resolvedAt: now },
    });

    await logEvent(db, ctx, {
        action: 'RISK_APPETITE_BREACH_RECONCILED',
        entityType: 'RiskAppetiteBreach',
        entityId: breach.id,
        details: `Appetite breach (${breach.breachType}) resolved on remediation-task close`,
        detailsJson: {
            category: 'status_change',
            entityName: 'RiskAppetiteBreach',
            toStatus: 'RESOLVED',
        },
        metadata: { taskId, breachId: breach.id, breachType: breach.breachType },
    });

    recordApplied(out, 'risk_appetite_breach');
    logger.info('task-source-reconcile: risk-appetite breach resolved', {
        taskId,
        breachId: breach.id,
    });
}

// ─── Reconciler 5 — KRI breach → mark the reading addressed ─────────
//
// A RED-transition reading pins its remediation task on
// `KriReading.remediationTaskId`. Closing the task stamps `addressedAt`
// — the KRI history + re-assess nudge then reflect that the breach was
// worked. Non-destructive: never touches the reading value/rag.

async function reconcileKriBreach(
    db: PrismaTx,
    ctx: RequestContext,
    out: ReconcileOutcome,
): Promise<void> {
    const taskId = out.taskId;
    const reading = await db.kriReading.findFirst({
        where: { remediationTaskId: taskId, tenantId: ctx.tenantId, addressedAt: null },
        select: { id: true, kriId: true },
    });
    // [exit 8/12]
    if (!reading) {
        recordSkip(out, 'kri_breach', 'kri_reading_pointer_absent');
        return;
    }

    const now = new Date();
    await db.kriReading.update({
        where: { id: reading.id },
        data: { addressedAt: now },
    });

    await logEvent(db, ctx, {
        action: 'KRI_BREACH_RECONCILED',
        entityType: 'KeyRiskIndicator',
        entityId: reading.kriId,
        details: `KRI breach marked addressed on remediation-task close`,
        detailsJson: {
            category: 'status_change',
            entityName: 'KeyRiskIndicator',
            toStatus: 'ADDRESSED',
        },
        metadata: { taskId, kriId: reading.kriId, readingId: reading.id },
    });

    recordApplied(out, 'kri_breach');
    logger.info('task-source-reconcile: KRI breach addressed', {
        taskId,
        kriId: reading.kriId,
        readingId: reading.id,
    });
}

// ─── Reconciler 6 — policy-review reminder → advance the review ─────
//
// A POLICY_REVIEW reminder task is linked to its policy via a POLICY
// TaskLink. Closing the task means the review happened, so advance the
// policy's review cycle — by CALLING the shared `applyPolicyReviewed`
// that `markPolicyReviewed` also calls, on the caller's transaction so it
// still commits atomically with the task close.
//
// This used to be an inline copy of the cadence rule, and it had drifted:
// it wrote `nextReviewAt = null` for a policy with a manually-set review
// date and no cadence, dropping that policy out of
// `processOverdueReminders`' `nextReviewAt: { not: null }` predicate
// forever. Sharing the function makes that class of drift impossible.

async function reconcilePolicyReview(
    db: PrismaTx,
    ctx: RequestContext,
    out: ReconcileOutcome,
): Promise<void> {
    const taskId = out.taskId;
    const link = await db.taskLink.findFirst({
        where: { taskId, tenantId: ctx.tenantId, entityType: 'POLICY' },
        select: { entityId: true },
    });
    // [exit 9/12]
    if (!link) {
        recordSkip(out, 'policy_review', 'policy_link_absent');
        return;
    }

    const policy = await db.policy.findFirst({
        where: { id: link.entityId, tenantId: ctx.tenantId },
        select: { id: true, reviewFrequencyDays: true, nextReviewAt: true },
    });
    // [exit 10/12]
    if (!policy) {
        recordSkip(out, 'policy_review', 'policy_missing', { policyId: link.entityId });
        return;
    }

    const { nextReviewAt } = await applyPolicyReviewed(db, ctx, policy, {
        trigger: 'reminder_task_close',
        taskId,
    });

    recordApplied(out, 'policy_review');
    logger.info('task-source-reconcile: policy review advanced', {
        taskId,
        policyId: policy.id,
        nextReviewAt: nextReviewAt?.toISOString() ?? null,
    });
}

// ─── Reconciler 7 — evidence-expiry reminder → service the review ───
//
// An EVIDENCE_EXPIRY reminder task is linked to its evidence via an
// EVIDENCE TaskLink. Closing the task means the owner attended to the
// expiring evidence. We record the acknowledgement and — if the evidence
// carries a review cadence — service that cadence by rolling
// `nextReviewDate` forward. We deliberately DO NOT touch `retentionUntil`
// (the real expiry): only a genuine re-upload / extension moves that, so
// the sweep correctly re-raises if the evidence is still expiring.

const EVIDENCE_CADENCE_DAYS: Record<string, number> = {
    MONTHLY: 30,
    QUARTERLY: 91,
    SEMI_ANNUALLY: 182,
    ANNUALLY: 365,
};

async function reconcileEvidenceExpiry(
    db: PrismaTx,
    ctx: RequestContext,
    out: ReconcileOutcome,
): Promise<void> {
    const taskId = out.taskId;
    const link = await db.taskLink.findFirst({
        where: { taskId, tenantId: ctx.tenantId, entityType: 'EVIDENCE' },
        select: { entityId: true },
    });
    // [exit 11/12]
    if (!link) {
        recordSkip(out, 'evidence_expiry', 'evidence_link_absent');
        return;
    }

    const evidence = await db.evidence.findFirst({
        where: { id: link.entityId, tenantId: ctx.tenantId },
        select: { id: true, reviewCycle: true },
    });
    // [exit 12/12]
    if (!evidence) {
        recordSkip(out, 'evidence_expiry', 'evidence_missing', { evidenceId: link.entityId });
        return;
    }

    const now = new Date();
    const cadenceDays = evidence.reviewCycle ? EVIDENCE_CADENCE_DAYS[evidence.reviewCycle] : undefined;
    const nextReviewDate = cadenceDays ? new Date(now.getTime() + cadenceDays * 86_400_000) : undefined;

    if (nextReviewDate) {
        await db.evidence.update({
            where: { id: evidence.id },
            data: { nextReviewDate },
        });
    }

    await logEvent(db, ctx, {
        action: 'EVIDENCE_EXPIRY_RECONCILED',
        entityType: 'Evidence',
        entityId: evidence.id,
        details: `Evidence refresh acknowledged on reminder-task close${nextReviewDate ? `; next review ${nextReviewDate.toISOString().slice(0, 10)}` : ''}`,
        detailsJson: {
            category: 'custom',
            event: 'evidence_expiry_task_reconciled',
        },
        metadata: { taskId, evidenceId: evidence.id, nextReviewDate: nextReviewDate?.toISOString() ?? null },
    });

    recordApplied(out, 'evidence_expiry');
    logger.info('task-source-reconcile: evidence refresh acknowledged', {
        taskId,
        evidenceId: evidence.id,
    });
}
