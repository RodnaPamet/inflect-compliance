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
    },
}));

import { AuditLogRepository } from '@/app-layer/repositories/AuditLogRepository';
import { listAuditLogs } from '@/app-layer/usecases/auditLog';
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
