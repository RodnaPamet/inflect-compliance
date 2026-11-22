/**
 * The `anthropic-workspace` connection against a real database (Step 5a of
 * docs/claude-managed-agents-design.md), through the real usecases.
 *
 *   - The key is stored through the connection-secret encryption path: a RAW
 *     read of the row returns ciphertext, and neither column holds the key.
 *   - A configuration naming any host but api.anthropic.com is refused at save,
 *     on a create and on an update.
 *   - Test writes no row and never marks the connection failed, even when the
 *     key is refused: no execution, no audit row, `authFailedAt` stays null, and
 *     the only request is one GET.
 *   - Two tenants: tenant B cannot read, test or change tenant A's connection,
 *     and A's key is never sent on B's behalf.
 *
 * The network is a faux transport (`safeFetch` mocked to answer as the
 * Anthropic API would). Prisma is NOT mocked.
 */
const mockSafeFetch = jest.fn<Promise<Response>, [string, RequestInit | undefined]>();
jest.mock('@/app-layer/automation/webhook-safety', () => ({
    ...jest.requireActual('@/app-layer/automation/webhook-safety'),
    safeFetch: (url: string, init?: RequestInit) => mockSafeFetch(url, init),
}));

import { randomUUID } from 'node:crypto';

import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { decryptField } from '@/lib/security/encryption';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';
import {
    listIntegrationConnections,
    testConnectionCredentials,
    upsertIntegrationConnection,
} from '@/app-layer/usecases/integrations';
import type { RequestContext } from '@/app-layer/types';

const prisma = prismaTestClient();
const SUITE = `anthws-${randomUUID().slice(0, 8)}`;
const TENANT_A = `${SUITE}-a`;
const TENANT_B = `${SUITE}-b`;
const USER_A = `${SUITE}-ua`;
const USER_B = `${SUITE}-ub`;
const WS = 'wrkspc_01IntegrationFixture';
const KEY = 'sk-ant-integration-fixture'; // pragma: allowlist secret — a fixture, too short to be a real key
const PROVIDER = 'anthropic-workspace';

const ctxFor = (tenantId: string, userId: string): RequestContext =>
    ({
        requestId: randomUUID(),
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true },
        appPermissions: {},
    }) as unknown as RequestContext;
const ctxA = () => ctxFor(TENANT_A, USER_A);
const ctxB = () => ctxFor(TENANT_B, USER_B);

const agentsPage = () =>
    new Response(JSON.stringify({ data: [], next_page: null }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'anthropic-workspace-id': WS },
    });
const keyRefused = () =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
    });

let connectionId: string;

beforeAll(async () => {
    for (const [tenant, user] of [
        [TENANT_A, USER_A],
        [TENANT_B, USER_B],
    ] as const) {
        await prisma.user.create({ data: { id: user, email: `${user}@example.test`, name: user } });
        const { wrapped } = generateAndWrapDek();
        await prisma.tenant.create({ data: { id: tenant, name: tenant, slug: tenant, encryptedDek: wrapped } });
        // ADMIN, not OWNER: the last-OWNER trigger refuses the teardown delete.
        await prisma.tenantMembership.create({ data: { tenantId: tenant, userId: user, role: 'ADMIN', status: 'ACTIVE' } });
    }
    const created = await upsertIntegrationConnection(ctxA(), {
        provider: PROVIDER,
        name: 'Anthropic workspace',
        configJson: { workspaceId: WS, keepSessions: false },
        secrets: { apiKey: KEY },
    });
    connectionId = created.id;
});

afterAll(async () => {
    await deleteAuditRowsForTenants(prisma, [TENANT_A, TENANT_B]);
    await prisma.integrationConnection.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
});

beforeEach(() => mockSafeFetch.mockReset());

describe('the key is stored encrypted', () => {
    it('a raw read of the row returns ciphertext, and no column holds the key', async () => {
        const rows = await prisma.$queryRaw<Array<{ secretEncrypted: string | null; configJson: unknown }>>`
            SELECT "secretEncrypted", "configJson" FROM "IntegrationConnection" WHERE id = ${connectionId}`;
        expect(rows).toHaveLength(1);
        const raw = rows[0].secretEncrypted ?? '';
        expect(raw).toMatch(/^v[12]:/);
        expect(raw).not.toContain(KEY);
        expect(JSON.stringify(rows[0].configJson)).not.toContain(KEY);
        expect(rows[0].configJson).toEqual({ workspaceId: WS, keepSessions: false });
        // …and it is the key, once decrypted through the connection-secret path.
        expect(JSON.parse(decryptField(raw))).toEqual({ apiKey: KEY });
    });
});

