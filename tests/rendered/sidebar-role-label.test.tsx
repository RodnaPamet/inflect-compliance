/** @jest-environment jsdom */

/**
 * The role under the user's name in both sidebars is a label, as the
 * workspace switcher beside it shows it — never the stored enum (#5309).
 *
 * Uses the repo-wide next-intl mock, which resolves keys against the real
 * English catalogue, so `AI_ADMIN` reading "AI admin" is the catalogue's word.
 */
import * as React from 'react';
import { render } from '@testing-library/react';

const en = require('../../messages/en.json');

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    usePathname: () => '/t/acme/dashboard',
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
}));

const mockOrg = { role: 'ORG_OWNER' };
jest.mock('@/lib/org-context-provider', () => ({
    useOrgContext: () => ({
        orgName: 'Globex Org',
        orgSlug: 'globex',
        role: mockOrg.role,
        permissions: { canDrillDown: true, canManageMembers: true },
    }),
    useOrgHref: () => (p: string) => `/org/globex${p}`,
    useOrgPermissions: () => ({ canDrillDown: true, canManageMembers: true }),
}));
jest.mock('@/components/org-switcher', () => ({ OrgSwitcher: () => <div /> }));

import type { Role } from '@prisma/client';

import { SidebarContent } from '@/components/layout/SidebarNav';
import { OrgSidebarContent } from '@/components/layout/OrgSidebarNav';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { TenantProvider, type TenantContextValue } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

import { makeRequestContext } from '../helpers/make-context';

function tenant(role: Role): TenantContextValue {
    return {
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        tenantName: 'Acme',
        role,
        membershipRole: role,
        permissions: makeRequestContext(role).permissions,
        appPermissions: getPermissionsForRole(role),
        modules: { processCanvas: false },
    };
}

describe('the role under the user in the sidebar', () => {
    test.each(['AI_ADMIN', 'OWNER', 'READER'] as Role[])('a %s membership reads by its label', (role) => {
        const { container } = render(
            <KeyboardShortcutProvider>
                <TenantProvider value={tenant(role)}>
                    <SidebarContent user={{ name: 'Ada' }} onLogout={() => {}} />
                </TenantProvider>
            </KeyboardShortcutProvider>,
        );
        const lines = Array.from(container.querySelectorAll('p')).map((p) => p.textContent);
        expect(lines).toContain(en.roles[role]);
        expect(lines).not.toContain(role);
    });

    test.each(['ORG_OWNER', 'ORG_READER'])('an %s reads by its label in the org sidebar', (role) => {
        mockOrg.role = role;
        const { container } = render(<OrgSidebarContent user={{ name: 'Ada' }} onLogout={() => {}} />);
        const lines = Array.from(container.querySelectorAll('p')).map((p) => p.textContent);
        expect(lines).toContain(en.orgRoles[role]);
        expect(lines).not.toContain(role);
    });
});
