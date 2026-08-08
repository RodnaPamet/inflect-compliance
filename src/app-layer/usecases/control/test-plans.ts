/**
 * Control Test usecases — test plan lifecycle, test run execution, evidence linking.
 */
import { RequestContext } from '../../types';
import { TestPlanRepository } from '../../repositories/TestPlanRepository';
import { TestRunRepository } from '../../repositories/TestRunRepository';
import { TestEvidenceRepository } from '../../repositories/TestEvidenceRepository';
import {
    assertCanReadTests,
    assertCanManageTestPlans,
    assertCanExecuteTests,
    assertCanLinkTestEvidence,
    assertCanBulkManageTestPlans,
} from '../../policies/test.policies';
import {
    emitTestPlanCreated,
    emitTestPlanUpdated,
    emitTestPlanStatusChanged,
    emitTestPlanStatusAutomationEvent,
    emitTestRunCreated,
    emitTestRunCompleted,
    emitTestRunFailed,
    emitTestEvidenceLinked,
    emitTestEvidenceUnlinked,
} from '../../events/test.events';
import { logEvent } from '../../events/audit';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { withDeleted } from '@/lib/soft-delete';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { computeNextDueAt } from '../../utils/cadence';
import { computeNextRunFromCron } from '../../jobs/control-test-scheduler';
import { createTask } from '../task';
import { TERMINAL_WORK_ITEM_STATUSES } from '../../domain/work-item-status';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';

/**
 * Idempotency guard for the FAIL → CONTROL_GAP spawn. A re-run of a
 * failing test on the same control + plan must reuse the existing open
 * gap task instead of minting a duplicate every run (mirrors the
 * dedupe in retention-notifications + the automation executor). Scoped
 * per (control, testPlan) via the metadataJson.testPlanId pointer that
 * every spawn writes.
 */
async function hasOpenGapTask(
    db: PrismaTx,
    ctx: RequestContext,
    controlId: string | null,
    testPlanId: string,
): Promise<boolean> {
    if (!controlId) return false;
    const existing = await db.task.findFirst({
        where: {
            tenantId: ctx.tenantId,
            type: 'CONTROL_GAP',
            controlId,
            status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
            deletedAt: null,
            metadataJson: { path: ['testPlanId'], equals: testPlanId },
        },
        select: { id: true },
    });
    return existing != null;
}

// Epic D.2 — preserve the three-state contract on update paths.
function sanitizeOptional(v: string | null | undefined): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return sanitizePlainText(v);
}

// R3-P2 — `method` (auditor-facing MANUAL/AUTOMATED) is a derived projection
// of `automationType` (how execution runs: MANUAL/SCRIPT/INTEGRATION). They
// used to be edited on two separate surfaces and could disagree. This is the
// single source of truth for the mapping; every write that touches one side
// runs it so the pair can never drift.
// The implementation moved to `domain/test-plan-method` so `TestPlanRepository`
// can derive too without a repository→usecase import (which would invert the
// layer dependency). Imported (for local use below) AND re-exported, because
// this has long been the import site for the usecase layer.
import { deriveMethodFromAutomationType } from '../../domain/test-plan-method';
export { deriveMethodFromAutomationType };

// ─── Queries ───

export async function listControlTestPlans(ctx: RequestContext, controlId: string) {
    assertCanReadTests(ctx);
    return runInTenantContext(ctx, (db) =>
        TestPlanRepository.listByControl(db, ctx, controlId)
    );
}

export async function getTestPlan(ctx: RequestContext, planId: string) {
    assertCanReadTests(ctx);
    return runInTenantContext(ctx, async (db) => {
        const plan = await TestPlanRepository.getById(db, ctx, planId);
        if (!plan) throw notFound('Test plan not found');
        // R4-P3 #4 — the embedded `runs` array is capped at the 10 most recent,
        // but the KPI cards want pass/fail counts over EVERY run. Deriving them
        // from the capped array made "Total 47 / Passed 6 / Failed 3" (6+3 < 47)
        // whenever a plan had run more than 10 times. Aggregate the full
        // population by result so the cards and `_count.runs` agree.
        const resultGroups = await db.controlTestRun.groupBy({
            by: ['result'],
            where: { testPlanId: planId, tenantId: ctx.tenantId, status: 'COMPLETED' },
            _count: { _all: true },
        });
        let passed = 0;
        let failed = 0;
        let inconclusive = 0;
        for (const g of resultGroups) {
            if (g.result === 'PASS') passed = g._count._all;
            else if (g.result === 'FAIL') failed = g._count._all;
            else if (g.result === 'INCONCLUSIVE') inconclusive = g._count._all;
        }
        return { ...plan, runResultCounts: { passed, failed, inconclusive } };
    });
}

export async function getTestRun(ctx: RequestContext, runId: string) {
    assertCanReadTests(ctx);
    return runInTenantContext(ctx, async (db) => {
        const run = await TestRunRepository.getById(db, ctx, runId);
        if (!run) throw notFound('Test run not found');
        return run;
    });
}

export async function listRunEvidence(ctx: RequestContext, runId: string) {
    assertCanReadTests(ctx);
    return runInTenantContext(ctx, (db) =>
        TestEvidenceRepository.listByRun(db, ctx, runId)
    );
}

// ─── Control effectiveness ─────────────────────────────────────────
//
// Audit Coherence S2 (2026-05-22) — auditors reviewing control
// operating effectiveness expect a "pass rate over the last N runs"
// number. Pre-this-PR they could read raw test-run rows from the
// detail page and compute it by eye; this surfaces the metric
// directly.

