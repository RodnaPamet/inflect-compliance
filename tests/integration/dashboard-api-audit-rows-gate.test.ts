/**
 * `GET /api/t/:slug/dashboard` and the agent tool `get_tenant_context` return
 * the audit log's ten latest rows only to a caller that can read the audit log
 * (owner decision, 2026-10-30). Real database, real routes, real API keys.
 *
 *   1. THE USECASE, per built-in role. Owner, Admin and Auditor get the rows;
 *      Reader, Editor and AI admin get `recentActivity: []` and the same counts.
 *   2. THE REST DOOR, per key shape. A key's role comes from its scopes, so
 *      only `*` and `admin:write` resolve to ADMIN and read the rows. Each key
 *      is also sent to `GET /audit-log`: the dashboard returns rows exactly
 *      when that route answers 200, which is the claim "the same gate", tested
 *      rather than restated.
 *   3. THE AGENT DOOR. `/api/mcp` intersects every key with its creator, so an
 *      ADMIN-scoped key reads the rows only when its creator is an Owner, Admin
 *      or Auditor, and the usual agent key (`mcp:read` + read scopes) never does.
 *
 * Every refused case also asserts the counts are still there: the decision
 * withholds the rows, it does not refuse the dashboard.
 */
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { appendAuditEntry } from '@/lib/audit';
import { getDashboardData } from '@/app-layer/usecases/dashboard';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `dbaudit-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const MARKER = `marker-${SUITE}`;
const RISK_COUNT = 2;

const USERS = {
    owner: `u-owner-${SUITE}`,
    auditor: `u-auditor-${SUITE}`,
    reader: `u-reader-${SUITE}`,
} as const;

interface DashboardBody {
    stats?: { risks?: number; controls?: number };
    recentActivity?: Array<{ entityId: string }>;
}

async function mintKey(createdById: string, scopes: string[]): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: {
            tenantId: TENANT,
            name: `${scopes.join('+')}-${randomUUID().slice(0, 6)}`,
            keyPrefix,
            keyHash,
            scopes,
            createdById,
        },
    });
    return plaintext;
}

function get(path: string, token: string): NextRequest {
    return new NextRequest(`http://localhost/api/t/${TENANT}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
    });
}

async function restDashboard(token: string): Promise<{ status: number; body: DashboardBody }> {
    const { GET } = await import('@/app/api/t/[tenantSlug]/dashboard/route');
    const res = await GET(get('/dashboard', token), { params: Promise.resolve({ tenantSlug: TENANT }) });
    return { status: res.status, body: (await res.json()) as DashboardBody };
}

async function restAuditLogStatus(token: string): Promise<number> {
    const { GET } = await import('@/app/api/t/[tenantSlug]/audit-log/route');
    const res = await GET(get('/audit-log', token), { params: Promise.resolve({ tenantSlug: TENANT }) });
    return res.status;
}

async function mcpTenantContext(token: string): Promise<{ body: DashboardBody | undefined; error?: string }> {
    const { POST } = await import('@/app/api/mcp/route');
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'get_tenant_context', arguments: {} },
        }),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    const json = (await res.json()) as {
        result?: { content?: Array<{ text: string }> };
        error?: { message?: string };
    };
    const text = json.result?.content?.[0]?.text;
    return { body: text === undefined ? undefined : (JSON.parse(text) as DashboardBody), error: json.error?.message };
}

/** The seeded audit row is in the feed. */
function hasMarker(body: DashboardBody | undefined): boolean {
    return (body?.recentActivity ?? []).some((r) => r.entityId === MARKER);
}

