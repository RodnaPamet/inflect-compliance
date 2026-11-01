/**
 * THE NEW-WORKSPACE FORM DOES WHAT ITS FRAMEWORK CHOICE SAYS (#4844).
 *
 *   1. Choosing a framework lands on that framework's install page in the new
 *      workspace, after the session's claims are re-minted. It used to land on
 *      the frameworks list with an `?install=` hint that page never read.
 *   2. "Choose later" lands on the new workspace's dashboard.
 *   3. A refused create says the workspace was not created, with no HTTP status.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

const pushMock = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: pushMock, refresh: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/org/acme/tenants/new',
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string) => {
        const v = resolve(`${ns}.${key}`);
        return typeof v === 'string' ? v : key;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});
const refreshClaims = jest.fn(async () => undefined);
jest.mock('@/lib/auth/refresh-session-claims', () => ({ refreshSessionClaims: () => refreshClaims() }));

import { NewTenantForm } from '@/app/org/[orgSlug]/(app)/tenants/new/NewTenantForm';

const EN = (require('../../messages/en.json') as { org: { newTenant: Record<string, string> } }).org.newTenant;

function stubCreate(answer: { ok: boolean; status: number; body?: unknown }) {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
        ok: answer.ok,
        status: answer.status,
        json: async () => {
            if (answer.body === undefined) throw new Error('not JSON');
            return answer.body;
        },
    })) as unknown as typeof fetch;
}

beforeEach(() => {
    pushMock.mockReset();
    refreshClaims.mockClear();
});
afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

async function fillAndSubmit(framework: 'later' | 'ISO27001' | 'NIS2') {
    const user = userEvent.setup();
    render(<NewTenantForm orgSlug="acme" />);
    await user.type(screen.getByTestId('org-new-tenant-name'), 'Acme EU');
    if (framework !== 'later') await user.click(screen.getByTestId(`org-new-tenant-framework-${framework}`));
    await user.click(screen.getByTestId('org-new-tenant-submit'));
}

it.each(['ISO27001', 'NIS2'] as const)('choosing %s lands on its install page in the new workspace', async (fw) => {
    stubCreate({ ok: true, status: 201, body: { tenant: { slug: 'acme-eu' } } });
    await fillAndSubmit(fw);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/t/acme-eu/frameworks/${fw}/install`));
    expect(refreshClaims).toHaveBeenCalledTimes(1);
    expect(refreshClaims.mock.invocationCallOrder[0]).toBeLessThan(pushMock.mock.invocationCallOrder[0]);
});

it('choosing later lands on the new workspace\'s dashboard', async () => {
    stubCreate({ ok: true, status: 201, body: { tenant: { slug: 'acme-eu' } } });
    await fillAndSubmit('later');
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/t/acme-eu/dashboard'));
});

it('a refused create says the workspace was not created, with no status code', async () => {
    stubCreate({ ok: false, status: 409 });
    await fillAndSubmit('later');
    const alert = await screen.findByTestId('org-new-tenant-error');
    expect(alert).toHaveTextContent(EN.tenantCreationFailed);
    expect(alert.textContent ?? '').not.toMatch(/409/);
    expect(pushMock).not.toHaveBeenCalled();
});