export interface ControlEffectiveness {
    controlId: string;
    /// Rolling pass rate over the window — `passes / scored` rounded to a
    /// percentage 0–100, where `scored = passes + fails`. INCONCLUSIVE runs
    /// (no verdict — e.g. a no-engine scheduled run that errored, or a handler
    /// that couldn't reach a decision) are EXCLUDED from the denominator so a
    /// run that never produced a pass/fail can't silently drag effectiveness
    /// down. `null` if no PASS/FAIL runs in window.
    passRate: number | null;
    /// Count of completed runs (PASS + FAIL + INCONCLUSIVE) in window.
    total: number;
    /// Count of runs that produced a verdict (PASS + FAIL) — the pass-rate
    /// denominator. `total - scored` is the inconclusive count.
    scored: number;
    passes: number;
    fails: number;
    inconclusive: number;
    /// The rolling window the metric covers. Defaults to 90 days
    /// (matches the audit-readiness scoring convention).
    windowDays: number;
}

const DEFAULT_EFFECTIVENESS_WINDOW_DAYS = 90;

const emptyEffectiveness = (controlId: string, windowDays: number): ControlEffectiveness => ({
    controlId, passRate: null, total: 0, scored: 0, passes: 0, fails: 0, inconclusive: 0, windowDays,
});

/**
 * THE canonical control-effectiveness signal — the measured pass rate over
 * COMPLETED test runs in a rolling window, keyed per control. ONE `groupBy`
 * for N controls (no N+1). This is the single source of truth consumed by
 * control health, the risk residual-suggestion, and the control ROI/best-value
 * math (each previously reimplemented — or, for ROI, ignored — this query).
 *
 * DB-level: callers already inside a tenant transaction (health, residual, ROI)
 * pass their own `db`. `getControlEffectiveness` below is the context-opening
 * single-control convenience wrapper.
 */
export async function computeControlEffectivenessMap(
    db: PrismaTx,
    tenantId: string,
    controlIds: string[],
    windowDays: number = DEFAULT_EFFECTIVENESS_WINDOW_DAYS,
): Promise<Map<string, ControlEffectiveness>> {
    const map = new Map<string, ControlEffectiveness>();
    for (const id of controlIds) map.set(id, emptyEffectiveness(id, windowDays));
    if (controlIds.length === 0) return map;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    const grouped = await db.controlTestRun.groupBy({
        by: ['controlId', 'result'],
        where: {
            tenantId,
            controlId: { in: controlIds },
            status: 'COMPLETED',
            executedAt: { gte: cutoff },
        },
        _count: { _all: true },
    });
    for (const g of grouped) {
        const e = map.get(g.controlId);
        if (!e) continue;
        const n = g._count._all;
        if (g.result === 'PASS') e.passes += n;
        else if (g.result === 'FAIL') e.fails += n;
        else if (g.result === 'INCONCLUSIVE') e.inconclusive += n;
        e.total += n;
    }
    for (const e of map.values()) {
        // Pass-rate denominator is verdict-producing runs only (PASS + FAIL).
        // INCONCLUSIVE runs stay in `total` (for display) but are excluded here
        // so a no-verdict run can't drag measured effectiveness down.
        e.scored = e.passes + e.fails;
        e.passRate = e.scored > 0 ? Math.round((e.passes / e.scored) * 100) : null;
    }
    return map;
}

// PR-R — the `getControlEffectiveness(ctx, controlId)` single-control convenience
// wrapper was removed (zero prod callers). `computeControlEffectivenessMap` is the
// live source of truth — every real consumer (control-roi, risk-residual-suggestion,
// control/health) calls it directly inside its own tenant-gated context.

/**
 * Attest that a control was exercised by a completed test/check run —
 * stamps `Control.lastTested = now` and rolls the control's own cadence
 * (`nextDueAt`). This is the control-state write that the previously
 * un-triggered `markControlTestCompleted` performed; wiring it into run
 * completion means testing a control via the UI (manual OR automated check)
 * finally advances the control's tested-state and feeds the health summary.
 * Skips NOT_APPLICABLE controls and global-library rows (no tenantId match).
 */
/**
 * A run only ATTESTS a control when it reached a real verdict. INCONCLUSIVE
 * (and any future non-verdict outcome) means the test did not establish
 * anything: effectiveness stays null, so claiming "tested & on-schedule" would
 * be a false assurance an auditor could act on.
 *
 * Exported because the same rule gates the plan-cadence roll at every
 * completion site — the two must never diverge.
 */
export function isAttestingVerdict(result: string | null | undefined): boolean {
    return result === 'PASS' || result === 'FAIL';
}

export async function attestControlTested(
    db: PrismaTx,
    ctx: RequestContext,
    controlId: string | null | undefined,
    /**
     * The run's verdict. REQUIRED (not optional-defaulting-to-attest) so every
     * call site has to state it — a completion path can't silently attest by
     * forgetting the argument, which is exactly how INCONCLUSIVE runs were
     * marking controls tested.
     */
    result: string | null | undefined,
): Promise<void> {
    if (!controlId) return;
    // Non-verdict → the control was NOT exercised conclusively. Leave
    // lastTested / nextDueAt untouched so it keeps reading as due.
    if (!isAttestingVerdict(result)) return;
    const control = await db.control.findFirst({
        where: { id: controlId, tenantId: ctx.tenantId },
        select: { id: true, frequency: true, applicability: true },
    });
    if (!control || control.applicability === 'NOT_APPLICABLE') return;
    const now = new Date();
    await db.control.update({
        where: { id: control.id },
        data: { lastTested: now, nextDueAt: computeNextDueAt(control.frequency, now) },
    });
}

