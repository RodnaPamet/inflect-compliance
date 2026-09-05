/**
 * Editing a policy card is a PRIVILEGED act — the gate, the audit row, and the
 * chain.
 *
 * A card is the machine-readable statement of how far an autonomous agent may
 * reach. Whoever can edit one can raise an agent's autonomy rung, widen its data
 * ceiling, add tools and lift its action budgets. So three properties, and each
 * is a different mechanism that can break on its own:
 *
 *   1. THE GATE IS AT THE ROUTE, AND IT IS ITS OWN KEY. `admin.agent_policy_card`
 *      — not `admin.agent_tool_exposure`, which is the one an operator holds for
 *      routine "let it read tasks too" work. The negative that matters is a
 *      principal holding the NEIGHBOURING key being refused: that is the
 *      composition the separate key exists to prevent, and it is invisible to a
 *      test that only compares OWNER against READER.
 *
 *   2. THE DENIAL AUDITS, EXACTLY ONCE. `requirePermission` writes a
 *      hash-chained `AUTHZ_DENIED` row; a usecase `assertCanWrite` throw writes
 *      nothing. That difference is the whole reason the gate is at the route
 *      (Epic D.3), and "exactly once" is the half that a `>= 1` assertion would
 *      miss — a second gate added one layer down would double every denial and
 *      make the trail count refusals rather than attempts.
 *
 *   3. THE CHAIN STILL VERIFIES. A row appended under a rejected request is
 *      still a row in the tenant's hash chain. If a denial wrote a row that did
 *      not link, every later entry in that tenant would be unverifiable — the
 *      audit trail broken by the control meant to protect it.
 *
 * Driven through the REAL route handlers. Only `getTenantCtx` is mocked, because
 * it is the one thing in the path that needs a browser session; everything
 * below it — `requirePermission`, `assertPermission`, `appendAuditEntry`, the
 * usecase, RLS — is real, against the real database.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { GET, POST, PUT } from '@/app/api/t/[tenantSlug]/admin/agents/[agentId]/policy-card/route';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { verifyAuditChain } from '@/lib/audit';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { makeRequestContext } from '../helpers/make-context';
import type { RequestContext } from '@/app-layer/types';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `pcauth-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;
const PATH = `/api/t/${TENANT}/admin/agents/AGENT/policy-card`;

let agentId = '';

const ALL_TRIGGERS = [
    'TOOL_NOT_PERMITTED',
    'DATA_SCOPE_EXCEEDED',
    'AUTONOMY_EXCEEDED',
    'RUN_ACTION_CAP_EXCEEDED',
    'DAILY_ACTION_CAP_EXCEEDED',
] as const;

function ownerCtx(): RequestContext {
    return makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });
}

/**
 * An ADMIN whose custom role holds the NEIGHBOURING agent keys but not this one.
 *
 * This is the principal the separate key exists for: somebody trusted to widen
 * an approved agent's tool list and to manage the register, who must NOT thereby
 * be able to raise that agent's autonomy ceiling or its action budgets. A test
 * that only refused a READER would pass on a route gated by `admin.manage`.
 */
function neighbourKeyCtx(): RequestContext {
    const base = getPermissionsForRole('ADMIN');
    return makeRequestContext('ADMIN', {
        tenantId: TENANT,
        tenantSlug: TENANT,
        userId: USER,
        appPermissions: {
            ...base,
            admin: {
                ...base.admin,
                agent_registry: true,
                agent_tool_exposure: true,
                agent_policy_card: false,
            },
        },
    });
}

