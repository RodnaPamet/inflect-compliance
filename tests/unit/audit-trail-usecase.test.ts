/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/auditLog.ts`.
 *
 * Roadmap Q2 — Audit + audit trail. The usecase is a single
 * delegation wrapped by the AUDITOR-or-ADMIN gate; this test pins
 * the contract so a future refactor can't drop the gate or change
 * the seam.
 *
 * Also removes the file from EXEMPTIONS in
 * tests/guardrails/usecase-test-coverage.test.ts — the ratchet's
 * count assertion catches the shrink and locks the gain.
 */

const mockDb = {} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/AuditLogRepository', () => ({
    AuditLogRepository: {
        list: jest.fn(),
        listPage: jest.fn(),
        resolvePeople: jest.fn(async () => new Map()),
    },
}));

import { AuditLogRepository } from '@/app-layer/repositories/AuditLogRepository';
import { AUDIT_LOG_PAGE_SIZE, listAuditLogPage, listAuditLogs } from '@/app-layer/usecases/auditLog';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN');
const auditorCtx = makeRequestContext('AUDITOR');
const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');

describe('listAuditLogs', () => {
    it('returns rows from AuditLogRepository.list for ADMIN', async () => {
        (AuditLogRepository.list as jest.Mock).mockResolvedValue([{ id: 'a-1' }]);
        const rows = await listAuditLogs(adminCtx);
        expect(rows).toEqual([{ id: 'a-1' }]);
        expect(AuditLogRepository.list).toHaveBeenCalledWith(mockDb, adminCtx);
    });

    it('returns rows for AUDITOR', async () => {
        (AuditLogRepository.list as jest.Mock).mockResolvedValue([{ id: 'a-1' }]);
        await expect(listAuditLogs(auditorCtx)).resolves.toEqual([{ id: 'a-1' }]);
    });

    it('rejects EDITOR (audit gate)', async () => {
        await expect(listAuditLogs(editorCtx)).rejects.toBeDefined();
        expect(AuditLogRepository.list).not.toHaveBeenCalled();
    });

    it('rejects READER (audit gate)', async () => {
        await expect(listAuditLogs(readerCtx)).rejects.toBeDefined();
    });
});

describe('listAuditLogPage — the Audit log page', () => {
    it.each([['ADMIN', adminCtx], ['AUDITOR', auditorCtx]])('reads one page for %s, from the cursor given', async (_r, ctx) => {
        (AuditLogRepository.listPage as jest.Mock).mockResolvedValue({
            rows: [{ id: 'a-1', action: 'RISK_CREATED', entity: 'Risk', entityId: 'r-1', detailsJson: null }],
            nextCursor: 'c-2',
        });
        await expect(listAuditLogPage(ctx, { cursor: 'c-1' })).resolves.toEqual({
            rows: [{ id: 'a-1', action: 'RISK_CREATED', entity: 'Risk', entityId: 'r-1', detailsJson: null, person: null }],
            nextCursor: 'c-2',
        });
        expect(AuditLogRepository.listPage).toHaveBeenCalledWith(mockDb, ctx, { cursor: 'c-1', limit: AUDIT_LOG_PAGE_SIZE });
    });

    it('reads the newest page when no cursor is given', async () => {
        (AuditLogRepository.listPage as jest.Mock).mockResolvedValue({ rows: [], nextCursor: null });
        await listAuditLogPage(adminCtx);
        expect(AuditLogRepository.listPage).toHaveBeenCalledWith(mockDb, adminCtx, { cursor: null, limit: AUDIT_LOG_PAGE_SIZE });
    });

    // #5950: a row names the person it is about by id only; the read resolves
    // the id while the person exists and hands the bare id once they do not.
    it('resolves the person each row names by id, and keeps the bare id when nobody resolves', async () => {
        (AuditLogRepository.listPage as jest.Mock).mockResolvedValue({
            rows: [
                { id: 'a-1', action: 'MEMBER_REMOVED', entity: 'TenantMembership', entityId: 'm-1', detailsJson: { targetUserId: 'u-1' } },
                { id: 'a-2', action: 'MEMBER_REMOVED', entity: 'TenantMembership', entityId: 'm-2', detailsJson: { targetUserId: 'u-gone' } },
                { id: 'a-3', action: 'RISK_CREATED', entity: 'Risk', entityId: 'r-1', detailsJson: null },
            ],
            nextCursor: null,
        });
        (AuditLogRepository.resolvePeople as jest.Mock).mockResolvedValueOnce(new Map([['user:u-1', 'Alice Example']]));
        const page = await listAuditLogPage(adminCtx);
        expect(page.rows.map((r) => r.person)).toEqual([
            { id: 'u-1', label: 'Alice Example' },
            { id: 'u-gone', label: null },
            null,
        ]);
        expect(AuditLogRepository.resolvePeople).toHaveBeenCalledWith(mockDb, adminCtx, [
            { kind: 'user', id: 'u-1' },
            { kind: 'user', id: 'u-gone' },
        ]);
    });

    it.each([['EDITOR', editorCtx], ['READER', readerCtx]])('rejects %s (audit gate) before reading', async (_r, ctx) => {
        await expect(listAuditLogPage(ctx)).rejects.toBeDefined();
        expect(AuditLogRepository.listPage).not.toHaveBeenCalled();
    });
});