// ─── Create / Update Test Plans ───
//
// Audit S2 OVERDUE semantics note (2026-05-22):
//
//   `TestPlanStatus` does NOT carry an `OVERDUE` value, by design.
//   A test plan's overdue-ness is derived live from `nextDueAt < now()`
//   — transient, computed on read (see test-readiness scoring). It is
//   NOT persisted as a status because test-plan due-dates roll forward
//   automatically on every run completion (`computeNextDueAt`); a
//   persisted OVERDUE state would race the next run.
//
//   This is intentional and DIFFERENT from `RiskTreatmentPlan`, which
//   persists `OVERDUE` and has a cron job to transition. Treatment
//   plans don't auto-roll their dates — they have a fixed targetDate
//   the owner needs to meet — so the persisted state is the right
//   shape there.
//
//   The audit flagged this as "inconsistency could confuse operators";
//   the resolution is to document the semantic difference here and at
//   the read sites (see `audits/readiness`-style consumers) rather
//   than over-unify the shapes.

/** Upper bound on evidence links accepted in one automated-run payload. */
const MAX_AUTOMATION_EVIDENCE_LINKS = 50;

/**
 * Reject an ownerUserId that is not an ACTIVE member of the tenant. The plan
 * owner is auto-assigned the CONTROL_GAP task on a FAIL, so a foreign/inactive
 * owner would misroute (or leak) that task. No-op for a null owner.
 */
async function assertOwnerIsActiveMember(
    db: PrismaTx,
    ctx: RequestContext,
    ownerUserId: string | null | undefined,
): Promise<void> {
    if (!ownerUserId) return;
    const member = await db.tenantMembership.findFirst({
        where: { userId: ownerUserId, tenantId: ctx.tenantId, status: 'ACTIVE' },
        select: { id: true },
    });
    if (!member) throw badRequest('Owner is not an active member of this tenant');
}

export async function createTestPlan(ctx: RequestContext, controlId: string, input: {
    name: string;
    description?: string | null;
    frequency?: string;
    ownerUserId?: string | null;
    expectedEvidence?: unknown;
    steps?: Array<{ instruction: string; expectedOutput?: string | null }>;
}) {
    assertCanManageTestPlans(ctx);

    // Epic D.2 — sanitise free-text on the test-plan write path. The
    // plan row itself is not in the encrypted-fields manifest, but
    // `name` + `description` + `steps[].instruction|expectedOutput`
    // surface in UI, audit details, and PDF exports — sanitise at
    // the row level so every downstream consumer is safe.
    const sanitisedInput = {
        ...input,
        name: sanitizePlainText(input.name),
        description: input.description ? sanitizePlainText(input.description) : input.description,
        steps: input.steps?.map((s) => ({
            instruction: sanitizePlainText(s.instruction),
            expectedOutput: s.expectedOutput == null
                ? s.expectedOutput
                : sanitizePlainText(s.expectedOutput),
        })),
    };
    const result = await runInTenantContext(ctx, async (db) => {
        // The path controlId and the owner must belong to THIS tenant before we
        // stamp the plan — the owner is auto-assigned the CONTROL_GAP task on a
        // FAIL, so a foreign owner would leak a task cross-tenant.
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!control) throw badRequest('Control not found in this tenant');
        await assertOwnerIsActiveMember(db, ctx, input.ownerUserId);

        const plan = await TestPlanRepository.create(db, ctx, controlId, sanitisedInput);

        // Compute initial nextDueAt
        const nextDueAt = computeNextDueAt(input.frequency || 'AD_HOC');
        if (nextDueAt) {
            await TestPlanRepository.updateNextDueAt(db, ctx, plan.id, nextDueAt);
        }

        await emitTestPlanCreated(db, ctx, { id: plan.id, name: plan.name, controlId });
        return { ...plan, nextDueAt };
    });
    await bumpEntityCacheVersion(ctx, 'test');
    return result;
}

