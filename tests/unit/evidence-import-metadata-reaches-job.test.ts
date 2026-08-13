/**
 * Bulk evidence import — the operator's "Default control" and "Folder" must
 * actually reach the extracted evidence.
 *
 * Both were discarded at the HTTP boundary. The modal posted `controlIds`
 * (plural) while the route read `formData.get('controlId')` (singular), so the
 * chosen control resolved to null; and `folder` was posted but never read at
 * all, with no member for it on `EvidenceImportPayload`. The import reported
 * success either way, so an operator setting both got neither and had no
 * signal that anything was dropped.
 *
 * These assert on the ENQUEUED PAYLOAD rather than on source text, because a
 * key-name mismatch is invisible to a grep for `controlId` — both spellings
 * are present in the codebase and both look right in isolation. The payload is
 * the seam where the two sides actually have to agree.
 */
import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
const enqueueMock = jest.fn();
const writeMock = jest.fn();
const createPendingMock = jest.fn();
const markStoredMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

jest.mock('@/app-layer/jobs/queue', () => ({
    __esModule: true,
    enqueue: (...a: unknown[]) => enqueueMock(...a),
}));

jest.mock('@/lib/storage', () => ({
    __esModule: true,
    getStorageProvider: () => ({ write: (...a: unknown[]) => writeMock(...a) }),
    buildTenantObjectKey: () => 'tenants/t1/evidence-import-staging/x.zip',
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    __esModule: true,
    FileRepository: {
        createPending: (...a: unknown[]) => createPendingMock(...a),
        markStored: (...a: unknown[]) => markStoredMock(...a),
    },
}));

jest.mock('@/lib/db/rls-middleware', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn({}),
    runInTenantReadContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn({}),
}));

import { POST } from '@/app/api/t/[tenantSlug]/evidence/imports/route';

function zipRequest(fields: Record<string, string>): NextRequest {
    const fd = new FormData();
    fd.append(
        'file',
        new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'bundle.zip', {
            type: 'application/zip',
        }),
    );
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return new NextRequest('https://x.test/api/t/acme/evidence/imports', {
        method: 'POST',
        body: fd,
    });
}

/** The payload handed to `enqueue('evidence-import', ...)`. */
function enqueuedPayload(): Record<string, unknown> {
    const call = enqueueMock.mock.calls.find(([name]) => name === 'evidence-import');
    if (!call) throw new Error('evidence-import was never enqueued');
    return call[1] as Record<string, unknown>;
}

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue({
        tenantId: 't1',
        userId: 'u1',
        role: 'ADMIN',
        requestId: 'req-1',
        permissions: {},
        // The route gates on this before doing anything else.
        appPermissions: { evidence: { upload: true } },
    });
    createPendingMock.mockResolvedValue({ id: 'fr-1' });
    markStoredMock.mockResolvedValue(undefined);
    writeMock.mockResolvedValue({ sha256: 'abc', sizeBytes: 4 });
    enqueueMock.mockResolvedValue({ id: 'job-1' });
});

describe('evidence import — operator metadata reaches the job', () => {
    it('carries the chosen control through under the key the route reads', async () => {
        // The modal sends ONE id. The whole pipeline downstream — route,
        // EvidenceImportPayload, uploadEvidenceFile — is singular `controlId`.
        await POST(zipRequest({ controlId: 'ctrl-42' }), {
            params: Promise.resolve({ tenantSlug: 'acme' }),
        });

        expect(enqueuedPayload().controlId).toBe('ctrl-42');
    });

    it('carries the folder label through', async () => {
        await POST(zipRequest({ folder: 'Q1 Audit' }), {
            params: Promise.resolve({ tenantSlug: 'acme' }),
        });

        expect(enqueuedPayload().folder).toBe('Q1 Audit');
    });

    it('leaves both null when the operator supplied neither', async () => {
        // The optional path still has to be a real null rather than the
        // string "undefined" or an absent key the job would mis-read.
        await POST(zipRequest({}), {
            params: Promise.resolve({ tenantSlug: 'acme' }),
        });

        const p = enqueuedPayload();
        expect(p.controlId).toBeNull();
        expect(p.folder).toBeNull();
    });
});