describe('the host cannot be changed by configuration', () => {
    it('a create naming another host is refused at save', async () => {
        await expect(
            upsertIntegrationConnection(ctxA(), {
                provider: PROVIDER,
                name: 'elsewhere',
                configJson: { workspaceId: WS, apiHost: 'evil.example.com' },
                secrets: { apiKey: KEY },
            }),
        ).rejects.toThrow(/Refusing to send Anthropic credentials to "evil\.example\.com"/);
    });

    it('an update naming another host is refused, and the stored row is unchanged', async () => {
        const before = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        await expect(
            upsertIntegrationConnection(ctxA(), {
                id: connectionId,
                provider: PROVIDER,
                configJson: { workspaceId: WS, apiHost: 'api.anthropic.com.evil.tld' },
            }),
        ).rejects.toThrow(/not a recognised Anthropic host/);
        const after = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        expect(after.configJson).toEqual(before.configJson);
        expect(after.secretEncrypted).toBe(before.secretEncrypted);
    });

    it('a Test pointing the STORED key at another host is refused, and sends nothing', async () => {
        // `apiHost` is an origin field, so the redirect check refuses before
        // the provider is even asked.
        await expect(
            testConnectionCredentials(ctxA(), {
                connectionId,
                provider: PROVIDER,
                configJson: { workspaceId: WS, apiHost: 'evil.example.com' },
            }),
        ).rejects.toThrow(/points this connection at a different host/);
        expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('a Test that re-enters a key WITH another host is refused by the provider, and sends nothing', async () => {
        const r = await testConnectionCredentials(ctxA(), {
            connectionId,
            provider: PROVIDER,
            configJson: { workspaceId: WS, apiHost: 'evil.example.com' },
            secrets: { apiKey: KEY },
        });
        expect(r.valid).toBe(false);
        expect(mockSafeFetch).not.toHaveBeenCalled();
    });
});

/**
 * "Writes no row": the Test creates no row — no execution, no connection, no
 * audit entry of its own — and changes nothing on the connection except the
 * operator's own record of pressing Test (`lastTestedAt` / `lastTestStatus`,
 * which the shared Test usecase keeps for every provider and the card's badge
 * reads). The database's audit extension journals that one `updateMany`, so
 * the only audit row a Test leaves is that UPDATEMANY of IntegrationConnection.
 *
 * "Never marks the connection failed": `authFailedAt` / `authFailureReason`,
 * the credential-health flag the freshness surface and background jobs read,
 * stay null even when Anthropic refuses the key.
 */
describe('Test writes no row and never marks the connection failed', () => {
    const counts = async () => ({
        executions: await prisma.integrationExecution.count({ where: { tenantId: TENANT_A } }),
        connections: await prisma.integrationConnection.count({ where: { tenantId: TENANT_A } }),
        auditOtherThanTheTestStatus: await prisma.auditLog.count({
            where: { tenantId: TENANT_A, NOT: { entity: 'IntegrationConnection', action: 'UPDATEMANY' } },
        }),
    });

    it('a refused key: invalid, no execution or connection row and no audit entry beyond the test-status update, authFailedAt stays null, one GET', async () => {
        mockSafeFetch.mockResolvedValue(keyRefused());
        const before = await counts();

        const r = await testConnectionCredentials(ctxA(), { connectionId, provider: PROVIDER });

        expect(r.valid).toBe(false);
        expect(await counts()).toEqual(before);
        const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        expect(row.authFailedAt).toBeNull();
        expect(row.authFailureReason).toBeNull();
        expect(mockSafeFetch).toHaveBeenCalledTimes(1);
        expect(mockSafeFetch.mock.calls[0][1]?.method).toBe('GET');
    });

    it('a working key: valid, with the stored key, and still no new row of its own', async () => {
        mockSafeFetch.mockResolvedValue(agentsPage());
        const before = await counts();

        const r = await testConnectionCredentials(ctxA(), { connectionId, provider: PROVIDER });

        expect(r).toEqual({ valid: true });
        expect(await counts()).toEqual(before);
        expect((mockSafeFetch.mock.calls[0][1]?.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    });
});

describe('two tenants: B cannot reach A\'s connection', () => {
    it('B does not see it in its list', async () => {
        const listB = await listIntegrationConnections(ctxB());
        expect(listB.map((c) => c.id)).not.toContain(connectionId);
        const listA = await listIntegrationConnections(ctxA());
        expect(listA.map((c) => c.id)).toContain(connectionId);
    });

    it('B cannot test it, and A\'s key is never sent', async () => {
        mockSafeFetch.mockResolvedValue(agentsPage());
        await expect(testConnectionCredentials(ctxB(), { connectionId, provider: PROVIDER })).rejects.toThrow(
            /Connection not found/,
        );
        expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('B cannot change it: keep sessions stays as A set it', async () => {
        await expect(
            upsertIntegrationConnection(ctxB(), {
                id: connectionId,
                provider: PROVIDER,
                configJson: { workspaceId: WS, keepSessions: true },
            }),
        ).rejects.toThrow(/Connection not found/);
        const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        expect(row.configJson).toEqual({ workspaceId: WS, keepSessions: false });
        expect(row.tenantId).toBe(TENANT_A);
    });
});