export async function updateTestPlan(ctx: RequestContext, planId: string, patch: {
    name?: string;
    description?: string | null;
    frequency?: string;
    ownerUserId?: string | null;
    expectedEvidence?: unknown;
    status?: string;
    /**
     * Changing automation is what makes a plan automated. `method` is NEVER a
     * caller input — it is recomputed from this via
     * `deriveMethodFromAutomationType` below, so the pair cannot drift.
     * (The schedule endpoint is the usual writer; this keeps the invariant
     * even if a future caller sets automationType through here.)
     */
    automationType?: string;
    steps?: Array<{ instruction: string; expectedOutput?: string | null }>;
}) {
    assertCanManageTestPlans(ctx);

    // Epic D.2 — sanitise the free-text fields in the patch only when
    // they're actually being written (preserves "don't touch"
    // semantics for undefined).
    const sanitisedPatch: Parameters<typeof TestPlanRepository.update>[3] = {
        ...patch,
        name: sanitizeOptional(patch.name) ?? undefined,
        description: sanitizeOptional(patch.description),
        steps: patch.steps?.map((s) => ({
            instruction: sanitizePlainText(s.instruction),
            expectedOutput: s.expectedOutput == null ? s.expectedOutput : sanitizePlainText(s.expectedOutput),
        })),
    };

    // R3-P2 / PR-CC — method↔automation reconciliation, now DERIVED rather
    // than asserted. `method` is not a caller input: whenever `automationType`
    // is written, `method` is recomputed from it, so the two can never
    // disagree. (Previously only a `method === 'MANUAL'` patch reconciled, so
    // `method: 'AUTOMATED'` set the column while automationType stayed MANUAL
    // and schedule stayed null — the badge lied.)
    if (patch.automationType !== undefined) {
        sanitisedPatch.method = deriveMethodFromAutomationType(patch.automationType);
        // Reverting to MANUAL must also strip the automation it carried — a
        // MANUAL plan cannot stay scheduled, or the scheduler keeps firing a
        // plan the operator believes is manual.
        if (patch.automationType === 'MANUAL') {
            sanitisedPatch.schedule = null;
            sanitisedPatch.nextRunAt = null;
        }
    }
    const result = await runInTenantContext(ctx, async (db) => {
        await assertOwnerIsActiveMember(db, ctx, patch.ownerUserId);
        const existing = await TestPlanRepository.getById(db, ctx, planId);
        if (!existing) throw notFound('Test plan not found');

        // Detect status change for event emission
        const oldStatus = existing.status;
        const newStatus = patch.status;

        const updated = await TestPlanRepository.update(db, ctx, planId, sanitisedPatch);

        // Recompute nextDueAt if frequency changed
        if (patch.frequency && patch.frequency !== existing.frequency) {
            const nextDueAt = computeNextDueAt(patch.frequency);
            await TestPlanRepository.updateNextDueAt(db, ctx, planId, nextDueAt);
        }

        // Emit events. PR-E — only a genuine pause/resume (to/from PAUSED)
        // fires the pause/resume event; other status changes (e.g.
        // ACTIVE→ARCHIVED) are generic updates, not a mislabelled RESUMED.
        const isPauseResume =
            !!newStatus &&
            newStatus !== oldStatus &&
            (newStatus === 'PAUSED' || oldStatus === 'PAUSED');
        if (isPauseResume) {
            await emitTestPlanStatusChanged(db, ctx, planId, oldStatus, newStatus!);
        } else {
            await emitTestPlanUpdated(db, ctx, planId, patch);
        }

        return updated;
    });
    await bumpEntityCacheVersion(ctx, 'test');
    return result;
}

// ─── Test Runs ───

export async function createTestRun(ctx: RequestContext, planId: string) {
    assertCanExecuteTests(ctx);

    const result = await runInTenantContext(ctx, async (db) => {
        const plan = await TestPlanRepository.getById(db, ctx, planId);
        if (!plan) throw notFound('Test plan not found');
        if (plan.status !== 'ACTIVE') throw badRequest('Cannot create a run for a paused test plan');

        // Idempotency / duplicate-run guard (R4-P2 #5). A plan carries at most
        // one open run at a time — the UI hides "New run" while one is pending,
        // but a double-submit or a stale client can still race to here. Reuse
        // the existing PLANNED/RUNNING run instead of minting a second, which
        // would fork the plan's execution history and let two testers attest
        // the same control in parallel.
        const existing = await db.controlTestRun.findFirst({
            where: { testPlanId: planId, tenantId: ctx.tenantId, status: { in: ['PLANNED', 'RUNNING'] } },
            orderBy: { createdAt: 'asc' },
        });
        if (existing) return existing;

        const run = await TestRunRepository.create(db, ctx, {
            testPlanId: planId,
            controlId: plan.controlId,
        });

        await emitTestRunCreated(db, ctx, { id: run.id, testPlanId: planId });
        return run;
    });
    await bumpEntityCacheVersion(ctx, 'test');
    return result;
}

// R3-P2 — PLANNED → RUNNING. Clicking "Run" now begins a guided execution
// (the tester walks the plan's procedure) rather than jumping straight to a
// result-entry form. Idempotent for an already-RUNNING run; rejects a run
// that is already COMPLETED.
export async function startTestRun(ctx: RequestContext, runId: string) {
    assertCanExecuteTests(ctx);

    const result = await runInTenantContext(ctx, async (db) => {
        const run = await TestRunRepository.getById(db, ctx, runId);
        if (!run) throw notFound('Test run not found');
        if (run.status === 'COMPLETED') throw badRequest('Test run is already completed');
        // A run must not proceed (and later attest the control) on a plan that
        // is no longer ACTIVE — createTestRun already guards this at creation.
        const plan = await TestPlanRepository.getById(db, ctx, run.testPlanId);
        if (plan && plan.status !== 'ACTIVE') {
            throw badRequest('Cannot run a test on a paused or archived plan');
        }
        if (run.status === 'RUNNING') return run;
        return TestRunRepository.start(db, ctx, runId);
    });
    await bumpEntityCacheVersion(ctx, 'test');
    return result;
}

