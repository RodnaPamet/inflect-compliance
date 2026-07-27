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
 */
import { RequestContext } from '../types';
import type { PrismaTx } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability/logger';
import { computeNextDueAt } from '../utils/cadence';

/** The statuses that trigger source reconciliation. CANCELED is
 *  deliberately excluded — cancelling a task did not remediate. */
const RECONCILE_STATUSES = new Set(['RESOLVED', 'CLOSED']);

type TaskMetadata = { testPlanId?: string; testRunId?: string; findingId?: string } | null;

/**
 * Dispatch a terminal task close to its per-source reconciler. Safe to
 * call for any task/status — it no-ops unless the status is terminal
 * (RESOLVED/CLOSED) and the task actually points at a reconcilable source.
 *
 * NOT fail-open. This function has no try/catch, and that is deliberate: it
 * runs INSIDE the caller's tenant transaction (see `setTaskStatus`), so a
 * reconciler failure rolls the status change back with it. The alternative —
 * swallowing the error — would leave a task closed while its source still
 * shows the gap open, which is precisely the drift the reconciler exists to
 * prevent. A missing or foreign source is not an error and no-ops silently;
 * only a genuine write failure propagates.
 *
 * (An earlier version of this comment claimed the opposite — "never throws …
 * best-effort and logged" — while the code has always propagated. The code
 * matches the atomicity `setTaskStatus` documents, so the comment was the
 * side that was wrong.)
 */
export async function reconcileTaskSource(
    db: PrismaTx,
    ctx: RequestContext,
    taskId: string,
    status: string,
): Promise<void> {
    if (!RECONCILE_STATUSES.has(status)) return;

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
    if (!task) return;
    const metadata = (task.metadataJson ?? null) as TaskMetadata;

    // Reconciler 2 — vulnerability. Keyed on `remediationTaskId`, NOT
    // on task.type (vuln remediation tasks are plain type='TASK'), so
    // this lookup runs for every terminal task.
    await reconcileVulnerability(db, ctx, taskId);

    // Reconciler 4 — risk-appetite breach. Keyed on the breach's
    // `remediationTaskId` FK (same shape as vuln — the breach task is a
    // plain type='TASK', source='RISK_MONITOR'), so it runs for every
    // terminal task and resolves the breach the task was raised for.
    await reconcileRiskAppetiteBreach(db, ctx, taskId);

    // Reconciler 5 — KRI breach. Keyed on the breaching KriReading's
    // `remediationTaskId` FK, marking it addressed on task close.
    await reconcileKriBreach(db, ctx, taskId);

    // Reconciler 1 — CONTROL_GAP → reflect a re-check on the control.
    // NB NIS2 gap-lifecycle plain-TASK remediations are type='CONTROL_GAP'
    // with controlId=null (no CONTROL_LINK approval): they intentionally
    // DO NOT reconcile here — the gap self-assessment answer is the
    // source of truth, and closing the nudge task must not silently flip
    // an unanswered self-assessment. Only NIS2 CONTROL_LINK remediations
    // (real controlId) re-attest their control below.
    if (task.type === 'CONTROL_GAP' && task.controlId) {
        await reconcileControlGap(db, ctx, taskId, task.controlId, metadata);
    }

    // Reconciler 6 — policy-review reminder. Keyed on source; advances
    // the linked policy's review cycle (mirrors markPolicyReviewed).
    if (task.source === 'POLICY_REVIEW') {
        await reconcilePolicyReview(db, ctx, taskId);
    }

    // Reconciler 7 — evidence-expiry reminder. Keyed on source; records
    // the refresh acknowledgement + services the review cadence.
    if (task.source === 'EVIDENCE_EXPIRY') {
        await reconcileEvidenceExpiry(db, ctx, taskId);
    }

    // Reconciler 3 — close the linked Finding. Keyed on the FK (with a
    // metadataJson fallback for legacy rows) rather than task.type, so
    // BOTH audit AUDIT_FINDING tasks AND NIS2 CONTROL_GAP tasks (which
    // also carry a findingId) close their finding on terminal close.
    const findingId = task.findingId ?? metadata?.findingId ?? null;
    if (findingId) await reconcileFinding(db, ctx, taskId, findingId);
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
    taskId: string,
    controlId: string,
    metadata: TaskMetadata,
): Promise<void> {
    const control = await db.control.findFirst({
        where: { id: controlId, tenantId: ctx.tenantId },
        select: { id: true, frequency: true, applicability: true },
    });
    // NOT_APPLICABLE controls (or a foreign/missing control) get no
    // re-attestation — nothing to reflect.
    if (!control || control.applicability === 'NOT_APPLICABLE') return;

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
    taskId: string,
): Promise<void> {
    const vuln = await db.assetVulnerability.findFirst({
        where: { remediationTaskId: taskId, tenantId: ctx.tenantId },
        select: { id: true, status: true },
    });
    if (!vuln) return;
    // Only advance from an active state — never regress ACCEPTED /
    // FALSE_POSITIVE / already-MITIGATED.
    if (vuln.status !== 'OPEN' && vuln.status !== 'MITIGATING') return;

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

    logger.info('task-source-reconcile: vulnerability mitigated', {
        taskId,
        vulnerabilityId: vuln.id,
    });
}

