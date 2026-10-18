/**
 * The agent ownership transfer's two routes are gated on
 * `admin.tenant_lifecycle` — at the ROUTE, literally, and audited (#3698).
 *
 * Step 0e puts both steps of `transferAgentOwnership` under tenant lifecycle,
 * NOT under `admin.agent_registry`. The negative that matters is therefore a
 * principal holding the REGISTER key being refused: a built-in ADMIN holds
 * `agent_registry` (it can register, amend, suspend and retire agents) and does
 * not hold `tenant_lifecycle`. A route gated on the register key, or a rule
 * ordered below the `admin/agents(/.*)?` catch-all, lets that ADMIN move an
 * agent's accountable owner — the composition 0e rejects.
 *
 * Each denial must write EXACTLY ONE hash-chained `AUTHZ_DENIED` row:
 * `requirePermission` writes one, a usecase `assertCan*` writes none, and a
 * second gate added a layer down would write two.
 *
 * Driven through the REAL route handlers. Only `getTenantCtx` is mocked — the one
 * thing in the path that needs a browser session; `requirePermission`, the audit
 * writer, the usecases and RLS are all real, against the real database.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { PrismaClient, Role } from '@prisma/client';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { verifyAuditChain } from '@/lib/audit';
import {
    DELETE,
    GET,
    POST,
} from '@/app/api/t/[tenantSlug]/admin/agents/[agentId]/ownership-transfer/route';
import { POST as COMPLETE } from '@/app/api/t/[tenantSlug]/admin/agents/[agentId]/ownership-transfer/complete/route';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const SUITE = `otauth-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const PEOPLE = ['ownerA', 'ownerB', 'admin'] as const;
type Person = (typeof PEOPLE)[number];
const users = {} as Record<Person, string>;
let agentId = '';

const emailOf = (who: Person) => `${who}@${TENANT}.test`;

function ctxAs(who: Person): RequestContext {
    return makeRequestContext(who === 'admin' ? 'ADMIN' : 'OWNER', {
        tenantId: TENANT,
        tenantSlug: TENANT,
        userId: users[who],
    });
}

const base = () => `http://localhost/api/t/${TENANT}/admin/agents/${agentId}/ownership-transfer`;

function req(method: string, url: string, body?: unknown): NextRequest {
    return new NextRequest(url, {
        method,
        headers: new Headers({ 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

const routeArgs = () => ({ params: Promise.resolve({ tenantSlug: TENANT, agentId }) });

const countDenials = () => prisma.auditLog.count({ where: { tenantId: TENANT, action: 'AUTHZ_DENIED' } });

const ownerOf = async () =>
    (await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agentId } })).ownerUserId;

beforeAll(async () => {
    await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
    for (const who of PEOPLE) {
        const email = emailOf(who);
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        users[who] = user.id;
        await prisma.tenantMembership.create({
            data: {
                tenantId: TENANT,
                userId: user.id,
                role: who === 'admin' ? Role.ADMIN : Role.OWNER,
                status: 'ACTIVE',
            },
        });
    }
    const sys = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `host ${SUITE}`, ownerUserId: users.ownerA },
    });
    agentId = (
        await prisma.registeredAgent.create({
            data: {
                tenantId: TENANT,
                aiSystemId: sys.id,
                name: `gated ${SUITE}`,
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: users.ownerA,
                status: 'ACTIVE',
            },
        })
    ).id;
});

afterAll(async () => {
    await prisma.agentOwnershipTransfer.deleteMany({ where: { tenantId: TENANT } });
    await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
    await deleteAuditRowsForTenants(prisma, TENANT);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
    });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.user.deleteMany({ where: { emailHash: { in: PEOPLE.map((p) => hashForLookup(emailOf(p))) } } });
    await prisma.$disconnect();
});

describe('the ownership-transfer routes are tenant-lifecycle routes', () => {
    it('an ADMIN — who holds the register key — is refused on every verb, one AUTHZ_DENIED row each', async () => {
        // The ADMIN really does hold the neighbouring key; otherwise this proves
        // only that a principal with nothing is refused.
        expect(ctxAs('admin').appPermissions.admin.agent_registry).toBe(true);
        expect(ctxAs('admin').appPermissions.admin.tenant_lifecycle).toBe(false);
        getTenantCtxMock.mockResolvedValue(ctxAs('admin'));

        const calls: Array<[string, () => Promise<Response>]> = [
            ['GET', () => GET(req('GET', base()), routeArgs())],
            ['POST', () => POST(req('POST', base(), { toOwnerUserId: users.ownerB }), routeArgs())],
            ['DELETE', () => DELETE(req('DELETE', `${base()}?transferId=whatever`), routeArgs())],
            ['COMPLETE', () => COMPLETE(req('POST', `${base()}/complete`, { transferId: 'whatever' }), routeArgs())],
        ];
        for (const [label, call] of calls) {
            const before = await countDenials();
            const res = await call();
            expect({ label, status: res.status }).toEqual({ label, status: 403 });
            // The body never echoes the key.
            const body = JSON.stringify(await res.json());
            expect(body).not.toContain('tenant_lifecycle');
            // EXACTLY one row, not "at least one".
            expect({ label, denials: await countDenials() }).toEqual({ label, denials: before + 1 });
            const row = await prisma.auditLog.findFirstOrThrow({
                where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
                orderBy: { createdAt: 'desc' },
            });
            expect(row.entityId).toBe('admin.tenant_lifecycle');
        }

        // …and nothing happened.
        expect(await prisma.agentOwnershipTransfer.count({ where: { tenantId: TENANT } })).toBe(0);
        expect(await ownerOf()).toBe(users.ownerA);
    });

    it('OWNERs pass both routes: A proposes (201), B completes (200), and ownership moves', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('ownerA'));
        const proposed = await POST(req('POST', base(), { toOwnerUserId: users.ownerB }), routeArgs());
        expect(proposed.status).toBe(201);
        const { id: transferId } = (await proposed.json()) as { id: string };

        const read = await GET(req('GET', base()), routeArgs());
        expect(read.status).toBe(200);
        expect(((await read.json()) as { open: { id: string } | null }).open?.id).toBe(transferId);

        // The initiator holds the key and is still refused: by the usecase, not
        // the gate, so it is a 403 that writes no AUTHZ_DENIED row.
        const before = await countDenials();
        const byInitiator = await COMPLETE(req('POST', `${base()}/complete`, { transferId }), routeArgs());
        expect(byInitiator.status).toBe(403);
        expect(await countDenials()).toBe(before);
        expect(await ownerOf()).toBe(users.ownerA);

        getTenantCtxMock.mockResolvedValue(ctxAs('ownerB'));
        const done = await COMPLETE(req('POST', `${base()}/complete`, { transferId }), routeArgs());
        expect(done.status).toBe(200);
        expect(await ownerOf()).toBe(users.ownerB);
    });

    it('cancel takes the transfer id from the query string, and refuses an unknown key', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('ownerB'));
        const proposed = await POST(req('POST', base(), { toOwnerUserId: users.ownerA }), routeArgs());
        expect(proposed.status).toBe(201);
        const { id: transferId } = (await proposed.json()) as { id: string };

        const unknownKey = await DELETE(
            req('DELETE', `${base()}?transferId=${transferId}&force=1`),
            routeArgs(),
        );
        expect(unknownKey.status).toBe(400);

        const cancelled = await DELETE(req('DELETE', `${base()}?transferId=${transferId}`), routeArgs());
        expect(cancelled.status).toBe(200);
        expect((await prisma.agentOwnershipTransfer.findUniqueOrThrow({ where: { id: transferId } })).status).toBe(
            'CANCELLED',
        );
    });

    it('the hash chain still verifies with the denials and the transfer rows in it', async () => {
        const result = await verifyAuditChain(TENANT, prisma);
        expect(result.valid).toBe(true);
        expect(result.unhashedEntries).toBe(0);
    });
});