export async function completeTestRun(ctx: RequestContext, runId: string, input: {
    result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    notes?: string | null;
    findingSummary?: string | null;
}) {
    assertCanExecuteTests(ctx);

    // Epic D.2 — `notes` and `findingSummary` are encrypted on
    // `ControlTestRun` and also surface verbatim in the auto-created
    // CONTROL_GAP task's description below. Sanitise once at the top
    // so the row at rest, the task body, and any audit/event payload
    // all carry the cleaned value.
    const sanitisedInput = {
        ...input,
        notes: sanitizeOptional(input.notes),
        findingSummary: sanitizeOptional(input.findingSummary),
    };
    const result = await runInTenantContext(ctx, async (db) => {
        const run = await TestRunRepository.getById(db, ctx, runId);
        if (!run) throw notFound('Test run not found');
        if (run.status === 'COMPLETED') throw badRequest('Test run is already completed');
        // Completing a run attests the control (Control.lastTested + cadence
        // roll) — refuse to attest on a plan that is no longer ACTIVE.
        const runPlan = await TestPlanRepository.getById(db, ctx, run.testPlanId);
        if (runPlan && runPlan.status !== 'ACTIVE') {
            throw badRequest('Cannot complete a test on a paused or archived plan');
        }

        // 1. Complete the run
        const completedRun = await TestRunRepository.complete(db, ctx, runId, sanitisedInput);

        // 1b. Attest the control was exercised — completing a run now writes
        // back to Control.lastTested (+ rolls the control's own cadence), the
        // state the (previously un-triggered) markControlTestCompleted set.
        // Without this, a control tested via the UI never showed lastTested
        // and the health summary/readiness couldn't tell it had been tested.
        await attestControlTested(db, ctx, run.controlId, input.result);

        // 2. Update the plan's nextDueAt based on frequency — but ONLY on a
        // real verdict. An INCONCLUSIVE run established nothing, so rolling
        // the cadence would push the plan out of the overdue list while the
        // control remains genuinely untested.
        const plan = run.testPlan;
        if (plan && isAttestingVerdict(input.result)) {
            const completedAt = new Date();
            const nextDueAt = computeNextDueAt(plan.frequency, completedAt);
            await TestPlanRepository.updateNextDueAt(db, ctx, plan.id, nextDueAt);

            // A SCHEDULED plan completed by hand must ALSO roll `nextRunAt`
            // forward from its cron. `effectiveDueAt = min(nextDueAt, nextRunAt)`,
            // so leaving the stale past run-time in place pinned the plan to it —
            // it re-appeared as overdue on every surface until the scheduler
            // happened to tick, no matter how recently it was actually tested.
            if (plan.schedule && plan.nextRunAt && plan.nextRunAt <= completedAt) {
                const nextRunAt = computeNextRunFromCron(
                    plan.schedule,
                    plan.scheduleTimezone,
                    completedAt,
                );
                // A null means the cron no longer parses — leave the stored value
                // rather than silently clearing the plan's schedule.
                if (nextRunAt) {
                    await TestPlanRepository.update(db, ctx, plan.id, { nextRunAt });
                }
            }
        }

        // 3. Emit completion event
        await emitTestRunCompleted(db, ctx, {
            id: runId,
            result: input.result,
            testPlanId: run.testPlanId,
        });

        // 4. If FAIL, emit the failure event in-tx and hand the CONTROL_GAP
        //    task off to a POST-COMMIT step (see below). Creating it here nested
        //    createTask's own `runInTenantContext` inside this one — two pool
        //    connections held at once, and a gap task that could outlive an
        //    outer rollback. The task is a downstream effect of a durably
        //    completed run, so it belongs after this transaction commits.
        let gapTask: GapTaskSpec | null = null;
        if (input.result === 'FAIL') {
            await emitTestRunFailed(db, ctx, { id: runId, findingSummary: sanitisedInput.findingSummary });
            gapTask = {
                controlId: run.controlId,
                testPlanId: run.testPlanId,
                planName: plan?.name ?? null,
                ownerUserId: plan?.ownerUserId ?? null,
                description: sanitisedInput.findingSummary || sanitisedInput.notes || 'A control test run failed and requires remediation.',
            };
        }

        return { completedRun, gapTask };
    });

    // Post-commit: spawn the CONTROL_GAP follow-up in its OWN transaction, only
    // after the run completion has durably landed. Idempotent + best-effort —
    // a failure here must never undo the (already committed) completion.
    if (result.gapTask) await spawnControlGapTask(ctx, runId, result.gapTask);

    await bumpEntityCacheVersion(ctx, 'test');
    return result.completedRun;
}

interface GapTaskSpec {
    controlId: string;
    testPlanId: string;
    planName: string | null;
    ownerUserId: string | null;
    description: string;
    automated?: boolean;
    integrationResultId?: string | null;
}

/**
 * Post-commit CONTROL_GAP spawn for a FAILED run. Runs after completeTestRun /
 * createAutomatedTestRun have committed, so it never nests inside their
 * transaction. Idempotent (reuses an open gap for the control+plan) and
 * best-effort (a failure is audited, not propagated).
 */
async function spawnControlGapTask(ctx: RequestContext, runId: string, spec: GapTaskSpec) {
    try {
        const alreadyOpen = await runInTenantContext(ctx, (db) =>
            hasOpenGapTask(db, ctx, spec.controlId, spec.testPlanId),
        );
        if (alreadyOpen) return;
        await createTask(ctx, {
            title: `${spec.automated ? 'Automated test failed' : 'Test failed'}: ${spec.planName || 'Unknown plan'}`,
            type: 'CONTROL_GAP',
            description: spec.description,
            severity: 'HIGH',
            priority: 'P1',
            source: 'INTEGRATION',
            controlId: spec.controlId,
            assigneeUserId: spec.ownerUserId,
            metadataJson: {
                testRunId: runId,
                testPlanId: spec.testPlanId,
                testPlanName: spec.planName,
                ...(spec.automated
                    ? { automated: true, integrationResultId: spec.integrationResultId ?? null }
                    : {}),
            },
        });
    } catch (taskErr) {
        // Audit the miss in its own short transaction; do not fail the run.
        await runInTenantContext(ctx, (db) =>
            logEvent(db, ctx, {
                action: 'TEST_RUN_TASK_CREATION_FAILED',
                entityType: 'ControlTestRun',
                entityId: runId,
                details: `Failed to create follow-up task: ${taskErr instanceof Error ? taskErr.message : String(taskErr)}`,
                detailsJson: {
                    category: 'custom',
                    event: 'task_creation_failed',
                    error: taskErr instanceof Error ? taskErr.message : String(taskErr),
                },
            }),
        ).catch(() => { /* the audit log is itself best-effort here */ });
    }
}

