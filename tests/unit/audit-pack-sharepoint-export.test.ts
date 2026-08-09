/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * SP-5 — export a frozen audit pack to SharePoint. Pack data, the Graph client,
 * and the DB are mocked; this locks the FROZEN gate, the ZIP upload, and the
 * AuditPack + IntegrationExecution record.
 */
const mockDb = {
    auditPack: { update: jest.fn() },
    integrationExecution: { create: jest.fn() },
    evidence: { findMany: jest.fn() },
    fileRecord: { findMany: jest.fn() },
};
const mockClient = { uploadNewFile: jest.fn() };
const mockGetPack = jest.fn();
const mockExport = jest.fn();
const mockReadStream = jest.fn();

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: any, fn: (db: any) => any) => fn(mockDb),
}));
jest.mock('@/lib/storage', () => ({
    __esModule: true,
    getStorageProvider: () => ({ readStream: (...a: unknown[]) => mockReadStream(...a) }),
    // Mirrors the real `assertTenantKey` rather than stubbing it to a no-op:
    // the export's tenant-prefix check is one of the things under test here,
    // and a mock that always passes would assert nothing about it.
    assertTenantKey: (pathKey: string, tenantId: string) => {
        if (!pathKey.startsWith(`tenants/${tenantId}/`)) {
            throw new Error(`Tenant isolation violation: ${pathKey}`);
        }
    },
}));
jest.mock('@/lib/storage/av-scan', () => ({
    __esModule: true,
    // Mirrors the real predicate's enforcing-mode semantics against the REAL
    // ScanStatus values ('PENDING' | 'CLEAN' | 'INFECTED' | 'SKIPPED'). The
    // fixtures below previously used lowercase, which no row ever holds — the
    // stub `s === 'clean'` was the only reason that passed.
    isDownloadAllowed: (s: string) => s === 'CLEAN' || s === 'SKIPPED',
}));
jest.mock('@/app-layer/usecases/audit-readiness/packs', () => ({
    __esModule: true,
    getAuditPack: (...a: unknown[]) => mockGetPack(...a),
    exportAuditPack: (...a: unknown[]) => mockExport(...a),
}));
jest.mock('@/app-layer/integrations/providers/sharepoint', () => ({
    __esModule: true,
    getSharePointClient: jest.fn(async () => mockClient),
    listSharePointConnections: jest.fn(async () => [{ id: 'c1' }]),
}));
jest.mock('@/app-layer/events/audit', () => ({ __esModule: true, logEvent: jest.fn() }));

import { exportAuditPackToSharePoint } from '@/app-layer/usecases/audit-pack-sharepoint-export';

const admin = { tenantId: 't1', userId: 'u1', permissions: { canAdmin: true } } as any;
const reader = { tenantId: 't1', userId: 'u2', permissions: { canAdmin: false } } as any;

beforeEach(() => {
    jest.clearAllMocks();
    mockGetPack.mockResolvedValue({ id: 'p1', name: 'Q2 Audit', status: 'FROZEN', frozenAt: new Date('2026-01-01'), items: [{}, {}] });
    mockExport.mockImplementation((_ctx: any, _id: string, fmt: string) =>
        fmt === 'csv' ? { csv: 'Type,Id\n' } : { pack: { id: 'p1' }, items: [] },
    );
    mockClient.uploadNewFile.mockResolvedValue({ id: 'sp-item-1', webUrl: 'https://sp/pack.zip' });
    mockDb.auditPack.update.mockResolvedValue({});
    mockDb.integrationExecution.create.mockResolvedValue({});
    mockDb.evidence.findMany.mockResolvedValue([]);
    mockDb.fileRecord.findMany.mockResolvedValue([]);
});

