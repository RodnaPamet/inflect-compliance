/**
 * TP-2 — behavioural integration for the reviewer sign-off gate + the
 * watcher notification fan-out. Live DB (project convention).
 *
 *   • A task WITH a reviewer cannot close directly from an active state:
 *     it must pass through IN_REVIEW, and only the reviewer may sign off.
 *   • CANCELED is exempt (cancelling is not completing).
 *   • A task WITHOUT a reviewer closes in one step (unchanged).
 *   • Watching a task delivers comment/status/assign activity to the
 *     watcher's bell (a Notification row), never to the actor.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createTask, setTaskStatus, bulkSetTaskStatus, updateTask, assignTask, addTaskWatcher, addTaskComment } from '@/app-layer/usecases/task';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `trw-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${TAG}`;

let reviewerId: string;
let actorId: string;
let ctxActor: ReturnType<typeof makeRequestContext>;
let ctxReviewer: ReturnType<typeof makeRequestContext>;
/** A plain EDITOR — write access but NOT admin. The opt-out hole is about an
 *  editor escaping sign-off; ctxActor is an OWNER (canAdmin), who is
 *  deliberately allowed to override. */
let ctxEditor: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await db.tenantMembership.create({
        data: { tenantId: TENANT, userId: u.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('task reviewer gate + watcher fan-out (integration)', () => {
    beforeAll(async () => {
        await db.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: `t ${TAG}`, slug: TENANT } });
        actorId = await makeUser('actor');
        reviewerId = await makeUser('reviewer');
        ctxActor = makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: actorId });
        ctxReviewer = makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: reviewerId });
        ctxEditor = makeRequestContext('EDITOR', { tenantId: TENANT, tenantSlug: TENANT, userId: actorId });
    });

    afterAll(async () => {
        try {
            for (const t of ['Notification', 'TaskWatcher', 'TaskComment', 'Task']) {
                await db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, TENANT);
            }
            await db.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
            await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = ANY($1)`, [actorId, reviewerId]);
            await db.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, TENANT);
        } catch (e) { void e; }
        await db.$disconnect().catch(() => {});
    });

    // ─── Reviewer sign-off gate ──────────────────────────────────────

    it('a reviewed task cannot close directly — it must pass through IN_REVIEW', async () => {
        const task = await createTask(ctxActor, { title: 'Reviewed task', type: 'TASK', reviewerUserId: reviewerId });
        await expect(
            setTaskStatus(ctxActor, task.id, 'CLOSED', 'done'),
        ).rejects.toThrow(/must be In review before it can be closed/);
    });

    it('only the reviewer can sign off an IN_REVIEW task to a terminal state', async () => {
        const task = await createTask(ctxActor, { title: 'Needs sign-off', type: 'TASK', reviewerUserId: reviewerId });
        // Submit for review (OPEN → IN_REVIEW) — anyone with write can.
        await setTaskStatus(ctxActor, task.id, 'IN_REVIEW');
        // A non-reviewer cannot complete it.
        await expect(
            setTaskStatus(ctxActor, task.id, 'CLOSED', 'done'),
        ).rejects.toThrow(/reviewer/i);
        // The reviewer signs off.
        const closed = await setTaskStatus(ctxReviewer, task.id, 'CLOSED', 'looks good');
        expect(closed.status).toBe('CLOSED');
    });

    it('CANCELED is exempt from the reviewer gate (cancelling is not completing)', async () => {
        const task = await createTask(ctxActor, { title: 'To cancel', type: 'TASK', reviewerUserId: reviewerId });
        const canceled = await setTaskStatus(ctxActor, task.id, 'CANCELED', 'no longer needed');
        expect(canceled.status).toBe('CANCELED');
    });

    it('a task WITHOUT a reviewer still closes in one step', async () => {
        const task = await createTask(ctxActor, { title: 'No reviewer', type: 'TASK' });
        const closed = await setTaskStatus(ctxActor, task.id, 'CLOSED', 'done');
        expect(closed.status).toBe('CLOSED');
    });

    // ─── The gate is not bypassable (the three holes) ────────────────

    it('BULK close cannot bypass the reviewer gate — /tasks/bulk/status is not an escape hatch', async () => {
        const task = await createTask(ctxActor, { title: 'Bulk-gated', type: 'TASK', reviewerUserId: reviewerId });
        // Straight to CLOSED via the bulk path — the hole this PR closes.
        await expect(
            bulkSetTaskStatus(ctxActor, [task.id], 'CLOSED', 'bulk done'),
        ).rejects.toThrow(/must be In review before it can be closed/);
        // …and even from IN_REVIEW, a NON-reviewer can't bulk-close it.
        await setTaskStatus(ctxActor, task.id, 'IN_REVIEW');
        await expect(
            bulkSetTaskStatus(ctxActor, [task.id], 'CLOSED', 'bulk done'),
        ).rejects.toThrow(/reviewer/i);
        // The reviewer can, through the same bulk path.
        await bulkSetTaskStatus(ctxReviewer, [task.id], 'CLOSED', 'bulk sign-off');
        const row = await db.task.findUnique({ where: { id: task.id }, select: { status: true } });
        expect(row?.status).toBe('CLOSED');
    });

    it('a bulk batch is rejected WHOLESALE when any row violates the gate (no partial close)', async () => {
        const gated = await createTask(ctxActor, { title: 'Gated row', type: 'TASK', reviewerUserId: reviewerId });
        const ungated = await createTask(ctxActor, { title: 'Ungated row', type: 'TASK' });
        await expect(
            bulkSetTaskStatus(ctxActor, [ungated.id, gated.id], 'CLOSED', 'batch'),
        ).rejects.toThrow(/must be In review before it can be closed/);
        // The innocent row must NOT have been closed — all-or-nothing.
        const row = await db.task.findUnique({ where: { id: ungated.id }, select: { status: true } });
        expect(row?.status).not.toBe('CLOSED');
    });

    it('an EDITOR cannot clear or reassign the reviewer to escape sign-off once under review', async () => {
        const task = await createTask(ctxActor, { title: 'No opt-out', type: 'TASK', reviewerUserId: reviewerId });
        await setTaskStatus(ctxActor, task.id, 'IN_REVIEW');
        // PATCHing reviewerUserId: null is the opt-out hole this PR closes.
        await expect(
            updateTask(ctxEditor, task.id, { reviewerUserId: null }),
        ).rejects.toThrow(/reviewer or an admin/i);
        // Reassigning it away is equally blocked.
        await expect(
            updateTask(ctxEditor, task.id, { reviewerUserId: actorId }),
        ).rejects.toThrow(/reviewer or an admin/i);
        // The sitting reviewer may still hand off / step down.
        const handed = await updateTask(ctxReviewer, task.id, { reviewerUserId: null });
        expect(handed.reviewerUserId).toBeNull();
    });

    it('an ADMIN may still override the reviewer under review (documented carve-out)', async () => {
        const task = await createTask(ctxActor, { title: 'Admin override', type: 'TASK', reviewerUserId: reviewerId });
        await setTaskStatus(ctxActor, task.id, 'IN_REVIEW');
        // ctxActor is an OWNER (canAdmin) — admins retain the escape hatch on
        // purpose (a departed reviewer must not deadlock the task); the action
        // is audited via TASK_UPDATED.
        const cleared = await updateTask(ctxActor, task.id, { reviewerUserId: null });
        expect(cleared.reviewerUserId).toBeNull();
    });

    it('the reviewer may still be changed freely BEFORE the task reaches review', async () => {
        const task = await createTask(ctxActor, { title: 'Pre-review', type: 'TASK', reviewerUserId: reviewerId });
        // Still OPEN — review isn't required yet, so an editor can adjust it.
        const cleared = await updateTask(ctxEditor, task.id, { reviewerUserId: null });
        expect(cleared.reviewerUserId).toBeNull();
    });

    it('rejects self-review — reviewer must differ from assignee (create, update, assign)', async () => {
        // create
        await expect(
            createTask(ctxActor, {
                title: 'Self review', type: 'TASK',
                assigneeUserId: actorId, reviewerUserId: actorId,
            }),
        ).rejects.toThrow(/different from its assignee/i);

        // update — setting the reviewer to the existing assignee
        const t2 = await createTask(ctxActor, { title: 'Assigned', type: 'TASK', assigneeUserId: actorId });
        await expect(
            updateTask(ctxActor, t2.id, { reviewerUserId: actorId }),
        ).rejects.toThrow(/different from its assignee/i);

        // assign — from the other side: assigning the task to its reviewer
        const t3 = await createTask(ctxActor, { title: 'Reviewed', type: 'TASK', reviewerUserId: reviewerId });
        await expect(
            assignTask(ctxActor, t3.id, reviewerId),
        ).rejects.toThrow(/different from its assignee/i);

        // A genuine two-person split is accepted.
        const ok = await createTask(ctxActor, {
            title: 'Four eyes', type: 'TASK',
            assigneeUserId: actorId, reviewerUserId: reviewerId,
        });
        expect(ok.reviewerUserId).toBe(reviewerId);
    });

    // ─── Watcher fan-out ─────────────────────────────────────────────

    it('a status change notifies the watcher (bell), not the actor', async () => {
        const task = await createTask(ctxActor, { title: 'Watched task', type: 'TASK' });
        await addTaskWatcher(ctxActor, task.id, reviewerId); // reviewer is watching

        await setTaskStatus(ctxActor, task.id, 'IN_PROGRESS');

        const watcherNotif = await db.notification.findFirst({
            where: { tenantId: TENANT, userId: reviewerId, type: 'TASK_WATCH_UPDATE' },
        });
        expect(watcherNotif).not.toBeNull();
        expect(watcherNotif!.message).toContain('OPEN → IN_PROGRESS');

        // The actor (who made the change) is NOT notified as a watcher.
        const actorNotif = await db.notification.findFirst({
            where: { tenantId: TENANT, userId: actorId, type: 'TASK_WATCH_UPDATE' },
        });
        expect(actorNotif).toBeNull();
    });

    it('a MATERIAL edit (due-date reschedule) notifies the watcher', async () => {
        const task = await createTask(ctxActor, { title: 'Reschedule me', type: 'TASK' });
        await addTaskWatcher(ctxActor, task.id, reviewerId);
        await updateTask(ctxActor, task.id, { dueAt: '2030-01-15' });

        const notifs = await db.notification.findMany({
            where: { tenantId: TENANT, userId: reviewerId, type: 'TASK_WATCH_UPDATE' },
        });
        expect(notifs.length).toBeGreaterThan(0);
        expect(notifs.some((n) => n.message.includes('due'))).toBe(true);
    });

    it('a COSMETIC edit (title only) does NOT notify the watcher', async () => {
        const task = await createTask(ctxActor, { title: 'Before', type: 'TASK' });
        await addTaskWatcher(ctxActor, task.id, reviewerId);
        const before = await db.notification.count({
            where: { tenantId: TENANT, userId: reviewerId, type: 'TASK_WATCH_UPDATE' },
        });
        await updateTask(ctxActor, task.id, { title: 'After' });
        const after = await db.notification.count({
            where: { tenantId: TENANT, userId: reviewerId, type: 'TASK_WATCH_UPDATE' },
        });
        // A bell for every save trains people to ignore the bell.
        expect(after).toBe(before);
    });

    it('a comment notifies the watcher', async () => {
        const task = await createTask(ctxActor, { title: 'Commented task', type: 'TASK' });
        await addTaskWatcher(ctxActor, task.id, reviewerId);

        await addTaskComment(ctxActor, task.id, 'please review the attached log');

        const notif = await db.notification.findFirst({
            where: { tenantId: TENANT, userId: reviewerId, type: 'TASK_WATCH_UPDATE', message: { contains: 'comment' } },
        });
        expect(notif).not.toBeNull();
    });
});
