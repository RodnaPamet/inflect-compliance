/**
 * Showing an evidence preview is not recorded as a download (#4277, option A).
 *
 * The details panel's inline image/PDF and the gallery's thumbnails load the
 * file from the download route, which wrote `EVIDENCE_DOWNLOADED` and an
 * `EVIDENCE_DOWNLOAD` ledger entry on every load — scrolling the gallery
 * logged a download per image. A preview now asks the same route with
 * `?purpose=preview`: every gate a download has still applies, and it is
 * still recorded (the bytes reached the browser), as `EVIDENCE_PREVIEWED` and
 * ledger channel `EVIDENCE_PREVIEW`. A download keeps `EVIDENCE_DOWNLOADED`.
 *
 * Usecase mocks mirror tests/unit/evidence-download-shared-file.test.ts; the
 * route half mirrors tests/unit/file-exposure-egress-wiring.test.ts.
 */
import { NextRequest } from 'next/server';

type Holder = { id: string; deletedAt: Date | null; isArchived: boolean; _count: { evidenceControlLinks: number } };
const mockDb = {
    fileRecord: { findFirst: jest.fn(async () => null) },
    evidence: { findMany: jest.fn<Promise<Holder[]>, [unknown]>() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        getById: jest.fn(async () => ({
            id: 'fr-1',
            tenantId: 'tenant-1',
            status: 'STORED',
            scanStatus: 'CLEAN',
            pathKey: 'tenants/tenant-1/evidence/shot.png',
            originalName: 'shot.png',
            mimeType: 'image/png',
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
const logEventMock = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }));

import { downloadEvidenceFile } from '@/app-layer/usecases/evidence';
import { makeRequestContext } from '../helpers/make-context';

const live = (o: Partial<Holder> = {}): Holder => ({
    id: 'ev-1', deletedAt: null, isArchived: false, _count: { evidenceControlLinks: 0 }, ...o,
});
const admin = makeRequestContext('ADMIN', { tenantId: 'tenant-1' });
const reader = makeRequestContext('READER', { tenantId: 'tenant-1' });

const recordedActions = () => logEventMock.mock.calls.map((c) => (c[2] as { action: string }).action);

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.evidence.findMany.mockResolvedValue([live()]);
});

describe('downloadEvidenceFile — what a read is recorded as', () => {
    it('a download is EVIDENCE_DOWNLOADED, as it always was', async () => {
        await downloadEvidenceFile(admin, 'fr-1');
        expect(recordedActions()).toEqual(['EVIDENCE_DOWNLOADED']);
    });

    it('a preview is EVIDENCE_PREVIEWED, not a download', async () => {
        await downloadEvidenceFile(admin, 'fr-1', { purpose: 'preview' });
        expect(recordedActions()).toEqual(['EVIDENCE_PREVIEWED']);
    });

    it('a preview passes the same gates: archived evidence is refused, and nothing is recorded', async () => {
        mockDb.evidence.findMany.mockResolvedValue([live({ isArchived: true })]);
        await expect(downloadEvidenceFile(admin, 'fr-1', { purpose: 'preview' })).rejects.toThrow(/archived/);
        mockDb.evidence.findMany.mockResolvedValue([live()]);
        await expect(downloadEvidenceFile(reader, 'fr-1', { purpose: 'preview' })).rejects.toThrow(/linked to a control/);
        expect(logEventMock).not.toHaveBeenCalled();
    });
});

describe('the download route — `?purpose=preview` picks the action and the ledger channel', () => {
    const downloadMock = jest.fn();
    const recordMock = jest.fn(async () => true);

    beforeAll(() => {
        jest.resetModules();
        jest.doMock('@/app-layer/context', () => ({
            getTenantCtx: jest.fn(async () => ({ tenantId: 'tenant-1', userId: 'user-9' })),
        }));
        jest.doMock('@/app-layer/usecases/evidence', () => ({
            downloadEvidenceFile: (...a: unknown[]) => downloadMock(...a),
        }));
        jest.doMock('@/app-layer/services/file-distribution', () => ({
            recordFileDistribution: (...a: unknown[]) => recordMock(...(a as [])),
        }));
    });

    beforeEach(() => {
        downloadMock.mockReset().mockResolvedValue({
            mode: 'redirect',
            downloadUrl: 'https://signed.example/blob',
            originalName: 'shot.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            sha256: 'c'.repeat(64),
        });
        recordMock.mockClear();
    });

    async function get(qs: string) {
        const { GET } = await import('@/app/api/t/[tenantSlug]/evidence/files/[fileId]/download/route');
        const req = new NextRequest(`https://example.test/api/t/acme/evidence/files/fr-1/download${qs}`);
        await GET(req, { params: Promise.resolve({ tenantSlug: 'acme', fileId: 'fr-1' }) });
        const [, , options] = downloadMock.mock.calls[0];
        const [entry] = recordMock.mock.calls[0] as unknown as [{ channel: string }];
        return { purpose: (options as { purpose: string }).purpose, channel: entry.channel };
    }

    it('a preview', async () => {
        expect(await get('?purpose=preview')).toEqual({ purpose: 'preview', channel: 'EVIDENCE_PREVIEW' });
    });

    it('no flag is a download', async () => {
        expect(await get('')).toEqual({ purpose: 'download', channel: 'EVIDENCE_DOWNLOAD' });
    });

    it('any other value is a download', async () => {
        expect(await get('?purpose=audit')).toEqual({ purpose: 'download', channel: 'EVIDENCE_DOWNLOAD' });
    });
});
