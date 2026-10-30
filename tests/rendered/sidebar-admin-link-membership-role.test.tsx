/**
 * The sidebar's admin link (the gear) follows the membership's OWN role, as
 * the edge's admin gate does (owner decision 2026-10-30, #4581 B).
 *
 * The gear used to show for anybody holding `admin.view`, which a custom role
 * can grant on a Reader, Editor or Auditor membership. The edge reads the
 * membership's own role and refuses that person's admin API calls, so the gear
 * led to pages that could not load or save. It now needs both: the key, and a
 * membership the edge admits (OWNER or ADMIN).
 */
import * as React from 'react';
import { render } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    usePathname: () => '/t/acme/dashboard',
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
}));

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'en',
}));

import type { Role } from '@prisma/client';

import { SidebarContent } from '@/components/layout/SidebarNav';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { TenantProvider, type TenantContextValue } from '@/lib/tenant-context-provider';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';

import { makeRequestContext } from '../helpers/make-context';

function tenant(role: Role, appPermissions: PermissionSet, membershipRole: Role | undefined): TenantContextValue {
    return {
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        tenantName: 'Acme',
        role,
        membershipRole,
        permissions: makeRequestContext(role).permissions,
        appPermissions,
        modules: { processCanvas: false },
    };
}

function gearShown(value: TenantContextValue): boolean {
    const { container, unmount } = render(
        <KeyboardShortcutProvider>
            <TenantProvider value={value}>
                <SidebarContent user={{ name: 'Ada' }} onLogout={() => {}} />
            </TenantProvider>
        </KeyboardShortcutProvider>,
    );
    const shown = container.querySelector('[data-testid="nav-admin-icon"]') !== null;
    unmount();
    return shown;
}

/** `base`'s own keys, with `admin.view` granted, as a custom role stores them. */
function withAdminView(base: Role): PermissionSet {
    const set = getPermissionsForRole(base);
    return { ...set, admin: { ...set.admin, view: true } };
}

describe('the sidebar admin link', () => {
    test.each(['OWNER', 'ADMIN'] as Role[])('shows for a built-in %s', (role) => {
        expect(gearShown(tenant(role, getPermissionsForRole(role), role))).toBe(true);
    });

    test.each(['EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN'] as Role[])('does not show for a built-in %s', (role) => {
        expect(gearShown(tenant(role, getPermissionsForRole(role), role))).toBe(false);
    });

    test.each(['READER', 'EDITOR', 'AUDITOR'] as Role[])(
        'does not show for a %s membership whose custom role grants admin.view',
        (membershipRole) => {
            for (const base of ['ADMIN', 'EDITOR', 'READER', 'AUDITOR'] as Role[]) {
                expect({ base, shown: gearShown(tenant(base, withAdminView(base), membershipRole)) }).toEqual({
                    base,
                    shown: false,
                });
            }
        },
    );

    test('shows for an ADMIN membership whose custom role on a Reader base grants admin.view', () => {
        expect(gearShown(tenant('READER', withAdminView('READER'), 'ADMIN'))).toBe(true);
    });

    test('does not show for an ADMIN membership whose custom role switches admin.view off', () => {
        const set = getPermissionsForRole('ADMIN');
        expect(gearShown(tenant('ADMIN', { ...set, admin: { ...set.admin, view: false } }, 'ADMIN'))).toBe(false);
    });

    test('does not show when the membership role is unknown', () => {
        expect(gearShown(tenant('OWNER', getPermissionsForRole('OWNER'), undefined))).toBe(false);
    });
});
