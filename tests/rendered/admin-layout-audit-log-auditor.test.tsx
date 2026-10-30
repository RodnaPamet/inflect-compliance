/**
 * The admin layout shows the audit log to whoever its server gate admits
 * (owner decision 2026-10-29: an AUDITOR may open the Audit log page,
 * read-only), and nothing else beyond its `admin.view` floor.
 *
 * The server gate (`gateAdminPage`) has admitted `canAudit` on the audit log
 * since #4489, but the CLIENT layout above it still asked `admin.view`, which
 * an AUDITOR does not hold — so the page it was sent rendered "Access denied".
 * The layout now reads the same `ADMIN_PAGE_REQUIREMENTS` row the server gate
 * does. This drives the real layout, per role and per path, and asserts which
 * of the two it renders: the page, or the forbidden screen.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    return {
        useTranslations: (ns: string) => (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v : key;
        },
        useLocale: () => 'en',
    };
});

let currentPath = '/t/acme/admin/audit-log';
jest.mock('next/navigation', () => ({
    usePathname: () => currentPath,
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

import AdminLayout from '@/app/t/[tenantSlug]/(app)/admin/layout';
import { TenantProvider, type TenantContextValue } from '@/lib/tenant-context-provider';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import type { Role } from '@prisma/client';
import { makeRequestContext } from '../helpers/make-context';

const FORBIDDEN_TITLE = (require('../../messages/en.json') as { admin: { forbidden: { title: string } } })
    .admin.forbidden.title;

function tenant(role: Role, appPermissions: PermissionSet = getPermissionsForRole(role)): TenantContextValue {
    return {
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        tenantName: 'Acme',
        role,
        // The coarse tier the tenant layout threads through, as the unit
        // helper derives it (`computePermissions` imports the Prisma client).
        permissions: makeRequestContext(role).permissions,
        appPermissions,
        modules: { processCanvas: false },
    };
}

function shows(value: TenantContextValue, path: string): 'page' | 'forbidden' {
    currentPath = path;
    const { unmount } = render(
        <TenantProvider value={value}>
            <AdminLayout>
                <p>the page</p>
            </AdminLayout>
        </TenantProvider>,
    );
    const page = screen.queryByText('the page') !== null;
    const forbidden = screen.queryByText(FORBIDDEN_TITLE) !== null;
    unmount();
    if (page === forbidden) throw new Error(`rendered both or neither at ${path}`);
    return page ? 'page' : 'forbidden';
}

const AUDIT_LOG = '/t/acme/admin/audit-log';
const OTHER_ADMIN_PAGES = [
    '/t/acme/admin',
    '/t/acme/admin/members',
    '/t/acme/admin/billing',
    '/t/acme/admin/personnel',
    '/t/acme/admin/vendor-templates/t-1',
];

describe('an AUDITOR', () => {
    test('sees the audit log', () => {
        expect(shows(tenant('AUDITOR'), AUDIT_LOG)).toBe('page');
        expect(shows(tenant('AUDITOR'), `${AUDIT_LOG}/`)).toBe('page');
    });

    test.each(OTHER_ADMIN_PAGES)('is still refused %s', (path) => {
        expect(shows(tenant('AUDITOR'), path)).toBe('forbidden');
    });

    test.each([
        '/t/acme/admin/audit-log/extra',
        '/t/acme/admin/audit-log-export',
        '/t/acme/admin//audit-log',
        '/t/acme/admin/AUDIT-LOG',
    ])('is refused a path that only resembles the audit log: %s', (path) => {
        expect(shows(tenant('AUDITOR'), path)).toBe('forbidden');
    });
});

describe('the built-in roles otherwise see what they saw before', () => {
    test.each(['OWNER', 'ADMIN'] as const)('%s sees every admin page', (role) => {
        for (const path of [AUDIT_LOG, ...OTHER_ADMIN_PAGES]) {
            expect(shows(tenant(role), path)).toBe('page');
        }
    });

    test.each(['EDITOR', 'READER', 'AI_ADMIN'] as const)('%s sees no admin page, the audit log included', (role) => {
        for (const path of [AUDIT_LOG, ...OTHER_ADMIN_PAGES]) {
            expect(shows(tenant(role), path)).toBe('forbidden');
        }
    });
});

describe('a custom role follows the server gate', () => {
    test('an ADMIN base with admin.view switched off sees the audit log, as its server gate admits, and nothing else', () => {
        const base = getPermissionsForRole('ADMIN');
        const value = tenant('ADMIN', { ...base, admin: { ...base.admin, view: false } });
        expect(shows(value, AUDIT_LOG)).toBe('page');
        for (const path of OTHER_ADMIN_PAGES) expect(shows(value, path)).toBe('forbidden');
    });

    test('a READER base granted admin.view is passed by the layout floor on every page, as before', () => {
        const base = getPermissionsForRole('READER');
        const value = tenant('READER', { ...base, admin: { ...base.admin, view: true } });
        // On the audit log the server page then renders its own forbidden page,
        // because `listAuditLogs` asserts canAudit — the layout adds no refusal.
        expect(shows(value, '/t/acme/admin/members')).toBe('page');
        expect(shows(value, AUDIT_LOG)).toBe('page');
    });
});
