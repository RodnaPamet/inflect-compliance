/**
 * The workspace language is an EN | БГ toggle under the theme switch in the
 * admin hub's header (owner decision 2026-11-25, #5965).
 *
 *   1. A holder of `admin.manage` sees it, in the header box directly under
 *      the theme switch, with the stored language selected; each option is
 *      named by its endonym, and the help icon says it is not anyone's
 *      interface language.
 *   2. Choosing the other language PUTs it at once and adopts the answer.
 *   3. A refused save puts the stored language back and says so.
 *   4. Somebody without `admin.manage` is neither shown it nor has it read.
 *   5. The hub no longer renders the old card at its foot.
 *
 * The real page is rendered the way Next renders it, with the client toggle
 * inside it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@prisma/client';
import { makeRequestContext } from '../helpers/make-context';

const gateCtx = { current: makeRequestContext('ADMIN') };
jest.mock('@/app/t/[tenantSlug]/(app)/admin/_lib/admin-page-gate', () => ({
    __esModule: true,
    gateAdminPage: async () => ({ allowed: true, ctx: gateCtx.current, tenantSlug: 'acme' }),
}));

jest.mock('@/components/theme/ThemeToggle', () => ({
    ThemeToggle: ({ id }: { id?: string }) => <button type="button" id={id} aria-label="theme" />,
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    return { useTenantApiUrl: () => apiUrl };
});

const toast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn() };
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({
    __esModule: true,
    useToast: () => toast,
}));

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
import { LOCALE_LABELS } from '@/lib/locale-constants';

const EN = (require('../../messages/en.json') as { workspaceLanguage: Record<string, string> }).workspaceLanguage;

async function renderHubAs(role: Role, overrides?: { manage: boolean }) {
    const ctx = makeRequestContext(role);
    gateCtx.current = overrides
        ? { ...ctx, appPermissions: { ...ctx.appPermissions, admin: { ...ctx.appPermissions.admin, manage: overrides.manage } } }
        : ctx;
    const ui = await AdminPage({ params: Promise.resolve({ tenantSlug: 'acme' }) });
    return render(ui);
}

function respond(ok: boolean, body: unknown) {
    const fetchMock = jest.fn().mockResolvedValue({ ok, status: ok ? 200 : 403, json: async () => body });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
}

beforeEach(() => {
    getWorkspaceLanguage.mockClear();
    Object.values(toast).forEach((f) => f.mockClear());
});

describe('the workspace language toggle in the admin hub header', () => {
    it.each(['ADMIN', 'OWNER'] as const)('a %s sees it under the theme switch, with the stored language selected', async (role) => {
        const { container } = await renderHubAs(role);
        const box = container.querySelector('#admin-header-settings');
        const theme = container.querySelector('#admin-theme-toggle');
        const toggle = container.querySelector('#workspace-language-toggle');
        expect(box).not.toBeNull();
        expect(theme).not.toBeNull();
        expect(toggle).not.toBeNull();
        // One header box: the theme row first, the language toggle after it.
        expect(box).toContainElement(theme as HTMLElement);
        expect(box).toContainElement(toggle as HTMLElement);
        expect(theme!.compareDocumentPosition(toggle!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(box!.closest('header')).not.toBeNull();

        const group = screen.getByRole('radiogroup', { name: EN.title });
        expect(toggle).toContainElement(group);
        expect(screen.getByRole('radio', { name: LOCALE_LABELS.bg })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('radio', { name: LOCALE_LABELS.en })).toHaveAttribute('aria-checked', 'false');
        expect(container.querySelector('#workspace-language-bg')).toHaveAttribute('aria-checked', 'true');
        // The help icon beside the label carries what it is NOT.
        expect(screen.getByRole('button', { name: `More info about ${EN.title}` })).toBeInTheDocument();
    });

    it('a change PUTs the new language at once and adopts the answer', async () => {
        const user = userEvent.setup();
        const fetchMock = respond(true, { defaultLocale: 'en' });
        await renderHubAs('ADMIN');

        await user.click(screen.getByRole('radio', { name: LOCALE_LABELS.en }));

        await waitFor(() => expect(toast.success).toHaveBeenCalledWith(EN.saved));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/admin/workspace-language', expect.objectContaining({
            method: 'PUT',
            body: JSON.stringify({ defaultLocale: 'en' }),
        }));
        expect(screen.getByRole('radio', { name: LOCALE_LABELS.en })).toHaveAttribute('aria-checked', 'true');
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('choosing the language already shown sends nothing', async () => {
        const user = userEvent.setup();
        const fetchMock = respond(true, { defaultLocale: 'bg' });
        await renderHubAs('ADMIN');
        await user.click(screen.getByRole('radio', { name: LOCALE_LABELS.bg }));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a refused save puts the stored language back and says so', async () => {
        const user = userEvent.setup();
        respond(false, {});
        await renderHubAs('ADMIN');

        await user.click(screen.getByRole('radio', { name: LOCALE_LABELS.en }));

        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(EN.saveFailed));
        expect(screen.getByRole('radio', { name: LOCALE_LABELS.bg })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('radio', { name: LOCALE_LABELS.en })).toHaveAttribute('aria-checked', 'false');
        expect(toast.success).not.toHaveBeenCalled();
    });

    it('a save that never reaches the server also puts the stored language back', async () => {
        const user = userEvent.setup();
        global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
        await renderHubAs('ADMIN');

        await user.click(screen.getByRole('radio', { name: LOCALE_LABELS.en }));

        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(EN.saveFailed));
        expect(screen.getByRole('radio', { name: LOCALE_LABELS.bg })).toHaveAttribute('aria-checked', 'true');
    });

    it('somebody without admin.manage is neither shown it nor has it read', async () => {
        const { container } = await renderHubAs('ADMIN', { manage: false });
        expect(container.querySelector('#workspace-language-toggle')).toBeNull();
        expect(screen.queryByRole('radiogroup', { name: EN.title })).not.toBeInTheDocument();
        expect(getWorkspaceLanguage).not.toHaveBeenCalled();
        // The theme switch is still there.
        expect(container.querySelector('#admin-theme-toggle')).not.toBeNull();
    });

    it('the hub no longer renders the card at its foot', async () => {
        await renderHubAs('OWNER');
        expect(screen.queryByTestId('workspace-language-card')).not.toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Workspace' })).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: EN.title })).not.toBeInTheDocument();
    });
});