describe('exportAuditPackToSharePoint', () => {
    it('rejects a non-admin', async () => {
        await expect(exportAuditPackToSharePoint(reader, 'p1', { driveId: 'd1' })).rejects.toBeDefined();
    });

    it('refuses a non-FROZEN pack', async () => {
        mockGetPack.mockResolvedValueOnce({ id: 'p1', name: 'x', status: 'DRAFT', items: [] });
        await expect(exportAuditPackToSharePoint(admin, 'p1', { driveId: 'd1' })).rejects.toThrow(/FROZEN/);
    });

    it('uploads a ZIP + records the export on the pack and an execution', async () => {
        const r = await exportAuditPackToSharePoint(admin, 'p1', { driveId: 'd1' }, { now: () => new Date('2026-06-09T00:00:00Z') });
        // toMatchObject, not toEqual: the result now also carries the
        // bundled/skipped/bytes counts the UI needs in order to warn when a
        // pack shipped incomplete.
        expect(r).toMatchObject({ spItemId: 'sp-item-1', webUrl: 'https://sp/pack.zip' });

        // Uploaded a .zip to the drive root with a templated name.
        const [driveId, folderId, name, , contentType] = mockClient.uploadNewFile.mock.calls[0];
        expect(driveId).toBe('d1');
        expect(folderId).toBe('root');
        expect(name).toBe('Q2-Audit-2026-06-09.zip');
        expect(contentType).toBe('application/zip');

        // Recorded on the pack + an IntegrationExecution.
        expect(mockDb.auditPack.update.mock.calls[0][0].data).toMatchObject({ spExportItemId: 'sp-item-1' });
        expect(mockDb.integrationExecution.create.mock.calls[0][0].data).toMatchObject({
            provider: 'sharepoint',
            automationKey: 'sharepoint.audit_pack_export',
            status: 'PASSED',
        });
    });

    it('requires a driveId', async () => {
        await expect(exportAuditPackToSharePoint(admin, 'p1', { driveId: '' })).rejects.toBeDefined();
    });

    it('bundles scanned-clean evidence binaries + skips infected/deleted (SP-F2)', async () => {
        const { Readable } = await import('node:stream');
        mockGetPack.mockResolvedValueOnce({
            id: 'p1', name: 'Q2', status: 'FROZEN', frozenAt: new Date('2026-01-01'),
            items: [
                { entityType: 'EVIDENCE', entityId: 'ev1' },
                { entityType: 'EVIDENCE', entityId: 'ev2' },
                { entityType: 'CONTROL', entityId: 'c1' },
            ],
        });
        mockDb.evidence.findMany.mockResolvedValueOnce([
            { fileRecord: { pathKey: 'tenants/t1/evidence/k1', originalName: 'a.pdf', scanStatus: 'CLEAN', status: 'STORED', deletedAt: null } },
            { fileRecord: { pathKey: 'tenants/t1/evidence/k2', originalName: 'b.pdf', scanStatus: 'INFECTED', status: 'STORED', deletedAt: null } },
        ]);
        mockReadStream.mockImplementation(() => Readable.from([Buffer.from('PDFDATA')]));

        await exportAuditPackToSharePoint(admin, 'p1', { driveId: 'd1' }, { now: () => new Date('2026-06-09T00:00:00Z') });

        // Only the clean file is read + bundled; the infected one is skipped.
        expect(mockReadStream).toHaveBeenCalledTimes(1);
        expect(mockReadStream).toHaveBeenCalledWith('tenants/t1/evidence/k1');
        expect(mockDb.integrationExecution.create.mock.calls[0][0].data.resultJson).toMatchObject({
            evidenceBundled: 1,
            evidenceSkipped: 1,
        });
    });
    /**
     * A pack handed to an external auditor must never be quietly incomplete.
     *
     * Every reason a file gets dropped — infected, still unscanned,
     * soft-deleted, over the 200MB cap, unreadable — used to land in one
     * `skipped` counter, and then:
     *   - the usecase returned only { spItemId, webUrl }, discarding it;
     *   - the IntegrationExecution row hardcoded status 'PASSED';
     *   - the button read `webUrl` and fired an unconditional success toast.
     *
     * So the pack could be missing evidence with all three layers reporting a
     * clean export. These assert the three of them together, because fixing
     * any one alone still leaves the auditor holding an incomplete pack.
     */
    describe('partial exports are reported, not swallowed', () => {
        async function exportWith(files: any[], readImpl?: () => any) {
            const { Readable } = await import('node:stream');
            mockGetPack.mockResolvedValueOnce({
                id: 'p1', name: 'Q2', status: 'FROZEN', frozenAt: new Date('2026-01-01'),
                items: files.map((_, i) => ({ entityType: 'EVIDENCE', entityId: `ev${i}` })),
            });
            mockDb.evidence.findMany.mockResolvedValueOnce(files.map((f) => ({ fileRecord: f })));
            mockReadStream.mockImplementation(
                readImpl ?? (() => Readable.from([Buffer.from('PDFDATA')])),
            );
            return exportAuditPackToSharePoint(
                admin, 'p1', { driveId: 'd1' }, { now: () => new Date('2026-06-09T00:00:00Z') },
            );
        }

        // Fixture keys carry the canonical `tenants/<tenantId>/` prefix that a
        // real `FileRecord.pathKey` has. They used to be bare (`k1`), which the
        // export's tenant-prefix assertion now — correctly — rejects. A test
        // fixture that could not exist in the database proves nothing about the
        // code that reads the database.
        const key = (k: string) => `tenants/t1/evidence/${k}`;
        const clean = (k: string) => ({ pathKey: key(k), originalName: `${k}.pdf`, scanStatus: 'CLEAN', status: 'STORED', deletedAt: null });
        const infected = (k: string) => ({ pathKey: key(k), originalName: `${k}.pdf`, scanStatus: 'INFECTED', status: 'STORED', deletedAt: null });
        const pending = (k: string) => ({ pathKey: key(k), originalName: `${k}.pdf`, scanStatus: 'PENDING', status: 'STORED', deletedAt: null });
        const removed = (k: string) => ({ pathKey: key(k), originalName: `${k}.pdf`, scanStatus: 'CLEAN', status: 'STORED', deletedAt: new Date() });
        /** A row whose pathKey points outside this tenant — the case the assertion exists for. */
        const foreign = (k: string) => ({ pathKey: `tenants/OTHER-TENANT/evidence/${k}`, originalName: `${k}.pdf`, scanStatus: 'CLEAN', status: 'STORED', deletedAt: null });

        it('reports an INFECTED and an oversized file separately, and does not record PASSED', async () => {
            const { Readable } = await import('node:stream');
            // 1 clean small, 1 infected, 1 clean but enormous (blows the cap).
            const huge = Buffer.alloc(210 * 1024 * 1024);
            let call = 0;
            const res = await exportWith(
                [clean('k1'), infected('k2'), clean('k3')],
                () => Readable.from([call++ === 0 ? Buffer.from('SMALL') : huge]),
            );

            expect(res.skipped.infected).toBe(1);
            expect(res.skipped.sizeCapped).toBe(1);
            expect(res.skippedTotal).toBe(2);
            expect(res.bundled).toBe(1);

            const row = mockDb.integrationExecution.create.mock.calls[0][0].data;
            expect(row.status).not.toBe('PASSED');
            expect(row.status).toBe('PARTIAL');
            expect(row.resultJson).toMatchObject({
                evidenceSkipped: 2,
                evidenceSkippedByReason: expect.objectContaining({ infected: 1, sizeCapped: 1 }),
            });
        });

        it('distinguishes unscanned from infected — they are different sentences to an auditor', async () => {
            const res = await exportWith([infected('k1'), pending('k2')]);
            expect(res.skipped.infected).toBe(1);
            expect(res.skipped.unscanned).toBe(1);
        });

        it('counts a soft-deleted file under deleted, not under scan reasons', async () => {
            const res = await exportWith([removed('k1')]);
            expect(res.skipped.deleted).toBe(1);
            expect(res.skipped.infected + res.skipped.unscanned).toBe(0);
        });

        it('counts an unreadable file rather than losing it', async () => {
            const res = await exportWith([clean('k1')], () => { throw new Error('storage down'); });
            expect(res.skipped.unreadable).toBe(1);
            expect(res.bundled).toBe(0);
        });

        it('never reads a file whose pathKey is outside this tenant', async () => {
            // Defence-in-depth: both queries that produce these rows already
            // filter by tenantId, so this is unreachable through any known
            // path. It is here because `audit-hardening.ts` asserts the same
            // thing on an identically-sourced key, and a defence that only one
            // of two siblings applies is a defence that will be dropped.
            const res = await exportWith([clean('k1'), foreign('k2')]);
            expect(res.skipped.foreignKey).toBe(1);
            expect(res.bundled).toBe(1);
            // Counted under its OWN reason: a corrupt row is a data-integrity
            // problem, an unreadable one is a storage problem, and an operator
            // does different things about each.
            expect(res.skipped.unreadable).toBe(0);
            expect(mockReadStream).not.toHaveBeenCalledWith(
                'tenants/OTHER-TENANT/evidence/k2',
            );
        });

        it('records PASSED and zero skips when the whole pack bundles', async () => {
            // The status must still be able to say "clean" — otherwise
            // PARTIAL means nothing.
            const res = await exportWith([clean('k1'), clean('k2')]);
            expect(res.skippedTotal).toBe(0);
            expect(mockDb.integrationExecution.create.mock.calls[0][0].data.status).toBe('PASSED');
        });

        it('returns the counts to the caller — the UI cannot warn about what it is not told', async () => {
            const res = await exportWith([clean('k1'), infected('k2')]);
            expect(res).toEqual(expect.objectContaining({
                spItemId: expect.any(String),
                webUrl: expect.any(String),
                bundled: expect.any(Number),
                skippedTotal: expect.any(Number),
                skipped: expect.objectContaining({
                    infected: expect.any(Number),
                    unscanned: expect.any(Number),
                    deleted: expect.any(Number),
                    sizeCapped: expect.any(Number),
                    unreadable: expect.any(Number),
                }),
            }));
        });
    });
});