// ─── Retest Flow ───

export async function retestFromRun(ctx: RequestContext, runId: string) {
    assertCanExecuteTests(ctx);

    const result = await runInTenantContext(ctx, async (db) => {
        const run = await db.controlTestRun.findFirst({
            where: { id: runId, tenantId: ctx.tenantId },
            include: { testPlan: { select: { id: true, name: true, status: true, controlId: true } } },
        });
        if (!run) throw notFound('Test run not found');
        if (run.status !== 'COMPLETED') throw badRequest('Can only retest from a completed run');

        const plan = run.testPlan;
        if (!plan) throw notFound('Test plan not found');

        const newRun = await db.controlTestRun.create({
            data: {
                tenantId: ctx.tenantId,
                controlId: plan.controlId,
                testPlanId: plan.id,
                status: 'PLANNED',
                createdByUserId: ctx.userId,
                requestId: ctx.requestId,
            },
        });

        await emitTestRunCreated(db, ctx, { id: newRun.id, testPlanId: plan.id });

        await logEvent(db, ctx, {
            action: 'TEST_RETEST_CREATED',
            entityType: 'ControlTestRun',
            entityId: newRun.id,
            details: `Retest created from run ${runId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ControlTestRun',
                operation: 'created',
                after: { originalRunId: runId, testPlanId: plan.id },
                summary: `Retest created from run ${runId}`,
            },
        });

        return newRun;
    });
    await bumpEntityCacheVersion(ctx, 'test');
    return result;
}

// ─── Evidence Linking ───

export async function linkEvidenceToRun(ctx: RequestContext, runId: string, input: {
    kind: 'FILE' | 'EVIDENCE' | 'LINK' | 'INTEGRATION_RESULT';
    fileId?: string | null;
    evidenceId?: string | null;
    url?: string | null;
    integrationResultId?: string | null;
    note?: string | null;
}) {
    assertCanLinkTestEvidence(ctx);

    const result = await runInTenantContext(ctx, async (db) => {
        const run = await TestRunRepository.getById(db, ctx, runId);
        if (!run) throw notFound('Test run not found');

        // A COMPLETED run is frozen audit evidence — its verdict is immutable
        // (completeTestRun rejects a second completion) and so is the evidence
        // backing it. Reject post-completion evidence mutation; an amendment
        // must fork a new run via retestFromRun.
        if (run.status === 'COMPLETED') {
            throw forbidden(
                'This test run is completed — its evidence is frozen. Retest to attach new evidence.',
            );
        }

        // PR-R — freeze the file's integrity hash at link time for FILE-kind
        // evidence, sourced from FileRecord.sha256 (the trustworthy checksum
        // computed at upload). verifyRunEvidence later recomputes the bytes from
        // storage and compares against this frozen value, so tampering is
        // detectable.
        let sha256Hash: string | null = null;
        if (input.kind === 'FILE') {
            // A FILE link whose fileId does not resolve in the tenant can NEVER
            // be integrity-verified — storing a null hash and linking anyway is
            // the fail-open path where a foreign/missing fileId scored VERIFIED.
            // Reject it instead.
            if (!input.fileId) {
                throw badRequest('A FILE evidence link requires a fileId.');
            }
            const file = await db.fileRecord.findFirst({
                where: { id: input.fileId, tenantId: ctx.tenantId },
                select: { sha256: true },
            });
            if (!file) {
                throw badRequest('The referenced file does not exist in this tenant.');
            }
            sha256Hash = file.sha256 ?? null;
        }

        // An EVIDENCE link must reference a real tenant Evidence row — a foreign
        // evidenceId was previously stamped blind.
        if (input.kind === 'EVIDENCE' && input.evidenceId) {
            const ev = await db.evidence.findFirst({
                where: { id: input.evidenceId, tenantId: ctx.tenantId },
                select: { id: true },
            });
            if (!ev) throw badRequest('The referenced evidence does not exist in this tenant.');
        }

        const link = await TestEvidenceRepository.link(db, ctx, {
            testRunId: runId,
            ...input,
            sha256Hash,
        });

        await emitTestEvidenceLinked(db, ctx, { id: link.id, testRunId: runId, kind: input.kind });
        return link;
    });
    await bumpEntityCacheVersion(ctx, 'test');
    return result;
}

export async function unlinkEvidenceFromRun(ctx: RequestContext, runId: string, linkId: string) {
    assertCanLinkTestEvidence(ctx);

    await runInTenantContext(ctx, async (db) => {
        // Scope the link to the run in the URL — a link must not be deletable
        // through an unrelated run's route (and the audit must name the run the
        // link actually belonged to).
        const existing = await db.controlTestEvidenceLink.findFirst({
            where: { id: linkId, testRunId: runId, tenantId: ctx.tenantId },
        });
        if (!existing) throw notFound('Evidence link not found on this run');

        // Frozen audit evidence on a completed run cannot be removed.
        const run = await TestRunRepository.getById(db, ctx, runId);
        if (run?.status === 'COMPLETED') {
            throw forbidden(
                'This test run is completed — its evidence is frozen and cannot be removed.',
            );
        }

        await TestEvidenceRepository.unlink(db, ctx, linkId);
        // The row (incl. its frozen sha256Hash) is hard-deleted, so record the
        // destroyed fields in the audit detail — the deletion stays
        // reconstructible even though the link row is gone.
        await emitTestEvidenceUnlinked(db, ctx, linkId, existing.testRunId, {
            kind: existing.kind,
            fileId: existing.fileId,
            sha256Hash: existing.sha256Hash,
        });
    });
    await bumpEntityCacheVersion(ctx, 'test');
}

// ─── Automation Bridge ───

/**
 * Create a completed test run from an automation/integration result.
 * Used when method=AUTOMATED and an integration check completes.
 */
export async function createAutomatedTestRun(
    ctx: RequestContext,
    planId: string,
    input: {
        result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
        notes?: string | null;
        integrationResultId?: string | null;
        evidenceLinks?: Array<{
            kind: 'FILE' | 'LINK' | 'INTEGRATION_RESULT';
            fileId?: string | null;
            url?: string | null;
            integrationResultId?: string | null;
            note?: string | null;
        }>;
    },
) {
    assertCanExecuteTests(ctx);

    // Sanitise notes at the top (like completeTestRun) — they land in the run
    // row AND verbatim in the CONTROL_GAP task description below.
    const notes = sanitizeOptional(input.notes);
    if ((input.evidenceLinks?.length ?? 0) > MAX_AUTOMATION_EVIDENCE_LINKS) {
        throw badRequest(
            `At most ${MAX_AUTOMATION_EVIDENCE_LINKS} evidence links may be attached to an automated run.`,
        );
    }

    const result = await runInTenantContext(ctx, async (db) => {
        const plan = await TestPlanRepository.getById(db, ctx, planId);
        if (!plan) throw notFound('Test plan not found');
        // This mints a COMPLETED verdict that attests the control (lastTested +
        // both cadences roll) — never do that for a plan that is not ACTIVE.
        if (plan.status !== 'ACTIVE') {
            throw badRequest('Cannot record an automated run for a paused or archived plan');
        }

        // Create run (starts as PLANNED)
        const run = await TestRunRepository.create(db, ctx, {
            controlId: plan.controlId,
            testPlanId: plan.id,
        });

        // Complete the run with result
        const completedRun = await TestRunRepository.complete(db, ctx, run.id, {
            result: input.result,
            notes: notes || `Automated run from integration`,
            findingSummary: input.result === 'FAIL' ? (notes || 'Automated check failed') : undefined,
        });

        // Attest the control was exercised by this automated check — only on a
        // real verdict (an INCONCLUSIVE automated check attests nothing).
        await attestControlTested(db, ctx, plan.controlId, input.result);

        // Advance cadence — same verdict gate, so an inconclusive check can't
        // push the plan's due date out.
        const nextDue = computeNextDueAt(plan.frequency, new Date());
        if (nextDue && isAttestingVerdict(input.result)) {
            await TestPlanRepository.updateNextDueAt(db, ctx, plan.id, nextDue);
        }

        // Link evidence if provided. FILE links freeze the integrity hash and
        // must resolve in-tenant — same fail-closed rule as linkEvidenceToRun,
        // so an automated run can't be born with an unverifiable FILE link that
        // later scores VERIFIED. Resolve every FILE fileId in ONE query (no
        // N+1) and map by id.
        if (input.evidenceLinks && input.evidenceLinks.length > 0) {
            const fileIds = input.evidenceLinks
                .filter((e) => e.kind === 'FILE')
                .map((e) => e.fileId)
                .filter((x): x is string => Boolean(x));
            const files = fileIds.length > 0
                ? await db.fileRecord.findMany({
                      where: { id: { in: [...new Set(fileIds)] }, tenantId: ctx.tenantId },
                      select: { id: true, sha256: true },
                  })
                : [];
            const fileById = new Map(files.map((f) => [f.id, f]));
            for (const ev of input.evidenceLinks) {
                let sha256Hash: string | null = null;
                if (ev.kind === 'FILE') {
                    if (!ev.fileId) throw badRequest('A FILE evidence link requires a fileId.');
                    const file = fileById.get(ev.fileId);
                    if (!file) throw badRequest('The referenced file does not exist in this tenant.');
                    sha256Hash = file.sha256 ?? null;
                }
                await TestEvidenceRepository.link(db, ctx, {
                    testRunId: run.id,
                    kind: ev.kind,
                    fileId: ev.fileId ?? null,
                    url: ev.url ?? null,
                    integrationResultId: ev.integrationResultId ?? input.integrationResultId ?? null,
                    note: ev.note ?? null,
                    sha256Hash,
                });
            }
        }

        // On FAIL, emit the failure event in-tx and defer the CONTROL_GAP task
        // to a POST-COMMIT step (same reasoning as completeTestRun — createTask
        // must not nest its transaction inside this one).
        let gapTask: GapTaskSpec | null = null;
        if (input.result === 'FAIL') {
            await emitTestRunFailed(db, ctx, { id: run.id, findingSummary: input.notes });
            gapTask = {
                controlId: plan.controlId,
                testPlanId: plan.id,
                planName: plan.name ?? null,
                ownerUserId: plan.ownerUserId ?? null,
                description: notes || 'An automated control test run failed and requires remediation.',
                automated: true,
                integrationResultId: input.integrationResultId ?? null,
            };
        }

        await emitTestRunCompleted(db, ctx, {
            id: run.id,
            testPlanId: plan.id,
            result: input.result,
        });

        await logEvent(db, ctx, {
            action: 'AUTOMATED_TEST_RUN_CREATED',
            entityType: 'ControlTestRun',
            entityId: run.id,
            details: `Automated test run: ${input.result}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'ControlTestRun',
                operation: 'created',
                after: {
                    testPlanId: plan.id,
                    result: input.result,
                    integrationResultId: input.integrationResultId,
                    evidenceCount: input.evidenceLinks?.length || 0,
                    automated: true,
                },
                summary: `Automated test run: ${input.result}`,
            },
        });

        return { completedRun, gapTask };
    });

    // Post-commit CONTROL_GAP spawn — see completeTestRun for the rationale.
    if (result.gapTask) await spawnControlGapTask(ctx, result.completedRun.id, result.gapTask);

    await bumpEntityCacheVersion(ctx, 'test');
    return result.completedRun;
}

