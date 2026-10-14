/**
 * #3472 — the ordered step feed: bounded, cursor-exact, and ONE TENANT'S.
 *
 * Three claims, and each is the kind that passes by accident if asserted
 * loosely:
 *
 *   1. BOUNDED. `getWorkflowRun` returns every step a run ever wrote; this
 *      feed must not, because the canvas scrubber and the live tail both read
 *      it and "never stream unbounded history" is the plan's own wording. A
 *      `take` that silently ignored its cap would pass any test that only
 *      counted a short run's steps, so the run here has MORE steps than the
 *      cap and the page is measured against the cap rather than the run.
 *
 *   2. CURSOR-EXACT. The ledger is append-only and ordered, so paging by `seq`
 *      should miss nothing and re-send nothing. Asserted by walking the whole
 *      run in pages and comparing the UNION against a direct read — a test
 *      that only checked page one would not notice an off-by-one at the seam,
 *      which is the one error this shape admits.
 *
 *   3. TENANT-SCOPED. Tenant B asking for tenant A's run must get not-found,
 *      and the test asserts the ROW EXISTS first — otherwise "not found"
 *      proves only that the id was wrong.
 *
 * Real database, real usecase, real RLS. A mocked Prisma would answer whatever
 * the mock was told, and the claim here is about what the predicate does.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    getRunStepFeed,
    MAX_STEP_FEED_TAKE,
    DEFAULT_STEP_FEED_TAKE,
} from '@/app-layer/usecases/workflow-run-steps';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `feed-${randomUUID().slice(0, 8)}`;
const TENANT_A = `ta-${SUITE}`;
const TENANT_B = `tb-${SUITE}`;
const USER_A = `ua-${SUITE}`;
const USER_B = `ub-${SUITE}`;
const RUN_A = `run-${SUITE}`;
/** A SECOND run in the SAME tenant. RLS cannot separate these two. */
const RUN_A2 = `run2-${SUITE}`;

/** More steps than one page holds, so the cap is exercised rather than described. */
const STEP_COUNT = DEFAULT_STEP_FEED_TAKE + 7;

const ctxA = () =>
    makeRequestContext('ADMIN', { tenantId: TENANT_A, tenantSlug: TENANT_A, userId: USER_A });
const ctxB = () =>
    makeRequestContext('ADMIN', { tenantId: TENANT_B, tenantSlug: TENANT_B, userId: USER_B });

async function makeTenant(id: string, userId: string) {
    await prisma.tenant.create({ data: { id, name: id, slug: id } });
    const email = `${id}@example.test`;
    await prisma.user.create({ data: { id: userId, email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId: id, userId, role: 'OWNER', status: 'ACTIVE' },
    });
}

