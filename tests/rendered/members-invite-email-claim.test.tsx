/**
 * The members page says it emailed an invite only when the server says it did.
 *
 * After "Send Invite" the page used to announce, unconditionally, "We also
 * emailed them an invite link." — while the route it calls sent no mail at
 * all, and a deployment with no mailer configured cannot send any. The route
 * now answers `emailSent`; the page reads it:
 *
 *   - `emailSent: true`  → "We also emailed them an invite link.", plus the
 *     link as an alternative ("Or share this link:");
 *   - `emailSent: false` → no email claim; the admin is told to copy the link
 *     and send it, and the link is shown.
 *
 * Both cases render the copyable invite link, so neither leaves the admin
 * without a way to reach the invitee.
 */
import * as React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/members',
    useSearchParams: () => new URLSearchParams(),
}));

import MembersAdminPage from '@/app/t/[tenantSlug]/(app)/admin/members/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

function renderWithInviteResponse(emailSent: boolean) {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === 'POST' && u.endsWith('/admin/members')) {
            return {
                ok: true,
                status: 201,
                json: async () => ({
                    invite: { id: 'inv-1', email: 'new.person@example.com', role: 'READER' },
                    url: '/invite/tok-abc',
                    emailSent,
                }),
            } as unknown as Response;
        }
        return { ok: true, json: async () => [] } as unknown as Response;
    }) as unknown as typeof fetch;

    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'viewer',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role: 'ADMIN',
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: getPermissionsForRole('ADMIN'),
                    modules: { processCanvas: false },
                }}
            >
                <MembersAdminPage />
            </TenantProvider>
        </TooltipProvider>,
    );
}

const byId = (id: string) => document.getElementById(id);

async function sendInvite(): Promise<HTMLElement> {
    const open = await waitFor(() => {
        const el = byId('invite-member-btn');
        if (!el) throw new Error('the invite button never rendered');
        return el;
    });
    fireEvent.click(open);
    const input = await waitFor(() => {
        const el = byId('invite-email-input');
        if (!el) throw new Error('the invite form never opened');
        return el;
    });
    fireEvent.change(input, { target: { value: 'new.person@example.com' } });
    fireEvent.click(byId('send-invite-btn')!);
    return waitFor(() => {
        const el = byId('members-success');
        if (!el) throw new Error('no success notice after the invite');
        return el;
    });
}

const posted = () =>
    (global.fetch as jest.Mock).mock.calls.filter(
        ([u, init]) => (init as RequestInit | undefined)?.method === 'POST' && String(u).endsWith('/admin/members'),
    );

describe('members page — the invite success notice', () => {
    it('says the invite was emailed when the server reports emailSent: true', async () => {
        renderWithInviteResponse(true);
        const notice = await sendInvite();

        expect(posted()).toHaveLength(1);
        const text = notice.textContent ?? '';
        expect(text).toContain('We also emailed them an invite link.');
        expect(text).not.toContain('was not emailed');
        expect(text).toContain('Or share this link:');
        expect(text).toContain('/invite/tok-abc');
    });

    it('does NOT claim an email when the server reports emailSent: false, and tells the admin to send the link', async () => {
        renderWithInviteResponse(false);
        const notice = await sendInvite();

        expect(posted()).toHaveLength(1);
        const text = notice.textContent ?? '';
        expect(text).not.toContain('emailed them');
        expect(text).toContain('The invite was not emailed — copy the link below and send it to them.');
        expect(text).toContain('Invite link:');
        expect(text).toContain('/invite/tok-abc');
    });
});
