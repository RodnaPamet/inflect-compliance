/**
 * RQ-10 follow-up — deliverReportToSharePoint pushes a generated report to a
 * Graph drive via the SP-3 client, with no-op guards. SP client + storage are
 * mocked (no Graph/DB).
 */
const uploadNewFile = jest.fn().mockResolvedValue({ id: 'sp-item-1', webUrl: 'https://sp/item' });

jest.mock('@/app-layer/integrations/providers/sharepoint', () => ({
    // The delivery path now filters on isEnabled and picks the OLDEST enabled
    // connection deterministically, so the fixture needs both fields. A
    // connection with isEnabled absent reads as NOT enabled — fail-closed.
    listSharePointConnections: jest.fn().mockResolvedValue([
        { id: 'conn-1', isEnabled: true, createdAt: new Date('2026-01-01') },
    ]),
    getSharePointClient: jest.fn().mockResolvedValue({ uploadNewFile }),
}));

jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => ({
        // an async-iterable stream of one chunk
        readStream: () => (async function* () { yield Buffer.from('PDFBYTES'); })(),
    }),
    // Real key shape, so the tenant assertion below is a real check.
    generatePathKey: (t: string, n: string) => `tenants/${t}/reports/2026/07/aaaaaaaa-${n}`,
    assertTenantKey: (pathKey: string, tenantId: string) => {
        if (!pathKey.startsWith(`tenants/${tenantId}/`)) {
            throw new Error(`Tenant isolation violation: "${pathKey}" is not in tenant "${tenantId}"`);
        }
    },
}));

import { deliverReportToSharePoint } from '@/app-layer/usecases/risk-report';
import { listSharePointConnections } from '@/app-layer/integrations/providers/sharepoint';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext();
// `openReportArtefact` now asserts the key belongs to the ctx tenant, so the
// stub path must be a real tenant-scoped key.
const completed = {
    id: 'r1',
    outputPath: `tenants/${ctx.tenantId}/reports/2026/07/aaaaaaaa-report_r1.pdf`,
    format: 'PDF',
    status: 'COMPLETED',
};


describe('deliverReportToSharePoint', () => {
    beforeEach(() => uploadNewFile.mockClear());

    it('uploads the artefact to the drive folder + returns the item id', async () => {
        const id = await deliverReportToSharePoint(ctx, completed, 'drive-1', 'folder-9', 'Portfolio, Q2');
        expect(id).toBe('sp-item-1');
        expect(uploadNewFile).toHaveBeenCalledTimes(1);
        const [driveId, folderId, name, body, mime] = uploadNewFile.mock.calls[0];
        expect(driveId).toBe('drive-1');
        expect(folderId).toBe('folder-9');
        expect(name).toBe('Portfolio-Q2-r1.pdf'); // label sanitised (", " → "-")
        expect(Buffer.isBuffer(body)).toBe(true);
        expect(mime).toBe('application/pdf');
    });

    it('defaults the folder to root when none is given', async () => {
        await deliverReportToSharePoint(ctx, completed, 'drive-1', null, 'X');
        expect(uploadNewFile.mock.calls[0][1]).toBe('root');
    });

    it('is a no-op when no driveId is configured', async () => {
        expect(await deliverReportToSharePoint(ctx, completed, null, 'f', 'X')).toBeNull();
        expect(uploadNewFile).not.toHaveBeenCalled();
    });

    it('is a no-op when the run is not COMPLETED', async () => {
        expect(await deliverReportToSharePoint(ctx, { ...completed, status: 'FAILED' }, 'drive-1', 'f', 'X')).toBeNull();
        expect(uploadNewFile).not.toHaveBeenCalled();
    });

    it('is a no-op when the tenant has no SharePoint connection', async () => {
        (listSharePointConnections as jest.Mock).mockResolvedValueOnce([]);
        expect(await deliverReportToSharePoint(ctx, completed, 'drive-1', 'f', 'X')).toBeNull();
        expect(uploadNewFile).not.toHaveBeenCalled();
    });
});
