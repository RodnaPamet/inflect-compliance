/**
 * Control Test audit event emitters.
 *
 * Each function writes an audit-log entry and publishes a matching
 * automation-bus event so rule dispatchers can react without the
 * usecase knowing either consumer exists.
 */
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { logEvent } from './audit';
import { emitAutomationEvent } from '../automation';

// ─── Test Plan Events ───

export async function emitTestPlanCreated(db: PrismaTx, ctx: RequestContext, plan: { id: string; name: string; controlId: string }) {
    await logEvent(db, ctx, {
        action: 'TEST_PLAN_CREATED',
        entityType: 'ControlTestPlan',
        entityId: plan.id,
        details: `Created test plan "${plan.name}" for control ${plan.controlId}`,
    });
    await emitAutomationEvent(ctx, {
        event: 'TEST_PLAN_CREATED',
        entityType: 'ControlTestPlan',
        entityId: plan.id,
        actorUserId: ctx.userId,
        data: { name: plan.name, controlId: plan.controlId },
    });
}

export async function emitTestPlanUpdated(db: PrismaTx, ctx: RequestContext, planId: string, changes: Record<string, unknown>) {
    await logEvent(db, ctx, {
        action: 'TEST_PLAN_UPDATED',
        entityType: 'ControlTestPlan',
        entityId: planId,
        details: `Updated test plan fields: ${Object.keys(changes).join(', ')}`,
    });
    await emitAutomationEvent(ctx, {
        event: 'TEST_PLAN_UPDATED',
        entityType: 'ControlTestPlan',
        entityId: planId,
        actorUserId: ctx.userId,
        data: { changedFields: Object.keys(changes) },
    });
}

/**
 * PR-E — the pause/resume automation event for a status transition, or null
 * when it isn't one. RESUMED is ONLY a transition OUT of PAUSED (previously it
 * fired for any non-PAUSED target, e.g. ACTIVE→ARCHIVED, which was wrong).
 */
export function testPlanPauseResumeAction(
    oldStatus: string,
    newStatus: string,
): 'TEST_PLAN_PAUSED' | 'TEST_PLAN_RESUMED' | null {
    if (newStatus === 'PAUSED') return 'TEST_PLAN_PAUSED';
    if (oldStatus === 'PAUSED') return 'TEST_PLAN_RESUMED';
    return null;
}

/**
 * PR-E — fire ONLY the pause/resume automation event (no audit row). Used by
 * the bulk status path, which writes its own audit. No-op for a non-pause/
 * resume change, so a bulk ACTIVE→ARCHIVED never emits a spurious RESUMED.
 */
export async function emitTestPlanStatusAutomationEvent(
    ctx: RequestContext,
    planId: string,
    oldStatus: string,
    newStatus: string,
) {
    const action = testPlanPauseResumeAction(oldStatus, newStatus);
    if (!action) return;
    await emitAutomationEvent(ctx, {
        event: action,
        entityType: 'ControlTestPlan',
        entityId: planId,
        actorUserId: ctx.userId,
        data: { fromStatus: oldStatus, toStatus: newStatus },
    });
}

export async function emitTestPlanStatusChanged(db: PrismaTx, ctx: RequestContext, planId: string, oldStatus: string, newStatus: string) {
    // Only ever called for a genuine pause/resume transition (the caller
    // gates), so this maps cleanly: →PAUSED = paused, PAUSED→ = resumed.
    const action = newStatus === 'PAUSED' ? 'TEST_PLAN_PAUSED' : 'TEST_PLAN_RESUMED';
    await logEvent(db, ctx, {
        action,
        entityType: 'ControlTestPlan',
        entityId: planId,
        details: `Test plan status changed from ${oldStatus} to ${newStatus}`,
    });
    await emitAutomationEvent(ctx, {
        event: action,
        entityType: 'ControlTestPlan',
        entityId: planId,
        actorUserId: ctx.userId,
        data: { fromStatus: oldStatus, toStatus: newStatus },
    });
}

