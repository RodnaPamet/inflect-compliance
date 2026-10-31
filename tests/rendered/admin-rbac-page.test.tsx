/**
 * #4821 — Roles & Access says roles and permissions in words, tells an active
 * member from a deactivated, removed or invited one, and shows a member's
 * custom role.
 */
import * as React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const EN = jest.requireActual('../../messages/en.json') as Record<string, unknown> & {
    roles: Record<string, string>;
    admin: { resourceLabels: Record<string, string>; roles: { actions: Record<string, string> }; rbac: { status: Record<string, string> } };
};

jest.mock('next-intl/server', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const lookup = (o: unknown, path: string): unknown =>
        path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
    return {
        __esModule: true,
        getTranslations: async (ns: string) => {
            const bag = lookup(en, ns);
            const t = (key: string, values?: Record<string, unknown>) => {
                const v = lookup(bag, key);
                if (typeof v !== 'string') return key;
                return v.replace(/\{(\w+)\}/g, (_m, k: string) => String(values?.[k] ?? ''));
            };
            t.rich = (key: string) => t(key);
            t.has = (key: string) => typeof lookup(bag, key) === 'string';
            return t;
        },
    };
});

jest.mock('@/app/t/[tenantSlug]/(app)/admin/_lib/admin-page-gate', () => ({
    gateAdminPage: async () => ({ allowed: true, ctx: { tenantId: 't1', role: 'ADMIN' }, tenantSlug: 'acme' }),
}));

const membership = (id: string, over: Record<string, unknown>) => ({
    id,
    role: 'EDITOR',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01'),
    user: { id: `u-${id}`, name: `Person ${id}`, email: `${id}@acme.test` },
    customRole: null,
    ...over,
});
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: { findUnique: async () => ({ name: 'Acme' }) },
        tenantMembership: {
            findMany: async () => [
                membership('a', { role: 'OWNER' }),
                membership('b', { status: 'DEACTIVATED' }),
                membership('c', { role: 'READER', customRole: { name: 'Auditor lite' } }),
                membership('d', { role: 'AI_ADMIN', status: 'INVITED' }),
            ],
        },
    },
}));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));
jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import RbacPage from '@/app/t/[tenantSlug]/(app)/admin/rbac/page';

afterEach(cleanup);

async function renderPage() {
    const el = await RbacPage({ params: Promise.resolve({ tenantSlug: 'acme' }) });
    return render(<NextIntlClientProvider locale="en" messages={EN}>{el}</NextIntlClientProvider>);
}

it('labels the role columns, the domains and the actions, not the stored keys', async () => {
    await renderPage();
    const matrix = document.querySelector('table.data-table') as HTMLElement;
    const heads = within(matrix).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(expect.arrayContaining([EN.roles.OWNER, EN.roles.AI_ADMIN]));
    expect(heads).not.toContain('AI_ADMIN');
    expect(within(matrix).getAllByText(EN.admin.resourceLabels.admin).length).toBeGreaterThan(0);
    expect(within(matrix).queryByText('compliance_dsar_manage')).toBeNull();
    expect(document.getElementById('rbac-your-role')).toHaveTextContent(EN.roles.ADMIN);
});

it('tells each membership\'s status, so a deactivated person is not read as active', async () => {
    await renderPage();
    expect(screen.getByTestId('rbac-status-a')).toHaveTextContent(EN.admin.rbac.status.ACTIVE);
    expect(screen.getByTestId('rbac-status-b')).toHaveTextContent(EN.admin.rbac.status.DEACTIVATED);
    expect(screen.getByTestId('rbac-status-d')).toHaveTextContent(EN.admin.rbac.status.INVITED);
});

it('shows a member\'s custom role beside the built-in one', async () => {
    await renderPage();
    expect(screen.getByTestId('rbac-custom-role-c')).toHaveTextContent('Auditor lite');
    expect(screen.queryByTestId('rbac-custom-role-a')).toBeNull();
});