// ─── Reconciler 3 — AUDIT_FINDING → close the Finding ───────────────

async function reconcileFinding(
    db: PrismaTx,
    ctx: RequestContext,
    taskId: string,
    findingId: string,
): Promise<void> {
    const finding = await db.finding.findFirst({
        where: { id: findingId, tenantId: ctx.tenantId },
        select: { id: true, status: true },
    });
    if (!finding || finding.status === 'CLOSED') return;

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
    taskId: string,
): Promise<void> {
    const breach = await db.riskAppetiteBreach.findFirst({
        where: { remediationTaskId: taskId, tenantId: ctx.tenantId, resolvedAt: null },
        select: { id: true, breachType: true },
    });
    if (!breach) return;

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
    taskId: string,
): Promise<void> {
    const reading = await db.kriReading.findFirst({
        where: { remediationTaskId: taskId, tenantId: ctx.tenantId, addressedAt: null },
        select: { id: true, kriId: true },
    });
    if (!reading) return;

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
// policy's review cycle exactly as `markPolicyReviewed` does
// (lastReviewedAt = now, nextReviewAt = now + reviewFrequencyDays) —
// inlined on `db` so it commits atomically with the task close.

async function reconcilePolicyReview(
    db: PrismaTx,
    ctx: RequestContext,
    taskId: string,
): Promise<void> {
    const link = await db.taskLink.findFirst({
        where: { taskId, tenantId: ctx.tenantId, entityType: 'POLICY' },
        select: { entityId: true },
    });
    if (!link) return;

    const policy = await db.policy.findFirst({
        where: { id: link.entityId, tenantId: ctx.tenantId },
        select: { id: true, reviewFrequencyDays: true },
    });
    if (!policy) return;

    const now = new Date();
    const nextReviewAt = policy.reviewFrequencyDays
        ? new Date(now.getTime() + policy.reviewFrequencyDays * 86_400_000)
        : null;

    await db.policy.update({
        where: { id: policy.id },
        data: { lastReviewedAt: now, nextReviewAt },
    });

    await logEvent(db, ctx, {
        action: 'POLICY_REVIEWED',
        entityType: 'Policy',
        entityId: policy.id,
        details: `Policy review cycle advanced on reminder-task close${nextReviewAt ? `; next review ${nextReviewAt.toISOString().slice(0, 10)}` : ''}`,
        detailsJson: {
            category: 'status_change',
            entityName: 'Policy',
            operation: 'reviewed',
            after: {
                lastReviewedAt: now.toISOString(),
                nextReviewAt: nextReviewAt?.toISOString() ?? null,
            },
            summary: 'Policy marked reviewed on reminder-task close',
        },
        metadata: { taskId, policyId: policy.id },
    });

    logger.info('task-source-reconcile: policy review advanced', {
        taskId,
        policyId: policy.id,
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
    taskId: string,
): Promise<void> {
    const link = await db.taskLink.findFirst({
        where: { taskId, tenantId: ctx.tenantId, entityType: 'EVIDENCE' },
        select: { entityId: true },
    });
    if (!link) return;

    const evidence = await db.evidence.findFirst({
        where: { id: link.entityId, tenantId: ctx.tenantId },
        select: { id: true, reviewCycle: true },
    });
    if (!evidence) return;

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

    logger.info('task-source-reconcile: evidence refresh acknowledged', {
        taskId,
        evidenceId: evidence.id,
    });
}
