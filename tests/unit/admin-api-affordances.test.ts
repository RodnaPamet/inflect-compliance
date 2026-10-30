/**
 * The admin pages ask the edge (#4467, #4466, generalised from #4471): a page
 * offers an admin-API write only where the edge, the route's key and the
 * usecase's floor would all let it through.
 *
 *   - `offersAdminApiWrite` composes the three, and fails on any one;
 *   - the admin pages' edge verdict is #4587's `membershipOpensAdminConsole`
 *     over the membership's own role, and it IS the edge's answer —
 *     `checkAdminAccess` itself — for the custom roles and integrations APIs,
 *     for every role; a missing role is not admitted;
 *   - the agent register asks the edge for its own subtree, where an AI admin
 *     is admitted too;
 *   - the tenant layout hands pages the membership's role and no verdict of its
 *     own, so there is one edge answer, not two.
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
import { membershipOpensAdminConsole } from '@/lib/auth/edge-admin-roles';
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

describe('the admin pages’ edge verdict is the edge’s own answer', () => {
    const PAGES = ['/admin/roles', '/admin/roles/cr-1', '/admin/integrations', '/admin/integrations/c-1/sync'];

    it.each(TENANT_ROLES)('for a %s membership, it equals checkAdminAccess on the roles and integrations APIs', (role) => {
        const verdict = membershipOpensAdminConsole(role);
        for (const page of PAGES) {
            for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
                const edge = checkAdminAccess(`/api/t/acme${page}`, 'READER', claims(role).memberships, method) !== 'deny';
                expect({ role, page, method, edge }).toEqual({ role, page, method, edge: verdict });
            }
        }
    });

    it('admits exactly OWNER and ADMIN memberships — a custom role never enters it — and not a missing role', () => {
        expect(TENANT_ROLES.filter((role) => membershipOpensAdminConsole(role))).toEqual(['OWNER', 'ADMIN']);
        expect(membershipOpensAdminConsole(undefined)).toBe(false);
        expect(membershipOpensAdminConsole(null)).toBe(false);
    });

    it('the agent register asks the edge for its own subtree, where an AI admin is admitted', () => {
        expect(edgeAdmitsAgentAdminWrite('acme', claims('AI_ADMIN'))).toBe(true);
        expect(membershipOpensAdminConsole('AI_ADMIN')).toBe(false);
        expect(edgeAdmitsAgentAdminWrite('acme', claims('EDITOR'))).toBe(false);
        expect(edgeAdmitsAgentAdminWrite('acme', claims('ADMIN'))).toBe(true);
    });
});

describe('the tenant layout hands pages the membership’s role, and no second verdict', () => {
    async function layoutValueFor(membershipRole: string) {
        (auth as jest.Mock).mockResolvedValue({ user: { id: 'u-1', ...claims(membershipRole) } });
        (getTenantServerContext as jest.Mock).mockResolvedValue({
            tenant: { id: 't-1', slug: 'acme', name: 'Acme', currencySymbol: '€' },
            role: 'ADMIN',
            membershipRole,
            permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true },
            appPermissions: admin,
            modules: { processCanvas: false },
        });
        const element = (await TenantLayout({
            children: null,
            params: Promise.resolve({ tenantSlug: 'acme' }),
        })) as { props: { value: Record<string, unknown> } };
        return element.props.value;
    }

    it('an EDITOR membership whose custom role is ADMIN-built is handed EDITOR, which opens no admin console', async () => {
        // The context's own permissions are a custom role's (ADMIN keys, admin
        // tier); the edge, and so the pages, read the EDITOR membership.
        const value = await layoutValueFor('EDITOR');
        expect(value.membershipRole).toBe('EDITOR');
        expect(membershipOpensAdminConsole(value.membershipRole as string)).toBe(false);
        expect(membershipOpensAdminConsole((await layoutValueFor('ADMIN')).membershipRole as string)).toBe(true);
    });

    it('carries no verdict of its own beside the role', async () => {
        expect(Object.keys(await layoutValueFor('ADMIN')).filter((k) => /edge/i.test(k))).toEqual([]);
    });
});
