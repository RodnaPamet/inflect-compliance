/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * `clearFileQuarantine` — the only in-app way back from a terminal
 * `scanStatus: INFECTED`.
 *
 * The REAL `FileRepository` runs against a mocked Prisma delegate, so
 * these tests exercise the repository's own guards (reason required,
 * auditLogId required, the INFECTED + non-DELETED predicate) rather
 * than a stub that would happily accept anything.
 *
 * The invariants under test, in the order they matter:
 *
 *   1. ADMIN is refused and OWNER succeeds — `admin.tenant_lifecycle`
 *      is the key ADMIN is explicitly denied. A refusal must reach
 *      neither the audit chain nor the write.
 *   2. The audit row is written BEFORE the state transition, and its
 *      id is threaded into the row's own `scanDetails`. Proven by
 *      invocation order, not by both merely having been called.
 *   3. A refused claim (race, deleted row) leaves the audit row
 *      standing — the decision was taken even though the write lost.
 *   4. The human reason is mandatory, bounded, sanitised, and lands
 *      in the persisted provenance.
 */

const mockFileRecord = {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
};
const mockTenantDb = { fileRecord: mockFileRecord } as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) =>
        fn(mockTenantDb),
    ),
}));

// The parameter is declared even though the body ignores it: tsc infers a
// mock's signature from its implementation, so a zero-arg `jest.fn(async () =>
// …)` invoked as `mock(input)` is a hard TS2554, and `mock.calls[0][0]` on the
// resulting `[]` tuple is TS2493. Both are invisible to jest and fail the build.
const appendAuditEntryMock = jest.fn(async (_input: unknown) => ({
    id: 'audit-1',
    entryHash: 'hash-1',
    previousHash: null,
}));
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: (input: unknown) => appendAuditEntryMock(input as never),
}));

import {
    clearFileQuarantine,
    MIN_QUARANTINE_CLEAR_REASON,
    MAX_QUARANTINE_CLEAR_REASON,
} from '@/app-layer/usecases/file-quarantine';
import { makeRequestContext } from '../helpers/make-context';

const ownerCtx = makeRequestContext('OWNER', {
    tenantId: 'tenant-1',
    userId: 'owner-1',
});
const adminCtx = makeRequestContext('ADMIN', {
    tenantId: 'tenant-1',
    userId: 'admin-1',
});
const editorCtx = makeRequestContext('EDITOR', { tenantId: 'tenant-1' });

const REASON = 'ClamAV 27.9 signature ClamAV-Test.UNOFFICIAL misfired on our SOC2 report';

const infectedRow = {
    id: 'file-1',
    tenantId: 'tenant-1',
    originalName: 'soc2-report.pdf',
    sha256: 'abc123',
    scanStatus: 'INFECTED',
    status: 'FAILED',
    scanDetails: '{"result":"infected","signature":"Eicar-Test-Signature"}',
};

/** The row the repository re-reads after a successful claim. */
const restoredRow = { ...infectedRow, scanStatus: 'CLEAN', status: 'STORED' };

beforeEach(() => {
    jest.clearAllMocks();
    mockFileRecord.findFirst.mockResolvedValue(infectedRow);
    mockFileRecord.updateMany.mockResolvedValue({ count: 1 });
    mockFileRecord.findUnique.mockResolvedValue(restoredRow);
});

describe('clearFileQuarantine — authorization', () => {
    it('refuses ADMIN: tenant_lifecycle is the key ADMIN does not carry', async () => {
        await expect(
            clearFileQuarantine(adminCtx, { fileId: 'file-1', reason: REASON }),
        ).rejects.toMatchObject({ status: 403 });

        // A denial must not touch the chain or the row.
        expect(appendAuditEntryMock).not.toHaveBeenCalled();
        expect(mockFileRecord.findFirst).not.toHaveBeenCalled();
        expect(mockFileRecord.updateMany).not.toHaveBeenCalled();
    });

    it('refuses EDITOR', async () => {
        await expect(
            clearFileQuarantine(editorCtx, { fileId: 'file-1', reason: REASON }),
        ).rejects.toMatchObject({ status: 403 });
        expect(mockFileRecord.updateMany).not.toHaveBeenCalled();
    });

    it('allows OWNER and returns the restored row', async () => {
        const result = await clearFileQuarantine(ownerCtx, {
            fileId: 'file-1',
            reason: REASON,
        });

        expect(result).toEqual({
            fileId: 'file-1',
            originalName: 'soc2-report.pdf',
            scanStatus: 'CLEAN',
            status: 'STORED',
            auditLogId: 'audit-1',
        });
    });
});