describeFn('the dashboard API returns audit-log rows only to audit-log readers', () => {
    beforeAll(async () => {
        await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        // The fixture opts out of the agent register: the keys here are plain
        // integration keys, and the property under test is the audit-log gate,
        // not registration (proved in agent-registry-enforcement.test.ts).
        await prisma.tenantSecuritySettings.create({
            data: { tenantId: TENANT, requireRegisteredAgent: false },
        });
        for (const [id, role] of [
            [USERS.owner, Role.OWNER],
            [USERS.auditor, Role.AUDITOR],
            [USERS.reader, Role.READER],
        ] as const) {
            const email = `${id}@example.test`;
            await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
            await prisma.tenantMembership.create({
                data: { tenantId: TENANT, userId: id, role, status: 'ACTIVE' },
            });
        }
        for (let i = 0; i < RISK_COUNT; i++) {
            await prisma.risk.create({
                data: { tenantId: TENANT, title: `${SUITE}-risk-${i}`, score: 4, inherentScore: 4, status: 'OPEN' },
            });
        }
        // Through the real hash-chained writer: a hand-made row would break
        // this tenant's chain.
        await appendAuditEntry({
            tenantId: TENANT,
            userId: USERS.owner,
            entity: 'Membership',
            entityId: MARKER,
            action: 'MEMBER_INVITED',
            detailsJson: { category: 'access' },
        });
    });

    afterAll(async () => {
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
        await prisma.risk.deleteMany({ where: { tenantId: TENANT } });
        await deleteAuditRowsForTenants(prisma, TENANT);
        // The last-OWNER trigger refuses an ordinary delete of the membership.
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
        await prisma.user.deleteMany({ where: { id: { in: Object.values(USERS) } } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    describe('the usecase, per built-in role', () => {
        const ctxFor = (role: Role) =>
            makeRequestContext(role, { userId: USERS.owner, tenantId: TENANT, tenantSlug: TENANT });

        it.each([Role.OWNER, Role.ADMIN, Role.AUDITOR])('%s gets the rows', async (role) => {
            const data = await getDashboardData(ctxFor(role));
            expect(hasMarker(data as DashboardBody)).toBe(true);
            expect(data.stats.risks).toBe(RISK_COUNT);
        });

        it.each([Role.READER, Role.EDITOR, Role.AI_ADMIN])(
            '%s gets an empty feed and the same counts',
            async (role) => {
                const data = await getDashboardData(ctxFor(role));
                // Present and empty, not absent: the shape existing clients read.
                expect(data.recentActivity).toEqual([]);
                expect(data.stats.risks).toBe(RISK_COUNT);
            },
        );
    });

    describe('the REST door, per key shape', () => {
        // [scopes, reads the audit log]. Created by the OWNER: at `/api/t/**`
        // a key bound to no agent is not narrowed by its creator, which is the
        // rule `GET /audit-log` follows too, and the last column checks it.
        const CASES: ReadonlyArray<[string[], boolean]> = [
            [['controls:read'], false],
            [['controls:read', 'risks:write'], false],
            [['admin:*'], false],
            [['admin:write'], true],
            [['*'], true],
        ];

        it.each(CASES)('a key scoped %j reads the rows: %s', async (scopes, readsAuditLog) => {
            const key = await mintKey(USERS.owner, scopes);
            const { status, body } = await restDashboard(key);
            expect(status).toBe(200);
            expect(body.stats?.risks).toBe(RISK_COUNT);
            if (readsAuditLog) {
                expect(hasMarker(body)).toBe(true);
            } else {
                expect(body.recentActivity).toEqual([]);
            }
            // Same gate as the audit log itself, measured on the same key.
            expect(await restAuditLogStatus(key)).toBe(readsAuditLog ? 200 : 403);
        });
    });

    describe('the agent door, get_tenant_context', () => {
        // `risks:read` so the risk count survives the tool's per-domain
        // redaction and can stand for "the rest of the payload".
        const AGENT_READ = ['mcp:read', 'controls:read', 'risks:read'];
        const AGENT_READ_ADMIN = [...AGENT_READ, 'admin:write'];

        it('the usual agent key gets the counts and no rows', async () => {
            const { body, error } = await mcpTenantContext(await mintKey(USERS.owner, AGENT_READ));
            expect(error).toBeUndefined();
            expect(body?.stats?.risks).toBe(RISK_COUNT);
            expect(body?.recentActivity).toEqual([]);
        });

        it('an ADMIN-scoped key whose creator is an Owner gets the rows', async () => {
            const { body, error } = await mcpTenantContext(await mintKey(USERS.owner, AGENT_READ_ADMIN));
            expect(error).toBeUndefined();
            expect(hasMarker(body)).toBe(true);
        });

        it('an ADMIN-scoped key whose creator is an Auditor gets the rows', async () => {
            const { body, error } = await mcpTenantContext(await mintKey(USERS.auditor, AGENT_READ_ADMIN));
            expect(error).toBeUndefined();
            expect(hasMarker(body)).toBe(true);
        });

        it('the same key shape created by a Reader gets no rows: the creator narrows it', async () => {
            const { body, error } = await mcpTenantContext(await mintKey(USERS.reader, AGENT_READ_ADMIN));
            expect(error).toBeUndefined();
            expect(body?.stats?.risks).toBe(RISK_COUNT);
            expect(body?.recentActivity).toEqual([]);
        });
    });
});
