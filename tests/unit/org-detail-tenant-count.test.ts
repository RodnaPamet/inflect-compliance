/**
 * GET /api/org/[orgSlug] counts the tenants GET /api/org/[orgSlug]/tenants
 * lists (#5303). The count used to include soft-deleted (org-removed)
 * tenants, so the two endpoints disagreed for any org that had removed one.
 */
const tenantCount = jest.fn();
const tenantFindMany = jest.fn();
const membershipFindMany = jest.fn();

jest.mock('@/app-layer/context', () => ({
    getOrgCtx: async () => ({ userId: 'user-1', organizationId: 'org-1', orgRole: 'ORG_ADMIN', permissions: {} }),
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: {
            count: (a: unknown) => tenantCount(a),
            findMany: (a: unknown) => tenantFindMany(a),
        },
        orgMembership: { count: async () => 2 },
        tenantMembership: { findMany: (a: unknown) => membershipFindMany(a) },
        organization: { findUnique: async () => ({ id: 'org-1', slug: 'acme', name: 'Acme' }) },
    },
}));

import { NextRequest } from 'next/server';
import { GET as getOrg } from '@/app/api/org/[orgSlug]/route';
import { GET as listTenants } from '@/app/api/org/[orgSlug]/tenants/route';

type Where = Record<string, unknown>;

/** Applies a where clause's two keys the way Postgres would, over a fixture. */
const ROWS = [
    { id: 't1', organizationId: 'org-1', deletedAt: null },
    { id: 't2', organizationId: 'org-1', deletedAt: null },
    { id: 't3', organizationId: 'org-1', deletedAt: new Date('2026-11-01') },
];
function matching(where: Where) {
    return ROWS.filter(
        (r) =>
            r.organizationId === where.organizationId &&
            (!('deletedAt' in where) || r.deletedAt === where.deletedAt),
    );
}

const args = { params: Promise.resolve({ orgSlug: 'acme' }) };

beforeEach(() => {
    tenantCount.mockReset().mockImplementation(async ({ where }: { where: Where }) => matching(where).length);
    tenantFindMany.mockReset().mockImplementation(async ({ where }: { where: Where }) => matching(where));
    membershipFindMany.mockReset().mockResolvedValue([]);
});

it('the org detail tenant count agrees with the org tenants list', async () => {
    const detail = await (await getOrg(new NextRequest('http://localhost/api/org/acme'), args as never)).json();
    const list = await (await listTenants(new NextRequest('http://localhost/api/org/acme/tenants'), args as never)).json();
    expect(list.tenants).toHaveLength(2);
    expect(detail.counts.tenants).toBe(list.tenants.length);
});

// #5309 item 16 — each row says whether the CALLER can open it: an ACTIVE
// membership of their own in that tenant. The switcher lists an ORG_READER
// only those.
it('marks each tenant isMember by the caller\'s own ACTIVE membership', async () => {
    membershipFindMany.mockResolvedValue([{ tenantId: 't2' }]);
    const list = await (await listTenants(new NextRequest('http://localhost/api/org/acme/tenants'), args as never)).json();
    expect(list.tenants.map((t: { id: string; isMember: boolean }) => [t.id, t.isMember])).toEqual([
        ['t1', false],
        ['t2', true],
    ]);
    expect(membershipFindMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: 'user-1', status: 'ACTIVE', tenantId: { in: ['t1', 't2'] } },
    }));
});
