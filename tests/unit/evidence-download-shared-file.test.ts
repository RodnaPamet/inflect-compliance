/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fakes for Prisma delegates. */
/**
 * `downloadEvidenceFile` when several evidence records hold one file.
 *
 * `Evidence.fileRecordId` carries no unique key, and the upload's SHA-256
 * dedup points a new record at an existing FileRecord, so one file can be held
 * by a live record and by a deleted or archived one. The owning-evidence read
 * was an unordered `findFirst` that also returned deleted rows, so whichever
 * row it happened to return decided the download: a deleted sibling could
 * refuse "Evidence has been deleted" to someone downloading through the live
 * record that holds the same bytes.
 *
 * The gates are now asked of the holder that can serve the file: a live one
 * linked to a control, then any live one, then an archived one, then a deleted
 * one. Refusal still happens when NO holder can serve it.
 */

const mockDb: any = {
    fileRecord: { findFirst: jest.fn(async () => null) },
    evidence: {
        findMany: jest.fn(),
        // What the old single-row read returned: the first matching row,
        // deleted or not. Kept so the old code runs against the same data.
        findFirst: jest.fn(async (args: any) => (await mockDb.evidence.findMany(args))[0] ?? null),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        getById: jest.fn(async () => ({
            id: 'fr-1',
            tenantId: 'tenant-1',
            status: 'STORED',
            scanStatus: 'CLEAN',
            pathKey: 'tenants/tenant-1/evidence/report.pdf',
            originalName: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 10,
            sha256: 'a'.repeat(64),
            storageProvider: 'local',
        })),
    },
}));

jest.mock('@/lib/storage/index', () => ({
    ...jest.requireActual('@/lib/storage/index'),
    getProviderByName: jest.fn(() => ({ name: 'local', readStream: jest.fn(() => 'STREAM') })),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { downloadEvidenceFile } from '@/app-layer/usecases/evidence';
import { makeRequestContext } from '../helpers/make-context';

const holder = (id: string, o: { deleted?: boolean; archived?: boolean; controls?: number } = {}) => ({
    id,
    deletedAt: o.deleted ? new Date('2026-10-01') : null,
    isArchived: o.archived ?? false,
    _count: { evidenceControlLinks: o.controls ?? 0 },
});

const admin = makeRequestContext('ADMIN', { tenantId: 'tenant-1' });
const reader = makeRequestContext('READER', { tenantId: 'tenant-1' });

beforeEach(() => {
    jest.clearAllMocks();
});

describe('downloadEvidenceFile — a file held by several records', () => {
    it('serves the file when a deleted record comes first and a live one also holds it', async () => {
        mockDb.evidence.findMany.mockResolvedValue([holder('ev-old', { deleted: true }), holder('ev-live')]);
        await expect(downloadEvidenceFile(admin, 'fr-1')).resolves.toMatchObject({ mode: 'stream', stream: 'STREAM' });
    });

    it('serves the file when an archived record comes first and a live one also holds it', async () => {
        mockDb.evidence.findMany.mockResolvedValue([holder('ev-old', { archived: true }), holder('ev-live')]);
        await expect(downloadEvidenceFile(admin, 'fr-1')).resolves.toMatchObject({ mode: 'stream' });
    });

    it('lets a reader download when any live holder is linked to a control', async () => {
        // The reader could fetch these bytes through the linked record anyway.
        mockDb.evidence.findMany.mockResolvedValue([holder('ev-unlinked'), holder('ev-linked', { controls: 1 })]);
        await expect(downloadEvidenceFile(reader, 'fr-1')).resolves.toMatchObject({ mode: 'stream' });
    });

    it('refuses a reader when no live holder is linked to a control', async () => {
        mockDb.evidence.findMany.mockResolvedValue([holder('ev-unlinked'), holder('ev-old', { deleted: true, controls: 1 })]);
        await expect(downloadEvidenceFile(reader, 'fr-1')).rejects.toThrow(/linked to a control/);
    });

    it('still refuses when every holder is deleted, or archived', async () => {
        mockDb.evidence.findMany.mockResolvedValue([holder('ev-a', { deleted: true }), holder('ev-b', { deleted: true })]);
        await expect(downloadEvidenceFile(admin, 'fr-1')).rejects.toThrow(/Evidence has been deleted/);

        mockDb.evidence.findMany.mockResolvedValue([holder('ev-a', { deleted: true }), holder('ev-b', { archived: true })]);
        await expect(downloadEvidenceFile(admin, 'fr-1')).rejects.toThrow(/archived/);
    });

    it('still refuses an orphaned file, for every role', async () => {
        mockDb.evidence.findMany.mockResolvedValue([]);
        await expect(downloadEvidenceFile(admin, 'fr-1')).rejects.toThrow(/File not found/);
    });

    it('reads every holder of the file, deleted ones included, bounded and in a fixed order', async () => {
        mockDb.evidence.findMany.mockResolvedValue([holder('ev-live')]);
        await downloadEvidenceFile(admin, 'fr-1');
        const args = mockDb.evidence.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ tenantId: 'tenant-1', fileRecordId: 'fr-1' });
        expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
        expect(args.take).toBeGreaterThan(0);
    });
});