describe('clearFileQuarantine — audit precedes the write', () => {
    it('writes the audit entry BEFORE the state transition', async () => {
        await clearFileQuarantine(ownerCtx, { fileId: 'file-1', reason: REASON });

        expect(appendAuditEntryMock).toHaveBeenCalledTimes(1);
        expect(mockFileRecord.updateMany).toHaveBeenCalledTimes(1);
        expect(
            appendAuditEntryMock.mock.invocationCallOrder[0],
        ).toBeLessThan(mockFileRecord.updateMany.mock.invocationCallOrder[0]);
    });

    it('records the reversal as FILE_QUARANTINE_CLEARED on the FileRecord', async () => {
        await clearFileQuarantine(ownerCtx, { fileId: 'file-1', reason: REASON });

        const entry = appendAuditEntryMock.mock.calls[0][0] as any;
        expect(entry).toMatchObject({
            tenantId: 'tenant-1',
            userId: 'owner-1',
            entity: 'FileRecord',
            entityId: 'file-1',
            action: 'FILE_QUARANTINE_CLEARED',
            detailsJson: {
                category: 'status_change',
                fromStatus: 'INFECTED',
                toStatus: 'CLEAN',
                reason: REASON,
            },
        });
        // The verdict being reversed is part of the record.
        expect(entry.metadataJson.previousScanDetails).toBe(
            infectedRow.scanDetails,
        );
    });

    it('threads the audit id + reason into the row it clears', async () => {
        await clearFileQuarantine(ownerCtx, { fileId: 'file-1', reason: REASON });

        const [args] = mockFileRecord.updateMany.mock.calls[0];
        // Exact, atomic transition — both columns in one statement,
        // and only from a state that can hold a live file.
        expect(args.where).toMatchObject({
            id: 'file-1',
            tenantId: 'tenant-1',
            scanStatus: 'INFECTED',
        });
        expect(args.data).toMatchObject({ scanStatus: 'CLEAN', status: 'STORED' });

        const details = JSON.parse(args.data.scanDetails);
        expect(details).toMatchObject({
            result: 'false_positive_cleared',
            reason: REASON,
            clearedByUserId: 'owner-1',
            auditLogId: 'audit-1',
        });
    });

    it('keeps the audit row when the claim is refused mid-flight', async () => {
        // A racing rescan / delete moved the row between our read and
        // our write: the repository claim matches nothing.
        mockFileRecord.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(
            clearFileQuarantine(ownerCtx, { fileId: 'file-1', reason: REASON }),
        ).rejects.toMatchObject({ status: 409 });

        // The DECISION was taken, so its record stands.
        expect(appendAuditEntryMock).toHaveBeenCalledTimes(1);
        // And the caller is not told a lie about the outcome.
        expect(mockFileRecord.findUnique).not.toHaveBeenCalled();
    });
});

describe('clearFileQuarantine — state guards', () => {
    it('404s an unknown or foreign-tenant file, before auditing', async () => {
        mockFileRecord.findFirst.mockResolvedValueOnce(null);

        await expect(
            clearFileQuarantine(ownerCtx, { fileId: 'nope', reason: REASON }),
        ).rejects.toMatchObject({ status: 404 });
        expect(appendAuditEntryMock).not.toHaveBeenCalled();
    });

    it('reads the row scoped to the caller tenant', async () => {
        await clearFileQuarantine(ownerCtx, { fileId: 'file-1', reason: REASON });
        expect(mockFileRecord.findFirst).toHaveBeenCalledWith({
            where: { id: 'file-1', tenantId: 'tenant-1' },
        });
    });

    it('409s a row that was never quarantined', async () => {
        mockFileRecord.findFirst.mockResolvedValueOnce({
            ...infectedRow,
            scanStatus: 'CLEAN',
            status: 'STORED',
        });

        await expect(
            clearFileQuarantine(ownerCtx, { fileId: 'file-1', reason: REASON }),
        ).rejects.toMatchObject({ status: 409 });
        expect(appendAuditEntryMock).not.toHaveBeenCalled();
        expect(mockFileRecord.updateMany).not.toHaveBeenCalled();
    });

    it('never resurrects a DELETED row', async () => {
        mockFileRecord.findFirst.mockResolvedValueOnce({
            ...infectedRow,
            status: 'DELETED',
        });

        await expect(
            clearFileQuarantine(ownerCtx, { fileId: 'file-1', reason: REASON }),
        ).rejects.toMatchObject({ status: 409 });
        expect(mockFileRecord.updateMany).not.toHaveBeenCalled();
    });
});

describe('clearFileQuarantine — the reason is provenance, not a formality', () => {
    it('rejects a missing or too-short reason before auditing', async () => {
        for (const reason of ['', '   ', 'fp']) {
            jest.clearAllMocks();
            mockFileRecord.findFirst.mockResolvedValue(infectedRow);
            await expect(
                clearFileQuarantine(ownerCtx, { fileId: 'file-1', reason }),
            ).rejects.toMatchObject({ status: 400 });
            expect(appendAuditEntryMock).not.toHaveBeenCalled();
        }
    });

    it('rejects an unbounded reason', async () => {
        await expect(
            clearFileQuarantine(ownerCtx, {
                fileId: 'file-1',
                reason: 'x'.repeat(MAX_QUARANTINE_CLEAR_REASON + 1),
            }),
        ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects an empty fileId', async () => {
        await expect(
            clearFileQuarantine(ownerCtx, { fileId: '  ', reason: REASON }),
        ).rejects.toMatchObject({ status: 400 });
    });

    it('strips markup before the reason is persisted', async () => {
        await clearFileQuarantine(ownerCtx, {
            fileId: 'file-1',
            reason: '<script>alert(1)</script>Vendor confirmed a bad signature set',
        });

        const [args] = mockFileRecord.updateMany.mock.calls[0];
        const persisted = JSON.parse(args.data.scanDetails).reason;
        expect(persisted).not.toMatch(/<script/i);
        expect(persisted).toContain('Vendor confirmed a bad signature set');
    });

    it('the minimum is a real bound, not a zero-length rubber stamp', () => {
        expect(MIN_QUARANTINE_CLEAR_REASON).toBeGreaterThan(0);
        expect(MAX_QUARANTINE_CLEAR_REASON).toBeGreaterThan(
            MIN_QUARANTINE_CLEAR_REASON,
        );
    });
});
