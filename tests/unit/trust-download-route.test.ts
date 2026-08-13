/**
 * The public trust-center download route — the first executing tests it has had.
 *
 * This is the repo's ONLY unauthenticated file-serving path: no session, no
 * tenant context, just a single-use token. It previously selected nothing but
 * `{ pathKey, originalName }` from FileRecord, so it had no way to gate on the
 * scan verdict, the storage lifecycle, or a soft delete — and duly handed
 * anonymous callers a signed URL for INFECTED, mid-scan and deleted files.
 *
 * `tests/integration/trust-center-public-leak.test.ts` exists but covers
 * PROJECTION leakage and carries zero scanStatus or download-path assertions,
 * and it sits behind the DB_AVAILABLE silent-skip. Its green status was never
 * evidence about any of this.
 *
 * These drive the REAL route export with prisma, the token consumer and the
 * storage provider mocked, so what is under test is the route's own gate.
 */
import { NextRequest } from 'next/server';

const consumeDownloadTokenMock = jest.fn();
const findUniqueMock = jest.fn();
const createSignedDownloadUrlMock = jest.fn();

jest.mock('@/lib/trust-center/gated', () => ({
    __esModule: true,
    consumeDownloadToken: (...a: unknown[]) => consumeDownloadTokenMock(...a),
}));

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: { fileRecord: { findUnique: (...a: unknown[]) => findUniqueMock(...a) } },
}));

jest.mock('@/lib/storage', () => ({
    __esModule: true,
    getStorageProvider: () => ({
        createSignedDownloadUrl: (...a: unknown[]) => createSignedDownloadUrlMock(...a),
    }),
}));

import { GET } from '@/app/api/trust/download/[token]/route';

const TOKEN = 'ictc_valid_token';
const ctx = { params: Promise.resolve({ token: TOKEN }) };
const req = () => new NextRequest('https://example.test/api/trust/download/ictc_valid_token');

/** A file that SHOULD be servable — every gate satisfied. */
const servable = {
    pathKey: 'tenants/t1/evidence/ok.pdf',
    originalName: 'ok.pdf',
    scanStatus: 'CLEAN',
    status: 'STORED',
    deletedAt: null,
};

beforeEach(() => {
    jest.clearAllMocks();
    // A VALID, correctly-consumed token in every test below. The point is that
    // token validity alone must not be sufficient to be served bytes.
    consumeDownloadTokenMock.mockResolvedValue({ fileRecordId: 'file-1' });
    createSignedDownloadUrlMock.mockResolvedValue('https://signed.example/blob');
});

describe('trust-center download — the happy path still works', () => {
    it('redirects to a signed URL for a CLEAN, STORED, live file', async () => {
        findUniqueMock.mockResolvedValue(servable);

        const res = await GET(req(), ctx);

        expect(res.status).toBe(302);
        expect(createSignedDownloadUrlMock).toHaveBeenCalledWith(
            servable.pathKey,
            expect.objectContaining({ downloadFilename: 'ok.pdf' }),
        );
    });

    it('loads the columns it gates on', async () => {
        findUniqueMock.mockResolvedValue(servable);
        await GET(req(), ctx);

        // The original defect was a SELECT omission, not a missing branch: you
        // cannot gate on a column you never loaded.
        const select = findUniqueMock.mock.calls[0][0].select;
        expect(select).toMatchObject({ scanStatus: true, status: true, deletedAt: true });
    });
});

describe('trust-center download — the scan gate', () => {
    it('refuses a file scanned INFECTED', async () => {
        findUniqueMock.mockResolvedValue({ ...servable, scanStatus: 'INFECTED' });

        const res = await GET(req(), ctx);

        expect(res.status).toBe(404);
        // The real assertion: no signed URL was ever minted. A 404 that still
        // called the provider would have leaked a live URL to the caller.
        expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
    });

    it('refuses a file whose scan is still PENDING', async () => {
        // Every file is PENDING between storage and the async scan completing.
        findUniqueMock.mockResolvedValue({ ...servable, scanStatus: 'PENDING' });

        const res = await GET(req(), ctx);

        expect(res.status).toBe(404);
        expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
    });
});

describe('trust-center download — the lifecycle gate', () => {
    it('refuses a soft-deleted file', async () => {
        findUniqueMock.mockResolvedValue({ ...servable, deletedAt: new Date('2026-01-01') });

        const res = await GET(req(), ctx);

        expect(res.status).toBe(404);
        expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
    });

    it('refuses a file that never reached STORED', async () => {
        findUniqueMock.mockResolvedValue({ ...servable, status: 'PENDING' });

        const res = await GET(req(), ctx);

        expect(res.status).toBe(404);
        expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
    });

    it('refuses a FAILED upload', async () => {
        findUniqueMock.mockResolvedValue({ ...servable, status: 'FAILED' });

        const res = await GET(req(), ctx);

        expect(res.status).toBe(404);
        expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
    });
});

describe('trust-center download — blocked is indistinguishable from absent', () => {
    it('returns the same status and body for a blocked file as for a missing one', async () => {
        findUniqueMock.mockResolvedValue(null);
        const missing = await GET(req(), ctx);
        const missingBody = await missing.json();

        findUniqueMock.mockResolvedValue({ ...servable, scanStatus: 'INFECTED' });
        const blocked = await GET(req(), ctx);
        const blockedBody = await blocked.json();

        // An anonymous caller replaying or guessing a token must not be able to
        // tell "this document exists but is quarantined" from "no such
        // document". A 403 here would confirm existence.
        expect(blocked.status).toBe(missing.status);
        expect(blockedBody).toEqual(missingBody);
    });

    it('still rejects an invalid or expired token before touching the DB', async () => {
        consumeDownloadTokenMock.mockResolvedValue(null);

        const res = await GET(req(), ctx);

        expect(res.status).toBe(404);
        expect(findUniqueMock).not.toHaveBeenCalled();
        expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
    });
});
