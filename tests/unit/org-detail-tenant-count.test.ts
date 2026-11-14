/**
 * GET /api/org/[orgSlug] counts the tenants GET /api/org/[orgSlug]/tenants
 * lists (#5303). The count used to include soft-deleted (org-removed)
 * tenants, so the two endpoints disagreed for any org that had removed one.
 */
const tenantCount = jest.fn();
const tenantFindMany = jest.fn();

jest.mock('@/app-layer/context', () => ({
    getOrgCtx: async () => ({ organizationId: 'org-1', orgRole: 'ORG_ADMIN', permissions: {} }),
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: {
            count: (a: unknown) => tenantCount(a),
            findMany: (a: unknown) => tenantFindMany(a),
        },
        orgMembership: { count: async () => 2 },
        organization: { findUnique: async () => ({ id: 'org-1', slug: 'acme', name: 'Acme' }) },
    },
}));

import { NextRequest } from 'next/server';
import { GET as getOrg } from '@/app/api/org/[orgSlug]/route';
import { GET as listTenants } from '@/app/api/org/[orgSlug]/tenants/route';

type Where = Record<string, unknown>;

/** Applies a where clause's two keys the way Postgres would, over a fixture. */
const ROWS = [
    { organizationId: 'org-1', deletedAt: null },
    { organizationId: 'org-1', deletedAt: null },
    { organizationId: 'org-1', deletedAt: new Date('2026-11-01') },
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
});

it('the org detail tenant count agrees with the org tenants list', async () => {
    const detail = await (await getOrg(new NextRequest('http://localhost/api/org/acme'), args as never)).json();
    const list = await (await listTenants(new NextRequest('http://localhost/api/org/acme/tenants'), args as never)).json();
    expect(list.tenants).toHaveLength(2);
    expect(detail.counts.tenants).toBe(list.tenants.length);
});
