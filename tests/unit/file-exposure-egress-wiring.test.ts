/* eslint-disable @typescript-eslint/no-explicit-any -- test-mock pattern. */
/**
 * Every path that lets bytes leave the platform must say so, and a late
 * INFECTED verdict must ask what already left.
 *
 * The gap these lock: quarantine only refuses FUTURE reads. The auditor
 * already holding a ZIP, the presigned URL still live for another four
 * minutes, the copy sitting in a customer's SharePoint — none of them were
 * recorded anywhere, so when the verdict flipped the product could not name a
 * single artefact. A gate that fires *after* the bytes are gone is not an
 * answer to "who has them".
 *
 * These drive the REAL exports of all four surfaces with the ledger module
 * mocked, so what is under test is the wiring itself: the call happens, on the
 * right occasions, carrying the fields the later hash-join needs.
 */
import { NextRequest } from 'next/server';

// ─── The ledger (mocked — its own behaviour is tested separately) ───
const recordMock = jest.fn();
const recordManyMock = jest.fn();
/**
 * #2096 split the webhook's ledger call in two: the READS take the
 * tenant-bound connection, the WRITE lands outside that scope because
 * `appendAuditEntry` opens its own advisory-locked transaction. So the route
 * no longer calls `assessExposureOnInfection` — it calls the two halves.
 */
// `_input` is declared even though the implementation ignores it, and that is
// load-bearing rather than tidiness. Handing `jest.fn` an implementation is what
// NARROWS its signature: with `async () => …` tsc infers `() => Promise<…>`, so
// `mock.calls` becomes an array of EMPTY tuples and `mock.calls[0][0]` below is
// TS2493 — "tuple of length 0 has no element at index 0".
//
// Jest does not care; the suite passes. Only the central `tsc` rejects it, so
// verifying with `npx jest` alone shows green and gives no signal. Note the
// contrast with `recordExposureMock` below: a BARE `jest.fn()` narrows nothing
// and indexes fine, so the more carefully-written mock is the one that breaks.
const buildExposureMock = jest.fn(async (_input: unknown) => ({
    fileRecordId: 'file-1',
    sha256: 'a'.repeat(64),
    siblingFileRecordIds: [],
    totalDistributions: 0,
    byChannel: {},
    firstDistributedAt: null,
    lastDistributedAt: null,
    unrevocableCopies: 0,
    liveSignedUrls: 0,
    signedUrlExposureEndsAt: null,
    recipientUserIds: [],
    artefacts: [],
    exhaustive: true,
    assessedAt: '2026-01-01T00:00:00.000Z',
}));
const recordExposureMock = jest.fn();

jest.mock('@/app-layer/services/file-distribution', () => ({
    __esModule: true,
    recordFileDistribution: (...a: unknown[]) => recordMock(...a),
    recordFileDistributions: (...a: unknown[]) => recordManyMock(...a),
    // `a[0]` rather than a spread cast: `...(a as [])` asserted an EMPTY tuple,
    // which matched the old zero-arg signature and stops compiling the moment
    // the mock declares a parameter. Passing the argument by position says what
    // is meant and needs no cast.
    buildFileExposureReport: (...a: unknown[]) => buildExposureMock(a[0]),
    recordFileExposureReport: (...a: unknown[]) => recordExposureMock(...a),
}));

// ─── Prisma: the AV webhook uses the DEFAULT export, trust uses the named one ───
let avRow: Record<string, unknown>;
const avFindUnique = jest.fn(async () => ({ ...avRow }));
const avUpdateMany = jest.fn(async ({ where }: any) => {
    if ((where.scanStatus?.not ?? null) === avRow.scanStatus) return { count: 0 };
    return { count: 1 };
});
const trustFindUnique = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { fileRecord: { findUnique: (...a: unknown[]) => avFindUnique(...(a as [])), findFirst: (...a: unknown[]) => avFindUnique(...(a as [])), updateMany: (...a: unknown[]) => avUpdateMany(...(a as [any])) } },
    prisma: { fileRecord: { findUnique: (...a: unknown[]) => trustFindUnique(...a) } },
}));

jest.mock('@/lib/audit/audit-writer', () => ({ __esModule: true, appendAuditEntry: jest.fn() }));

// ─── Storage: serves both the signed-URL surfaces and the SharePoint bundler ───
const createSignedDownloadUrlMock = jest.fn();
const readStreamMock = jest.fn();
jest.mock('@/lib/storage', () => ({
    __esModule: true,
    getStorageProvider: () => ({
        createSignedDownloadUrl: (...a: unknown[]) => createSignedDownloadUrlMock(...a),
        readStream: (...a: unknown[]) => readStreamMock(...a),
    }),
    assertTenantKey: (pathKey: string, tenantId: string) => {
        if (!pathKey.startsWith(`tenants/${tenantId}/`)) throw new Error('Tenant isolation violation');
    },
}));
jest.mock('@/lib/storage/av-scan', () => ({
    __esModule: true,
    isDownloadAllowed: (s: string) => s === 'CLEAN' || s === 'SKIPPED',
}));

