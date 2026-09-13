/**
 * Tasks roadmap TP-6 (P4.11) — two-tenant task isolation (integration).
 *
 * Proves, against a real DB with RLS active, that a tenant-B caller
 * cannot read or mutate tenant-A tasks or their children (comments,
 * links, watchers). Read/guarded-mutation of a foreign task id throws
 * notFound; unguarded child writes (addComment / addLink /
 * addTaskWatcher) never appear in tenant A's view — the write is scoped
 * to the caller's tenant, so tenant A's task is unaffected either way.
 *
 * Hits a real DB (project convention).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createTask,
    getTask,
    updateTask,
    deleteTask,
    setTaskStatus,
    addTaskComment,
    listTaskComments,
    addTaskLink,
    listTaskLinks,
    addTaskWatcher,
} from '@/app-layer/usecases/task';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `task-iso-${randomUUID().slice(0, 8)}`;
const TENANT_A = `t-${TAG}-a`;
const TENANT_B = `t-${TAG}-b`;

let ownerA = '';
let ownerB = '';
let ctxA: ReturnType<typeof makeRequestContext>;
let ctxB: ReturnType<typeof makeRequestContext>;
let taskAId = '';
let controlAId = '';

async function makeUser(label: string, tenantId: string, role: Role): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('task isolation — two tenants (integration)', () => {
    beforeAll(async () => {
        for (const [id, slug] of [
            [TENANT_A, `${TAG}-a`],
            [TENANT_B, `${TAG}-b`],
        ]) {
            await globalPrisma.tenant.upsert({
                where: { id },
                update: {},
                create: { id, name: `t ${slug}`, slug },
            });
        }
        ownerA = await makeUser('owner-a', TENANT_A, Role.OWNER);
        ownerB = await makeUser('owner-b', TENANT_B, Role.OWNER);
        ctxA = makeRequestContext('OWNER', { tenantId: TENANT_A, tenantSlug: `${TAG}-a`, userId: ownerA });
        ctxB = makeRequestContext('OWNER', { tenantId: TENANT_B, tenantSlug: `${TAG}-b`, userId: ownerB });

        const controlA = await globalPrisma.control.create({
            data: { tenantId: TENANT_A, code: 'C-ISO', name: 'Iso control' },
        });
        controlAId = controlA.id;

        // Tenant A's task, seeded with a comment + a link + a watcher.
        const taskA = await createTask(ctxA, { title: 'tenant A task' });
        taskAId = taskA.id;
        await addTaskComment(ctxA, taskAId, 'A comment');
        await addTaskLink(ctxA, taskAId, 'CONTROL', controlAId);
        await addTaskWatcher(ctxA, taskAId, ownerA);
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) {
            await globalPrisma.$disconnect();
            return;
        }
        for (const tid of [TENANT_A, TENANT_B]) {
            await globalPrisma.taskComment.deleteMany({ where: { tenantId: tid } });
            await globalPrisma.taskWatcher.deleteMany({ where: { tenantId: tid } });
            await globalPrisma.taskLink.deleteMany({ where: { tenantId: tid } });
            await globalPrisma.task.deleteMany({ where: { tenantId: tid } });
            await globalPrisma.control.deleteMany({ where: { tenantId: tid } });
        }
        await deleteAuditRowsForTenants(globalPrisma, [TENANT_A, TENANT_B]);
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            for (const tid of [TENANT_A, TENANT_B]) {
                await tx.$executeRawUnsafe(`DELETE FROM "Notification" WHERE "tenantId" = $1`, tid);
                await tx.$executeRawUnsafe(`DELETE FROM "NotificationOutbox" WHERE "tenantId" = $1`, tid);
                await tx.$executeRawUnsafe(`DELETE FROM "AutomationExecution" WHERE "tenantId" = $1`, tid);
                await tx.$executeRawUnsafe(`DELETE FROM "TaskKeySequence" WHERE "tenantId" = $1`, tid);
                await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, tid);
            }
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [ownerA, ownerB] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
        await globalPrisma.$disconnect();
    });

    it('tenant B cannot READ tenant A task', async () => {
        await expect(getTask(ctxB, taskAId)).rejects.toThrow(/not found/i);
    });

    it('tenant B guarded mutations on a tenant-A task throw notFound and leave A unchanged', async () => {
        await expect(updateTask(ctxB, taskAId, { title: 'hijacked' })).rejects.toThrow(/not found/i);
        await expect(setTaskStatus(ctxB, taskAId, 'TRIAGED')).rejects.toThrow(/not found/i);
        await expect(deleteTask(ctxB, taskAId)).rejects.toThrow(/not found/i);

        // Tenant A still sees its task with its original title + status.
        const stillThere = (await getTask(ctxA, taskAId)) as { title: string; status: string };
        expect(stillThere.title).toBe('tenant A task');
        expect(stillThere.status).toBe('OPEN');
    });

    it('tenant B child writes never appear in tenant A view', async () => {
        // These usecases do not pre-check task ownership; the guarantee
        // is that the write is scoped to tenant B, so tenant A's task is
        // untouched. (Some throw notFound, some write to B's own scope —
        // either way A must not grow.)
        await addTaskComment(ctxB, taskAId, 'B injected comment').catch(() => undefined);
        await addTaskLink(ctxB, taskAId, 'CONTROL', controlAId).catch(() => undefined);
        await addTaskWatcher(ctxB, taskAId, ownerB).catch(() => undefined);

        // Tenant A's view of its own task is unchanged: 1 comment, 1
        // link, 1 watcher — all seeded by A.
        const aComments = await listTaskComments(ctxA, taskAId);
        const aLinks = await listTaskLinks(ctxA, taskAId);
        const aTask = (await getTask(ctxA, taskAId)) as { watchers: unknown[] };

        expect(aComments).toHaveLength(1);
        expect(aLinks).toHaveLength(1);
        expect(aTask.watchers).toHaveLength(1);
    });
});
