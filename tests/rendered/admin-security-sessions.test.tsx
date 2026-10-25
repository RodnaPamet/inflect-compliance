/**
 * The Security & MFA page's session actions (#4117).
 *
 *   - "Sign Out Other Sessions" keeps you signed in. The server now leaves the
 *     session making the request alone and says so (`currentSessionKept`); the
 *     page used to send you to the sign-in page whatever happened.
 *   - Every destructive action asks in the product's confirm dialog, never the
 *     browser's `confirm()`, and "Revoke All" says plainly that it signs those
 *     members out of every workspace, not only this one.
 *   - One member's sessions are revoked by picking the member from a people
 *     picker. The page used to ask for a raw user id that no screen shows.
 */
import * as React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(120_000);

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/admin/security',
    useSearchParams: () => new URLSearchParams(),
}));

import { SWRConfig } from 'swr';
import AdminSecurityPage from '@/app/t/[tenantSlug]/(app)/admin/security/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

const EN = (
    require('../../messages/en.json') as { admin: { security: Record<string, string> } }
).admin.security;

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const refusal = (status: number, message: string) =>
    ({
        ok: false,
        status,
        json: async () => ({ error: { code: 'FORBIDDEN', message, requestId: 'req-1' } }),
    }) as unknown as Response;

/** The ACTIVE members `/users/assignable` lists — the signed-in admin among them. */
const MEMBERS = [
    { id: 'admin-1', name: 'Ada Admin', email: 'ada@acme.test', image: null },
    { id: 'user-2', name: 'Bob Builder', email: 'bob@acme.test', image: null },
    { id: 'user-3', name: 'Cleo Checker', email: 'cleo@acme.test', image: null },
];

type Handler = (init?: RequestInit) => Response;

function mount(overrides: Record<string, Handler> = {}) {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        const key = `${method} ${u.replace(/^.*\/api\/t\/acme/, '')}`;
        if (overrides[key]) return overrides[key](init);
        if (key === 'GET /security/mfa/policy') return ok({ mfaPolicy: 'OPTIONAL', sessionMaxAgeMinutes: null });
        if (key === 'GET /users/assignable') return ok(MEMBERS);
        // The two embedded cards read admin settings this test does not cover.
        return refusal(403, 'Forbidden');
    }) as unknown as typeof fetch;
    render(
        // A fresh SWR cache per test, so the member list is fetched each time.
        <SWRConfig value={{ provider: () => new Map() }}>
            <TooltipProvider>
                <TenantProvider
                    value={{
                        userId: 'admin-1',
                        tenantId: 'tenant-1',
                        tenantSlug: 'acme',
                        tenantName: 'Acme',
                        role: 'ADMIN',
                        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                        appPermissions: getPermissionsForRole('ADMIN'),
                        modules: { processCanvas: false },
                    }}
                >
                    <AdminSecurityPage />
                </TenantProvider>
            </TooltipProvider>
        </SWRConfig>,
    );
}

const calls = (key: string) =>
    (global.fetch as jest.Mock).mock.calls.filter(
        ([url, init]) => `${init?.method ?? 'GET'} ${String(url).replace(/^.*\/api\/t\/acme/, '')}` === key,
    );

async function loaded() {
    await waitFor(() => {
        if (!document.getElementById('security-save-btn')) throw new Error('not loaded yet');
    });
}

