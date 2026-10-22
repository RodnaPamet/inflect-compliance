/**
 * THE CREDENTIAL SEAM, END TO END (#3867).
 *
 * A stored secret, created the way the product creates it, decrypted the way the
 * runtime decrypts it, resolved into an `Authorization` header, and carried to a
 * real MCP server by the real tool client.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS WHEN EVERY PART OF IT IS ALREADY COVERED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three suites each prove a segment, and each substitutes its neighbours:
 *
 *   agent-credential-hygiene.test.ts  inserts `secretEncrypted` DIRECTLY via
 *                                     Prisma — the creation path never runs
 *   mcp-connection-token (unit)       exercises `resolveMcpCredentials` against
 *                                     MOCKS — no stored row is ever read
 *   deploy/sap-stub/verify-egress     drives the real egress path with NO
 *                                     credential at all
 *
 * So the chain passes everywhere and has never been run whole. This is the join:
 * the seams between those three, which is where a credential that encrypts but
 * does not decrypt, or resolves but never reaches the header, would live.
 *
 * The transport is the stub's OWN handler rather than a fake resembling it — the
 * same `createStubHandler` the bound server runs — reached through the
 * established `safeFetch` mock that `tests/unit/mcp-client-transport.test.ts`
 * uses. Nothing here passes `fetchImpl`.
 */
import { randomUUID } from 'node:crypto';

const safeFetchMock = jest.fn();
// PARTIAL mocks of this module break things far away: it also exports
// `checkWebhookUrl`, `assertPublicAddress` and `isPrivateAddress`, and a
// factory listing only `safeFetch` hands `undefined` to every other importer —
// which surfaced here as `prisma.$queryRawUnsafe is undefined` inside
// `resetDatabase`, nowhere near the mock. Spread the real module and override
// the one function.
jest.mock('@/app-layer/automation/webhook-safety', () => ({
    ...jest.requireActual('@/app-layer/automation/webhook-safety'),
    safeFetch: (...a: unknown[]) => safeFetchMock(...a),
}));

import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createStubHandler } from '../../packages/sap-mcp-stub/src/handler';
import { decryptField } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { upsertIntegrationConnection } from '@/app-layer/usecases/integrations';
import { authorizationFor } from '@/app-layer/integrations/mcp/token';
import { callTool, listTools } from '@/app-layer/integrations/mcp/client';
import type { RequestContext } from '@/app-layer/types';

const prisma = prismaTestClient();
// Run-unique, and NO `resetDatabase`. This suite needs its own rows, not a
// clean database — truncating every table is both heavier than the test
// requires and rude on a shared instance, and it is what produced a transient
// `57P01: terminating connection due to administrator command` here. Unique
// ids mean leftovers from a killed run cannot collide either.
const SUITE = `cred-seam-${randomUUID().slice(0, 8)}`;
const TENANT = `${SUITE}-tenant`;
const USER = `${SUITE}-user`;
const URL_ = 'https://sap-stub.example.test/mcp';

/** The static-header grant: `secrets.authorization` reaches the wire verbatim. */
const SECRET = 'Bearer stub-token-do-not-leak-9f3a'; // pragma: allowlist secret — a fixture; the point is that it travels

const ctx = (): RequestContext =>
    ({
        requestId: randomUUID(),
        userId: USER,
        tenantId: TENANT,
        role: 'OWNER',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true },
        appPermissions: {},
    }) as unknown as RequestContext;

/** Headers the server actually received, so "it was sent" is observed. */
let received: Record<string, string>;

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, email: `${USER}@example.test`, name: USER } });
    await createTenantWithDek({ id: TENANT, name: TENANT, slug: TENANT });
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
    });
});

