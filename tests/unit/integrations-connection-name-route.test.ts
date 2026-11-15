/**
 * `POST /api/t/:tenantSlug/admin/integrations` refuses a connection name with
 * a control character or a lone surrogate (#5317; owner decision 2026-11-15),
 * on a create and on an update, before the usecase is reached — and an update
 * that leaves the name out is still taken, because a stored label is left
 * alone.
 *
 * The usecase is mocked: what this file holds is the HTTP boundary, i.e. that
 * the refusal is a 400 carrying the stable code and that nothing is written.
 * The usecase's own check, and the stored row, are held against a real
 * database in `tests/integration/integration-connection-name.test.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// `requirePermission` records AUTHZ_DENIED through the audit chain on denial.
jest.mock('@/lib/audit', () => ({
    appendAuditEntryOrQueue: jest.fn(async () => ({ recorded: 'chain' as const, auditId: 'audit-x' })),
    appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'hash-x', previousHash: null })),
}));

const upsertMock = jest.fn(async (_ctx: unknown, input: { id?: string; provider: string; name?: string }) => ({
    id: input.id ?? 'conn-new',
    provider: input.provider,
    name: input.name ?? 'stored name',
    isEnabled: true,
    createdAt: new Date('2026-11-15T00:00:00.000Z'),
    updatedAt: new Date('2026-11-15T00:00:00.000Z'),
}));
jest.mock('@/app-layer/usecases/integrations', () => ({
    listIntegrationConnections: jest.fn(async () => []),
    upsertIntegrationConnection: (ctx: unknown, input: { id?: string; provider: string; name?: string }) =>
        upsertMock(ctx, input),
    removeIntegrationConnection: jest.fn(),
    listAvailableProviders: () => [],
    updateConnectionTestStatus: jest.fn(),
    testConnectionCredentials: jest.fn(),
}));

jest.mock('@/app-layer/integrations/registry', () => ({
    registry: {
        getProvider: (id: string) => (id === 'github' ? { id } : undefined),
        listProviderIds: () => ['github'],
    },
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/t/[tenantSlug]/admin/integrations/route';
import { getPermissionsForRole } from '@/lib/permissions';

function adminCtx() {
    return {
        requestId: 'req-1',
        userId: 'admin-1',
        tenantId: 'tenant-A',
        role: 'ADMIN' as const,
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

const routeArgs = { params: Promise.resolve({ tenantSlug: 'acme' }) };

async function post(body: unknown) {
    getTenantCtxMock.mockResolvedValueOnce(adminCtx());
    const req = new NextRequest('http://localhost/api/t/acme/admin/integrations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req, routeArgs as any);
    return { status: res.status, body: (await res.json()) as { error: { code: string; details: unknown } } };
}

beforeEach(() => upsertMock.mockClear());

describe('POST …/admin/integrations — the connection name', () => {
    it.each([
        ['a create with a control character', { provider: 'github', name: 'Acme\u0000Org' }],
        ['a create with DEL', { provider: 'github', name: 'Acme\u007F' }],
        ['a create with a C1 control', { provider: 'github', name: 'Acme\u0090' }],
        ['a create with a lone high surrogate', { provider: 'github', name: 'Acme \uD83D' }],
        ['an update with a lone low surrogate', { id: 'conn-1', provider: 'github', name: 'Acme \uDE00' }],
        ['an update with a newline', { id: 'conn-1', provider: 'github', name: 'Acme\nOrg' }],
    ])('%s is a 400 naming the code, and nothing is written', async (_label, body) => {
        const res = await post(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details).toEqual([
            expect.objectContaining({ path: ['name'], message: 'CONNECTION_NAME_INVALID_CHARACTERS' }),
        ]);
        expect(upsertMock).not.toHaveBeenCalled();
    });

    it('takes a create with an emoji, Cyrillic and accented name — the positive control', async () => {
        const name = 'Société Връзка 😀';
        const res = await post({ provider: 'github', name });
        expect(res.status).toBe(201);
        expect(upsertMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name }));
    });

    it('takes an update that leaves the name out, and passes no name on', async () => {
        const res = await post({ id: 'conn-1', provider: 'github', isEnabled: true });
        expect(res.status).toBe(200);
        expect(upsertMock).toHaveBeenCalledTimes(1);
        expect(upsertMock.mock.calls[0][1].name).toBeUndefined();
    });

    it('still refuses a create with no name', async () => {
        const res = await post({ provider: 'github' });
        expect(res.status).toBe(400);
        expect(upsertMock).not.toHaveBeenCalled();
    });
});