// ─── Trust-center token ───
const consumeDownloadTokenMock = jest.fn();
jest.mock('@/lib/trust-center/gated', () => ({
    __esModule: true,
    consumeDownloadToken: (...a: unknown[]) => consumeDownloadTokenMock(...a),
}));

// ─── Evidence download route ───
const getTenantCtxMock = jest.fn();
const downloadEvidenceFileMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));
jest.mock('@/app-layer/usecases/evidence', () => ({
    __esModule: true,
    downloadEvidenceFile: (...a: unknown[]) => downloadEvidenceFileMock(...a),
}));

// ─── SharePoint export ───
interface FakeFileRow {
    id: string;
    tenantId: string;
    sha256: string;
    pathKey: string;
    originalName: string;
    scanStatus: string;
    status: string;
    deletedAt: Date | null;
}

const mockDb = {
    auditPack: { update: jest.fn(async () => ({})) },
    integrationExecution: { create: jest.fn(async () => ({})) },
    // Element types are declared, not inferred. `jest.fn(async () => [])`
    // infers `Promise<never[]>`, so every later `mockResolvedValueOnce([{…}])`
    // is a TS2322 against `never` — which jest runs happily and the build
    // refuses.
    evidence: { findMany: jest.fn(async (): Promise<{ fileRecord: FakeFileRow }[]> => []) },
    fileRecord: { findMany: jest.fn(async (): Promise<FakeFileRow[]> => []) },
};
const mockClient = { uploadNewFile: jest.fn() };
const mockGetPack = jest.fn();
const mockExport = jest.fn();
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: any, fn: (db: any) => any) => fn(mockDb),
    // #2096 — the AV webhook's writes run in the file's tenant context. Must
    // live in THIS factory: a second `jest.mock` of the same module silently
    // replaces the first rather than merging, so a separate one higher up the
    // file would be overridden and the route would see no mock at all.
    runInTenantJobContext: async (
        _job: { tenantId: string; source: string },
        fn: (db: any) => Promise<unknown>,
    ) =>
        fn({
            fileRecord: {
                findUnique: (...a: unknown[]) => avFindUnique(...(a as [])),
                findFirst: (...a: unknown[]) => avFindUnique(...(a as [])),
                updateMany: (...a: unknown[]) => avUpdateMany(...(a as [any])),
            },
        }),
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

const NOW = new Date('2026-08-21T12:00:00.000Z');

function bufStream(text: string) {
    const { Readable } = jest.requireActual('node:stream');
    return Readable.from([Buffer.from(text)]);
}

beforeEach(() => {
    jest.clearAllMocks();
    avRow = {
        id: 'file-1',
        tenantId: 'tenant-1',
        pathKey: 'tenants/tenant-1/evidence/report.pdf',
        sha256: 'a'.repeat(64),
        uploadedByUserId: 'user-1',
        scanStatus: 'PENDING',
        status: 'STORED',
    };
    createSignedDownloadUrlMock.mockResolvedValue('https://signed.example/blob');
    readStreamMock.mockImplementation(() => bufStream('bytes'));
    consumeDownloadTokenMock.mockResolvedValue({ fileRecordId: 'file-1', accessRequestId: 'tcar-77' });
    trustFindUnique.mockResolvedValue({
        id: 'file-1',
        tenantId: 'tenant-1',
        sha256: 'b'.repeat(64),
        pathKey: 'tenants/tenant-1/trust/soc2.pdf',
        originalName: 'soc2.pdf',
        scanStatus: 'CLEAN',
        status: 'STORED',
        deletedAt: null,
    });
    getTenantCtxMock.mockResolvedValue({ tenantId: 'tenant-1', userId: 'user-9' });
    mockGetPack.mockResolvedValue({
        id: 'p1', name: 'Q2 Audit', status: 'FROZEN', frozenAt: new Date('2026-01-01'),
        items: [{ entityType: 'EVIDENCE', entityId: 'ev1' }, { entityType: 'EVIDENCE', entityId: 'ev2' }],
    });
    mockExport.mockImplementation((_c: any, _i: string, fmt: string) =>
        fmt === 'csv' ? { csv: 'Type,Id\n' } : { pack: { id: 'p1' }, items: [] },
    );
    mockClient.uploadNewFile.mockResolvedValue({ id: 'sp-item-1', webUrl: 'https://sp/pack.zip' });
});

