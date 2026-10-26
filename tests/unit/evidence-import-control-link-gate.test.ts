/**
 * `POST /api/t/:tenantSlug/evidence/imports` — the ZIP import's default
 * control links every record the import creates, so it takes the rule every
 * evidence-to-control link takes: the coarse write tier AND `controls.edit`
 * (#4326, owner decision).
 *
 * It is asked when the REQUEST is made, before the archive is staged. The
 * worker that extracts the archive later asks it again under the initiator's
 * custom role (#4362, `evidence-import-initiator-custom-role.test.ts`), but a
 * refusal there is a per-file error on an import already accepted, so this is
 * the place an EDITOR-based custom role without `controls.edit` is told.
 */
import { NextRequest } from 'next/server';
import { strictMock } from '../helpers/strict-mock';
import { getPermissionsForRole } from '@/lib/permissions';

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
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn({}),
    runInTenantReadContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn({}),
}));

// The AUTHZ_DENIED row. `strictMock`: `@/lib/audit` is a guarded barrel.
const mockAppendAuditEntryOrQueue = jest.fn(async (_entry: unknown) => ({
    recorded: 'chain' as const,
    auditId: 'audit-x',
}));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => mockAppendAuditEntryOrQueue(entry),
    }),
);

import { POST } from '@/app/api/t/[tenantSlug]/evidence/imports/route';

const EDITOR = getPermissionsForRole('EDITOR');
const editor = {
    tenantId: 't1',
    userId: 'editor-1',
    role: 'EDITOR',
    requestId: 'req-1',
    permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
    appPermissions: EDITOR,
};
const editorWithoutControlsEdit = {
    ...editor,
    userId: 'custom-1',
    appPermissions: { ...EDITOR, controls: { ...EDITOR.controls, edit: false } },
};

function zipRequest(fields: Record<string, string>): NextRequest {
    const fd = new FormData();
    fd.append(
        'file',
        new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'bundle.zip', { type: 'application/zip' }),
    );
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return new NextRequest('https://x.test/api/t/acme/evidence/imports', { method: 'POST', body: fd });
}

const post = (fields: Record<string, string>) =>
    POST(zipRequest(fields), { params: Promise.resolve({ tenantSlug: 'acme' }) });

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue(editor);
    createPendingMock.mockResolvedValue({ id: 'fr-1' });
    markStoredMock.mockResolvedValue(undefined);
    writeMock.mockResolvedValue({ sha256: 'abc', sizeBytes: 4 });
    enqueueMock.mockResolvedValue({ id: 'job-1' });
});

describe('the ZIP import default control needs controls.edit, asked at request time', () => {
    it('refuses a role without controls.edit a default control: 403, an AUTHZ_DENIED row, nothing staged or enqueued', async () => {
        getTenantCtxMock.mockResolvedValue(editorWithoutControlsEdit);
        const res = await post({ controlId: 'ctrl-42' });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error.details).toEqual({ reason: 'CONTROL_LINKS_NOT_PERMITTED' });
        expect(writeMock).not.toHaveBeenCalled();
        expect(createPendingMock).not.toHaveBeenCalled();
        expect(enqueueMock).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntryOrQueue.mock.calls[0][0]).toMatchObject({
            action: 'AUTHZ_DENIED',
            tenantId: 't1',
            userId: 'custom-1',
            detailsJson: expect.objectContaining({
                permissionKeys: ['controls.edit'],
                method: 'POST',
                path: '/api/t/acme/evidence/imports',
            }),
        });
    });

    it('lets the same role import with no default control', async () => {
        getTenantCtxMock.mockResolvedValue(editorWithoutControlsEdit);
        const res = await post({ folder: 'Q1 Audit' });

        expect(res.status).toBe(202);
        expect(enqueueMock).toHaveBeenCalledTimes(1);
        expect(enqueueMock.mock.calls[0][1]).toMatchObject({ controlId: null, folder: 'Q1 Audit' });
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });

    it('a built-in EDITOR imports with a default control', async () => {
        const res = await post({ controlId: 'ctrl-42' });

        expect(res.status).toBe(202);
        expect(enqueueMock.mock.calls[0][1]).toMatchObject({ controlId: 'ctrl-42' });
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });
});
