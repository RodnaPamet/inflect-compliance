/**
 * The admin hub offers the workspace language only to a holder of
 * `admin.manage`, the key its PUT takes, with the stored value selected — and
 * never reads it for anybody else.
 */
import { render, screen } from '@testing-library/react';
import type { Role } from '@prisma/client';
import { makeRequestContext } from '../helpers/make-context';

const gateCtx = { current: makeRequestContext('ADMIN') };
jest.mock('@/app/t/[tenantSlug]/(app)/admin/_lib/admin-page-gate', () => ({
    __esModule: true,
    gateAdminPage: async () => ({ allowed: true, ctx: gateCtx.current, tenantSlug: 'acme' }),
}));

jest.mock('@/components/theme/ThemeToggle', () => ({ ThemeToggle: () => null }));

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    return { useTenantApiUrl: () => apiUrl };
});

const getWorkspaceLanguage = jest.fn(async () => ({ defaultLocale: 'bg' }));
jest.mock('@/app-layer/usecases/workspace-language', () => ({
    __esModule: true,
    getWorkspaceLanguage: () => getWorkspaceLanguage(),
}));

jest.mock('next-intl/server', () => {
    const lookup = (bag: unknown, key: string): unknown =>
        key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), bag);
    return {
        __esModule: true,
        getTranslations: async (ns: string) => {
            const en = require('../../messages/en.json') as Record<string, unknown>;
            const bag = lookup(en, ns);
            return (key: string) => {
                const v = lookup(bag, key);
                return typeof v === 'string' ? v : key;
            };
        },
    };
});

import AdminPage from '@/app/t/[tenantSlug]/(app)/admin/page';

async function renderHubAs(role: Role) {
    gateCtx.current = makeRequestContext(role);
    const ui = await AdminPage({ params: Promise.resolve({ tenantSlug: 'acme' }) });
    return render(ui);
}

beforeEach(() => getWorkspaceLanguage.mockClear());

describe('the workspace language on the admin hub', () => {
    it.each(['ADMIN', 'OWNER'] as const)('a %s is offered it, with the stored language selected', async (role) => {
        await renderHubAs(role);
        expect(screen.getByTestId('workspace-language-card')).toBeInTheDocument();
        expect(screen.getByTestId('workspace-language-bg')).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('region', { name: 'Workspace' })).toBeInTheDocument();
    });

    it('somebody without admin.manage is neither shown it nor has it read', async () => {
        const ctx = makeRequestContext('ADMIN');
        gateCtx.current = { ...ctx, appPermissions: { ...ctx.appPermissions, admin: { ...ctx.appPermissions.admin, manage: false } } };
        const ui = await AdminPage({ params: Promise.resolve({ tenantSlug: 'acme' }) });
        render(ui);
        expect(screen.queryByTestId('workspace-language-card')).not.toBeInTheDocument();
        expect(getWorkspaceLanguage).not.toHaveBeenCalled();
    });
});
