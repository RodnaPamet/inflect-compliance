/**
 * A completed or cancelled audit is read-only, against a real database (#4531).
 *
 * The unit test holds the rule with the repository mocked. This one holds the
 * part a mock cannot: `AuditRepository.lockStatus` is raw SQL, and the reason
 * it reads `FOR UPDATE` is a race only Postgres can show — a cancel committed
 * while an edit is in flight must refuse the edit, not let it land on the
 * cancelled audit.
 */
import { PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { updateAudit } from '@/app-layer/usecases/audit';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'audit-read-only-t1';
const T2 = 'audit-read-only-t2';
const TENANTS = [T1, T2];

let ctx: RequestContext;
let otherCtx: RequestContext;

async function clearOwnRows() {
    await prisma.task.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await prisma.finding.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await prisma.auditChecklistItem.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await prisma.audit.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@audit-read-only.test' } } });
}

beforeAll(async () => {
    await clearOwnRows();
    const contexts: RequestContext[] = [];
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        const email = `editor-${tenantId}@audit-read-only.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role: Role.EDITOR } });
        contexts.push(makeRequestContext('EDITOR', { tenantId, tenantSlug: tenantId, userId: user.id }));
    }
    [ctx, otherCtx] = contexts;
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

async function auditWith(status: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED') {
    const audit = await prisma.audit.create({ data: { tenantId: T1, title: `Audit ${status}`, status } });
    const item = await prisma.auditChecklistItem.create({
        data: { tenantId: T1, auditId: audit.id, prompt: 'Access reviewed', sortOrder: 0 },
    });
    return { auditId: audit.id, itemId: item.id };
}

describe('updateAudit on a closed audit', () => {
    it('refuses an edit to a COMPLETED audit, and the row is unchanged', async () => {
        const { auditId } = await auditWith('COMPLETED');
        await expect(updateAudit(ctx, auditId, { title: 'Renamed' })).rejects.toMatchObject({
            status: 409,
            details: { reason: 'AUDIT_COMPLETED_READ_ONLY' },
        });
        expect((await prisma.audit.findUniqueOrThrow({ where: { id: auditId } })).title).toBe('Audit COMPLETED');
    });

    it('accepts the move back to IN_PROGRESS on a COMPLETED audit', async () => {
        const { auditId } = await auditWith('COMPLETED');
        await updateAudit(ctx, auditId, { status: 'IN_PROGRESS' });
        expect((await prisma.audit.findUniqueOrThrow({ where: { id: auditId } })).status).toBe('IN_PROGRESS');
    });

    it('refuses a checklist FAIL on a CANCELLED audit: no result, no finding, no task', async () => {
        const { auditId, itemId } = await auditWith('CANCELLED');
        await expect(
            updateAudit(ctx, auditId, { checklistUpdates: [{ id: itemId, result: 'FAIL' }] }),
        ).rejects.toMatchObject({ status: 409, details: { reason: 'AUDIT_CANCELLED_READ_ONLY' } });
        expect((await prisma.auditChecklistItem.findUniqueOrThrow({ where: { id: itemId } })).result).toBe('NOT_TESTED');
        expect(await prisma.finding.count({ where: { auditId } })).toBe(0);
    });

    it('an open audit still takes a checklist result', async () => {
        // PASS, not FAIL: the FAIL cascade (finding + task) on an open audit is
        // held by the unit test, and here it only adds a slow task insert.
        const { auditId, itemId } = await auditWith('IN_PROGRESS');
        await updateAudit(ctx, auditId, { checklistUpdates: [{ id: itemId, result: 'PASS' }] });
        expect((await prisma.auditChecklistItem.findUniqueOrThrow({ where: { id: itemId } })).result).toBe('PASS');
    });

    it('another tenant’s audit is not found, whatever its status', async () => {
        const { auditId } = await auditWith('PLANNED');
        await expect(updateAudit(otherCtx, auditId, { title: 'Theirs now' })).rejects.toMatchObject({ status: 404 });
        expect((await prisma.audit.findUniqueOrThrow({ where: { id: auditId } })).title).toBe('Audit PLANNED');
    });

    it('a cancel committed while an edit waits on the row refuses the edit', async () => {
        const { auditId } = await auditWith('PLANNED');
        // Hold the row: cancel it in a transaction that commits only after the
        // edit has started. With a plain read the edit would see PLANNED, wait
        // on the row for its UPDATE, and then write onto the cancelled audit.
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let locked!: () => void;
        const isLocked = new Promise<void>((resolve) => { locked = resolve; });
        const cancel = prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT 1 FROM "Audit" WHERE "id" = ${auditId} FOR UPDATE`;
            await tx.audit.update({ where: { id: auditId }, data: { status: 'CANCELLED' } });
            locked();
            await held;
        }, { timeout: 20_000 });
        await isLocked;
        const edit = updateAudit(ctx, auditId, { title: 'Edited during the cancel' });
        // Give the edit time to reach the lock before the cancel commits.
        await new Promise((r) => setTimeout(r, 300));
        release();
        await cancel;
        await expect(edit).rejects.toMatchObject({ status: 409, details: { reason: 'AUDIT_CANCELLED_READ_ONLY' } });
        const row = await prisma.audit.findUniqueOrThrow({ where: { id: auditId } });
        expect(row).toMatchObject({ status: 'CANCELLED', title: 'Audit PLANNED' });
    });
});