afterAll(async () => {
    await deleteAuditRowsForTenants(prisma, [TENANT]);
    await prisma.tenantMembership.deleteMany({ where: { tenantId: TENANT } });
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

beforeEach(() => {
    jest.clearAllMocks();
    received = {};
    const handler = createStubHandler();
    safeFetchMock.mockImplementation((url: string, init?: { body?: unknown; headers?: unknown }) => {
        const h = (init?.headers ?? {}) as Record<string, string>;
        received = { ...(h instanceof Headers ? Object.fromEntries(h) : h) };
        return handler(url, init);
    });
});

describe('a credential travels from the connection row to the wire', () => {
    it('stores the secret as ciphertext, never as the value', async () => {
        const conn = await upsertIntegrationConnection(ctx(), {
            provider: 'mcp-server',
            name: 'sap stub',
            configJson: { url: URL_ },
            secrets: { authorization: SECRET },
        });

        const row = await prisma.integrationConnection.findUniqueOrThrow({
            where: { id: conn.id },
        });

        // The POSITIVE half matters as much as the negative: a column that is
        // simply empty would also "not contain the secret".
        expect(row.secretEncrypted).toBeTruthy();
        expect(row.secretEncrypted).not.toContain(SECRET);
        expect(row.secretEncrypted).not.toContain('stub-token');
        expect(JSON.parse(decryptField(row.secretEncrypted!))).toEqual({ authorization: SECRET });
    });

    it('resolves the stored secret into the Authorization header the client sends', async () => {
        const conn = await upsertIntegrationConnection(ctx(), {
            provider: 'mcp-server',
            name: 'sap stub 2',
            configJson: { url: URL_ },
            secrets: { authorization: SECRET },
        });
        const row = await prisma.integrationConnection.findUniqueOrThrow({
            where: { id: conn.id },
        });

        // The two lines the runtime runs, not a hand-rolled decrypt.
        const secrets = JSON.parse(decryptField(row.secretEncrypted!)) as Record<string, unknown>;
        const config = (row.configJson ?? {}) as Record<string, unknown>;

        const authorization = await authorizationFor(row.id, config, secrets);
        expect(authorization).toBe(SECRET);

        const tools = await listTools({ url: URL_, authorization });
        expect(tools.map((t) => t.name)).toContain('sales_orders_by_creator');

        // THE SEAM, OBSERVED AT THE FAR END. Everything above could hold while
        // the header was dropped between the client and the socket, and the
        // call would still succeed because the stub does not authenticate.
        expect(received.Authorization ?? received.authorization).toBe(SECRET);
    });

    it('carries it on a tools/call too, not only the handshake', async () => {
        const conn = await upsertIntegrationConnection(ctx(), {
            provider: 'mcp-server',
            name: 'sap stub 3',
            configJson: { url: URL_ },
            secrets: { authorization: SECRET },
        });
        const row = await prisma.integrationConnection.findUniqueOrThrow({
            where: { id: conn.id },
        });
        const secrets = JSON.parse(decryptField(row.secretEncrypted!)) as Record<string, unknown>;
        const authorization = await authorizationFor(row.id, (row.configJson ?? {}) as Record<string, unknown>, secrets);

        const out = await callTool({ url: URL_, authorization }, 'sales_orders_by_creator', {
            sap_username: 'MMUELLER',
            sold_to_party: '0000100201',
            date_from: '2026-06-17',
            date_to: '2026-06-17',
        });
        const payload = JSON.parse(out.content[0]?.text ?? '{}') as { count?: number };

        expect(payload.count).toBe(2);
        expect(received.Authorization ?? received.authorization).toBe(SECRET);
    });

    it('sends NO Authorization when the connection holds no secret', async () => {
        // The discriminating control. Without it, the three assertions above
        // would pass against a client that always sent this header from
        // somewhere else entirely.
        const conn = await upsertIntegrationConnection(ctx(), {
            provider: 'mcp-server',
            name: 'sap stub bare',
            configJson: { url: URL_ },
        });
        const row = await prisma.integrationConnection.findUniqueOrThrow({
            where: { id: conn.id },
        });
        const secrets = row.secretEncrypted
            ? (JSON.parse(decryptField(row.secretEncrypted)) as Record<string, unknown>)
            : {};

        const authorization = await authorizationFor(row.id, (row.configJson ?? {}) as Record<string, unknown>, secrets);
        expect(authorization).toBeUndefined();

        await listTools({ url: URL_, authorization });
        expect(received.Authorization ?? received.authorization).toBeUndefined();
    });
});