function req(method: string, body?: unknown): NextRequest {
    return new NextRequest(`http://localhost${PATH}`, {
        method,
        headers: new Headers({ 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

const routeArgs = () => ({ params: Promise.resolve({ tenantSlug: TENANT, agentId }) });

/** A card body that NARROWS — so nothing here is refused by the ladder. */
const narrowingEdit = (expectedVersion: number) => ({
    expectedVersion,
    card: {
        permittedTools: [],
        maxDataScope: 'NONE' as const,
        maxAutonomyLevel: 0,
        maxActionsPerRun: 0,
        maxActionsPerDay: 0,
        escalationTriggers: [...ALL_TRIGGERS],
        approvalRung: 'SECOND_APPROVER' as const,
    },
});

async function countDenials(): Promise<number> {
    return prisma.auditLog.count({
        where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
    });
}

describeFn('editing a policy card is privileged (real route, real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        const email = `${TENANT}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: USER } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });
        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: TENANT, name: `Host ${SUITE}`, ownerUserId: USER },
        });
        const agent = await createRegisteredAgent(ownerCtx(), {
            aiSystemId: aiSystem.id,
            name: `Gated agent ${SUITE}`,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: USER,
        });
        agentId = agent.id;
        await prisma.registeredAgent.update({
            where: { id: agentId },
            data: { riskTier: 'MODERATE', riskTierScoredAt: new Date() },
        });
    });

    afterAll(async () => {
        if (TENANT) {
            await prisma.agentPolicyCardVersion.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.agentPolicyCard.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
                await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
            }).catch(() => {});
            await prisma.tenant.deleteMany({ where: { id: TENANT } }).catch(() => {});
            await prisma.user.deleteMany({ where: { id: USER } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    it('the declarative map resolves this path to its own key', () => {
        // The runtime middleware and the map are two mechanisms — the SDK and
        // the docs read the map — so they are asserted separately. And the key
        // must not be either neighbour: first-wins matching means a rule
        // ordered below the `admin/agents(/.*)?` catch-all would silently
        // resolve to `admin.agent_registry`.
        for (const method of ['GET', 'POST', 'PUT'] as const) {
            expect(resolveRoutePermission(PATH, method)?.permission).toBe(
                'admin.agent_policy_card',
            );
        }
        // The neighbour's path still resolves to the neighbour's key — so the
        // assertion above is about ORDERING, not about a rule that happens to
        // match everything under `admin/agents`.
        expect(
            resolveRoutePermission(`/api/t/${TENANT}/admin/agents/${agentId}/tools`, 'POST')
                ?.permission,
        ).toBe('admin.agent_tool_exposure');
    });

    it('a principal holding admin.agent_policy_card CAN create and edit', async () => {
        // The paired positive. Without it every refusal below is equally
        // consistent with a route that refuses everybody.
        getTenantCtxMock.mockResolvedValue(ownerCtx());

        const created = await POST(req('POST'), routeArgs());
        expect(created.status).toBe(201);
        const createdBody = (await created.json()) as { version: number };
        expect(createdBody.version).toBe(1);

        const edited = await PUT(req('PUT', narrowingEdit(1)), routeArgs());
        expect(edited.status).toBe(200);
        expect(((await edited.json()) as { version: number }).version).toBe(2);
    });

    it('a principal holding only the NEIGHBOURING agent keys is refused, and told nothing', async () => {
        getTenantCtxMock.mockResolvedValue(neighbourKeyCtx());
        const before = await countDenials();

        const res = await PUT(req('PUT', narrowingEdit(2)), routeArgs());
        expect(res.status).toBe(403);

        // The 403 body never echoes the key — otherwise the permission
        // namespace is enumerable one request at a time.
        const body = JSON.stringify(await res.json());
        expect(body).not.toContain('agent_policy_card');
        expect(body).not.toContain('admin.');

        // EXACTLY one row, not "at least one". A second gate added a layer down
        // would double every denial, and a trail that counts refusals rather
        // than attempts is a trail nobody can reconcile against a request log.
        expect(await countDenials()).toBe(before + 1);

        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
            orderBy: { createdAt: 'desc' },
        });
        expect(row.entity).toBe('Permission');
        // The row names the key even though the response does not: the point of
        // the split is that the operator can see what was refused and the
        // caller cannot.
        expect(row.entityId).toBe('admin.agent_policy_card');
        expect(row.entryHash).not.toBeNull();

        // …and the write did not happen. A route that audited the denial and
        // then ran the handler anyway would pass every assertion above.
        const head = await prisma.agentPolicyCard.findFirstOrThrow({
            where: { tenantId: TENANT, agentId },
        });
        expect(head.currentVersion).toBe(2);
    });

    it('the same key gates READING the card, and CREATING one', async () => {
        getTenantCtxMock.mockResolvedValue(neighbourKeyCtx());
        const before = await countDenials();

        expect((await GET(req('GET'), routeArgs())).status).toBe(403);
        expect((await POST(req('POST'), routeArgs())).status).toBe(403);

        // One row EACH — two calls, two rows, neither silent. With the PUT in
        // the test above that is all three verbs gated and all three audited.
        // The read is gated deliberately rather than left on the register's
        // key: a card is a readable statement of exactly how much authority an
        // agent holds, and publishing that to anyone who can list agents
        // publishes the narrowing too.
        expect(await countDenials()).toBe(before + 2);
    });

    it('the hash chain still verifies with the denial rows in it', async () => {
        // A denial row is appended to the SAME chain as every ordinary entry.
        // If it did not link, every later entry for this tenant would be
        // unverifiable — the audit trail broken by the control that protects it.
        const result = await verifyAuditChain(TENANT, prisma);
        expect(result.valid).toBe(true);
        expect(result.unhashedEntries).toBe(0);
        // The chain contains BOTH kinds of row: the denials above and the
        // card's own create/update entries. Verifying a chain of one kind
        // proves less than verifying a mixed one.
        expect(result.hashedEntries).toBeGreaterThanOrEqual(5);
        expect(
            await prisma.auditLog.count({
                where: { tenantId: TENANT, action: 'AGENT_POLICY_CARD_UPDATED' },
            }),
        ).toBe(1);
    });
});
