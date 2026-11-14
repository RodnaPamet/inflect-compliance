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

const resolveDownloadTokenMock = jest.fn();
const spendDownloadTokenMock = jest.fn();
const findUniqueMock = jest.fn();
const createSignedDownloadUrlMock = jest.fn();
const getProviderByNameMock = jest.fn();

jest.mock('@/lib/trust-center/gated', () => ({
    __esModule: true,
    resolveDownloadToken: (...a: unknown[]) => resolveDownloadTokenMock(...a),
    spendDownloadToken: (...a: unknown[]) => spendDownloadTokenMock(...a),
}));

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    prisma: { fileRecord: { findUnique: (...a: unknown[]) => findUniqueMock(...a) } },
}));

jest.mock('@/lib/storage', () => ({
    __esModule: true,
    // Mocked by NAME so a test can assert WHICH provider was asked — the
    // route must read with the provider that wrote the bytes (#5615), not the
    // process-wide default.
    getProviderByName: (...a: unknown[]) => getProviderByNameMock(...a),
}));

import { GET } from '@/app/api/trust/download/[token]/route';

const TOKEN = 'ictc_valid_token';
const ctx = { params: Promise.resolve({ token: TOKEN }) };
const req = () => new NextRequest('https://example.test/api/trust/download/ictc_valid_token');

/** A file that SHOULD be servable — every gate satisfied. */
const servable = {
    id: 'file-1',
    tenantId: 't1',
    sha256: 'a'.repeat(64),
    storageProvider: 's3',
    pathKey: 'tenants/t1/evidence/ok.pdf',
    originalName: 'ok.pdf',
    scanStatus: 'CLEAN',
    status: 'STORED',
    deletedAt: null,
};

beforeEach(() => {
    jest.clearAllMocks();
    // A VALID, correctly-resolved token in every test below. The point is that
    // token validity alone must not be sufficient to be served bytes.
    resolveDownloadTokenMock.mockResolvedValue({ fileRecordId: 'file-1', accessRequestId: 'req-1' });
    spendDownloadTokenMock.mockResolvedValue(true);
    createSignedDownloadUrlMock.mockResolvedValue('https://signed.example/blob');
    getProviderByNameMock.mockReturnValue({
        createSignedDownloadUrl: (...a: unknown[]) => createSignedDownloadUrlMock(...a),
    });
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
        // storageProvider joins the list for the same reason (#5615): it decides
        // which provider can read pathKey at all.
        expect(select).toMatchObject({ scanStatus: true, status: true, deletedAt: true, storageProvider: true });
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
        resolveDownloadTokenMock.mockResolvedValue(null);

        const res = await GET(req(), ctx);

        expect(res.status).toBe(404);
        expect(findUniqueMock).not.toHaveBeenCalled();
        expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
    });
});

describe('trust-center download — the signed URL is short-lived', () => {
    // The token is single-use and is spent immediately before the URL is
    // minted, so from that point the SIGNED URL is the bearer credential:
    // shareable, replayable, visible to intermediaries, and outside our
    // revocation. Its lifetime is the whole exposure window for a document a
    // human explicitly approved for one named requester.
    //
    // The route used to pass no `expiresIn` at all and took the s3-provider's
    // `?? 3600` fallback, so the only UNAUTHENTICATED serving path in the repo
    // minted URLs outliving the AUTHENTICATED evidence download's by 12x. That
    // was an omission rather than a decision, which is why these assert a
    // BOUND — comparing against a constant the route also owns would pass no
    // matter what number the route chose.
    const PROVIDER_DEFAULT_TTL_SECONDS = 3600; // s3-provider.ts: expiresIn ?? 3600
    const AUTHENTICATED_EVIDENCE_TTL_SECONDS = 300; // evidence.ts: expiresIn: 300

    const optsFromFirstCall = () => createSignedDownloadUrlMock.mock.calls[0][1];

    it('asks for an explicit expiry instead of inheriting the provider default', async () => {
        findUniqueMock.mockResolvedValue(servable);
        await GET(req(), ctx);

        const opts = optsFromFirstCall();
        // `undefined` here IS the bug: the provider reads a missing expiry as
        // "use 3600". An expiry that is absent is not an expiry that is short.
        expect(typeof opts?.expiresIn).toBe('number');
        expect(opts.expiresIn).toBeLessThan(PROVIDER_DEFAULT_TTL_SECONDS);
    });

    it('is no more generous than the authenticated evidence download', async () => {
        findUniqueMock.mockResolvedValue(servable);
        await GET(req(), ctx);

        const expiresIn = optsFromFirstCall()?.expiresIn;
        // A public path may be stricter than its authenticated sibling; it may
        // never be looser. Tightening this number keeps the test green.
        expect(expiresIn).toBeLessThanOrEqual(AUTHENTICATED_EVIDENCE_TTL_SECONDS);
        // Seconds, not milliseconds — the value goes straight to the S3
        // presigner, where 300_000 would read as ~3.5 days.
        expect(expiresIn).toBeGreaterThan(0);
    });
});

