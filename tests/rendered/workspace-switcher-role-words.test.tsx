/**
 * THE WORKSPACE SWITCHER SAYS ROLES IN WORDS (#4842).
 *
 * The organization rows read "org · admin" and the workspace rows "admin",
 * both cut from the stored value, and the section headings were hard-coded
 * English. They now come from the catalogue: "Org admin", "Admin".
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/dashboard',
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({ tenantName: 'Acme', tenantSlug: 'acme' }),
}));

import { TenantSwitcher } from '@/components/layout/tenant-switcher';

it('names organization and workspace roles in words', async () => {
    const user = userEvent.setup();
    render(
        <TenantSwitcher
            memberships={[{ slug: 'acme', role: 'ADMIN', tenantId: 't-1' }]}
            orgMemberships={[{ slug: 'acme-group', role: 'ORG_ADMIN', organizationId: 'o-1' }]}
        />,
    );
    await user.click(screen.getByRole('button'));

    expect(await screen.findByText('Organizations')).toBeInTheDocument();
    expect(screen.getByText('Workspaces')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-switcher-org-acme-group')).toHaveTextContent('Org admin');
    expect(screen.getByTestId('tenant-switcher-row-acme')).toHaveTextContent('Admin');
    expect(document.body.textContent ?? '').not.toMatch(/org · |ORG_ADMIN/);
});