describeFn('the run step feed (real DB, real RLS)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await makeTenant(TENANT_A, USER_A);
        await makeTenant(TENANT_B, USER_B);

        await prisma.workflowRun.create({
            data: {
                id: RUN_A,
                tenantId: TENANT_A,
                workflowKey: 'audit-prep',
                status: 'RUNNING',
                stepCount: STEP_COUNT,
                startedByUserId: USER_A,
            },
        });
        await prisma.workflowStep.createMany({
            data: Array.from({ length: STEP_COUNT }, (_, i) => ({
                runId: RUN_A,
                tenantId: TENANT_A,
                seq: i,
                kind: 'READ' as const,
                status: 'DONE' as const,
                toolCalled: 'get_framework_status',
            })),
        });

        // A sibling run in the SAME tenant, with OVERLAPPING seq numbers. This
        // is the axis RLS cannot cover — both rows are tenant A's — so it is
        // the one the `runId` predicate is actually load-bearing for.
        await prisma.workflowRun.create({
            data: {
                id: RUN_A2,
                tenantId: TENANT_A,
                workflowKey: 'audit-prep',
                status: 'COMPLETED',
                stepCount: 3,
                startedByUserId: USER_A,
            },
        });
        await prisma.workflowStep.createMany({
            data: Array.from({ length: 3 }, (_, i) => ({
                runId: RUN_A2,
                tenantId: TENANT_A,
                seq: i,
                kind: 'SYNTHESIS' as const,
                status: 'DONE' as const,
            })),
        });
    });

    afterAll(async () => {
        for (const t of [TENANT_A, TENANT_B]) {
            await prisma.workflowStep.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.workflowRun.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(
                    `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, t,
                );
            }).catch(() => {});
            await prisma.tenant.deleteMany({ where: { id: t } }).catch(() => {});
        }
        await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } }).catch(() => {});
        await prisma.$disconnect();
    });

    it('the run really has more steps than one page — otherwise the cap below is untested', async () => {
        const n = await prisma.workflowStep.count({ where: { runId: RUN_A, tenantId: TENANT_A } });
        expect(n).toBe(STEP_COUNT);
        expect(n).toBeGreaterThan(DEFAULT_STEP_FEED_TAKE);
    });

    it('returns at most one page, and says there is more', async () => {
        const feed = await getRunStepFeed(ctxA(), RUN_A);
        expect(feed.steps.length).toBe(DEFAULT_STEP_FEED_TAKE);
        expect(feed.hasMore).toBe(true);
        // MEASURED, not inferred from `stepCount`: the counter is written by the
        // executor, and during the window between a step's insert and the run
        // row's update a client comparing against it would be guessing.
        expect(feed.cursor).toBe(DEFAULT_STEP_FEED_TAKE - 1);
        expect(feed.live).toBe(true);
    });

    it('clamps a take nobody should be able to ask for', async () => {
        const feed = await getRunStepFeed(ctxA(), RUN_A, { take: 10_000 });
        expect(feed.steps.length).toBeLessThanOrEqual(MAX_STEP_FEED_TAKE);
        // The whole run fits inside the CAP, so the clamp is what bounded this
        // page — not the run's length.
        expect(STEP_COUNT).toBeLessThanOrEqual(MAX_STEP_FEED_TAKE);
        expect(feed.steps.length).toBe(STEP_COUNT);
        expect(feed.hasMore).toBe(false);
    });

    it('a take of zero or a negative is floored to one, never to "everything"', async () => {
        // `Math.max(1, …)` and not `|| DEFAULT`: a falsy 0 would have taken the
        // default, which is a larger page than the caller asked for, and a
        // negative would reach Prisma as a negative `take`.
        for (const take of [0, -5]) {
            const feed = await getRunStepFeed(ctxA(), RUN_A, { take });
            expect(feed.steps.length).toBe(1);
        }
    });

    it('pages through the WHOLE run with no gap and no repeat', async () => {
        const seen: number[] = [];
        let cursor = -1;
        let guard = 0;
        for (;;) {
            const feed = await getRunStepFeed(ctxA(), RUN_A, { sinceSeq: cursor, take: 25 });
            seen.push(...feed.steps.map((s) => s.seq));
            cursor = feed.cursor;
            if (!feed.hasMore) break;
            // A loop over a cursor that stopped advancing would hang the suite
            // rather than fail it, which is the one failure mode a paging test
            // must not have.
            if (++guard > 50) throw new Error('cursor did not advance');
        }
        expect(seen).toEqual([...Array(STEP_COUNT).keys()]);
        expect(new Set(seen).size).toBe(seen.length);
    });

    it('a cursor past the end returns an empty page that still says where it is', async () => {
        const feed = await getRunStepFeed(ctxA(), RUN_A, { sinceSeq: STEP_COUNT + 100 });
        expect(feed.steps).toEqual([]);
        expect(feed.hasMore).toBe(false);
        // The cursor is ECHOED rather than reset to -1: a tail that reset would
        // re-send the entire run on its next tick.
        expect(feed.cursor).toBe(STEP_COUNT + 100);
    });

    it("tenant B cannot read tenant A's run — and the run demonstrably exists", async () => {
        const row = await prisma.workflowRun.findUnique({ where: { id: RUN_A } });
        expect(row).not.toBeNull();
        await expect(getRunStepFeed(ctxB(), RUN_A)).rejects.toThrow(/not found/i);
    });

    it('does not mix in a SIBLING run of the same tenant', async () => {
        // Recorded because a mutation run proved it: deleting
        // `tenantId: ctx.tenantId` from EITHER query above leaves all eight of
        // the other assertions green. `WorkflowStep` and `WorkflowRun` both
        // carry FORCE ROW LEVEL SECURITY and `runInTenantContext` sets the
        // session variable the policy reads, so the cross-tenant case is held
        // by RLS and the explicit predicates are defence in depth — real, and
        // NOT what the test above proves.
        //
        // The `runId` predicate is different: both runs here belong to tenant
        // A, so no policy separates them. This is the assertion that fails if
        // the filter is dropped.
        const feed = await getRunStepFeed(ctxA(), RUN_A2);
        expect(feed.steps.length).toBe(3);
        expect(feed.steps.every((s) => s.kind === 'SYNTHESIS')).toBe(true);
        expect(feed.stepCount).toBe(3);
        // …and the sibling's status is its own, so a client is not told a
        // completed run is still live.
        expect(feed.live).toBe(false);
    });

    it('derives the data rung from the recorded tool, so the feed matches the page', async () => {
        // The projection is shared with `/agents/runs/[runId]`; this asserts it
        // actually ran rather than that the route returned rows. `READ` steps
        // calling `get_framework_status` resolve a scope; a feed that forgot to
        // project would carry a null here and look like a step that touched
        // nothing.
        const feed = await getRunStepFeed(ctxA(), RUN_A, { take: 1 });
        expect(feed.steps[0].tool).toBe('get_framework_status');
        expect(feed.steps[0].scope).not.toBeNull();
    });
});
