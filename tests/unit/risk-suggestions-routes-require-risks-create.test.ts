/**
 * AI Assist's generate and apply routes take `risks.create` (#4327).
 *
 * Applying a suggestion session creates real risks (`applySession`), and a
 * session exists only to be applied, so both routes need the key the Risk
 * button (`POST /risks`) and the import (`POST /risks/bulk/import`) need.
 * They checked only the AI feature gate and the coarse write tier, inside the
 * usecase — so a custom role on an Editor base with `risks.create` switched
 * off could add risks through AI Assist, and a refusal wrote no AUTHZ_DENIED
 * row.
 *
 * Dismiss creates nothing and keeps its usecase gate; the last case holds
 * that it is not swept up in the change.
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

const generateMock = jest.fn(async (_ctx: unknown, _input: unknown) => ({ session: { id: 's-1' }, items: [] }));
const applyMock = jest.fn(async (_ctx: unknown, _id: string, _body: unknown) => ({ id: 's-1', status: 'APPLIED' }));
const dismissMock = jest.fn(async (_ctx: unknown, _id: string) => ({ id: 's-1', status: 'DISMISSED' }));
jest.mock('@/app-layer/usecases/risk-suggestions', () => ({
    generateRiskSuggestions: (ctx: unknown, input: unknown) => generateMock(ctx, input),
    applySession: (ctx: unknown, id: string, body: unknown) => applyMock(ctx, id, body),
    dismissSession: (ctx: unknown, id: string) => dismissMock(ctx, id),
    getSession: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { POST as generatePOST } from '@/app/api/t/[tenantSlug]/ai/risk-suggestions/generate/route';
import { POST as applyPOST } from '@/app/api/t/[tenantSlug]/ai/risk-suggestions/[sessionId]/apply/route';
import { POST as dismissPOST } from '@/app/api/t/[tenantSlug]/ai/risk-suggestions/[sessionId]/dismiss/route';
import { getPermissionsForRole } from '@/lib/permissions';

const EDITOR_TIER = { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true };

const editor = {
    requestId: 'req-1',
    userId: 'editor-1',
    tenantId: 'tenant-A',
    role: 'EDITOR',
    permissions: EDITOR_TIER,
    appPermissions: getPermissionsForRole('EDITOR'),
};

/** A custom role on an EDITOR base with `risks.create` switched off — the
 *  coarse tier says write, the key the Risk button names says no. */
const editorWithoutCreate = {
    ...editor,
    userId: 'custom-1',
    appPermissions: {
        ...getPermissionsForRole('EDITOR'),
        risks: { ...getPermissionsForRole('EDITOR').risks, create: false },
    },
};

const reader = {
    ...editor,
    userId: 'reader-1',
    role: 'READER',
    permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
    appPermissions: getPermissionsForRole('READER'),
};

beforeEach(() => {
    getTenantCtxMock.mockReset();
    getTenantCtxMock.mockResolvedValue(editor);
    generateMock.mockClear();
    applyMock.mockClear();
    dismissMock.mockClear();
    mockAppendAuditEntryOrQueue.mockClear();
});

function post(path: string, body?: unknown) {
    return new NextRequest(`http://localhost/api/t/acme/ai/risk-suggestions${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const generate = () =>
    generatePOST(post('/generate', { frameworks: ['ISO27001'], assetIds: [] }), {
        params: Promise.resolve({ tenantSlug: 'acme' }),
    });
const apply = () =>
    applyPOST(post('/s-1/apply', { acceptedItemIds: ['item-1'] }), {
        params: Promise.resolve({ tenantSlug: 'acme', sessionId: 's-1' }),
    });
const dismiss = () =>
    dismissPOST(post('/s-1/dismiss'), {
        params: Promise.resolve({ tenantSlug: 'acme', sessionId: 's-1' }),
    });

describe.each([
    ['generate', generate, generateMock],
    ['apply', apply, applyMock],
] as const)('POST %s is gated risks.create at the route', (_name, call, usecase) => {
    it('refuses a caller without risks.create with a 403 and an AUTHZ_DENIED row', async () => {
        getTenantCtxMock.mockResolvedValue(editorWithoutCreate);
        const res = await call();
        expect(res.status).toBe(403);
        // The middleware refused — the usecase never ran.
        expect(usecase).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntryOrQueue.mock.calls[0][0]).toMatchObject({
            action: 'AUTHZ_DENIED',
            tenantId: 'tenant-A',
            userId: 'custom-1',
        });
        // A generic refusal: the key is not echoed to the client.
        expect(JSON.stringify(await res.json())).not.toContain('risks.create');
    });

    it('a READER is refused the same way', async () => {
        getTenantCtxMock.mockResolvedValue(reader);
        const res = await call();
        expect(res.status).toBe(403);
        expect(usecase).not.toHaveBeenCalled();
        expect(mockAppendAuditEntryOrQueue).toHaveBeenCalledTimes(1);
    });

    it('an Editor, who holds risks.create, reaches the usecase', async () => {
        const res = await call();
        expect(res.status).toBeLessThan(300);
        expect(usecase).toHaveBeenCalledTimes(1);
        expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
    });
});

it('the body still reaches the usecase validated', async () => {
    await apply();
    expect(applyMock).toHaveBeenCalledWith(editor, 's-1', { acceptedItemIds: ['item-1'] });
    await generate();
    expect(generateMock).toHaveBeenCalledWith(editor, { frameworks: ['ISO27001'], assetIds: [], context: undefined });
});

it('dismiss creates nothing and is NOT gated risks.create — the same caller still reaches it', async () => {
    getTenantCtxMock.mockResolvedValue(editorWithoutCreate);
    const res = await dismiss();
    expect(res.status).toBe(200);
    expect(dismissMock).toHaveBeenCalledTimes(1);
    expect(mockAppendAuditEntryOrQueue).not.toHaveBeenCalled();
});
