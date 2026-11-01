/**
 * #4844 — the new-workspace page tells a member who may not create one so,
 * with the org forbidden page, instead of throwing into the root error
 * boundary ("an unexpected error has occurred", reported as a crash). An
 * owner gets the form.
 */
import type { OrgContext } from '@/app-layer/types';
import { getOrgPermissions } from '@/lib/permissions';

let currentCtx: OrgContext;
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getOrgCtx: async () => currentCtx,
}));

jest.mock('next-intl/server', () => ({
    __esModule: true,
    getTranslations: async (ns: string) => (key: string) => `${ns}.${key}`,
}));

jest.mock('@/app/org/[orgSlug]/(app)/tenants/new/NewTenantForm', () => ({ NewTenantForm: () => null }));

import NewTenantPage from '@/app/org/[orgSlug]/(app)/tenants/new/page';
import { OrgForbiddenPage } from '@/app/org/[orgSlug]/(app)/_components/OrgForbiddenPage';
import { NewTenantForm } from '@/app/org/[orgSlug]/(app)/tenants/new/NewTenantForm';

function ctxAs(orgRole: 'ORG_OWNER' | 'ORG_ADMIN' | 'ORG_READER'): OrgContext {
    return {
        requestId: 'r',
        userId: 'u-1',
        organizationId: 'org-1',
        orgSlug: 'acme',
        orgRole,
        permissions: getOrgPermissions(orgRole),
    };
}

const props = { params: Promise.resolve({ orgSlug: 'acme' }) };

it.each(['ORG_ADMIN', 'ORG_READER'] as const)('an %s is told only an owner creates a workspace', async (role) => {
    currentCtx = ctxAs(role);
    const el = (await NewTenantPage(props)) as { type: unknown; props: { orgSlug: string; message: string } };
    expect(el.type).toBe(OrgForbiddenPage);
    expect(el.props).toEqual({ orgSlug: 'acme', message: 'org.forbidden.newWorkspace' });
});

it('an owner gets the form', async () => {
    currentCtx = ctxAs('ORG_OWNER');
    const el = (await NewTenantPage(props)) as { type: unknown };
    expect(el.type).toBe(NewTenantForm);
});
