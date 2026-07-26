/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Wave-B coverage — AuditRepository (previously ~0% branches).
 *
 * Every method takes an explicit `db: PrismaTx`, so the boundary here is a
 * fake `db` with jest.fn() model methods. We assert on the WHERE/select/
 * include/orderBy shapes passed to Prisma and exercise both branches of:
 *   - list(): with/without `take`
 *   - update(): existing-not-found (null) vs existing-found (update path)
 *   - updateChecklistItem(): result null/absent → undefined vs string → enum
 */

import { AuditRepository } from '@/app-layer/repositories/AuditRepository';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function freshDb() {
    return {
        audit: {
            findMany: jest.fn().mockResolvedValue([{ id: 'a1' }]),
            findFirst: jest.fn().mockResolvedValue({ id: 'a1', title: 't' }),
            create: jest.fn().mockResolvedValue({ id: 'a1' }),
            update: jest.fn().mockResolvedValue({ id: 'a1' }),
        },
        auditChecklistItem: {
            create: jest.fn().mockResolvedValue({ id: 'ci1' }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
    };
}

let db: ReturnType<typeof freshDb>;

beforeEach(() => {
    jest.clearAllMocks();
    db = freshDb();
});

describe('AuditRepository.list', () => {
    it('filters by tenantId, orders by createdAt desc, uses list select — defaults take to 500', async () => {
        await AuditRepository.list(db as any, ctx);
        const arg = db.audit.findMany.mock.calls[0][0];
        expect(arg.where).toEqual({ tenantId: 'tenant-1' });
        expect(arg.orderBy).toEqual({ createdAt: 'desc' });
        expect(arg.select.id).toBe(true);
        expect(arg.select._count.select).toEqual({ checklist: true, findings: true });
        // Bounded by default — an absent take falls back to `take ?? 500`.
        expect(arg.take).toBe(500);
    });

    it('applies take when provided (truthy branch)', async () => {
        await AuditRepository.list(db as any, ctx, { take: 25 });
        const arg = db.audit.findMany.mock.calls[0][0];
        expect(arg.take).toBe(25);
    });

    it('keeps take at 0 when explicitly 0 (nullish-coalesce leaves 0)', async () => {
        // `0 ?? 500 === 0` — an explicit take:0 is preserved, not defaulted.
        await AuditRepository.list(db as any, ctx, { take: 0 });
        const arg = db.audit.findMany.mock.calls[0][0];
        expect(arg.take).toBe(0);
    });
});

describe('AuditRepository.getById', () => {
    it('scopes by id + tenantId and includes ordered checklist + findings', async () => {
        await AuditRepository.getById(db as any, ctx, 'a1');
        const arg = db.audit.findFirst.mock.calls[0][0];
        expect(arg.where).toEqual({ id: 'a1', tenantId: 'tenant-1' });
        expect(arg.include.checklist.orderBy).toEqual({ sortOrder: 'asc' });
        expect(arg.include.findings.orderBy).toEqual({ createdAt: 'desc' });
    });
});

describe('AuditRepository.create', () => {
    it('injects tenantId alongside caller data', async () => {
        await AuditRepository.create(db as any, ctx, { title: 'New', status: 'PLANNED' } as any);
        const arg = db.audit.create.mock.calls[0][0];
        expect(arg.data).toEqual({ title: 'New', status: 'PLANNED', tenantId: 'tenant-1' });
    });
});

describe('AuditRepository.update', () => {
    it('returns null when the audit is not found (guard branch)', async () => {
        db.audit.findFirst.mockResolvedValueOnce(null);
        const result = await AuditRepository.update(db as any, ctx, 'missing', { title: 'x' });
        expect(result).toBeNull();
        // Branch: update never reached.
        expect(db.audit.update).not.toHaveBeenCalled();
    });

    it('updates when the audit exists (happy branch)', async () => {
        db.audit.findFirst.mockResolvedValueOnce({ id: 'a1' });
        await AuditRepository.update(db as any, ctx, 'a1', { title: 'x' });
        const arg = db.audit.update.mock.calls[0][0];
        expect(arg.where).toEqual({ id: 'a1' });
        expect(arg.data).toEqual({ title: 'x' });
    });
});

describe('AuditRepository.createChecklistItem', () => {
    it('writes tenantId/auditId/prompt/sortOrder', async () => {
        await AuditRepository.createChecklistItem(db as any, ctx, 'a1', 'Do X', 3);
        const arg = db.auditChecklistItem.create.mock.calls[0][0];
        expect(arg.data).toEqual({
            tenantId: 'tenant-1',
            auditId: 'a1',
            prompt: 'Do X',
            sortOrder: 3,
        });
    });
});

describe('AuditRepository.updateChecklistItem', () => {
    it('maps a string result to the enum and passes notes (string branch)', async () => {
        await AuditRepository.updateChecklistItem(db as any, ctx, 'ci1', 'a1', { result: 'PASS', notes: 'ok' });
        const arg = db.auditChecklistItem.updateMany.mock.calls[0][0];
        // Tenant + audit scoped write via updateMany (id alone is not a
        // compound unique).
        expect(arg.where).toEqual({ id: 'ci1', tenantId: 'tenant-1', auditId: 'a1' });
        expect(arg.data.result).toBe('PASS');
        expect(arg.data.notes).toBe('ok');
    });

    it('treats null result as undefined / leave-unchanged (null branch)', async () => {
        await AuditRepository.updateChecklistItem(db as any, ctx, 'ci1', 'a1', { result: null, notes: 'n' });
        const arg = db.auditChecklistItem.updateMany.mock.calls[0][0];
        expect(arg.data.result).toBeUndefined();
        expect(arg.data.notes).toBe('n');
    });

    it('treats absent result as undefined (absent branch)', async () => {
        await AuditRepository.updateChecklistItem(db as any, ctx, 'ci1', 'a1', {});
        const arg = db.auditChecklistItem.updateMany.mock.calls[0][0];
        expect(arg.data.result).toBeUndefined();
        expect(arg.data.notes).toBeUndefined();
    });
});
