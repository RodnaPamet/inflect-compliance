/**
 * Test Run repository — CRUD operations for ControlTestRun.
 */
import { PrismaTx } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
import { RequestContext } from '../types';

export const TestRunRepository = {
    async create(db: PrismaTx, ctx: RequestContext, data: {
        testPlanId: string;
        controlId: string;
    }) {
        return db.controlTestRun.create({
            data: {
                tenantId: ctx.tenantId,
                controlId: data.controlId,
                testPlanId: data.testPlanId,
                status: 'PLANNED',
                createdByUserId: ctx.userId,
                requestId: ctx.requestId,
            },
        });
    },

    async getById(db: PrismaTx, ctx: RequestContext, runId: string) {
        return db.controlTestRun.findFirst({
            where: { id: runId, tenantId: ctx.tenantId },
            include: {
                testPlan: {
                    select: {
                        id: true, name: true, controlId: true, frequency: true, ownerUserId: true,
                        // Schedule fields — a MANUAL completion of a SCHEDULED plan
                        // must also roll `nextRunAt` forward from the cron, or
                        // `effectiveDueAt = min(nextDueAt, nextRunAt)` stays pinned
                        // to the stale past run-time and the plan reads as
                        // perpetually overdue until the scheduler next ticks.
                        schedule: true, scheduleTimezone: true, nextRunAt: true,
                        // R3-P2 — the run surface shows the plan's procedure so a
                        // tester walks the steps during a RUNNING execution.
                        steps: {
                            orderBy: { sortOrder: 'asc' },
                            select: { id: true, sortOrder: true, instruction: true, expectedOutput: true },
                        },
                    },
                },
                executedBy: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
                evidence: {
                    include: {
                        evidence: { select: { id: true, title: true, type: true } },
                        createdBy: { select: { id: true, name: true, email: true } },
                    },
                    orderBy: { createdAt: 'desc' },
                },
            },
        });
    },

    async listByPlan(db: PrismaTx, ctx: RequestContext, testPlanId: string) {
        return db.controlTestRun.findMany({
            where: { tenantId: ctx.tenantId, testPlanId },
            include: {
                executedBy: { select: { id: true, name: true, email: true } },
                _count: { select: { evidence: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    },

    /** R3-P2 — PLANNED → RUNNING. Marks a run as actively in progress. */
    async start(db: PrismaTx, _ctx: RequestContext, runId: string) {
        return db.controlTestRun.update({
            where: { id: runId },
            data: { status: 'RUNNING' },
        });
    },

    async complete(db: PrismaTx, ctx: RequestContext, runId: string, data: {
        result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
        notes?: string | null;
        findingSummary?: string | null;
    }) {
        // A completed verdict is immutable. The transition is CONDITIONAL on
        // the run not already being COMPLETED (#5317): two completions racing
        // under READ COMMITTED both pass the caller's status read, but the
        // second UPDATE waits on the first's row lock, re-evaluates this
        // predicate against the committed row, matches nothing and is refused
        // here — so a FAIL can never be silently overwritten by a PASS.
        const res = await db.controlTestRun.updateMany({
            where: { id: runId, tenantId: ctx.tenantId, status: { not: 'COMPLETED' } },
            data: {
                status: 'COMPLETED',
                result: data.result,
                executedAt: new Date(),
                executedByUserId: ctx.userId,
                notes: data.notes ?? null,
                findingSummary: data.findingSummary ?? null,
            },
        });
        if (res.count === 0) throw badRequest('Test run is already completed');
        return db.controlTestRun.findFirstOrThrow({ where: { id: runId, tenantId: ctx.tenantId } });
    },
};
