/**
 * The workspace default language on real rows.
 *
 *   - A workspace created without naming it is English, which is what every
 *     workspace wrote before the column existed.
 *   - The CHECK refuses a language the product has no catalogue for, from any
 *     writer, the raw ones included.
 *   - Through the REAL route: an ADMIN sets it and the change is audited with
 *     both values; saving it again writes no second event; an EDITOR is refused
 *     with one AUTHZ_DENIED row and nothing written.
 *   - TWO TENANTS: one workspace's language never reaches another's row.
 *
 * Only `getTenantCtx` is mocked.
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
import { PUT } from '@/app/api/t/[tenantSlug]/admin/workspace-language/route';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const A = `wslang-a-${SUITE}`;
const B = `wslang-b-${SUITE}`;
const TENANTS = [A, B];
const userIds: string[] = [];
const users: Record<'admin' | 'editor', string> = { admin: '', editor: '' };
const ROLE_OF = { admin: 'ADMIN', editor: 'EDITOR' } as const;

const ctxAs = (who: keyof typeof users): RequestContext =>
    makeRequestContext(ROLE_OF[who] as Role, { tenantId: A, tenantSlug: A, userId: users[who] });

const put = (body: unknown) =>
    new NextRequest(`http://localhost/api/t/${A}/admin/workspace-language`, {
        method: 'PUT',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
    });
const routeArgs = () => ({ params: Promise.resolve({ tenantSlug: A }) });

const languageOf = async (id: string) =>
    (await prisma.tenant.findUniqueOrThrow({ where: { id }, select: { defaultLocale: true } })).defaultLocale;
const changeEvents = () =>
    prisma.auditLog.findMany({ where: { tenantId: A, action: 'WORKSPACE_LANGUAGE_CHANGED' } });

beforeAll(async () => {
    for (const t of TENANTS) await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
    for (const who of Object.keys(users) as Array<keyof typeof users>) {
        const email = `${who}@${A}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        userIds.push(user.id);
        await prisma.tenantMembership.create({
            data: { tenantId: A, userId: user.id, role: ROLE_OF[who] as Role, status: 'ACTIVE' },
        });
        users[who] = user.id;
    }
});

afterAll(async () => {
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    await prisma.$disconnect();
});

describe('Tenant.defaultLocale in the database', () => {
    it('is English for a workspace created without naming it', async () => {
        expect(await languageOf(A)).toBe('en');
        expect(await languageOf(B)).toBe('en');
    });

    it('the CHECK refuses a language with no catalogue, from a raw writer too', async () => {
        await expect(
            prisma.$executeRawUnsafe(`UPDATE "Tenant" SET "defaultLocale" = 'de' WHERE id = $1`, B),
        ).rejects.toThrow(/Tenant_defaultLocale_supported/);
        await expect(prisma.tenant.update({ where: { id: B }, data: { defaultLocale: '' } })).rejects.toThrow();
        expect(await languageOf(B)).toBe('en');
    });
});

describe('the workspace language through the real route', () => {
    it('an EDITOR is refused with one AUTHZ_DENIED row, and nothing is written', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('editor'));
        const denials = () => prisma.auditLog.count({ where: { tenantId: A, action: 'AUTHZ_DENIED' } });
        const before = await denials();
        const res = await PUT(put({ defaultLocale: 'bg' }), routeArgs());
        expect(res.status).toBe(403);
        expect(await denials()).toBe(before + 1);
        expect(await languageOf(A)).toBe('en');
    });

    it('an ADMIN sets Bulgarian, audited with both values, and only for this workspace', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('admin'));
        const res = await PUT(put({ defaultLocale: 'bg' }), routeArgs());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ defaultLocale: 'bg' });

        expect(await languageOf(A)).toBe('bg');
        expect(await languageOf(B)).toBe('en');
        const events = await changeEvents();
        expect(events).toHaveLength(1);
        expect(events[0].userId).toBe(users.admin);
        expect(events[0].detailsJson).toMatchObject({
            before: { defaultLocale: 'en' },
            after: { defaultLocale: 'bg' },
        });
    });

    it('saving the stored language again writes no second event', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('admin'));
        const res = await PUT(put({ defaultLocale: 'bg' }), routeArgs());
        expect(res.status).toBe(200);
        expect(await changeEvents()).toHaveLength(1);
    });

    it('a language with no catalogue is a 400, and nothing changes', async () => {
        getTenantCtxMock.mockResolvedValue(ctxAs('admin'));
        const res = await PUT(put({ defaultLocale: 'de' }), routeArgs());
        expect(res.status).toBe(400);
        expect(await languageOf(A)).toBe('bg');
    });
});
