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
 *   4. AND THE CHECKPOINT READ BESIDE IT. `getRunCheckpointReview` is the
 *      other thing the canvas asks about one run (#3472) — the PENDING
 *      proposals it queued, each with a diff. Same fixture, same tenancy
 *      question, and one claim neither of the above can make: the diff is
 *      computed against the target's state AT READ TIME, so it has to be
 *      asserted against a row that was changed after the proposal was
 *      written.
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
import {
    getRunCheckpointReview,
    MAX_CHECKPOINT_PROPOSALS,
} from '@/app-layer/usecases/run-checkpoint-review';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

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
/** The UPDATE proposal's target, and the row that MOVES under it. */
const RISK_A = `risk-${SUITE}`;

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

        // ── THE CHECKPOINT FIXTURE (#3472) ────────────────────────────────
        //
        // A real target row, so the UPDATE proposal's diff is computed against
        // something that exists and can be changed. `title` is the field the
        // proposal edits and the one the test later moves out from under it.
        await prisma.risk.create({
            data: { id: RISK_A, tenantId: TENANT_A, title: 'Original title' },
        });
        await prisma.agentProposal.createMany({
            data: [
                // PENDING, on this run — the row the panel exists to show.
                {
                    id: `p-update-${SUITE}`,
                    tenantId: TENANT_A,
                    runId: RUN_A,
                    stepSeq: 1,
                    kind: 'RISK',
                    operation: 'UPDATE',
                    status: 'PENDING',
                    targetEntityId: RISK_A,
                    payloadJson: JSON.stringify({ title: 'Proposed title' }),
                },
                // ALREADY DECIDED. A decided proposal is not a decision
                // waiting on anybody, and a panel that listed it would ask a
                // reviewer to approve something that is already approved.
                {
                    id: `p-done-${SUITE}`,
                    tenantId: TENANT_A,
                    runId: RUN_A,
                    stepSeq: 1,
                    kind: 'RISK',
                    operation: 'CREATE',
                    status: 'ACCEPTED',
                    payloadJson: JSON.stringify({ title: 'Already accepted' }),
                },
                // PENDING, on the SIBLING run of the SAME tenant. The axis RLS
                // cannot cover, and the one the `runId` predicate is load-
                // bearing for — exactly as for the step feed above.
                {
                    id: `p-other-run-${SUITE}`,
                    tenantId: TENANT_A,
                    runId: RUN_A2,
                    stepSeq: 0,
                    kind: 'RISK',
                    operation: 'CREATE',
                    status: 'PENDING',
                    payloadJson: JSON.stringify({ title: 'Another run entirely' }),
                },
            ],
        });
    });

    afterAll(async () => {
        for (const t of [TENANT_A, TENANT_B]) {
            await prisma.agentProposal.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.risk.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.workflowStep.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.workflowRun.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(
                    `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, t,
                );
            }).catch(() => {});
        }
        // AUDIT ROWS FIRST (#3343). Removing the `.catch(() => {})` from the
        // tenant delete below turned this suite red with
        // `Foreign key constraint violated on AuditLog_tenantId_fkey` — the
        // handler had been discarding exactly that, so the tenants survived the
        // teardown and whichever suite ran next in the shard inherited them.
        //
        // This file matched the #3342 guard's `CLEARS_AUDIT_ROWS` only because
        // it drops to `session_replication_role` for `TenantMembership`; it
        // never cleared `AuditLog`.
        await deleteAuditRowsForTenants(prisma, [TENANT_A, TENANT_B]);
        await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
        await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
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

    /*
        ═══ THE CHECKPOINT READ (#3472) ═══

        What the canvas asks when a node is parked on a HUMAN_CHECKPOINT. Four
        claims, and the third is the one only a real database can make.
    */
    describe('one run\'s open checkpoint', () => {
        it('returns the PENDING proposals of THIS run, and nothing else', async () => {
            const review = await getRunCheckpointReview(ctxA(), RUN_A);
            expect(review.proposals.map((p) => p.id)).toEqual([`p-update-${SUITE}`]);
            // Each exclusion is a different mistake:
            //   · the ACCEPTED row — a decided proposal is not a decision
            //     waiting on anybody;
            //   · the sibling run's row — same tenant, so RLS cannot separate
            //     them and the `runId` predicate is the whole of it.
            expect(review.proposals.map((p) => p.id)).not.toContain(`p-done-${SUITE}`);
            expect(review.proposals.map((p) => p.id)).not.toContain(`p-other-run-${SUITE}`);
            // And the three rows demonstrably exist — otherwise this asserts
            // only that the fixture failed to write.
            const all = await prisma.agentProposal.count({ where: { tenantId: TENANT_A } });
            expect(all).toBe(3);
        });

        it('names the run\'s own status, which is NOT the proposal count', async () => {
            // `AWAITING_APPROVAL` does not mean there are proposals, and a
            // run with proposals need not be awaiting anybody. They are
            // separate facts and the projection keeps them separate.
            const review = await getRunCheckpointReview(ctxA(), RUN_A);
            expect(review.status).toBe('RUNNING');
            expect(review.awaitingHuman).toBe(false);
            expect(review.proposals).toHaveLength(1);
            expect(review.truncated).toBe(false);
            expect(review.workflowKey).toBe('audit-prep');
        });

        it('computes the diff against the target AS IT IS NOW, not as it was', async () => {
            // THE CLAIM THIS FILE EXISTS TO MAKE for the checkpoint read.
            // There is no snapshot column and deliberately never will be: a
            // base captured when the proposal was queued answers "what was
            // true when the agent looked", and the reviewer is being asked
            // "what will this do if I approve it now". Those diverge exactly
            // when it matters — a record edited between proposal and review —
            // and the stored answer is the one that is confidently wrong.
            //
            // So the row is MOVED here, after the proposal was written, and
            // the diff has to follow it.
            const before = await getRunCheckpointReview(ctxA(), RUN_A);
            const beforeDigest = before.proposals[0].diff.baseDigest;
            expect(before.proposals[0].diff.status).toBe('UPDATE');
            expect(JSON.stringify(before.proposals[0].diff.fields)).toContain('Original title');

            await prisma.risk.update({
                where: { id: RISK_A },
                data: { title: 'Somebody else edited this' },
            });
            const after = await getRunCheckpointReview(ctxA(), RUN_A);
            expect(JSON.stringify(after.proposals[0].diff.fields)).toContain(
                'Somebody else edited this',
            );
            // AND THE FINGERPRINT MOVED WITH IT. This is what makes the
            // approve path's re-check meaningful: the reviewer's consent is
            // bound to the base they read, so a base that has changed must
            // produce a different digest or the binding proves nothing.
            expect(after.proposals[0].diff.baseDigest).not.toBe(beforeDigest);
            expect(after.proposals[0].diff.baseDigest).toBeTruthy();

            // Put it back, so a later assertion in this file reads the fixture
            // it was written against.
            await prisma.risk.update({
                where: { id: RISK_A },
                data: { title: 'Original title' },
            });
        });

        it('sends the proposed value as a DIFF FIELD, never as the raw payload', async () => {
            // The distinction this asserts is not "the proposed value is
            // hidden" — a reviewer must see what is proposed, and `after`
            // is where it belongs. It is that the value arrives STRUCTURED,
            // beside the base it would replace, rather than as the opaque
            // `payloadJson` blob the old queue rendered into a `<pre>`.
            //
            // Asserted over the SERIALISED result, because that is what the
            // route returns: a field-by-field check only looks at the fields
            // it already expected, and the failure here would be an EXTRA one.
            const review = await getRunCheckpointReview(ctxA(), RUN_A);
            const wire = JSON.stringify(review);

            // The column is absent by NAME…
            expect(wire).not.toContain('payloadJson');
            // …and absent by SHAPE: a nested JSON string would serialise with
            // escaped quotes, which is the signature of a dumped payload and
            // cannot be produced by the diff's own structure.
            expect(wire).not.toContain('\\"title\\"');

            // And the value IS there, in the one place it carries meaning —
            // paired with the base, which is what makes an update reviewable
            // at all.
            expect(review.proposals[0].diff.fields).toEqual([
                expect.objectContaining({
                    field: 'title',
                    before: 'Original title',
                    after: 'Proposed title',
                    changed: true,
                }),
            ]);

            // Timestamps are ISO STRINGS on the way out, because the client
            // derives its type from this return value and a `Date` there is a
            // lie the compiler accepts — #3546 shipped within one commit of
            // calling `.toISOString()` on one.
            expect(typeof review.proposals[0].createdAt).toBe('string');
        });

        it("tenant B cannot read tenant A's checkpoint — and the run demonstrably exists", async () => {
            await expect(getRunCheckpointReview(ctxB(), RUN_A)).rejects.toThrow(/not found/i);
            const row = await prisma.workflowRun.findUnique({ where: { id: RUN_A } });
            expect(row?.tenantId).toBe(TENANT_A);
        });

        it('bounds what one checkpoint can return', async () => {
            // A bound rather than a page: a checkpoint carrying more than this
            // is the proposals queue's job, and the panel says so. The cap is
            // asserted as a number a reader can see, so a change to it is a
            // change to this line rather than a silent widening.
            expect(MAX_CHECKPOINT_PROPOSALS).toBe(25);
        });
    });

});
