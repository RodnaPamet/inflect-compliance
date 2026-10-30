/**
 * `aiResidency` from Admin → AI features, proved on real rows.
 *
 *   - LOCAL_ONLY is reachable with NO gateway address of the tenant's own:
 *     the page offers none (#4545), and every consumer stops rather than sends
 *     when there is no gateway.
 *   - Every change writes `AI_RESIDENCY_CHANGED` naming the old and new value,
 *     beside the field-names-only `SECURITY_SETTINGS_UPDATED`; saving the
 *     stored value again writes no residency event.
 *   - The patch carries one key: a gateway address stored by an earlier API
 *     call is left exactly as it was.
 *   - Roles without `admin.manage` are refused at the route with one
 *     `AUTHZ_DENIED` row and nothing written.
 *   - TWO TENANTS: one tenant's residency never reaches another's row.
 *
 * The route is driven through its REAL handler. Only `getTenantCtx` is mocked.
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
import { GET, PUT } from '@/app/api/t/[tenantSlug]/admin/security-settings/route';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const A = `residency-a-${SUITE}`;
const B = `residency-b-${SUITE}`;
const TENANTS = [A, B];
const userIds: string[] = [];
const users: Record<'owner' | 'admin' | 'editor' | 'aiAdmin', string> = { owner: '', admin: '', editor: '', aiAdmin: '' };
const ROLE_OF = { owner: 'OWNER', admin: 'ADMIN', editor: 'EDITOR', aiAdmin: 'AI_ADMIN' } as const;

function ctxAs(who: keyof typeof users): RequestContext {
    return makeRequestContext(ROLE_OF[who] as Role, { tenantId: A, tenantSlug: A, userId: users[who] });
}

const url = () => `http://localhost/api/t/${A}/admin/security-settings`;
const put = (body: unknown) =>
    new NextRequest(url(), {
        method: 'PUT',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });
const routeArgs = () => ({ params: Promise.resolve({ tenantSlug: A }) });

const stored = (tenantId: string) =>
    prisma.tenantSecuritySettings.findUnique({
        where: { tenantId },
        select: { aiResidency: true, aiLocalBaseUrl: true },
    });
const residencyEvents = () =>
    prisma.auditLog.findMany({
        where: { tenantId: A, action: 'AI_RESIDENCY_CHANGED' },
        orderBy: { createdAt: 'asc' },
    });

async function person(label: keyof typeof users) {
    const email = `${label}@${A}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userIds.push(user.id);
    await prisma.tenantMembership.create({
        data: { tenantId: A, userId: user.id, role: ROLE_OF[label] as Role, status: 'ACTIVE' },
    });
    users[label] = user.id;
}

beforeAll(async () => {
    for (const t of TENANTS) await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
    for (const who of Object.keys(users) as Array<keyof typeof users>) await person(who);
    // B is LOCAL_ONLY from the start — the two-tenant control.
    await prisma.tenantSecuritySettings.create({ data: { tenantId: B, aiResidency: 'LOCAL_ONLY' } });
});

afterAll(async () => {
    await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    await prisma.$disconnect();
});

describe('aiResidency through the real route', () => {
    it.each(['editor', 'aiAdmin'] as const)('%s is refused with one AUTHZ_DENIED row, and nothing is written', async (who) => {
        expect(ctxAs(who).appPermissions.admin.manage).toBe(false);
        getTenantCtxMock.mockResolvedValue(ctxAs(who));
        const denials = () => prisma.auditLog.count({ where: { tenantId: A, action: 'AUTHZ_DENIED' } });
        const before = await denials();
        const res = await PUT(put({ aiResidency: 'LOCAL_ONLY' }), routeArgs());
        expect(res.status).toBe(403);
        expect(await denials()).toBe(before + 1);
        expect(await stored(A)).toBeNull();
    });

    it('an ADMIN sets LOCAL_ONLY with no gateway address, and the change is audited with both values', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('admin'));
        const res = await PUT(put({ aiResidency: 'LOCAL_ONLY' }), routeArgs());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.aiResidency).toBe('LOCAL_ONLY');
        expect(typeof body.deploymentHasLocalGateway).toBe('boolean');

        expect(await stored(A)).toEqual({ aiResidency: 'LOCAL_ONLY', aiLocalBaseUrl: null });
        const events = await residencyEvents();
        expect(events).toHaveLength(1);
        expect(events[0].userId).toBe(users.admin);
        expect(events[0].detailsJson).toMatchObject({
            before: { aiResidency: 'EXTERNAL' },
            after: { aiResidency: 'LOCAL_ONLY' },
        });
        // The general event still lands, with field names only.
        const general = await prisma.auditLog.findFirst({
            where: { tenantId: A, action: 'SECURITY_SETTINGS_UPDATED' },
            orderBy: { createdAt: 'desc' },
        });
        expect(general?.detailsJson).toMatchObject({ changedFields: ['aiResidency'] });
    });

    it('saving the stored value again writes no residency event', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('owner'));
        const res = await PUT(put({ aiResidency: 'LOCAL_ONLY' }), routeArgs());
        expect(res.status).toBe(200);
        expect(await residencyEvents()).toHaveLength(1);
    });

    it('the one-key patch leaves a gateway address stored by an earlier call exactly as it was', async () => {
        await prisma.tenantSecuritySettings.update({
            where: { tenantId: A },
            data: { aiLocalBaseUrl: 'https://gateway.earlier-call.example' },
        });
        getTenantCtxMock.mockResolvedValue(ctxAs('owner'));
        const res = await PUT(put({ aiResidency: 'EXTERNAL' }), routeArgs());
        expect(res.status).toBe(200);
        expect(await stored(A)).toEqual({ aiResidency: 'EXTERNAL', aiLocalBaseUrl: 'https://gateway.earlier-call.example' });

        const events = await residencyEvents();
        expect(events).toHaveLength(2);
        expect(events[1].detailsJson).toMatchObject({
            before: { aiResidency: 'LOCAL_ONLY' },
            after: { aiResidency: 'EXTERNAL' },
        });
        expect(JSON.stringify(events.map((e) => [e.details, e.detailsJson]))).not.toContain('earlier-call.example');
    });

    it('the read reports the stored value, and B\'s row is untouched by A\'s changes', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('admin'));
        const res = await GET(new NextRequest(url()), routeArgs());
        expect((await res.json()).aiResidency).toBe('EXTERNAL');
        expect((await stored(B))?.aiResidency).toBe('LOCAL_ONLY');
        expect(await prisma.auditLog.count({ where: { tenantId: B, action: 'AI_RESIDENCY_CHANGED' } })).toBe(0);
    });
});
