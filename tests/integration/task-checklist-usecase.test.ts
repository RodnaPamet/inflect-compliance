/**
 * Ticking a task's checklist, against a real database.
 *
 * The unit test proves the stamping and refusal rules with the repository
 * mocked out. What only a database can prove is the half that lives in SQL:
 * that `lockChecklist`'s raw statement names the right table and columns, that
 * it runs under the tenant's RLS binding, that a soft-deleted task is not
 * found, and — the reason the lock exists — that two people ticking different
 * steps of one task at the same moment both land. A read-modify-write of one
 * JSON column without the lock loses one of them and reports success for both.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { setTaskChecklistItem } from '@/app-layer/usecases/task';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `tcl-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const FOREIGN_TENANT_ID = `t-${TAG}-other`;

const STEPS = ['a', 'b', 'c', 'd'].map((id, i) => ({
    id,
    text: `Step ${i + 1} — record what was checked and who checked it`,
    done: false,
}));

let editorId = '';
let secondEditorId = '';

async function makeUser(label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    return u.id;
}

async function makeTask(tenantId: string, extra: Record<string, unknown> = {}): Promise<string> {
    const task = await globalPrisma.task.create({
        data: {
            tenantId,
            title: 'Declare the authority limits of each agentic deployment',
            createdByUserId: editorId,
            checklistJson: STEPS,
            ...extra,
        },
    });
    return task.id;
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    for (const [id, slug] of [
        [TENANT_ID, TAG],
        [FOREIGN_TENANT_ID, `${TAG}-other`],
    ]) {
        await globalPrisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: `t ${slug}`, slug } });
    }
    editorId = await makeUser('editor');
    secondEditorId = await makeUser('editor2');
    for (const userId of [editorId, secondEditorId]) {
        await globalPrisma.tenantMembership.create({
            data: { tenantId: TENANT_ID, userId, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
        });
    }
});

afterAll(async () => {
    if (!DB_AVAILABLE) {
        await globalPrisma.$disconnect();
        return;
    }
    // Every tick writes an AuditLog row, which holds FKs to the tenant and the
    // user. Clear them with the immutability triggers disabled first, or the
    // deletes below depend on which suite emptied the table before this one.
    await deleteAuditRowsForTenants(globalPrisma, [TENANT_ID, FOREIGN_TENANT_ID]);
    const tenants = { tenantId: { in: [TENANT_ID, FOREIGN_TENANT_ID] } };
    try { await globalPrisma.task.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.tenantMembership.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.user.deleteMany({ where: { id: { in: [editorId, secondEditorId] } } }); } catch { /* best effort */ }
    try { await globalPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_ID, FOREIGN_TENANT_ID] } } }); } catch { /* best effort */ }
    await globalPrisma.$disconnect();
});

describeFn('setTaskChecklistItem (integration)', () => {
    const ctxFor = (userId: string) =>
        makeRequestContext('EDITOR', { tenantId: TENANT_ID, userId, tenantSlug: TAG });

    async function stored(taskId: string) {
        const row = await globalPrisma.task.findUnique({ where: { id: taskId }, select: { checklistJson: true } });
        return row?.checklistJson as Array<Record<string, unknown>>;
    }

    it('persists the tick with who and when, and writes an audit row', async () => {
        const taskId = await makeTask(TENANT_ID);

        await setTaskChecklistItem(ctxFor(editorId), taskId, 'b', true);

        const items = await stored(taskId);
        expect(items.map((i) => i.done)).toEqual([false, true, false, false]);
        expect(items[1].doneByUserId).toBe(editorId);
        expect(typeof items[1].doneAt).toBe('string');

        const audit = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, entityId: taskId, action: 'TASK_CHECKLIST_ITEM_UPDATED' },
        });
        expect(audit).toHaveLength(1);
    });

    it('keeps both of two concurrent ticks on different steps — the lock serialises them', async () => {
        const taskId = await makeTask(TENANT_ID);

        await Promise.all([
            setTaskChecklistItem(ctxFor(editorId), taskId, 'a', true),
            setTaskChecklistItem(ctxFor(secondEditorId), taskId, 'c', true),
            setTaskChecklistItem(ctxFor(editorId), taskId, 'd', true),
        ]);

        const items = await stored(taskId);
        expect(items.map((i) => i.done)).toEqual([true, false, true, true]);
        expect(items[2].doneByUserId).toBe(secondEditorId);
    });

    it('does not reach a task in another tenant', async () => {
        const foreignTaskId = await makeTask(FOREIGN_TENANT_ID);
        await expect(
            setTaskChecklistItem(ctxFor(editorId), foreignTaskId, 'a', true),
        ).rejects.toMatchObject({ status: 404 });
        expect((await stored(foreignTaskId)).every((i) => i.done === false)).toBe(true);
    });

    it('does not reach a soft-deleted task', async () => {
        const taskId = await makeTask(TENANT_ID, { deletedAt: new Date() });
        await expect(
            setTaskChecklistItem(ctxFor(editorId), taskId, 'a', true),
        ).rejects.toMatchObject({ status: 404 });
    });
});