// ─── Test Run Events ───

export async function emitTestRunCreated(db: PrismaTx, ctx: RequestContext, run: { id: string; testPlanId: string }) {
    await logEvent(db, ctx, {
        action: 'TEST_RUN_CREATED',
        entityType: 'ControlTestRun',
        entityId: run.id,
        details: `Created test run for plan ${run.testPlanId}`,
    });
    await emitAutomationEvent(ctx, {
        event: 'TEST_RUN_CREATED',
        entityType: 'ControlTestRun',
        entityId: run.id,
        actorUserId: ctx.userId,
        data: { testPlanId: run.testPlanId },
    });
}

export async function emitTestRunCompleted(db: PrismaTx, ctx: RequestContext, run: { id: string; result: string; testPlanId: string }) {
    await logEvent(db, ctx, {
        action: 'TEST_RUN_COMPLETED',
        entityType: 'ControlTestRun',
        entityId: run.id,
        details: `Test run completed with result: ${run.result}`,
        metadata: { result: run.result, testPlanId: run.testPlanId },
    });
    await emitAutomationEvent(ctx, {
        event: 'TEST_RUN_COMPLETED',
        entityType: 'ControlTestRun',
        entityId: run.id,
        actorUserId: ctx.userId,
        data: { testPlanId: run.testPlanId, result: run.result },
    });
}

export async function emitTestRunFailed(db: PrismaTx, ctx: RequestContext, run: { id: string; findingSummary?: string | null }) {
    await logEvent(db, ctx, {
        action: 'TEST_RUN_FAILED',
        entityType: 'ControlTestRun',
        entityId: run.id,
        details: `Test run FAILED${run.findingSummary ? `: ${run.findingSummary}` : ''}`,
    });
    await emitAutomationEvent(ctx, {
        event: 'TEST_RUN_FAILED',
        entityType: 'ControlTestRun',
        entityId: run.id,
        actorUserId: ctx.userId,
        data: { findingSummary: run.findingSummary ?? null },
    });
}

// ─── Test Evidence Events ───

export async function emitTestEvidenceLinked(db: PrismaTx, ctx: RequestContext, link: { id: string; testRunId: string; kind: string }) {
    await logEvent(db, ctx, {
        action: 'TEST_EVIDENCE_LINKED',
        entityType: 'ControlTestEvidenceLink',
        entityId: link.id,
        details: `${link.kind} evidence linked to test run ${link.testRunId}`,
    });
    await emitAutomationEvent(ctx, {
        event: 'TEST_EVIDENCE_LINKED',
        entityType: 'ControlTestEvidenceLink',
        entityId: link.id,
        actorUserId: ctx.userId,
        data: { testRunId: link.testRunId, kind: link.kind },
    });
}

export async function emitTestEvidenceUnlinked(
    db: PrismaTx,
    ctx: RequestContext,
    linkId: string,
    testRunId: string,
    // The unlink hard-deletes the row (incl. the frozen sha256Hash), so the
    // destroyed fields are recorded here — the deletion stays reconstructible
    // from the audit trail even though the link row is gone.
    destroyed?: { kind: string; fileId: string | null; sha256Hash: string | null },
) {
    await logEvent(db, ctx, {
        action: 'TEST_EVIDENCE_UNLINKED',
        entityType: 'ControlTestEvidenceLink',
        entityId: linkId,
        details: `Evidence unlinked from test run ${testRunId}`,
        detailsJson: {
            category: 'relationship',
            testRunId,
            ...(destroyed
                ? {
                      destroyedLink: {
                          kind: destroyed.kind,
                          fileId: destroyed.fileId,
                          sha256Hash: destroyed.sha256Hash,
                      },
                  }
                : {}),
        },
    });
    await emitAutomationEvent(ctx, {
        event: 'TEST_EVIDENCE_UNLINKED',
        entityType: 'ControlTestEvidenceLink',
        entityId: linkId,
        actorUserId: ctx.userId,
        data: { testRunId },
    });
}
