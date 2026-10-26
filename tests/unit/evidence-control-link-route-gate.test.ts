/**
 * `POST /api/t/:tenantSlug/evidence/:id/controls` — the Evidence details
 * panel's "Link control" — is gated `controls.edit` at the route, the same key
 * as the unlink route beside it (#4326, owner decision).
 *
 * It asked only the usecase's coarse `assertCanWrite`, so an EDITOR-based
 * custom role without `controls.edit` could link a control it could not unlink,
 * and a refusal wrote no AUTHZ_DENIED row. The route now runs
 * `requirePermission('controls.edit', …)`, which refuses before the usecase and
 * writes the row.
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

const linkEvidenceToControlMock = jest.fn(async (_ctx: unknown, _evidenceId: string, _controlId: string) => ({
    linked: true,
}));
jest.mock('@/app-layer/usecases/evidence', () => ({
    linkEvidenceToControl: (ctx: unknown, evidenceId: string, controlId: string) =>
        linkEvidenceToControlMock(ctx, evidenceId, controlId),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/t/[tenantSlug]/evidence/[id]/controls/route';
import { getPermissionsForRole } from '@/lib/permissions';

const editor = {
    requestId: 'req-1',
    userId: 'editor-1',
    tenantId: 'tenant-A',
    role: 'EDITOR',
    permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
    appPermissions: getPermissionsForRole('EDITOR'),
};

/** A custom role on an EDITOR base with `controls.edit` switched off — the
 *  coarse tier says write, the key the link route names says no. */
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
    linkEvidenceToControlMock.mockClear();
    mockAppendAuditEntryOrQueue.mockClear();
});

function post(body: unknown) {
    return POST(
        new NextRequest('http://localhost/api/t/acme/evidence/ev-1/controls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ tenantSlug: 'acme', id: 'ev-1' }) },
    );
}

describe('linking a control to evidence is gated controls.edit at the route', () => {
    it('refuses a caller without controls.edit with a 403 and an AUTHZ_DENIED row', async () => {
        getTenantCtxMock.mockResolvedValue(editorWithoutControlsEdit);
        const res = await post({ controlId: 'c-1' });
        expect(res.status).toBe(403);
        // The middleware refused — the usecase never ran.
        expect(linkEvidenceToControlMock).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntryOrQueue.mock.calls[0][0]).toMatchObject({
            action: 'AUTHZ_DENIED',
            tenantId: 'tenant-A',
            userId: 'custom-1',
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
        const res = await post({ controlId: 'c-1' });
        expect(res.status).toBe(403);
        expect(linkEvidenceToControlMock).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
    });

    it('a built-in EDITOR links: the usecase runs with the evidence and control ids', async () => {
        const res = await post({ controlId: 'c-1' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, linked: true });
        expect(linkEvidenceToControlMock).toHaveBeenCalledTimes(1);
        expect(linkEvidenceToControlMock.mock.calls[0].slice(1)).toEqual(['ev-1', 'c-1']);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });

    it('the body is still validated for a caller the gate admits', async () => {
        const res = await post({});
        expect(res.status).toBe(400);
        expect(linkEvidenceToControlMock).not.toHaveBeenCalled();
    });
});
