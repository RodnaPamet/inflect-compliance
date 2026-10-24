/**
 * The personal MFA page is reachable from the account menu.
 *
 * `/t/<slug>/security/mfa` is where a person enrols, verifies and removes their
 * own authenticator, and nothing linked to it except the MFA challenge page —
 * so under an OPTIONAL policy, which never sends anyone there, a user had to
 * know the URL to turn MFA on. The account menu is where the chrome already
 * keeps a person's own security settings ("Account security"), so the row sits
 * beside it.
 *
 * Enrolment is per tenant (`UserMfaEnrollment` is keyed on user and tenant), so
 * the row exists only in the tenant chrome, pointing at the current tenant. The
 * org chrome has no tenant to enrol in and shows no row — asserted alongside
 * the row it does show, so a menu that rendered nothing would fail here.
 */
import * as React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';

let mockParams: Record<string, string> = { tenantSlug: 'acme' };
jest.mock('next/navigation', () => ({
    useParams: () => mockParams,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/dashboard',
    useSearchParams: () => new URLSearchParams(),
}));
// The bell polls and opens an event stream; neither is what this test is about.
jest.mock('@/components/layout/notifications-bell', () => ({ NotificationsBell: () => null }));

import { TopChrome } from '@/components/layout/TopChrome';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { OrgProvider } from '@/lib/org-context-provider';
import { getOrgPermissions, getPermissionsForRole } from '@/lib/permissions';

const user = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    image: null,
    memberships: [
        { slug: 'acme', role: 'EDITOR', tenantId: 'tenant-1' },
        { slug: 'globex', role: 'READER', tenantId: 'tenant-2' },
    ],
    orgMemberships: [],
};

/** Each chrome under the provider its real layout mounts: tenant or org, never both. */
function renderChrome(variant: 'tenant' | 'org') {
    const chrome = <TopChrome variant={variant} user={user} onMobileMenuClick={jest.fn()} onLogout={jest.fn()} />;
    render(
        <TooltipProvider>
            {variant === 'tenant' ? (
                <TenantProvider
                    value={{
                        userId: 'u-ada',
                        tenantId: 'tenant-1',
                        tenantSlug: 'acme',
                        tenantName: 'Acme',
                        role: 'EDITOR',
                        permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: false },
                        appPermissions: getPermissionsForRole('EDITOR'),
                        modules: { processCanvas: false },
                    }}
                >
                    {chrome}
                </TenantProvider>
            ) : (
                <OrgProvider
                    value={{
                        organizationId: 'org-1',
                        orgSlug: 'holding',
                        orgName: 'Holding',
                        role: 'ORG_ADMIN',
                        permissions: getOrgPermissions('ORG_ADMIN'),
                    }}
                >
                    {chrome}
                </OrgProvider>
            )}
        </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
}

describe('account menu — multi-factor authentication', () => {
    afterEach(() => {
        mockParams = { tenantSlug: 'acme' };
    });

    it("links to the current tenant's MFA page", () => {
        renderChrome('tenant');
        const row = screen.getByRole('menuitem', { name: 'Multi-factor authentication' });
        expect(row).toHaveAttribute('href', '/t/acme/security/mfa');
        // Beside the person's other security setting, not somewhere else.
        expect(screen.getByRole('menuitem', { name: 'Account security' })).toHaveAttribute('href', '/account/security');
    });

    // A person in two tenants has two enrolments; the row is for the one they
    // are in, not the first membership on the token.
    it('follows the tenant in the URL', () => {
        mockParams = { tenantSlug: 'globex' };
        renderChrome('tenant');
        expect(screen.getByRole('menuitem', { name: 'Multi-factor authentication' })).toHaveAttribute(
            'href',
            '/t/globex/security/mfa',
        );
    });

    it('is not offered in the org chrome, which has no tenant to enrol in', () => {
        mockParams = { orgSlug: 'holding' };
        renderChrome('org');
        expect(screen.getByRole('menuitem', { name: 'Account security' })).toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: 'Multi-factor authentication' })).toBeNull();
    });
});