describe('trust-center download — a refusal must not cost the single use (#5614)', () => {
    // #5385 settled this for the `enabled` check by putting it above the claim
    // inside the token module. The AV and lifecycle gate is the same shape of
    // refusal — transient, cleared by something that happens later — but it
    // lives out here, and the route used to consume before reaching it. So a
    // file that was merely mid-scan spent the requester's one use on a 404 that
    // would have succeeded minutes later.
    const refusals: Array<[string, Record<string, unknown>]> = [
        ['a scan still PENDING', { scanStatus: 'PENDING' }],
        ['a scan in progress', { scanStatus: 'SCANNING' }],
        ['an INFECTED verdict', { scanStatus: 'INFECTED' }],
        ['a soft delete', { deletedAt: new Date('2026-01-01') }],
        ['an upload that never reached STORED', { status: 'PENDING' }],
    ];

    it.each(refusals)('does not spend the token when the gate refuses: %s', async (_label, over) => {
        findUniqueMock.mockResolvedValue({ ...servable, ...over });

        const res = await GET(req(), ctx);

        expect(res.status).toBe(404);
        // The whole point. A spent token cannot be retried, and the admin is
        // never told it was burnt.
        expect(spendDownloadTokenMock).not.toHaveBeenCalled();
        expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
    });

    it('does not spend the token when the FileRecord has vanished', async () => {
        findUniqueMock.mockResolvedValue(null);
        expect((await GET(req(), ctx)).status).toBe(404);
        expect(spendDownloadTokenMock).not.toHaveBeenCalled();
    });

    it('DOES spend it on the happy path, naming the access request', async () => {
        findUniqueMock.mockResolvedValue(servable);

        const res = await GET(req(), ctx);

        expect(res.status).toBe(302);
        expect(spendDownloadTokenMock).toHaveBeenCalledWith('req-1');
    });

    it('spends BEFORE minting the URL, so no URL exists for a use it did not win', async () => {
        findUniqueMock.mockResolvedValue(servable);
        const order: string[] = [];
        spendDownloadTokenMock.mockImplementation(async () => { order.push('spend'); return true; });
        createSignedDownloadUrlMock.mockImplementation(async () => { order.push('sign'); return 'https://signed.example/blob'; });

        await GET(req(), ctx);

        expect(order).toEqual(['spend', 'sign']);
    });

    it('serves nothing when a concurrent request already took the use', async () => {
        findUniqueMock.mockResolvedValue(servable);
        spendDownloadTokenMock.mockResolvedValue(false);

        const res = await GET(req(), ctx);

        expect(res.status).toBe(404);
        // Losing the race must not mint a second URL for a one-use token.
        expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
    });
});

describe('trust-center download — reads with the provider that wrote the bytes (#5615)', () => {
    it('presigns with the provider named on the FileRecord', async () => {
        findUniqueMock.mockResolvedValue(servable);

        await GET(req(), ctx);

        // Not getStorageProvider(): on a deployment that migrated providers the
        // configured default presigns a key that is not in its bucket.
        expect(getProviderByNameMock).toHaveBeenCalledWith('s3');
    });

    it('refuses a locally-stored file instead of handing out a URL that cannot work', async () => {
        // The local provider's "signed URL" is /api/files/<key>, which calls
        // getLegacyCtx — an authenticated route an anonymous trust-center
        // visitor cannot open. Serving it would spend the use on a dead link.
        findUniqueMock.mockResolvedValue({ ...servable, storageProvider: 'local' });

        const res = await GET(req(), ctx);

        expect(res.status).toBe(404);
        expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
        // And the token survives for an operator who moves the object.
        expect(spendDownloadTokenMock).not.toHaveBeenCalled();
    });

    it('treats an unrecognised or absent provider as unservable, not as the default', async () => {
        for (const storageProvider of [undefined, null, '', 'gcs']) {
            jest.clearAllMocks();
            resolveDownloadTokenMock.mockResolvedValue({ fileRecordId: 'file-1', accessRequestId: 'req-1' });
            spendDownloadTokenMock.mockResolvedValue(true);
            getProviderByNameMock.mockReturnValue({ createSignedDownloadUrl: createSignedDownloadUrlMock });
            findUniqueMock.mockResolvedValue({ ...servable, storageProvider });

            const res = await GET(req(), ctx);

            expect(res.status).toBe(404);
            expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
            expect(spendDownloadTokenMock).not.toHaveBeenCalled();
        }
    });

    it('a refused provider is indistinguishable from a missing document', async () => {
        findUniqueMock.mockResolvedValue(null);
        const missing = await GET(req(), ctx);
        const missingBody = await missing.json();

        findUniqueMock.mockResolvedValue({ ...servable, storageProvider: 'local' });
        const refused = await GET(req(), ctx);

        expect(refused.status).toBe(missing.status);
        expect(await refused.json()).toEqual(missingBody);
    });
});
