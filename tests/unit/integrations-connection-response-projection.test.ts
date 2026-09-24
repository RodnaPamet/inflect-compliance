/**
 * `GET /api/t/:tenantSlug/admin/integrations` serves a NAMED set of connection
 * fields, not whatever the query happened to return.
 *
 * ═══ WHY THIS IS NOT REDUNDANT WITH THE USECASE'S `select` ═══
 *
 * `listIntegrationConnections` already names its columns. That is a statement
 * about the READ, and it is the only thing standing between the API and a
 * column nobody meant to publish — so the day it grows a field for an internal
 * reason (a sync cursor for a job, a lock timestamp for a dashboard, an
 * `include` for a relation), the field is on the wire with no diff in the
 * route and nothing to review. The route used to spread the row (`...c`),
 * which is exactly that shape: a response whose contents are decided
 * elsewhere.
 *
 * The assertion below is therefore written the way the hazard arrives — an
 * EXTRA field on the row the usecase returns — rather than as a re-statement
 * of today's field list. A projection built by DERIVING from the query it
 * projects would pass a list comparison and fail this one.
 *
 * Context: #2837. `configJson` is a plain unencrypted Json column served under
 * a payload advertising `secretStatus: '••••••••'`, and ten credential-named
 * keys were accepted into it at the write boundary. The accept-list was fixed
 * in `config-schema.ts`; this is the read half.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// `requirePermission` records AUTHZ_DENIED through the audit chain on denial.
// A unit test must not reach a real DB for that; see CLAUDE.md C.1.
jest.mock('@/lib/audit', () => ({
    appendAuditEntryOrQueue: jest.fn(async () => ({ recorded: 'chain' as const, auditId: 'audit-x' })),
    appendAuditEntry: jest.fn(async () => ({ id: 'audit-x', entryHash: 'hash-x', previousHash: null })),
}));

const listIntegrationConnectionsMock = jest.fn(async (_ctx: unknown) => [] as unknown[]);
jest.mock('@/app-layer/usecases/integrations', () => ({
    listIntegrationConnections: (ctx: unknown) => listIntegrationConnectionsMock(ctx),
    upsertIntegrationConnection: jest.fn(),
    removeIntegrationConnection: jest.fn(),
    listAvailableProviders: () => [],
    updateConnectionTestStatus: jest.fn(),
    testConnectionCredentials: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/admin/integrations/route';
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

const request = () =>
    new NextRequest('http://localhost/api/t/acme/admin/integrations', { method: 'GET' });
const routeArgs = { params: Promise.resolve({ tenantSlug: 'acme' }) };

/** The shape `listIntegrationConnections` returns today. */
const ROW = {
    id: 'conn-1',
    provider: 'active-directory',
    name: 'Corp AD',
    isEnabled: true,
    configJson: { url: 'ldaps://dc.corp.example.com:636', baseDN: 'DC=corp' },
    lastTestedAt: new Date('2026-09-20T00:00:00.000Z'),
    lastTestStatus: 'ok',
    authFailedAt: null,
    authFailureReason: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    _count: { executions: 3 },
};

async function connectionsFrom(rows: unknown[]): Promise<Record<string, unknown>[]> {
    getTenantCtxMock.mockResolvedValueOnce(adminCtx());
    listIntegrationConnectionsMock.mockResolvedValueOnce(rows);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(request(), routeArgs as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: Record<string, unknown>[] };
    return body.connections;
}

describe('GET …/admin/integrations — the connection payload is an allowlist', () => {
    it('serves the fields the admin UI consumes — the positive control', async () => {
        // Without this, every absence assertion below could equally mean the
        // projection dropped everything, or that the handler returned no rows.
        const [c] = await connectionsFrom([ROW]);
        expect(c.id).toBe('conn-1');
        expect(c.provider).toBe('active-directory');
        expect(c.name).toBe('Corp AD');
        expect(c.isEnabled).toBe(true);
        expect(c.configJson).toEqual({ url: 'ldaps://dc.corp.example.com:636', baseDN: 'DC=corp' });
        expect(c.lastTestStatus).toBe('ok');
        expect(c._count).toEqual({ executions: 3 });
        expect(c.secretStatus).toBe('••••••••');
        expect(String(c.webhookUrl)).toContain('/api/integrations/webhooks/active-directory');
    });

    it('drops a column the read grew that nobody meant to publish', async () => {
        // THE FAILURE THIS FILE EXISTS FOR, written as the hazard arrives: a
        // field appears on the row because someone widened the usecase's
        // `select`. The old `...c` spread published it; the projection does
        // not. `secretEncrypted` is the worst case and `syncCursor` the
        // likeliest, so both are exercised.
        const [c] = await connectionsFrom([
            { ...ROW, secretEncrypted: 'v2:ciphertext', syncCursor: 'opaque-cursor', tenantId: 'tenant-A' },
        ]);
        expect(c).not.toHaveProperty('secretEncrypted');
        expect(c).not.toHaveProperty('syncCursor');
        expect(c).not.toHaveProperty('tenantId');
        // And the row is still served — the projection drops the extra field,
        // it does not drop the connection.
        expect(c.id).toBe('conn-1');
    });

    it('serializes no secret-looking value anywhere in the response', async () => {
        getTenantCtxMock.mockResolvedValueOnce(adminCtx());
        listIntegrationConnectionsMock.mockResolvedValueOnce([
            { ...ROW, secretEncrypted: 'v2:UNIQUE-CIPHERTEXT-MARKER' },
        ]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET(request(), routeArgs as any);
        // Read over the WHOLE body rather than the connection object, because
        // a future echo of the row into a sibling key (a debug block, a
        // summary) would satisfy a per-field check and still ship the
        // ciphertext.
        expect(await res.text()).not.toContain('UNIQUE-CIPHERTEXT-MARKER');
    });

    it('omits a projected field the row does not carry, rather than emitting undefined', async () => {
        const { authFailureReason: _dropped, ...withoutOne } = ROW;
        const [c] = await connectionsFrom([withoutOne]);
        expect(c).not.toHaveProperty('authFailureReason');
        expect(c.authFailedAt).toBeNull();
    });
});
