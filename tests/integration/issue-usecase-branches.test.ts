/**
 * Branch-coverage integration test for the (deprecated) issue usecases —
 * which delegate to the WorkItemRepository. Exercises the error paths +
 * conditional branches the happy-path suite skips: not-found across every
 * read/mutation, READER permission denials, the work-item state-machine
 * gates (no-op / illegal / terminal-without-resolution), assignment,
 * links, comments, watchers, bulk actions, the overdue-job scan, control
 * linking, and the deprecated evidence-bundle stubs (which throw).
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
    listIssues,
    getIssue,
    createIssue,
    updateIssue,
    setIssueStatus,
    assignIssue,
    listIssueLinks,
    addIssueLink,
    removeIssueLink,
    listIssueComments,
    addIssueComment,
    listIssueWatchers,
    addIssueWatcher,
    removeIssueWatcher,
    getIssueMetrics,
    getIssueActivity,
    bulkAssign,
    bulkSetStatus,
    bulkSetDueDate,
    findOverdueIssuesAndEmitEvents,
    listIssuesByControl,
    listBundles,
    getBundle,
    createBundle,
    freezeBundle,
    addBundleItem,
    listBundleItems,
} from '@/app-layer/usecases/issue';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `issue-br-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let ownerUserId: string;
let readerUserId: string;
let controlId: string;
let ctx: ReturnType<typeof makeRequestContext>;
let reader: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('issue usecase — branch coverage (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        readerUserId = await makeUser('reader', Role.READER);
        const control = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'C-I1', name: 'Issue control' },
        });
        controlId = control.id;
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: ownerUserId });
        reader = makeRequestContext('READER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: readerUserId });
    });

    afterAll(async () => {
        await globalPrisma.taskComment.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.taskWatcher.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.taskLink.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.task.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.control.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "AutomationExecution" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "NotificationOutbox" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TaskKeySequence" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [ownerUserId, readerUserId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('not-found paths throw across read + mutation usecases', async () => {
        await expect(getIssue(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(updateIssue(ctx, 'nope', { title: 'x' })).rejects.toThrow(/not found/i);
        await expect(setIssueStatus(ctx, 'nope', 'TRIAGED')).rejects.toThrow(/not found/i);
        await expect(assignIssue(ctx, 'nope', null)).rejects.toThrow(/not found/i);
        await expect(removeIssueLink(ctx, 'nope', 'nope')).rejects.toThrow(/not found/i);
        await expect(removeIssueWatcher(ctx, 'nope', ownerUserId)).rejects.toThrow(/not found|watcher/i);
    });

    it('READER is denied every write/comment action, allowed reads', async () => {
        const iss = await createIssue(ctx, { title: 'perm target', type: 'TASK' });
        await expect(createIssue(reader, { title: 'x', type: 'TASK' })).rejects.toThrow(/permission/i);
        await expect(updateIssue(reader, iss.id, { title: 'x' })).rejects.toThrow(/permission/i);
        await expect(setIssueStatus(reader, iss.id, 'TRIAGED')).rejects.toThrow(/permission/i);
        await expect(assignIssue(reader, iss.id, null)).rejects.toThrow(/permission/i);
        await expect(addIssueLink(reader, iss.id, 'CONTROL', controlId)).rejects.toThrow(/permission/i);
        await expect(removeIssueLink(reader, iss.id, 'x')).rejects.toThrow(/permission/i);
        await expect(addIssueComment(reader, iss.id, 'hi')).rejects.toThrow(/permission/i);
        await expect(addIssueWatcher(reader, iss.id, ownerUserId)).rejects.toThrow(/permission/i);
        await expect(removeIssueWatcher(reader, iss.id, ownerUserId)).rejects.toThrow(/permission/i);
        await expect(bulkAssign(reader, [iss.id], null)).rejects.toThrow(/permission/i);
        await expect(bulkSetStatus(reader, [iss.id], 'TRIAGED')).rejects.toThrow(/permission/i);
        await expect(bulkSetDueDate(reader, [iss.id], null)).rejects.toThrow(/permission/i);
        await expect(createBundle(reader, iss.id, 'b')).rejects.toThrow(/permission/i);
        await expect(freezeBundle(reader, 'b')).rejects.toThrow(/permission/i);
        await expect(addBundleItem(reader, 'b', { entityType: 'X', entityId: 'y' })).rejects.toThrow(/permission/i);
        // reads allowed
        await expect(getIssue(reader, iss.id)).resolves.toBeTruthy();
        await expect(listIssues(reader)).resolves.toBeDefined();
        await expect(getIssueMetrics(reader)).resolves.toBeDefined();
    });

    it('createIssue + updateIssue + getIssue derived SLA', async () => {
        const iss = await createIssue(ctx, {
            title: 'full issue',
            type: 'TASK',
            description: 'desc',
            severity: 'HIGH',
            priority: 'P1',
            dueAt: new Date().toISOString(),
            assigneeUserId: readerUserId,
        });
        expect(iss.assigneeUserId).toBe(readerUserId);
        const fetched = await getIssue(ctx, iss.id);
        expect(fetched.sla).toBeDefined();
        const upd = await updateIssue(ctx, iss.id, { title: 'renamed', severity: 'LOW', priority: 'P3', dueAt: null });
        expect(upd?.title).toBe('renamed');
    });

    it('setIssueStatus: no-op, terminal-without-resolution, terminal-with-resolution, illegal', async () => {
        const iss = await createIssue(ctx, { title: 'status', type: 'TASK' });
        await expect(setIssueStatus(ctx, iss.id, 'OPEN')).rejects.toThrow(/already OPEN/i);
        const triaged = await setIssueStatus(ctx, iss.id, 'TRIAGED');
        expect(triaged?.status).toBe('TRIAGED');
        await expect(setIssueStatus(ctx, iss.id, 'CLOSED')).rejects.toThrow(/resolution is required/i);
        const closed = await setIssueStatus(ctx, iss.id, 'CLOSED', '  resolved  ');
        expect(closed?.status).toBe('CLOSED');
        await expect(setIssueStatus(ctx, iss.id, 'OPEN')).rejects.toThrow(/illegal/i);
    });

    it('assignIssue: assign then unassign', async () => {
        const iss = await createIssue(ctx, { title: 'assign', type: 'TASK' });
        const a = await assignIssue(ctx, iss.id, readerUserId);
        expect(a.assigneeUserId).toBe(readerUserId);
        const u = await assignIssue(ctx, iss.id, null);
        expect(u.assigneeUserId).toBeNull();
    });

    it('links + comments + watchers happy paths and activity', async () => {
        const iss = await createIssue(ctx, { title: 'rel', type: 'TASK' });
        const link = await addIssueLink(ctx, iss.id, 'CONTROL', controlId, 'RELATES_TO');
        expect((await listIssueLinks(ctx, iss.id)).length).toBeGreaterThan(0);
        const removed = await removeIssueLink(ctx, iss.id, link.id);
        expect(removed).toBe(true);
        await expect(removeIssueLink(ctx, iss.id, link.id)).rejects.toThrow(/not found/i);

        const c = await addIssueComment(ctx, iss.id, '<b>hi</b>there');
        expect(c.id).toBeTruthy();
        expect((await listIssueComments(ctx, iss.id)).length).toBe(1);

        await addIssueWatcher(ctx, iss.id, ownerUserId);
        expect((await listIssueWatchers(ctx, iss.id)).length).toBe(1);
        expect(await removeIssueWatcher(ctx, iss.id, ownerUserId)).toBe(true);

        expect(Array.isArray(await getIssueActivity(ctx, iss.id))).toBe(true);
    });

    it('list filters + by-control + metrics', async () => {
        await createIssue(ctx, { title: 'metric src', type: 'TASK', severity: 'HIGH' });
        expect(Array.isArray(await listIssues(ctx, { status: 'OPEN' }))).toBe(true);
        expect(Array.isArray(await listIssues(ctx, { severity: 'HIGH' }))).toBe(true);
        const m = await getIssueMetrics(ctx);
        expect(m.total).toBeGreaterThan(0);

        const linked = await createIssue(ctx, { title: 'linked', type: 'TASK' });
        await addIssueLink(ctx, linked.id, 'CONTROL', controlId);
        const byControl = await listIssuesByControl(ctx, controlId);
        expect(byControl.length).toBeGreaterThan(0);
    });

    it('bulk: assign, set-status gates + all-or-nothing, set-due', async () => {
        const a = await createIssue(ctx, { title: 'bulk-a', type: 'TASK' });
        const b = await createIssue(ctx, { title: 'bulk-b', type: 'TASK' });
        await bulkAssign(ctx, [a.id, b.id], readerUserId);
        await bulkAssign(ctx, [a.id, b.id], null);
        await expect(bulkSetStatus(ctx, [a.id, b.id], 'CLOSED')).rejects.toThrow(/resolution is required/i);
        await expect(bulkSetStatus(ctx, [a.id, 'nope'], 'TRIAGED')).rejects.toThrow(/not found/i);
        const r = await bulkSetStatus(ctx, [a.id, b.id], 'TRIAGED');
        expect(r.count).toBe(2);
        await expect(bulkSetStatus(ctx, [a.id, b.id], 'OPEN')).rejects.toThrow(/illegal/i);
        // legal bulk terminal transition WITH a resolution (trim branch)
        const closed = await bulkSetStatus(ctx, [a.id, b.id], 'CLOSED', '  bulk done  ');
        expect(closed.count).toBe(2);
        await bulkSetDueDate(ctx, [a.id, b.id], new Date().toISOString());
        await bulkSetDueDate(ctx, [a.id, b.id], null);
    });

    it('findOverdueIssuesAndEmitEvents picks up a past-due open issue', async () => {
        await createIssue(ctx, {
            title: 'overdue',
            type: 'TASK',
            dueAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
        });
        const res = await findOverdueIssuesAndEmitEvents(ctx);
        expect(res.processed).toBeGreaterThan(0);
    });

    it('evidence-bundle stubs: empty lists + deprecated throwers', async () => {
        const iss = await createIssue(ctx, { title: 'bundles', type: 'TASK' });
        expect(await listBundles(ctx, iss.id)).toEqual([]);
        expect(await getBundle(ctx, 'bid')).toBeNull();
        expect(await listBundleItems(ctx, 'bid')).toEqual([]);
        await expect(createBundle(ctx, iss.id, 'b')).rejects.toThrow(/no longer supported/i);
        await expect(freezeBundle(ctx, 'bid')).rejects.toThrow(/no longer supported/i);
        await expect(addBundleItem(ctx, 'bid', { entityType: 'X', entityId: 'y' })).rejects.toThrow(/no longer supported/i);
    });
});
