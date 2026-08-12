/**
 * B2-4 — the four-eyes reviewer gate must be DISCOVERABLE.
 *
 * `checkReviewerSignOffGate` means a reviewer-gated task can only be
 * completed by its one named reviewer. Two behaviours make that work
 * findable, and both are asserted here against a live DB:
 *
 *   • entering IN_REVIEW puts a TASK_REVIEW_REQUESTED bell in the
 *     REVIEWER's inbox — and in nobody else's — from EITHER status path
 *     (single and bulk share one post-commit sequence, so a regression
 *     that drops the emission from one drops it from both);
 *   • the `awaitingReviewBy` list filter returns exactly the tasks that
 *     user must sign off — IN_REVIEW *and* reviewed by them.
 *
 * Failure modes this catches: emission moved to a path-specific site,
 * the recipient widened to watchers/assignee, the trigger widened to
 * every status change, or the filter degrading to "reviewer is X"
 * (which would also return tasks not yet, or no longer, in review).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createTask,
    setTaskStatus,
    bulkSetTaskStatus,
    listTasks,
} from '@/app-layer/usecases/task';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `trr-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${TAG}`;

let actorId: string;
let reviewerId: string;
let bystanderId: string;
let ctxActor: ReturnType<typeof makeRequestContext>;
let ctxReviewer: ReturnType<typeof makeRequestContext>;
let ctxBystander: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await db.tenantMembership.create({
        data: { tenantId: TENANT, userId: u.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

/** Every review-request bell raised for one task, by recipient. */
async function reviewRequestRecipients(taskId: string): Promise<string[]> {
    const rows = await db.notification.findMany({
        where: { tenantId: TENANT, type: 'TASK_REVIEW_REQUESTED', linkUrl: { contains: taskId } },
        select: { userId: true },
    });
    return rows.map((r) => r.userId).sort();
}

describeFn('task review-request notification + awaiting-review filter (integration)', () => {
    beforeAll(async () => {
        await db.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: `t ${TAG}`, slug: TENANT },
        });
        actorId = await makeUser('actor');
        reviewerId = await makeUser('reviewer');
        bystanderId = await makeUser('bystander');
        ctxActor = makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: actorId });
        ctxReviewer = makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: reviewerId });
        ctxBystander = makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: bystanderId });
    });

    afterAll(async () => {
        try {
            for (const t of ['Notification', 'TaskWatcher', 'TaskComment', 'Task']) {
                await db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, TENANT);
            }
            await db.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
            await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = ANY($1)`, [actorId, reviewerId, bystanderId]);
            await db.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, TENANT);
        } catch (e) { void e; }
        await db.$disconnect().catch(() => {});
    });

    // ─── The bell ────────────────────────────────────────────────────

    it('entering IN_REVIEW notifies the reviewer — and nobody else', async () => {
        const task = await createTask(ctxActor, {
            title: 'Needs sign-off',
            type: 'TASK',
            assigneeUserId: actorId,
            reviewerUserId: reviewerId,
        });

        await setTaskStatus(ctxActor, task.id, 'IN_REVIEW');

        expect(await reviewRequestRecipients(task.id)).toEqual([reviewerId]);

        const bell = await db.notification.findFirst({
            where: { tenantId: TENANT, userId: reviewerId, type: 'TASK_REVIEW_REQUESTED', linkUrl: { contains: task.id } },
            select: { linkUrl: true, message: true, read: true },
        });
        // The bell must be actionable: it links to the task it is about.
        expect(bell?.linkUrl).toBe(`/t/${TENANT}/tasks/${task.id}`);
        expect(bell?.read).toBe(false);
        expect(bell?.message).toContain(task.title);
    });

    it('the BULK status path raises the same bell — the sequence is shared, not duplicated', async () => {
        const task = await createTask(ctxActor, {
            title: 'Bulk into review',
            type: 'TASK',
            reviewerUserId: reviewerId,
        });

        await bulkSetTaskStatus(ctxActor, [task.id], 'IN_REVIEW');

        expect(await reviewRequestRecipients(task.id)).toEqual([reviewerId]);
    });

    it('a status change that is NOT into review raises no review request', async () => {
        const task = await createTask(ctxActor, {
            title: 'Just progressing',
            type: 'TASK',
            reviewerUserId: reviewerId,
        });

        await setTaskStatus(ctxActor, task.id, 'IN_PROGRESS');

        expect(await reviewRequestRecipients(task.id)).toEqual([]);
    });

    it('a task with no reviewer raises no review request when it enters IN_REVIEW', async () => {
        const task = await createTask(ctxActor, { title: 'Unreviewed', type: 'TASK' });

        await setTaskStatus(ctxActor, task.id, 'IN_REVIEW');

        expect(await reviewRequestRecipients(task.id)).toEqual([]);
    });

    it('a reviewer who submits the task themselves is not notified of their own action', async () => {
        const task = await createTask(ctxActor, {
            title: 'Self-submitted',
            type: 'TASK',
            reviewerUserId: reviewerId,
        });

        await setTaskStatus(ctxReviewer, task.id, 'IN_REVIEW');

        expect(await reviewRequestRecipients(task.id)).toEqual([]);
    });

    // ─── The discovery filter ────────────────────────────────────────

    it('awaitingReviewBy returns the tasks that user must sign off — and only those', async () => {
        const mine = await createTask(ctxActor, {
            title: `${TAG} awaiting mine`,
            type: 'TASK',
            reviewerUserId: reviewerId,
        });
        const notYetInReview = await createTask(ctxActor, {
            title: `${TAG} not yet`,
            type: 'TASK',
            reviewerUserId: reviewerId,
        });
        const someoneElses = await createTask(ctxActor, {
            title: `${TAG} someone else`,
            type: 'TASK',
            reviewerUserId: bystanderId,
        });
        await setTaskStatus(ctxActor, mine.id, 'IN_REVIEW');
        await setTaskStatus(ctxActor, someoneElses.id, 'IN_REVIEW');

        const queue = await listTasks(ctxReviewer, { awaitingReviewBy: reviewerId });
        const ids = queue.map((t: { id: string }) => t.id);

        expect(ids).toContain(mine.id);
        // In review, but it is the bystander's sign-off, not the reviewer's.
        expect(ids).not.toContain(someoneElses.id);
        // Theirs to review eventually, but not waiting on them yet.
        expect(ids).not.toContain(notYetInReview.id);

        // And the same filter, asked on the bystander's behalf, returns
        // the other side of the split — the facet is per-user, not a
        // tenant-wide "everything in review" view.
        const bystanderQueue = await listTasks(ctxBystander, { awaitingReviewBy: bystanderId });
        const bystanderIds = bystanderQueue.map((t: { id: string }) => t.id);
        expect(bystanderIds).toContain(someoneElses.id);
        expect(bystanderIds).not.toContain(mine.id);
    });

    it('awaitingReviewBy composes with an explicit status filter instead of overriding it', async () => {
        const task = await createTask(ctxActor, {
            title: `${TAG} compose`,
            type: 'TASK',
            reviewerUserId: reviewerId,
        });
        await setTaskStatus(ctxActor, task.id, 'IN_REVIEW');

        // A contradictory pair must return nothing rather than silently
        // dropping one half of the predicate.
        const contradictory = await listTasks(ctxReviewer, {
            awaitingReviewBy: reviewerId,
            status: 'OPEN',
        });
        expect(contradictory.map((t: { id: string }) => t.id)).not.toContain(task.id);
    });
});
