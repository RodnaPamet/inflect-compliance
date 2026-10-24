/**
 * The profile page is reachable from the account menu.
 *
 * `/account/profile` is the only place a person changes their own display
 * name or photo, and nothing in the product linked to it: you had to know the
 * URL. The account menu already keeps a person's own settings ("Account
 * security"), so the row sits beside it. The page is not tied to a tenant,
 * so the row shows in the org chrome too.
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
    memberships: [{ slug: 'acme', role: 'EDITOR', tenantId: 'tenant-1' }],
    orgMemberships: [],
};

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

describe('account menu — profile', () => {
    afterEach(() => {
        mockParams = { tenantSlug: 'acme' };
    });

    it('links to the profile page in the tenant chrome', () => {
        renderChrome('tenant');
        expect(screen.getByRole('menuitem', { name: 'Your profile' })).toHaveAttribute('href', '/account/profile');
    });

    it('links to it in the org chrome too: the page belongs to the person, not a tenant', () => {
        mockParams = { orgSlug: 'holding' };
        renderChrome('org');
        expect(screen.getByRole('menuitem', { name: 'Your profile' })).toHaveAttribute('href', '/account/profile');
    });
});
