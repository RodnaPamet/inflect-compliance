/**
 * #4868 — the SCIM page says what the server said.
 *
 * A refused revoke used to be swallowed, so the token stayed listed with no
 * word; a failed load printed a status code; and the status pill read
 * "Not Configured" in a hand-rolled chip.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/scim',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = ns.split('.').reduce((o: Record<string, unknown>, k) => (o?.[k] as Record<string, unknown>) ?? {}, en);
        const resolve = (key: string) =>
            key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = resolve(key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.rich = (key: string) => t(key);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

const toast = { success: jest.fn(), error: jest.fn() };
jest.mock('@inflect/ui/components/ui/hooks/use-toast', () => ({ useToast: () => toast }));
jest.mock('@/components/admin/IdentityCrossLinks', () => ({ IdentityCrossLinks: () => null }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

import ScimAdminPage from '@/app/t/[tenantSlug]/(app)/admin/scim/page';

const STATE = {
    tokens: [{ id: 'tok-1', label: 'Okta SCIM', lastUsedAt: null, revokedAt: null, createdAt: '2026-10-01T00:00:00Z' }],
    scimEndpoint: 'https://app.example.com/api/scim/v2',
    isEnabled: true,
};

type Handler = (url: string, init?: RequestInit) => { ok: boolean; status: number; body: unknown };
function mockFetch(handler: Handler) {
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const r = handler(url, init);
        return { ok: r.ok, status: r.status, json: async () => r.body } as Response;
    }) as unknown as typeof fetch;
}

beforeEach(() => jest.clearAllMocks());

describe('the SCIM page', () => {
    it('says Not configured in sentence case on a badge when no token is active', async () => {
        mockFetch(() => ({ ok: true, status: 200, body: { ...STATE, tokens: [], isEnabled: false } }));
        render(<ScimAdminPage />);
        expect(await screen.findByText('Not configured')).toBeInTheDocument();
        expect(document.getElementById('scim-status')).toHaveTextContent('Not configured');
    });

    it("a failed load shows the server's sentence, not a status code", async () => {
        mockFetch(() => ({ ok: false, status: 500, body: { error: { code: 'INTERNAL', message: 'The database is unreachable.' } } }));
        render(<ScimAdminPage />);
        const notice = await screen.findByRole('alert');
        expect(notice).toHaveTextContent('The database is unreachable.');
        expect(notice).not.toHaveTextContent('500');
    });

    it('a refused revoke says so and keeps the token listed', async () => {
        mockFetch((_url, init) =>
            init?.method === 'DELETE'
                ? { ok: false, status: 404, body: { error: { code: 'NOT_FOUND', message: 'This token no longer exists in this workspace.' } } }
                : { ok: true, status: 200, body: STATE },
        );
        render(<ScimAdminPage />);

        fireEvent.click(await screen.findByRole('button', { name: /Revoke/ }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: /Revoke/ }));

        await waitFor(() =>
            expect(document.getElementById('scim-error')).toHaveTextContent(
                'This token no longer exists in this workspace.',
            ),
        );
        expect(screen.getByText('Okta SCIM')).toBeInTheDocument();
        expect(toast.success).not.toHaveBeenCalled();
    });

    it('a revoke the server accepted is confirmed', async () => {
        mockFetch((_url, init) =>
            init?.method === 'DELETE' ? { ok: true, status: 200, body: { ok: true } } : { ok: true, status: 200, body: STATE },
        );
        render(<ScimAdminPage />);

        fireEvent.click(await screen.findByRole('button', { name: /Revoke/ }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: /Revoke/ }));

        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Token revoked'));
    });

    it('the token label field has a label, and the endpoint has no external-link icon', async () => {
        mockFetch(() => ({ ok: true, status: 200, body: STATE }));
        render(<ScimAdminPage />);

        fireEvent.click(await screen.findByRole('button', { name: /Token/ }));
        expect(screen.getByLabelText('Token label')).toHaveAttribute('id', 'token-label-input');
        expect(document.querySelector('.lucide-external-link')).toBeNull();
    });
});
