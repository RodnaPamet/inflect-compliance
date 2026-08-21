/**
 * The break-glass flag's operator surface.
 *
 * `disableAccount` has refused a protected account since #2036, with the refusal
 * and its reason tested — and nothing ever SET the flag, so the rail was a guard
 * bound to nothing. These tests cover the half that was missing, at the layer an
 * operator actually touches.
 *
 * The load-bearing assertions:
 *   1. Protecting REQUIRES a reason — the submit stays disabled without one, and
 *      the usecase refuses too, so the rule is not only a UI courtesy.
 *   2. Releasing does NOT require one, and does not open the modal at all.
 *   3. The PATCH goes to the sibling path, not to a route nested under
 *      admin/integrations — nesting would resolve to a weaker permission.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/integrations/identity-accounts',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = en[ns] || {};
        const resolve = (key: string) =>
            key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
        const t = (key: string) => {
            const v = resolve(key);
            return typeof v === 'string' ? v : key;
        };
        t.rich = t;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import IdentityAccountsPage from '@/app/t/[tenantSlug]/(app)/admin/integrations/identity-accounts/page';

const account = (over: Record<string, unknown> = {}) => ({
    id: 'acct-1',
    provider: 'entra-id',
    email: 'ada@acme.test',
    displayName: 'Ada L',
    status: 'ACTIVE',
    isAdmin: false,
    mfaEnrolled: true,
    lastActiveAt: null,
    syncedAt: null,
    isProtected: false,
    protectionReason: null,
    ...over,
});

function mockFetch(rows: Array<Record<string, unknown>>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fn = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (init?.method === 'PATCH') return { ok: true, json: async () => ({ protection: {} }) } as Response;
        return { ok: true, json: async () => ({ accounts: rows }) } as Response;
    });
    global.fetch = fn as unknown as typeof fetch;
    return calls;
}

describe('the never-offboard flag on the identity roster', () => {
    it('offers Protect on an unprotected account and does not submit without a reason', async () => {
        mockFetch([account()]);
        render(<IdentityAccountsPage />);

        const protectBtn = await screen.findByRole('button', { name: 'Protect' });
        fireEvent.click(protectBtn);

        // The modal opened rather than firing a write straight away.
        expect(await screen.findByText(/Why must this account never be offboarded/i)).toBeInTheDocument();

        // Submit is disabled with an empty reason. The usecase refuses too — the
        // UI is the courtesy, not the rule.
        const submit = screen.getAllByRole('button', { name: 'Protect' }).at(-1)!;
        expect(submit).toBeDisabled();
    });

    it('PATCHes the SIBLING path once a reason is given', async () => {
        const calls = mockFetch([account()]);
        render(<IdentityAccountsPage />);

        fireEvent.click(await screen.findByRole('button', { name: 'Protect' }));
        fireEvent.change(await screen.findByLabelText(/Reason/), {
            target: { value: 'break-glass admin' },
        });
        fireEvent.click(screen.getAllByRole('button', { name: 'Protect' }).at(-1)!);

        await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true));
        const patch = calls.find((c) => c.init?.method === 'PATCH')!;
        // The sibling path. Nested under admin/integrations it would match the
        // admin.manage rule instead of admin.tenant_lifecycle.
        expect(patch.url).toBe('/api/t/acme/admin/identity-account-protection/acct-1');
        expect(JSON.parse(String(patch.init?.body))).toEqual({ isProtected: true, reason: 'break-glass admin' });
    });

    it('releases WITHOUT a modal and without a reason', async () => {
        const calls = mockFetch([account({ isProtected: true, protectionReason: 'break-glass admin' })]);
        render(<IdentityAccountsPage />);

        fireEvent.click(await screen.findByRole('button', { name: 'Release' }));

        await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true));
        const patch = calls.find((c) => c.init?.method === 'PATCH')!;
        expect(JSON.parse(String(patch.init?.body))).toEqual({ isProtected: false, reason: null });
        // No reason prompt was ever shown — releasing needs no justification.
        expect(screen.queryByText(/Why must this account never be offboarded/i)).not.toBeInTheDocument();
    });

    it('shows a protected account as protected', async () => {
        mockFetch([account({ isProtected: true, protectionReason: 'shared ops mailbox' })]);
        render(<IdentityAccountsPage />);

        expect(await screen.findByText('Protected')).toBeInTheDocument();
        // Plain text, not a StatusBadge: this page sits at the badge-density cap,
        // and an unclickable badge beside a button reads as two controls.
        expect(screen.getByText('Protected').tagName).toBe('SPAN');
    });
});
