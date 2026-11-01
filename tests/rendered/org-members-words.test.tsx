/**
 * THE ORG MEMBERS PAGE SPEAKS IN WORDS (#4848).
 *
 *   1. A named refusal (the last owner or admin) is shown in the page's own
 *      sentence, never the server's, which printed stored role values and
 *      offered to "delete the organization".
 *   2. A failure that names nothing says what did not happen, with no HTTP
 *      status.
 *   3. Revoking an invitation asks first; cancelling sends nothing.
 *   4. Adding someone directly says they join at once, and, for an admin,
 *      that they get Admin access to every workspace (owner decision,
 *      2026-11-01).
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

jest.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: jest.fn(), push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/org/acme/members',
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(`${ns}.${key}`);
            if (typeof v !== 'string') return key;
            for (const [p, val] of Object.entries(params ?? {})) v = (v as string).split(`{${p}}`).join(String(val));
            return v as string;
        };
        t.rich = (key: string, params?: Record<string, unknown>) => t(key, params).replace(/<\/?b>/g, '');
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

import { MembersTable } from '@/app/org/[orgSlug]/(app)/members/MembersTable';

const EN = (require('../../messages/en.json') as {
    org: { members: Record<string, string> & { refused: Record<string, string> } };
}).org.members;

const member = (userId: string, role: 'ORG_OWNER' | 'ORG_ADMIN' | 'ORG_READER') => ({
    membershipId: `m-${userId}`,
    userId,
    role,
    joinedAt: '2026-01-01T00:00:00.000Z',
    user: { id: userId, email: `${userId}@example.com`, name: userId },
});
const invite = {
    id: 'inv-1',
    email: 'newcomer@example.com',
    role: 'ORG_READER' as const,
    expiresAt: '2026-11-08T00:00:00.000Z',
    createdAt: '2026-11-01T00:00:00.000Z',
    invitedBy: { id: 'owner', name: 'owner', email: 'owner@example.com' },
};

type Call = { url: string; method: string };
let calls: Call[] = [];
function stubFetch(answer: { ok: boolean; status: number; body?: unknown }) {
    calls = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET' });
        return {
            ok: answer.ok,
            status: answer.status,
            json: async () => {
                if (answer.body === undefined) throw new Error('not JSON');
                return answer.body;
            },
        };
    }) as unknown as typeof fetch;
}
afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

function mount() {
    render(
        <MembersTable
            orgSlug="acme"
            currentUserId="owner"
            viewerRole="ORG_OWNER"
            rows={[member('owner', 'ORG_OWNER'), member('admin', 'ORG_ADMIN')]}
            invites={[invite]}
        />,
    );
}

describe('the org members page', () => {
    it("shows a named refusal in the page's own words", async () => {
        const user = userEvent.setup();
        const english = 'Cannot remove the last owner or admin of an organization. Make another member an admin first.';
        stubFetch({ ok: false, status: 409, body: { error: { code: 'CONFLICT', message: english, details: { reason: 'LAST_ORG_ADMIN' } } } });
        mount();
        await user.click(screen.getByTestId('org-member-remove-admin'));
        await user.click(await screen.findByTestId('org-remove-member-confirm'));
        const notice = await screen.findByTestId('org-remove-member-error');
        expect(notice).toHaveTextContent(EN.refused.LAST_ORG_ADMIN);
        expect(notice).not.toHaveTextContent(english);
        expect(notice.textContent ?? '').not.toMatch(/ORG_|delete the organization/);
    });

    it('says what did not happen, with no status code, when nothing is named', async () => {
        const user = userEvent.setup();
        stubFetch({ ok: false, status: 500 });
        mount();
        await user.click(screen.getByTestId('org-member-remove-admin'));
        await user.click(await screen.findByTestId('org-remove-member-confirm'));
        const notice = await screen.findByTestId('org-remove-member-error');
        expect(notice).toHaveTextContent(EN.failedRemoveMember);
        expect(notice.textContent ?? '').not.toMatch(/500/);
    });

    it('asks before revoking an invitation, and cancelling sends nothing', async () => {
        const user = userEvent.setup();
        stubFetch({ ok: true, status: 200, body: {} });
        mount();
        await user.click(screen.getByTestId('org-invite-revoke-inv-1'));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('The invitation to newcomer@example.com stops working at once.');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(calls).toEqual([]);

        await user.click(screen.getByTestId('org-invite-revoke-inv-1'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: EN.revokeInviteConfirm }));
        expect(calls).toEqual([{ url: '/api/org/acme/invites/inv-1', method: 'DELETE' }]);
    });

    it('says a direct add joins at once, and what an admin gets', async () => {
        const user = userEvent.setup();
        mount();
        await user.click(screen.getByTestId('org-members-add-button'));
        const note = await screen.findByTestId('org-add-member-joins-now');
        expect(note).toHaveTextContent(EN.addMemberJoinsNow);
        expect(note).not.toHaveTextContent(EN.addMemberAdminReach);
        await user.click(screen.getByTestId('org-add-member-role-ORG_ADMIN'));
        expect(screen.getByTestId('org-add-member-joins-now')).toHaveTextContent(EN.addMemberAdminReach);
    });
});
