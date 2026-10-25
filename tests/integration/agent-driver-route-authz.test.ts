/**
 * Who may read and who may change the tenant's agent engine, proved at the
 * route on real rows (owner decision 2026-10-25, #4139).
 *
 *   - READ is `admin.view`. OWNER and ADMIN get the whole gate. EDITOR, READER,
 *     AUDITOR and AI_ADMIN are refused at the route with exactly one
 *     `AUTHZ_DENIED` row each.
 *   - CHANGE is `admin.tenant_lifecycle`. An OWNER's PUT is stored and writes
 *     `AGENT_DRIVER_MODE_CHANGED`. A PUT crafted from an ADMIN session is a 403
 *     with exactly one `AUTHZ_DENIED` row, and nothing is written.
 *   - TWO TENANTS: one tenant's change never reaches the other.
 *
 * Only `getTenantCtx` is mocked, the one thing in the path that needs a
 * browser session. `requirePermission`, the usecase and the audit writer are
 * real.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { PrismaClient, type Role } from '@prisma/client';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { GET, PUT } from '@/app/api/t/[tenantSlug]/admin/agent-driver/route';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const A = `driver-a-${SUITE}`;
const B = `driver-b-${SUITE}`;
const TENANTS = [A, B];

const PEOPLE = ['owner', 'admin', 'aiAdmin', 'editor', 'reader', 'auditor'] as const;
type Person = (typeof PEOPLE)[number];
const ROLE_OF: Record<Person, Role> = {
    owner: 'OWNER',
    admin: 'ADMIN',
    aiAdmin: 'AI_ADMIN' as Role,
    editor: 'EDITOR',
    reader: 'READER',
    auditor: 'AUDITOR',
};
const users = {} as Record<Person, string>;
let bOwner = '';
const userIds: string[] = [];

function ctxAs(who: Person, tenantId = A): RequestContext {
    return makeRequestContext(ROLE_OF[who], { tenantId, tenantSlug: tenantId, userId: users[who] });
}

const url = (tenantSlug: string) => `http://localhost/api/t/${tenantSlug}/admin/agent-driver`;
const routeArgs = (tenantSlug = A) => ({ params: Promise.resolve({ tenantSlug }) });
const put = (mode: string, tenantSlug = A) =>
    new NextRequest(url(tenantSlug), {
        method: 'PUT',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ mode }),
    });

async function getAs(who: Person) {
    getTenantCtxMock.mockResolvedValue(ctxAs(who));
    return GET(new NextRequest(url(A)), routeArgs());
}
async function putAs(who: Person, mode: string) {
    getTenantCtxMock.mockResolvedValue(ctxAs(who));
    return PUT(put(mode), routeArgs());
}

const stored = async (tenantId = A) =>
    (await prisma.tenantSecuritySettings.findUnique({ where: { tenantId }, select: { agentDriver: true } }))
        ?.agentDriver ?? null;
const denialsBy = (userId: string) =>
    prisma.auditLog.count({ where: { tenantId: A, action: 'AUTHZ_DENIED', userId } });
const changes = (tenantId = A) =>
    prisma.auditLog.count({ where: { tenantId, action: 'AGENT_DRIVER_MODE_CHANGED' } });

async function person(tenantId: string, label: string, role: Role) {
    const email = `${label}@${tenantId}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userIds.push(user.id);
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status: 'ACTIVE' } });
    return user.id;
}

beforeAll(async () => {
    for (const t of TENANTS) await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
    for (const who of PEOPLE) users[who] = await person(A, who, ROLE_OF[who]);
    bOwner = await person(B, 'owner', 'OWNER');
});

afterAll(async () => {
    const t = { tenantId: { in: TENANTS } };
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    await prisma.$disconnect();
});

describe('the read: admin.view', () => {
    it.each(['owner', 'admin'] as const)('%s reads the whole gate', async (who) => {
        expect(ctxAs(who).appPermissions.admin.view).toBe(true);
        const res = await getAs(who);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual(
            expect.objectContaining({
                mode: 'STATIC',
                effective: expect.objectContaining({ driver: 'static' }),
                envEnabled: expect.any(Boolean),
                implemented: expect.any(Boolean),
            }),
        );
        expect(await denialsBy(users[who])).toBe(0);
    });

    it.each(['editor', 'reader', 'auditor', 'aiAdmin'] as const)(
        '%s is refused with exactly one AUTHZ_DENIED row',
        async (who) => {
            expect(ctxAs(who).appPermissions.admin.view).toBe(false);
            const before = await denialsBy(users[who]);
            const res = await getAs(who);
            expect(res.status).toBe(403);
            expect((await denialsBy(users[who])) - before).toBe(1);
        },
    );
});

describe('the change: admin.tenant_lifecycle', () => {
    it('a PUT crafted from an ADMIN session is a 403 with one AUTHZ_DENIED row, and nothing is written', async () => {
        expect(ctxAs('admin').appPermissions.admin.tenant_lifecycle).toBe(false);
        const storedBefore = await stored();
        const changesBefore = await changes();
        const denialsBefore = await denialsBy(users.admin);

        const res = await putAs('admin', 'FLUE');

        expect(res.status).toBe(403);
        expect((await denialsBy(users.admin)) - denialsBefore).toBe(1);
        expect(await stored()).toBe(storedBefore);
        expect(await changes()).toBe(changesBefore);
    });

    it('an OWNER changes it, and the change is audited with both values', async () => {
        const res = await putAs('owner', 'FLUE');
        expect(res.status).toBe(200);
        expect((await res.json()).mode).toBe('FLUE');
        expect(await stored()).toBe('FLUE');

        const rows = await prisma.auditLog.findMany({
            where: { tenantId: A, action: 'AGENT_DRIVER_MODE_CHANGED' },
            orderBy: { createdAt: 'asc' },
            take: 10,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].userId).toBe(users.owner);
        expect(rows[0].metadataJson).toEqual(expect.objectContaining({ from: 'STATIC', to: 'FLUE' }));
    });

    it('an ADMIN then reads the change it could not make', async () => {
        const res = await getAs('admin');
        expect(res.status).toBe(200);
        expect((await res.json()).mode).toBe('FLUE');
    });

    it('one tenant’s change never reaches the other', async () => {
        expect(await stored(B)).toBeNull();
        expect(await changes(B)).toBe(0);
        getTenantCtxMock.mockResolvedValue(
            makeRequestContext('OWNER', { tenantId: B, tenantSlug: B, userId: bOwner }),
        );
        const res = await GET(new NextRequest(url(B)), routeArgs(B));
        expect((await res.json()).mode).toBe('STATIC');
    });
});