// ─── Bulk actions (canonical BulkActionBar rollout) ───

export async function bulkSetTestPlanStatus(
    ctx: RequestContext,
    planIds: string[],
    status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
) {
    assertCanManageTestPlans(ctx);
    const updated = await runInTenantContext(ctx, async (db) => {
        const rows = await TestPlanRepository.listByIds(db, ctx, planIds);
        if (rows.length === 0) return 0;
        await TestPlanRepository.bulkUpdate(db, ctx, planIds, { status });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'UPDATE',
                entityType: 'ControlTestPlan',
                entityId: r.id,
                details: `Test plan status set to ${status}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'ControlTestPlan',
                    fromStatus: r.status,
                    toStatus: status,
                },
            });
            // PR-E — the bulk path previously emitted NO automation event, so a
            // bulk pause/resume never triggered rules. Fire it here (no-op for a
            // non-pause/resume change).
            await emitTestPlanStatusAutomationEvent(ctx, r.id, r.status, status);
        }
        return rows.length;
    });
    await bumpEntityCacheVersion(ctx, 'test');
    return { updated };
}

/** Bulk soft-delete control test plans selected in the table action bar. */
export async function bulkDeleteTestPlan(ctx: RequestContext, planIds: string[]) {
    // Deleting the tenant's test program is an ADMIN action (matching the peer
    // bulk registers) — not a plain write an EDITOR holds.
    assertCanBulkManageTestPlans(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        const rows = await db.controlTestPlan.findMany({
            where: { id: { in: planIds }, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (rows.length === 0) return { deleted: 0 };
        await db.controlTestPlan.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId } });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'SOFT_DELETE',
                entityType: 'ControlTestPlan',
                entityId: r.id,
                details: 'Control test plan soft-deleted (bulk)',
                detailsJson: { category: 'entity_lifecycle', entityName: 'ControlTestPlan', operation: 'deleted', summary: 'Control test plan soft-deleted' },
            });
        }
        return { deleted: rows.length };
    });
    // Bulk delete was the only bulk mutation not bumping the list-cache version.
    await bumpEntityCacheVersion(ctx, 'test');
    return result;
}

/**
 * Bulk-restore soft-deleted control test plans (R4-P2 #4).
 *
 * The undo/restore counterpart to `bulkDeleteTestPlan`. Without this the
 * table's bulk-delete was unrecoverable from the UI — the soft-delete row
 * survived in the DB but no surface could bring it back. Same ADMIN gate as
 * delete; only rows that are actually soft-deleted are touched (a plan that
 * is already live is a no-op, keeping the undo idempotent).
 */
export async function bulkRestoreTestPlan(ctx: RequestContext, planIds: string[]) {
    assertCanBulkManageTestPlans(ctx);
    const result = await runInTenantContext(ctx, async (db) => {
        // `withDeleted` bypasses the soft-delete read filter so we can see the
        // rows we're bringing back; we only restore ones currently deleted.
        const rows = await db.controlTestPlan.findMany(withDeleted({
            where: { id: { in: planIds }, tenantId: ctx.tenantId, deletedAt: { not: null } },
            select: { id: true },
        }));
        if (rows.length === 0) return { restored: 0 };
        await db.controlTestPlan.updateMany({
            where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId },
            data: { deletedAt: null, deletedByUserId: null },
        });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'ENTITY_RESTORED',
                entityType: 'ControlTestPlan',
                entityId: r.id,
                details: 'Control test plan restored (bulk)',
                detailsJson: { category: 'entity_lifecycle', entityName: 'ControlTestPlan', operation: 'restored', summary: 'Control test plan restored from soft-delete' },
            });
        }
        return { restored: rows.length };
    });
    await bumpEntityCacheVersion(ctx, 'test');
    return result;
}

export async function bulkAssignTestPlan(
    ctx: RequestContext,
    planIds: string[],
    ownerUserId: string | null,
) {
    assertCanManageTestPlans(ctx);
    const updated = await runInTenantContext(ctx, async (db) => {
        await assertOwnerIsActiveMember(db, ctx, ownerUserId);
        const rows = await TestPlanRepository.listByIds(db, ctx, planIds);
        if (rows.length === 0) return 0;
        await TestPlanRepository.bulkUpdate(db, ctx, planIds, {
            ownerUserId: ownerUserId || null,
        });
        for (const r of rows) {
            await logEvent(db, ctx, {
                action: 'UPDATE',
                entityType: 'ControlTestPlan',
                entityId: r.id,
                details: ownerUserId ? `Test plan owner reassigned` : `Test plan owner cleared`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'ControlTestPlan',
                    operation: 'updated',
                    changedFields: ['ownerUserId'],
                    after: { ownerUserId: ownerUserId || null },
                    summary: ownerUserId ? `owner reassigned (bulk)` : `owner cleared (bulk)`,
                },
            });
        }
        return rows.length;
    });
    await bumpEntityCacheVersion(ctx, 'test');
    return { updated };
}
