/**
 * The admin pages ask the edge (#4467, #4466, generalised from #4471): a page
 * offers an admin-API write only where the edge, the route's key and the
 * usecase's floor would all let it through.
 *
 *   - `offersAdminApiWrite` composes the three, and fails on any one;
 *   - `edgeAdmitsAdminApi` IS the edge's answer — asked of `checkAdminAccess`
 *     itself — for the custom roles and integrations APIs, for every role;
 *   - the tenant layout hands that verdict to every page, from the session's
 *     membership claims, as the middleware reads them.
 */
jest.mock('@/auth', () => ({ auth: jest.fn() }));
jest.mock('@/lib/server/tenant-context.server', () => ({ getTenantServerContext: jest.fn() }));
jest.mock('@/lib/entitlements-server', () => ({ getTenantPlan: jest.fn().mockResolvedValue(null) }));
jest.mock('next/cache', () => ({ unstable_noStore: jest.fn() }));
jest.mock('next/navigation', () => ({
    notFound: () => {
        throw new Error('NEXT_NOT_FOUND');
    },
}));

import { auth } from '@/auth';
import { getTenantServerContext } from '@/lib/server/tenant-context.server';
import { checkAdminAccess } from '@/lib/auth/guard';
import { offersAdminApiWrite } from '@/lib/auth/admin-api-affordances';
import { edgeAdmitsAdminApi } from '@/lib/auth/admin-api-edge';
import { edgeAdmitsAgentAdminWrite } from '@/lib/agentic/agent-register-affordances';
import { getPermissionsForRole } from '@/lib/permissions';
import { TENANT_ROLES } from '@/lib/roles';
import TenantLayout from '@/app/t/[tenantSlug]/layout';

const admin = getPermissionsForRole('ADMIN');
const claims = (role: string) => ({ role: 'READER', memberships: [{ slug: 'acme', role }] });

describe('offersAdminApiWrite — all three gates, or nothing', () => {
    const viewer = { edgeAdmits: true, appPermissions: admin, permissions: { canAdmin: true, canWrite: true } };

    it('offers the write when the edge admits, the key is held and the floor is met', () => {
        expect(offersAdminApiWrite(viewer, { key: 'admin.manage', floor: 'canAdmin' })).toBe(true);
        expect(offersAdminApiWrite(viewer, { key: 'admin.manage' })).toBe(true);
        expect(offersAdminApiWrite(viewer, { key: 'admin.manage', floor: true })).toBe(true);
    });

    it('withholds it when any one gate refuses', () => {
        expect(offersAdminApiWrite({ ...viewer, edgeAdmits: false }, { key: 'admin.manage' })).toBe(false);
        expect(
            offersAdminApiWrite(
                { ...viewer, appPermissions: { ...admin, admin: { ...admin.admin, manage: false } } },
                { key: 'admin.manage' },
            ),
        ).toBe(false);
        expect(
            offersAdminApiWrite({ ...viewer, permissions: { canAdmin: false, canWrite: true } }, { key: 'admin.manage', floor: 'canAdmin' }),
        ).toBe(false);
        expect(offersAdminApiWrite(viewer, { key: 'admin.manage', floor: false })).toBe(false);
        expect(offersAdminApiWrite({ ...viewer, appPermissions: null }, { key: 'admin.manage' })).toBe(false);
    });
});

describe('edgeAdmitsAdminApi is the edge’s own answer', () => {
    const PAGES = ['/admin/roles', '/admin/roles/cr-1', '/admin/integrations', '/admin/integrations/c-1/sync'];

    it.each(TENANT_ROLES)('for a %s membership, it equals checkAdminAccess on the roles and integrations APIs', (role) => {
        const verdict = edgeAdmitsAdminApi('acme', claims(role));
        for (const page of PAGES) {
            for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
                const edge = checkAdminAccess(`/api/t/acme${page}`, 'READER', claims(role).memberships, method) !== 'deny';
                expect({ role, page, method, edge }).toEqual({ role, page, method, edge: verdict });
            }
        }
    });

    it('admits exactly OWNER and ADMIN memberships there — a custom role never enters it', () => {
        expect(TENANT_ROLES.filter((role) => edgeAdmitsAdminApi('acme', claims(role)))).toEqual(['OWNER', 'ADMIN']);
    });

    it('defers, and so admits, for a tenant missing from a capped claim, as the edge does', () => {
        expect(edgeAdmitsAdminApi('acme', { role: 'READER', memberships: [{ slug: 'other', role: 'READER' }] })).toBe(true);
        expect(edgeAdmitsAdminApi('acme', null)).toBe(true);
    });

    it('the agent register asks the same function for its own subtree, where an AI admin is admitted', () => {
        expect(edgeAdmitsAgentAdminWrite('acme', claims('AI_ADMIN'))).toBe(true);
        expect(edgeAdmitsAdminApi('acme', claims('AI_ADMIN'))).toBe(false);
        expect(edgeAdmitsAgentAdminWrite('acme', claims('EDITOR'))).toBe(false);
    });
});

describe('the tenant layout hands every page the edge’s verdict', () => {
    async function layoutValueFor(role: string) {
        (auth as jest.Mock).mockResolvedValue({ user: { id: 'u-1', ...claims(role) } });
        (getTenantServerContext as jest.Mock).mockResolvedValue({
            tenant: { id: 't-1', slug: 'acme', name: 'Acme', currencySymbol: '€' },
            role: 'EDITOR',
            permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
            appPermissions: admin,
            modules: { processCanvas: false },
        });
        const element = (await TenantLayout({
            children: null,
            params: Promise.resolve({ tenantSlug: 'acme' }),
        })) as { props: { value: { edgeAdmitsAdminApi?: boolean } } };
        return element.props.value;
    }

    it('an ADMIN membership is admitted, and an EDITOR one whose custom role is ADMIN-built is not', async () => {
        expect((await layoutValueFor('ADMIN')).edgeAdmitsAdminApi).toBe(true);
        // The context's own permissions are a custom role's (ADMIN keys, admin
        // tier); the edge still reads the EDITOR membership.
        expect((await layoutValueFor('EDITOR')).edgeAdmitsAdminApi).toBe(false);
    });
});
