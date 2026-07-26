/**
 * Branch-coverage integration test for the task usecases — exercises the
 * error paths + conditional branches the happy-path suite skips:
 * not-found across every read/mutation, READER permission denials,
 * metadataJson validation, the field three-states on update, the work-item
 * state-machine gates (no-op / illegal / terminal-without-resolution), the
 * type-relevance gate (AUDIT_FINDING / CONTROL_GAP / INCIDENT), assignment,
 * links, evidence link/unlink, comments, watchers, bulk actions, and the
 * list-filter combinations.
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
    listTasks,
    listTasksPaginated,
    getTask,
    createTask,
    updateTask,
    bulkDeleteTask,
    deleteTask,
    setTaskStatus,
    assignTask,
    listTaskLinks,
    addTaskLink,
    removeTaskLink,
    getTaskEvidenceTab,
    linkTaskEvidence,
    unlinkTaskEvidence,
    listTaskComments,
    addTaskComment,
    listTaskWatchers,
    addTaskWatcher,
    removeTaskWatcher,
    getTaskMetrics,
    getTaskActivity,
    bulkAssignTasks,
    bulkSetTaskStatus,
    bulkSetTaskDueDate,
    listTasksByControl,
} from '@/app-layer/usecases/task';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `task-br-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let ownerUserId: string;
let readerUserId: string;
let controlId: string;
let assetId: string;
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

describeFn('task usecase — branch coverage (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        readerUserId = await makeUser('reader', Role.READER);
        const control = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'C-T1', name: 'Task control' },
        });
        controlId = control.id;
        // A REAL asset: task links now resolve their target against the
        // tenant before insert, so a synthetic id no longer inserts.
        const asset = await globalPrisma.asset.create({
            data: { tenantId: TENANT_ID, name: 'Task asset', type: 'SYSTEM' },
        });
        assetId = asset.id;
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: ownerUserId });
        reader = makeRequestContext('READER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: readerUserId });
    });

    afterAll(async () => {
        await globalPrisma.asset.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.evidence.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.taskComment.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.taskWatcher.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.taskLink.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.task.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.control.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "Notification" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "NotificationOutbox" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "AutomationExecution" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TaskKeySequence" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [ownerUserId, readerUserId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('not-found paths throw across read + mutation usecases', async () => {
        await expect(getTask(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(updateTask(ctx, 'nope', { title: 'x' })).rejects.toThrow(/not found/i);
        await expect(deleteTask(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(setTaskStatus(ctx, 'nope', 'TRIAGED')).rejects.toThrow(/not found/i);
        await expect(assignTask(ctx, 'nope', null)).rejects.toThrow(/not found/i);
        await expect(removeTaskLink(ctx, 'nope', 'nope')).rejects.toThrow(/not found/i);
        await expect(getTaskEvidenceTab(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(linkTaskEvidence(ctx, 'nope', { url: 'http://x' })).rejects.toThrow(/not found/i);
        await expect(unlinkTaskEvidence(ctx, 'nope', 'x')).rejects.toThrow(/not found/i);
        await expect(removeTaskWatcher(ctx, 'nope', ownerUserId)).rejects.toThrow(/not found|watcher/i);
    });

    it('READER is denied every write/comment action, allowed reads', async () => {
        const t = await createTask(ctx, { title: 'perm target' });
        await expect(createTask(reader, { title: 'x' })).rejects.toThrow(/permission/i);
        await expect(updateTask(reader, t.id, { title: 'x' })).rejects.toThrow(/permission/i);
        await expect(deleteTask(reader, t.id)).rejects.toThrow(/permission/i);
        await expect(bulkDeleteTask(reader, [t.id])).rejects.toThrow(/permission/i);
        await expect(setTaskStatus(reader, t.id, 'TRIAGED')).rejects.toThrow(/permission/i);
        await expect(assignTask(reader, t.id, null)).rejects.toThrow(/permission/i);
        await expect(addTaskLink(reader, t.id, 'CONTROL', controlId)).rejects.toThrow(/permission/i);
        await expect(removeTaskLink(reader, t.id, 'x')).rejects.toThrow(/permission/i);
        await expect(linkTaskEvidence(reader, t.id, { url: 'http://x' })).rejects.toThrow(/permission/i);
        await expect(unlinkTaskEvidence(reader, t.id, 'x')).rejects.toThrow(/permission/i);
        await expect(addTaskComment(reader, t.id, 'hi')).rejects.toThrow(/permission/i);
        await expect(addTaskWatcher(reader, t.id, ownerUserId)).rejects.toThrow(/permission/i);
        await expect(removeTaskWatcher(reader, t.id, ownerUserId)).rejects.toThrow(/permission/i);
        await expect(bulkAssignTasks(reader, [t.id], null)).rejects.toThrow(/permission/i);
        await expect(bulkSetTaskStatus(reader, [t.id], 'TRIAGED')).rejects.toThrow(/permission/i);
        await expect(bulkSetTaskDueDate(reader, [t.id], null)).rejects.toThrow(/permission/i);
        // reads allowed
        await expect(getTask(reader, t.id)).resolves.toBeTruthy();
        await expect(listTasks(reader)).resolves.toBeDefined();
        await expect(getTaskMetrics(reader)).resolves.toBeDefined();
    });

    it('createTask: invalid metadataJson rejected, valid + assignee + dueAt accepted', async () => {
        await expect(
            createTask(ctx, { title: 'bad meta', metadataJson: 42 }),
        ).rejects.toThrow(/metadataJson/i);

        const dueSoon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const t = await createTask(ctx, {
            title: 'full create',
            type: 'TASK',
            description: 'desc',
            severity: 'HIGH',
            priority: 'P1',
            dueAt: dueSoon,
            assigneeUserId: readerUserId,
            metadataJson: { foo: 'bar' },
        });
        expect(t.key).toMatch(/^TSK-/);
        expect(t.assigneeUserId).toBe(readerUserId);
        // getTask attaches the derived SLA status.
        const fetched = await getTask(ctx, t.id);
        expect(fetched.sla).toBeDefined();
    });

    it('updateTask: invalid metadata + the field three-states', async () => {
        const t = await createTask(ctx, { title: 'upd', dueAt: new Date().toISOString(), controlId });
        await expect(updateTask(ctx, t.id, { metadataJson: 42 })).rejects.toThrow(/metadataJson/i);
        // set values
        const u1 = await updateTask(ctx, t.id, {
            title: 'renamed',
            description: 'new',
            type: 'IMPROVEMENT',
            severity: 'LOW',
            priority: 'P3',
            dueAt: new Date().toISOString(),
            controlId,
            metadataJson: { a: 1 },
        });
        expect(u1?.title).toBe('renamed');
        // null-out the nullable fields
        const u2 = await updateTask(ctx, t.id, { description: null, dueAt: null, controlId: null, metadataJson: null });
        expect(u2?.dueAt).toBeNull();
        expect(u2?.controlId).toBeNull();
        // leave-undefined (no-op patch) still returns the row
        const u3 = await updateTask(ctx, t.id, {});
        expect(u3?.id).toBe(t.id);
    });

    it('setTaskStatus: no-op, illegal, terminal-without-resolution, terminal-with-resolution', async () => {
        const t = await createTask(ctx, { title: 'status', controlId });
        // no-op (OPEN → OPEN)
        await expect(setTaskStatus(ctx, t.id, 'OPEN')).rejects.toThrow(/already OPEN/i);
        // legal non-terminal transition
        const triaged = await setTaskStatus(ctx, t.id, 'TRIAGED');
        expect(triaged?.status).toBe('TRIAGED');
        // terminal without resolution
        await expect(setTaskStatus(ctx, t.id, 'CLOSED')).rejects.toThrow(/resolution is required/i);
        // terminal with resolution (controlId satisfies type-relevance)
        const closed = await setTaskStatus(ctx, t.id, 'CLOSED', '  done  ');
        expect(closed?.status).toBe('CLOSED');
        // illegal transition out of terminal CLOSED
        await expect(setTaskStatus(ctx, t.id, 'OPEN')).rejects.toThrow(/illegal/i);
    });

    it('setTaskStatus type-relevance: AUDIT_FINDING + INCIDENT gates and their satisfiers', async () => {
        // AUDIT_FINDING with no controlId + no link → RESOLVE rejected.
        const af = await createTask(ctx, { title: 'audit finding', type: 'AUDIT_FINDING' });
        await expect(setTaskStatus(ctx, af.id, 'RESOLVED', 'x')).rejects.toThrow(/controlId or a link/i);
        // satisfy via a CONTROL link → now resolvable.
        await addTaskLink(ctx, af.id, 'CONTROL', controlId);
        const afResolved = await setTaskStatus(ctx, af.id, 'RESOLVED', 'fixed');
        expect(afResolved?.status).toBe('RESOLVED');

        // INCIDENT with no controlId/link → rejected; ASSET link satisfies.
        const inc = await createTask(ctx, { title: 'incident', type: 'INCIDENT' });
        await expect(setTaskStatus(ctx, inc.id, 'RESOLVED', 'x')).rejects.toThrow(/controlId or a link to CONTROL or ASSET/i);
        await addTaskLink(ctx, inc.id, 'ASSET', assetId);
        const incResolved = await setTaskStatus(ctx, inc.id, 'RESOLVED', 'contained');
        expect(incResolved?.status).toBe('RESOLVED');

        // CONTROL_GAP with controlId set on the row → early return, resolvable.
        const cg = await createTask(ctx, { title: 'gap', type: 'CONTROL_GAP', controlId });
        const cgResolved = await setTaskStatus(ctx, cg.id, 'RESOLVED', 'closed gap');
        expect(cgResolved?.status).toBe('RESOLVED');
    });

    it('assignTask: assign to a user then unassign, plus notification side effects', async () => {
        const t = await createTask(ctx, { title: 'assign', dueAt: new Date(Date.now() + 3600_000).toISOString() });
        const assigned = await assignTask(ctx, t.id, readerUserId);
        expect(assigned.assigneeUserId).toBe(readerUserId);
        const unassigned = await assignTask(ctx, t.id, null);
        expect(unassigned.assigneeUserId).toBeNull();
    });

    it('links: add, list, remove + not-found removal', async () => {
        const t = await createTask(ctx, { title: 'links' });
        const link = await addTaskLink(ctx, t.id, 'CONTROL', controlId, 'RELATES_TO');
        const links = await listTaskLinks(ctx, t.id);
        expect(links.length).toBeGreaterThan(0);
        const removed = await removeTaskLink(ctx, t.id, link.id);
        expect(removed).toBe(true);
        await expect(removeTaskLink(ctx, t.id, link.id)).rejects.toThrow(/not found/i);
    });

    it('evidence: tab payload, link with + without note, unlink + not-found', async () => {
        const t = await createTask(ctx, { title: 'evidence' });
        const empty = await getTaskEvidenceTab(ctx, t.id);
        expect(empty.evidence).toEqual([]);
        // link with a note (sanitised) then without a note (url as title)
        const ev1 = await linkTaskEvidence(ctx, t.id, { url: 'https://example.test/a', note: 'a note' });
        const ev2 = await linkTaskEvidence(ctx, t.id, { url: 'https://example.test/b' });
        const tab = await getTaskEvidenceTab(ctx, t.id);
        expect(tab.evidence.length).toBe(2);
        await unlinkTaskEvidence(ctx, t.id, ev1.id);
        await expect(unlinkTaskEvidence(ctx, t.id, ev1.id)).rejects.toThrow(/not found/i);
        // ev2 still attached
        const after = await getTaskEvidenceTab(ctx, t.id);
        expect(after.evidence.map((e) => e.id)).toContain(ev2.id);
    });

    it('comments + watchers happy paths and activity feed', async () => {
        const t = await createTask(ctx, { title: 'comments' });
        const c = await addTaskComment(ctx, t.id, '<script>alert(1)</script>hello');
        expect(c.id).toBeTruthy();
        const comments = await listTaskComments(ctx, t.id);
        expect(comments.length).toBe(1);
        const w = await addTaskWatcher(ctx, t.id, ownerUserId);
        expect(w).toBeTruthy();
        const watchers = await listTaskWatchers(ctx, t.id);
        expect(watchers.length).toBe(1);
        const removedW = await removeTaskWatcher(ctx, t.id, ownerUserId);
        expect(removedW).toBe(true);
        const activity = await getTaskActivity(ctx, t.id);
        expect(Array.isArray(activity)).toBe(true);
    });

    it('list filter combinations + paginated + by-control', async () => {
        await createTask(ctx, { title: 'filtered', severity: 'HIGH', priority: 'P1', controlId, assigneeUserId: ownerUserId });
        expect(Array.isArray(await listTasks(ctx, { status: 'OPEN' }))).toBe(true);
        expect(Array.isArray(await listTasks(ctx, { type: 'TASK' }))).toBe(true);
        expect(Array.isArray(await listTasks(ctx, { severity: 'HIGH' }))).toBe(true);
        expect(Array.isArray(await listTasks(ctx, { priority: 'P1' }))).toBe(true);
        expect(Array.isArray(await listTasks(ctx, { assigneeUserId: ownerUserId }))).toBe(true);
        expect(Array.isArray(await listTasks(ctx, { controlId }))).toBe(true);
        expect(Array.isArray(await listTasks(ctx, { due: 'overdue' }))).toBe(true);
        expect(Array.isArray(await listTasks(ctx, { due: 'next7d' }))).toBe(true);
        expect(Array.isArray(await listTasks(ctx, { q: 'filtered' }))).toBe(true);
        expect(Array.isArray(await listTasks(ctx, { linkedEntityType: 'CONTROL', linkedEntityId: controlId }))).toBe(true);
        expect(Array.isArray(await listTasks(ctx, {}, { take: 5 }))).toBe(true);
        const page = await listTasksPaginated(ctx, { limit: 2 });
        expect(page.items).toBeDefined();
        expect(Array.isArray(await listTasksByControl(ctx, controlId))).toBe(true);
    });

    it('bulk: assign, set-status (gates + all-or-nothing), set-due, delete', async () => {
        const a = await createTask(ctx, { title: 'bulk-a' });
        const b = await createTask(ctx, { title: 'bulk-b' });
        // bulk assign + unassign
        await bulkAssignTasks(ctx, [a.id, b.id], readerUserId);
        await bulkAssignTasks(ctx, [a.id, b.id], null);
        // terminal without resolution → reject
        await expect(bulkSetTaskStatus(ctx, [a.id, b.id], 'CLOSED')).rejects.toThrow(/resolution is required/i);
        // not-found id in batch → reject
        await expect(bulkSetTaskStatus(ctx, [a.id, 'nope'], 'TRIAGED')).rejects.toThrow(/not found/i);
        // legal bulk transition
        const r = await bulkSetTaskStatus(ctx, [a.id, b.id], 'TRIAGED');
        expect(r.count).toBe(2);
        // illegal bulk transition (TRIAGED → OPEN is not allowed)
        await expect(bulkSetTaskStatus(ctx, [a.id, b.id], 'OPEN')).rejects.toThrow(/illegal/i);
        // bulk due date
        await bulkSetTaskDueDate(ctx, [a.id, b.id], new Date().toISOString());
        await bulkSetTaskDueDate(ctx, [a.id, b.id], null);
        // bulk delete: empty set → deleted 0, then real delete
        expect(await bulkDeleteTask(ctx, ['nope-1', 'nope-2'])).toEqual({ deleted: 0 });
        const del = await bulkDeleteTask(ctx, [a.id, b.id]);
        expect(del.deleted).toBe(2);
    });

    it('deleteTask happy path removes the row', async () => {
        const t = await createTask(ctx, { title: 'to delete' });
        const res = await deleteTask(ctx, t.id);
        expect(res.id).toBe(t.id);
        await expect(getTask(ctx, t.id)).rejects.toThrow(/not found/i);
    });
});
