/**
 * `POST /api/t/:tenantSlug/controls/:controlId/evidence` — attaching evidence
 * from the control's side — is gated `controls.edit` at the route, the key of
 * the unlink route beside it and of the evidence side's link route (#4326,
 * owner decision).
 *
 * Its usecase, `linkEvidence`, already asserts `assertCanLinkEvidence` (the
 * coarse write tier AND `controls.edit`), so no role gains or loses anything.
 * The route gate is what makes a refusal write an AUTHZ_DENIED row: the
 * usecase's throw records nothing.
 */
import { strictMock } from '../helpers/strict-mock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// The AUTHZ_DENIED row a middleware refusal writes. `strictMock`: `@/lib/audit`
// is a guarded barrel, so an export this fixture forgot fails loudly.
const mockAppendAuditEntryOrQueue = jest.fn(async (_entry: unknown) => ({
    recorded: 'chain' as const,
    auditId: 'audit-x',
}));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntryOrQueue: (entry: unknown) => mockAppendAuditEntryOrQueue(entry),
    }),
);

const linkEvidenceMock = jest.fn(async (_ctx: unknown, _controlId: string, _body: unknown) => ({ id: 'ev-new' }));
jest.mock('@/app-layer/usecases/control', () => ({
    linkEvidence: (ctx: unknown, controlId: string, body: unknown) => linkEvidenceMock(ctx, controlId, body),
    getControlEvidenceTab: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/t/[tenantSlug]/controls/[controlId]/evidence/route';
import { getPermissionsForRole } from '@/lib/permissions';

const editor = {
    requestId: 'req-1',
    userId: 'editor-1',
    tenantId: 'tenant-A',
    role: 'EDITOR',
    permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
    appPermissions: getPermissionsForRole('EDITOR'),
};

/** A custom role on an EDITOR base with `controls.edit` switched off. */
const editorWithoutControlsEdit = {
    ...editor,
    userId: 'custom-1',
    appPermissions: {
        ...getPermissionsForRole('EDITOR'),
        controls: { ...getPermissionsForRole('EDITOR').controls, edit: false },
    },
};

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getTenantCtxMock.mockResolvedValue(editor);
    linkEvidenceMock.mockClear();
    mockAppendAuditEntryOrQueue.mockClear();
});

function post(body: unknown) {
    return POST(
        new NextRequest('http://localhost/api/t/acme/controls/ctrl-1/evidence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ tenantSlug: 'acme', controlId: 'ctrl-1' }) },
    );
}

const LINK = { kind: 'LINK', url: 'https://example.com/policy', note: 'Signed policy' };

describe('attaching evidence from the control side is gated controls.edit at the route', () => {
    it('refuses a caller without controls.edit with a 403 and an AUTHZ_DENIED row, and never calls the usecase', async () => {
        getTenantCtxMock.mockResolvedValue(editorWithoutControlsEdit);
        const res = await post(LINK);
        expect(res.status).toBe(403);
        expect(linkEvidenceMock).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntryOrQueue.mock.calls[0][0]).toMatchObject({
            action: 'AUTHZ_DENIED',
            tenantId: 'tenant-A',
            userId: 'custom-1',
            detailsJson: expect.objectContaining({ permissionKeys: ['controls.edit'] }),
        });
        // A generic refusal: the key is not echoed to the client.
        expect(JSON.stringify(await res.json())).not.toContain('controls.edit');
    });

    it('a READER is refused the same way', async () => {
        getTenantCtxMock.mockResolvedValue({
            ...editor,
            role: 'READER',
            permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
            appPermissions: getPermissionsForRole('READER'),
        });
        const res = await post(LINK);
        expect(res.status).toBe(403);
        expect(linkEvidenceMock).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
    });

    it('a built-in EDITOR attaches a URL link: the body reaches the usecase whole, and the answer is 201', async () => {
        const res = await post(LINK);
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ id: 'ev-new' });
        expect(linkEvidenceMock).toHaveBeenCalledTimes(1);
        expect(linkEvidenceMock.mock.calls[0][1]).toBe('ctrl-1');
        expect(linkEvidenceMock.mock.calls[0][2]).toEqual(LINK);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });

    it('keeps the FILE kind, by fileId', async () => {
        const res = await post({ kind: 'FILE', fileId: 'fr-1', note: null });
        expect(res.status).toBe(201);
        expect(linkEvidenceMock.mock.calls[0][2]).toEqual({ kind: 'FILE', fileId: 'fr-1', note: null });
    });

    it('the body is still validated for a caller the gate admits', async () => {
        const res = await post({ kind: 'NOT_A_KIND' });
        expect(res.status).toBe(400);
        expect(linkEvidenceMock).not.toHaveBeenCalled();
    });
});
