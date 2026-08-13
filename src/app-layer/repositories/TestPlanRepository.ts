/**
 * Test Plan repository — CRUD operations for ControlTestPlan.
 */
import { Prisma } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { deriveMethodFromAutomationType } from '../domain/test-plan-method';

export const TestPlanRepository = {
    async listByControl(db: PrismaTx, ctx: RequestContext, controlId: string) {
        return db.controlTestPlan.findMany({
            where: { tenantId: ctx.tenantId, controlId },
            include: {
                owner: { select: { id: true, name: true, email: true } },
                _count: { select: { runs: true, steps: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    },

    async getById(db: PrismaTx, ctx: RequestContext, planId: string) {
        return db.controlTestPlan.findFirst({
            where: { id: planId, tenantId: ctx.tenantId },
            include: {
                owner: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
                steps: { orderBy: { sortOrder: 'asc' } },
                runs: {
                    orderBy: { createdAt: 'desc' },
                    take: 10,
                    include: {
                        executedBy: { select: { id: true, name: true, email: true } },
                        _count: { select: { evidence: true } },
                    },
                },
                _count: { select: { runs: true, steps: true } },
            },
        });
    },

    async create(db: PrismaTx, ctx: RequestContext, controlId: string, data: {
        name: string;
        description?: string | null;
        /**
         * How execution runs. `method` is DERIVED from this (never accepted
         * directly) so the auditor-facing MANUAL/AUTOMATED projection can't
         * drift from reality — see `deriveMethodFromAutomationType`. A new plan
         * with no automationType is MANUAL on both axes.
         */
        automationType?: string;
        frequency?: string;
        ownerUserId?: string | null;
        expectedEvidence?: unknown;
        steps?: Array<{ instruction: string; expectedOutput?: string | null }>;
    }) {
        const plan = await db.controlTestPlan.create({
            data: {
                tenantId: ctx.tenantId,
                controlId,
                name: data.name,
                description: data.description ?? null,
                // Derived, never supplied — the ONLY writers of `method` in the
                // codebase are deriveMethodFromAutomationType call sites.
                method: deriveMethodFromAutomationType(data.automationType ?? 'MANUAL'),
                frequency: (data.frequency as 'AD_HOC' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY') || 'AD_HOC',
                ownerUserId: data.ownerUserId ?? null,
                expectedEvidence: data.expectedEvidence ? JSON.parse(JSON.stringify(data.expectedEvidence)) : undefined,
                createdByUserId: ctx.userId,
            },
        });

        // Create steps if provided
        if (data.steps && data.steps.length > 0) {
            await db.controlTestStep.createMany({
                data: data.steps.map((step, i) => ({
                    tenantId: ctx.tenantId,
                    testPlanId: plan.id,
                    sortOrder: i,
                    instruction: step.instruction,
                    expectedOutput: step.expectedOutput ?? null,
                })),
            });
        }

        return plan;
    },

    async update(db: PrismaTx, ctx: RequestContext, planId: string, patch: {
        name?: string;
        description?: string | null;
        method?: string;
        frequency?: string;
        ownerUserId?: string | null;
        expectedEvidence?: unknown;
        status?: string;
        automationType?: string;
        schedule?: string | null;
        nextRunAt?: Date | null;
        nextDueAt?: Date | null;
        steps?: Array<{ instruction: string; expectedOutput?: string | null }>;
    }) {
        const data: Record<string, unknown> = {};
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.description !== undefined) data.description = patch.description;
        if (patch.method !== undefined) data.method = patch.method;
        if (patch.frequency !== undefined) data.frequency = patch.frequency;
        if (patch.ownerUserId !== undefined) data.ownerUserId = patch.ownerUserId;
        if (patch.expectedEvidence !== undefined) data.expectedEvidence = JSON.parse(JSON.stringify(patch.expectedEvidence));
        if (patch.status !== undefined) data.status = patch.status;
        // R3-P2 — method↔automation reconciliation writes these together so
        // a plan can never be MANUAL-method while still carrying a schedule.
        if (patch.automationType !== undefined) data.automationType = patch.automationType;
        if (patch.schedule !== undefined) data.schedule = patch.schedule;
        if (patch.nextRunAt !== undefined) data.nextRunAt = patch.nextRunAt;
        if (patch.nextDueAt !== undefined) data.nextDueAt = patch.nextDueAt;

        const updated = await db.controlTestPlan.update({
            where: { id: planId },
            data,
        });

        // R3-P2 — steps, when provided, REPLACE the plan's procedure. Delete
        // then recreate so sort order and removals apply atomically (the
        // caller runs this inside a tenant transaction).
        if (patch.steps !== undefined) {
            await db.controlTestStep.deleteMany({ where: { tenantId: ctx.tenantId, testPlanId: planId } });
            if (patch.steps.length > 0) {
                await db.controlTestStep.createMany({
                    data: patch.steps.map((step, i) => ({
                        tenantId: ctx.tenantId,
                        testPlanId: planId,
                        sortOrder: i,
                        instruction: step.instruction,
                        expectedOutput: step.expectedOutput ?? null,
                    })),
                });
            }
        }

        return updated;
    },

    /**
     * When this plan was last actually tested — the `executedAt` of its most
     * recent COMPLETED run, or null if it has never completed one.
     *
     * This is the anchor a cadence change must measure from. `getById`
     * already includes runs, but only the latest 10 of ANY status, so a plan
     * with a run of planned/running churn can push its last completed run out
     * of that window. Asking the database directly cannot miss it.
     */
    async lastCompletedRunAt(db: PrismaTx, ctx: RequestContext, planId: string): Promise<Date | null> {
        const run = await db.controlTestRun.findFirst({
            where: {
                testPlanId: planId,
                tenantId: ctx.tenantId,
                status: 'COMPLETED',
                executedAt: { not: null },
            },
            select: { executedAt: true },
            orderBy: { executedAt: 'desc' },
        });
        return run?.executedAt ?? null;
    },

    async updateNextDueAt(db: PrismaTx, _ctx: RequestContext, planId: string, nextDueAt: Date | null) {
        return db.controlTestPlan.update({
            where: { id: planId },
            data: { nextDueAt },
        });
    },

    /** Fetch the tenant's test plans for the given ids (bulk-action audit source). */
    async listByIds(db: PrismaTx, ctx: RequestContext, ids: string[]) {
        // Bounded by the `in: ids` set (bulk schemas cap at 100 ids); a `take:`
        // would be redundant.
        return db.controlTestPlan.findMany({ // guardrail-allow: unbounded
            where: { id: { in: ids }, tenantId: ctx.tenantId },
        });
    },

    /**
     * Tenant-scoped bulk update — one `updateMany` so the bulk-action path
     * never reads/writes per-id in a loop. Returns the affected-row count.
     */
    async bulkUpdate(
        db: PrismaTx,
        ctx: RequestContext,
        ids: string[],
        data: Omit<Prisma.ControlTestPlanUncheckedUpdateInput, 'tenantId'>,
    ) {
        return db.controlTestPlan.updateMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId },
            data,
        });
    },
};