let confirmSpy: jest.SpyInstance;
beforeEach(() => {
    // `confirm` is not implemented in jsdom; spying lets each test assert the
    // page never reaches for it.
    window.confirm = () => true;
    confirmSpy = jest.spyOn(window, 'confirm');
});
afterEach(() => {
    expect(confirmSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

describe('Sign Out Other Sessions', () => {
    it('asks in the confirm dialog, and keeps you signed in when the server kept this session', async () => {
        const user = userEvent.setup();
        mount({
            'POST /security/sessions/revoke-current': () =>
                ok({ success: true, currentSessionKept: true, sessionsRevoked: 2 }),
        });
        await loaded();

        await user.click(document.getElementById('revoke-my-sessions-btn') as HTMLElement);
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(EN.signOutOthersConfirmBody);
        // Nothing is sent before the dialog is confirmed.
        expect(calls('POST /security/sessions/revoke-current')).toHaveLength(0);

        await user.click(within(dialog).getByRole('button', { name: EN.signOutOthersConfirmLabel }));

        expect(await screen.findByText(EN.otherSessionsRevoked)).toBeInTheDocument();
        expect(screen.queryByText(EN.mySessionsRevoked)).not.toBeInTheDocument();
        expect(calls('POST /security/sessions/revoke-current')).toHaveLength(1);
    });

    it('says you will be signed out when the server could not keep this session', async () => {
        const user = userEvent.setup();
        mount({
            'POST /security/sessions/revoke-current': () =>
                ok({ success: true, currentSessionKept: false, sessionsRevoked: 3 }),
        });
        await loaded();

        await user.click(document.getElementById('revoke-my-sessions-btn') as HTMLElement);
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: EN.signOutOthersConfirmLabel }));

        expect(await screen.findByText(EN.mySessionsRevoked)).toBeInTheDocument();
    });

    it("shows the server's sentence when it is refused", async () => {
        const user = userEvent.setup();
        mount({ 'POST /security/sessions/revoke-current': () => refusal(429, 'Too many requests. Try again later.') });
        await loaded();

        await user.click(document.getElementById('revoke-my-sessions-btn') as HTMLElement);
        await user.click(
            within(await screen.findByRole('dialog')).getByRole('button', { name: EN.signOutOthersConfirmLabel }),
        );

        expect(await screen.findByText('Too many requests. Try again later.')).toBeInTheDocument();
    });
});

describe('Revoke All User Sessions', () => {
    it('says it signs members out of every workspace, and sends only once confirmed', async () => {
        const user = userEvent.setup();
        mount({
            'POST /security/sessions/revoke-all': () =>
                ok({ success: true, usersAffected: 3, currentSessionKept: true }),
        });
        await loaded();

        await user.click(document.getElementById('revoke-all-sessions-btn') as HTMLElement);
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(EN.revokeAllConfirmBody);
        expect(dialog).toHaveTextContent(/every other workspace they belong to/);
        expect(calls('POST /security/sessions/revoke-all')).toHaveLength(0);

        await user.click(within(dialog).getByRole('button', { name: EN.revokeAllConfirmLabel }));

        expect(await screen.findByText(EN.allRevoked.replace('{count}', '3'))).toBeInTheDocument();
        expect(calls('POST /security/sessions/revoke-all')).toHaveLength(1);
    });
});

describe("Revoking one member's sessions", () => {
    it('picks the member by name, leaves you out of the list, and sends their id', async () => {
        const user = userEvent.setup();
        mount({ 'POST /security/sessions/revoke-user': () => ok({ success: true, userId: 'user-2' }) });
        await loaded();

        // There is no free-text id box any more.
        expect(document.getElementById('revoke-user-id-input')).toBeNull();
        const revoke = document.getElementById('revoke-user-btn') as HTMLButtonElement;
        expect(revoke).toBeDisabled();

        await user.click(screen.getByRole('combobox'));
        const bob = await screen.findByRole('option', { name: /Bob Builder/ });
        expect(screen.getByRole('option', { name: /Cleo Checker/ })).toBeInTheDocument();
        // "Sign Out Other Sessions" is your own action.
        expect(screen.queryByRole('option', { name: /Ada Admin/ })).not.toBeInTheDocument();
        await user.click(bob);

        await waitFor(() => expect(revoke).toBeEnabled());
        await user.click(revoke);
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(EN.revokeUserConfirmTitle.replace('{name}', 'Bob Builder'));
        expect(calls('POST /security/sessions/revoke-user')).toHaveLength(0);

        await user.click(within(dialog).getByRole('button', { name: EN.revokeUserConfirmLabel }));

        expect(await screen.findByText(EN.userSessionsRevoked.replace('{name}', 'Bob Builder'))).toBeInTheDocument();
        const [[, init]] = calls('POST /security/sessions/revoke-user');
        expect(JSON.parse(String(init?.body))).toEqual({ targetUserId: 'user-2' });
    });

    it("shows the server's sentence when it is refused", async () => {
        const user = userEvent.setup();
        mount({ 'POST /security/sessions/revoke-user': () => refusal(404, 'Target user is not a member of this tenant') });
        await loaded();

        await user.click(screen.getByRole('combobox'));
        await user.click(await screen.findByRole('option', { name: /Cleo Checker/ }));
        await user.click(document.getElementById('revoke-user-btn') as HTMLElement);
        await user.click(
            within(await screen.findByRole('dialog')).getByRole('button', { name: EN.revokeUserConfirmLabel }),
        );

        expect(await screen.findByText('Target user is not a member of this tenant')).toBeInTheDocument();
        expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
    });
});