// ════════════════════════════════════════════════════════════════════
describe('AV webhook — a late INFECTED verdict asks what already left', () => {
    function post(body: Record<string, unknown>) {
        return new NextRequest('http://localhost/api/storage/av-webhook', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('assesses exposure for the quarantined file, keyed by id AND content hash', async () => {
        const { POST } = await import('@/app/api/storage/av-webhook/route');

        await POST(post({ fileId: 'file-1', status: 'infected', engine: 'clamav' }));

        expect(buildExposureMock).toHaveBeenCalledTimes(1);
        // The hash is what lets the report cover OTHER rows holding the same
        // bytes. Without it the answer only covers the row the scanner named.
        expect(buildExposureMock.mock.calls[0][0]).toMatchObject({
            tenantId: 'tenant-1',
            fileRecordId: 'file-1',
            sha256: 'a'.repeat(64),
        });
        // And the built report reaches the writer — the half that lands the row.
        expect(recordExposureMock).toHaveBeenCalledTimes(1);
        expect(recordExposureMock.mock.calls[0][1]).toMatchObject({
            tenantId: 'tenant-1',
            fileRecordId: 'file-1',
        });
    });

    it('does not assess exposure on a CLEAN verdict', async () => {
        const { POST } = await import('@/app/api/storage/av-webhook/route');
        const res = await POST(post({ fileId: 'file-1', status: 'clean', engine: 'clamav' }));

        // The negative below is only evidence if the route actually RAN and took
        // the CLEAN branch. On its own `not.toHaveBeenCalled()` passes just as
        // well when POST threw, refused, or never reached the verdict at all —
        // an absence cannot say WHICH absence it is without something positive
        // beside it. So: the request succeeded, and the CLEAN verdict was written.
        expect(res.status).toBe(200);
        expect(avUpdateMany).toHaveBeenCalledTimes(1);
        expect(avUpdateMany.mock.calls[0][0]).toMatchObject({
            data: expect.objectContaining({ scanStatus: 'CLEAN' }),
        });

        expect(buildExposureMock).not.toHaveBeenCalled();
        expect(recordExposureMock).not.toHaveBeenCalled();
    });

    it('still returns 200 when the assessment itself fails — quarantine already committed', async () => {
        buildExposureMock.mockRejectedValueOnce(new Error('ledger unreachable'));
        const { POST } = await import('@/app/api/storage/av-webhook/route');

        const res = await POST(post({ fileId: 'file-1', status: 'infected' }));

        expect(res.status).toBe(200);
    });
});

// ════════════════════════════════════════════════════════════════════
describe('trust-center download — the unauthenticated egress is recorded', () => {
    const ctx = { params: Promise.resolve({ token: 'ictc_valid' }) };
    const req = () => new NextRequest('https://example.test/api/trust/download/ictc_valid');

    it('records the distribution with the URL expiry that bounds it', async () => {
        const { GET } = await import('@/app/api/trust/download/[token]/route');

        const res = await GET(req(), ctx);
        expect(res.status).toBe(302);

        expect(recordMock).toHaveBeenCalledTimes(1);
        const arg = recordMock.mock.calls[0][0] as any;
        expect(arg).toMatchObject({
            tenantId: 'tenant-1',
            fileRecordId: 'file-1',
            sha256: 'b'.repeat(64),
            channel: 'TRUST_CENTER_DOWNLOAD',
            // The CONTEXT is the access request, not the document. That is the
            // whole point on this channel: the request row carries the approved
            // requester, so an exposure report here can name a person. Pointing
            // context at the fileRecordId would repeat what the entry already
            // holds and answer nobody's question.
            contextType: 'TrustCenterAccessRequest',
            contextId: 'tcar-77',
        });
        // The signed URL is the bearer credential from here on. Recording WHEN
        // it dies is what turns "a URL is out there" into a bounded window.
        expect(arg.signedUrlExpiresAt).toBeInstanceOf(Date);
        const ttlSeconds = (arg.signedUrlExpiresAt.getTime() - Date.now()) / 1000;
        expect(ttlSeconds).toBeGreaterThan(240);
        expect(ttlSeconds).toBeLessThanOrEqual(300);
    });

    it('records nothing when the gate refused to serve', async () => {
        trustFindUnique.mockResolvedValueOnce({
            id: 'file-1', tenantId: 'tenant-1', sha256: 'b'.repeat(64),
            pathKey: 'tenants/tenant-1/trust/soc2.pdf', originalName: 'soc2.pdf',
            scanStatus: 'INFECTED', status: 'STORED', deletedAt: null,
        });
        const { GET } = await import('@/app/api/trust/download/[token]/route');

        const res = await GET(req(), ctx);

        expect(res.status).toBe(404);
        expect(recordMock).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════
describe('evidence download — both serving modes are recorded', () => {
    const ctx = { params: Promise.resolve({ tenantSlug: 'acme', fileId: 'file-1' }) };
    const req = () => new NextRequest('https://example.test/api/t/acme/evidence/files/file-1/download');

    it('records a bounded window for the presigned-URL mode', async () => {
        downloadEvidenceFileMock.mockResolvedValue({
            mode: 'redirect',
            downloadUrl: 'https://signed.example/blob',
            originalName: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 10,
            sha256: 'c'.repeat(64),
        });
        const { GET } = await import('@/app/api/t/[tenantSlug]/evidence/files/[fileId]/download/route');

        await GET(req(), ctx as any);

        expect(recordMock).toHaveBeenCalledTimes(1);
        const arg = recordMock.mock.calls[0][0] as any;
        expect(arg).toMatchObject({
            tenantId: 'tenant-1',
            fileRecordId: 'file-1',
            sha256: 'c'.repeat(64),
            channel: 'EVIDENCE_DOWNLOAD',
            actorUserId: 'user-9',
        });
        expect(arg.signedUrlExpiresAt).toBeInstanceOf(Date);
    });

    it('records the streamed mode with no expiry — those bytes are already delivered', async () => {
        const nodeStream = bufStream('bytes');
        downloadEvidenceFileMock.mockResolvedValue({
            mode: 'stream',
            stream: nodeStream,
            originalName: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 5,
            sha256: 'c'.repeat(64),
        });
        const { GET } = await import('@/app/api/t/[tenantSlug]/evidence/files/[fileId]/download/route');

        await GET(req(), ctx as any);

        expect(recordMock).toHaveBeenCalledTimes(1);
        const arg = recordMock.mock.calls[0][0] as any;
        expect(arg.channel).toBe('EVIDENCE_DOWNLOAD');
        expect(arg.signedUrlExpiresAt ?? null).toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════
describe('audit-pack SharePoint export — the copies we cannot take back', () => {
    const admin = { tenantId: 't1', userId: 'u1', permissions: { canAdmin: true } } as any;

    it('records one distribution per BUNDLED file, naming the pack and the drive', async () => {
        mockDb.evidence.findMany.mockResolvedValueOnce([
            { fileRecord: { id: 'f-clean', tenantId: 't1', sha256: 'd'.repeat(64), pathKey: 'tenants/t1/evidence/k1', originalName: 'a.pdf', scanStatus: 'CLEAN', status: 'STORED', deletedAt: null } },
            { fileRecord: { id: 'f-bad', tenantId: 't1', sha256: 'e'.repeat(64), pathKey: 'tenants/t1/evidence/k2', originalName: 'b.pdf', scanStatus: 'INFECTED', status: 'STORED', deletedAt: null } },
        ]);
        const { exportAuditPackToSharePoint } = await import('@/app-layer/usecases/audit-pack-sharepoint-export');

        await exportAuditPackToSharePoint(admin, 'p1', { driveId: 'd1' }, { now: () => NOW });

        expect(recordManyMock).toHaveBeenCalledTimes(1);
        const batch = recordManyMock.mock.calls[0][0] as any[];
        // Only the file that actually went into the ZIP. Recording the blocked
        // one would claim an exposure that never happened.
        expect(batch).toHaveLength(1);
        expect(batch[0]).toMatchObject({
            tenantId: 't1',
            fileRecordId: 'f-clean',
            sha256: 'd'.repeat(64),
            channel: 'AUDIT_PACK_SHAREPOINT',
            contextType: 'AuditPack',
            contextId: 'p1',
            destination: 'd1',
        });
        // A copy in someone else's SharePoint has no expiry — it is permanent.
        expect(batch[0].signedUrlExpiresAt ?? null).toBeNull();
    });

    it('records nothing when the upload never happened', async () => {
        mockClient.uploadNewFile.mockRejectedValueOnce(new Error('graph 500'));
        mockDb.evidence.findMany.mockResolvedValueOnce([
            { fileRecord: { id: 'f-clean', tenantId: 't1', sha256: 'd'.repeat(64), pathKey: 'tenants/t1/evidence/k1', originalName: 'a.pdf', scanStatus: 'CLEAN', status: 'STORED', deletedAt: null } },
        ]);
        const { exportAuditPackToSharePoint } = await import('@/app-layer/usecases/audit-pack-sharepoint-export');

        await expect(
            exportAuditPackToSharePoint(admin, 'p1', { driveId: 'd1' }, { now: () => NOW }),
        ).rejects.toBeDefined();

        expect(recordManyMock).not.toHaveBeenCalled();
    });
});
