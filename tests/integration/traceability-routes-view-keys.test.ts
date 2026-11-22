/**
 * The traceability GET routes take the ANCHOR entity's view key (#5376, owner
 * decision 2026-11-12).
 *
 * The usecases refuse a read whose anchor the caller may not view and omit the
 * linked kinds it may not view (`traceability-reads-usecase.test.ts`). The
 * routes add the same refusal at the door through `requirePermission`, the way
 * `GET /risks/:id`, `/assets/:id` and `/controls/:id` already do, so a refusal
 * is a 403 that writes exactly one hash-chained `AUTHZ_DENIED` row. A built-in
 * READER is still admitted to every one of them.
 *
 * Only `getTenantCtx` is mocked, the one thing in the path that needs a browser
 * session; `requirePermission`, the usecases and the audit writer are real.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { GET as controlTraceability } from '@/app/api/t/[tenantSlug]/controls/[controlId]/traceability/route';
import { GET as controlRisks } from '@/app/api/t/[tenantSlug]/controls/[controlId]/risks/route';
import { GET as riskTraceability } from '@/app/api/t/[tenantSlug]/risks/[id]/traceability/route';
import { GET as assetTraceability } from '@/app/api/t/[tenantSlug]/assets/[id]/traceability/route';
import { GET as assetControls } from '@/app/api/t/[tenantSlug]/assets/[id]/controls/route';
import { GET as assetRisks } from '@/app/api/t/[tenantSlug]/assets/[id]/risks/route';
import { GET as policyTraceability } from '@/app/api/t/[tenantSlug]/policies/[id]/traceability/route';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const A = `trv-${SUITE}`;
let userId = '';
const ids = { control: '', risk: '', asset: '', policy: '' };

type Domain = 'controls' | 'risks' | 'assets' | 'policies';
type Handler = (req: NextRequest, args: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Each route, the anchor it hangs off, and the param name the anchor id travels in. */
const ROUTES: ReadonlyArray<{ name: string; handler: Handler; anchor: Domain; param: string }> = [
    { name: 'GET /controls/:id/traceability', handler: controlTraceability as unknown as Handler, anchor: 'controls', param: 'controlId' },
    { name: 'GET /controls/:id/risks', handler: controlRisks as unknown as Handler, anchor: 'controls', param: 'controlId' },
    { name: 'GET /risks/:id/traceability', handler: riskTraceability as unknown as Handler, anchor: 'risks', param: 'id' },
    { name: 'GET /assets/:id/traceability', handler: assetTraceability as unknown as Handler, anchor: 'assets', param: 'id' },
    { name: 'GET /assets/:id/controls', handler: assetControls as unknown as Handler, anchor: 'assets', param: 'id' },
    { name: 'GET /assets/:id/risks', handler: assetRisks as unknown as Handler, anchor: 'assets', param: 'id' },
    { name: 'GET /policies/:id/traceability', handler: policyTraceability as unknown as Handler, anchor: 'policies', param: 'id' },
];

const ANCHOR_ID: Record<Domain, () => string> = {
    controls: () => ids.control,
    risks: () => ids.risk,
    assets: () => ids.asset,
    policies: () => ids.policy,
};

function ctxWithout(domain: Domain | null): RequestContext {
    const appPermissions: PermissionSet = structuredClone(getPermissionsForRole('READER'));
    if (domain) appPermissions[domain].view = false;
    return makeRequestContext('READER', { tenantId: A, tenantSlug: A, userId, appPermissions });
}

async function call(route: (typeof ROUTES)[number], ctx: RequestContext) {
    getTenantCtxMock.mockResolvedValue(ctx);
    const req = new NextRequest(`http://localhost/api/t/${A}/traceability-test`);
    return route.handler(req, { params: Promise.resolve({ tenantSlug: A, [route.param]: ANCHOR_ID[route.anchor]() }) });
}

const countDenials = () => prisma.auditLog.count({ where: { tenantId: A, action: 'AUTHZ_DENIED' } });

beforeAll(async () => {
    await prisma.tenant.create({ data: { id: A, name: A, slug: A } });
    const email = `reader@${A}.test`;
    userId = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
    await prisma.tenantMembership.create({ data: { tenantId: A, userId, role: 'READER', status: 'ACTIVE' } });
    ids.control = (await prisma.control.create({ data: { tenantId: A, name: `${SUITE} control` } })).id;
    ids.risk = (await prisma.risk.create({ data: { tenantId: A, title: `${SUITE} risk`, score: 5, category: 'cat' } })).id;
    ids.asset = (await prisma.asset.create({ data: { tenantId: A, name: `${SUITE} asset`, type: 'SYSTEM', status: 'ACTIVE' } })).id;
    ids.policy = (await prisma.policy.create({ data: { tenantId: A, slug: `${SUITE}-p`, title: `${SUITE} policy` } })).id;
});

afterAll(async () => {
    await deleteAuditRowsForTenants(prisma, [A]);
    await prisma.policy.deleteMany({ where: { tenantId: A } });
    await prisma.control.deleteMany({ where: { tenantId: A } });
    await prisma.risk.deleteMany({ where: { tenantId: A } });
    await prisma.asset.deleteMany({ where: { tenantId: A } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, A);
    });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.tenant.deleteMany({ where: { id: A } });
});

describe('traceability GET routes take the anchor entity\'s view key', () => {
    it.each(ROUTES.map((r) => [r.name, r] as const))('%s admits a built-in READER', async (_name, route) => {
        const res = await call(route, ctxWithout(null));
        expect(res.status).toBe(200);
    });

    it.each(ROUTES.map((r) => [r.name, r] as const))(
        '%s refuses a custom role without its anchor\'s view key: 403 and one AUTHZ_DENIED row',
        async (_name, route) => {
            const before = await countDenials();
            const res = await call(route, ctxWithout(route.anchor));
            expect(res.status).toBe(403);
            expect(await countDenials()).toBe(before + 1);
        },
    );
});
