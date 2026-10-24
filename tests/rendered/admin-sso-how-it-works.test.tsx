/**
 * The SSO page's "How SSO works" box describes how people find single sign-on.
 *
 * It said "Email domains help auto-discover SSO on the login page". The sign-in
 * page finds SSO by WORKSPACE (`/api/auth/sso/discover`, `SsoSignIn`) and never
 * by email domain: a provider's domains are typed by a workspace admin and
 * verified by nobody, so routing by them would let any workspace claim anyone's
 * domain. An admin reading the old line would expect members to be sent to SSO
 * by their address, and would not tell them their workspace name.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/admin/sso',
    useSearchParams: () => new URLSearchParams(),
}));

import SsoAdminPage from '@/app/t/[tenantSlug]/(app)/admin/sso/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

function mount() {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch;
    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'admin-1',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role: 'ADMIN',
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: getPermissionsForRole('ADMIN'),
                    modules: { processCanvas: false },
                }}
            >
                <SsoAdminPage />
            </TenantProvider>
        </TooltipProvider>,
    );
}

describe('admin SSO page — How SSO works', () => {
    it('says people find SSO by workspace name, and that email domains only restrict', async () => {
        mount();
        const box = (await screen.findByRole('heading', { name: 'How SSO works' })).parentElement as HTMLElement;

        expect(within(box).getByText(/find SSO on the sign-in page by workspace name/)).toBeInTheDocument();
        expect(within(box).getByText(/email domains only limit which addresses can use it/)).toBeInTheDocument();
        expect(box).not.toHaveTextContent(/auto-discover/i);
    });
});
