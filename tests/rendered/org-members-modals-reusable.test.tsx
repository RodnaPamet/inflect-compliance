/**
 * The members page's modals can be used twice in a row (#5272).
 *
 * Each modal stays mounted between uses. Remove and Change role cleared their
 * busy state only on a failure, so after one success the next open had its
 * button already disabled and spinning; Invite's Done closed without clearing
 * the issued link, so the next Invite opened on the previous result.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

const member = (userId: string, role: 'ORG_OWNER' | 'ORG_ADMIN' | 'ORG_READER') => ({
    membershipId: `m-${userId}`,
    userId,
    role,
    joinedAt: '2026-01-01T00:00:00.000Z',
    user: { id: userId, email: `${userId}@example.com`, name: userId },
});

beforeEach(() => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ url: '/invite/tok-1', emailSent: true, invite: { email: 'new@example.com' } }),
    })) as unknown as typeof fetch;
});
afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

function mount() {
    render(
        <MembersTable
            orgSlug="acme"
            currentUserId="owner"
            viewerRole="ORG_OWNER"
            rows={[member('owner', 'ORG_OWNER'), member('a', 'ORG_READER'), member('b', 'ORG_READER')]}
            invites={[]}
        />,
    );
}

describe('a members-page modal after one success', () => {
    it('Remove opens ready for the next member', async () => {
        mount();
        fireEvent.click(screen.getByTestId('org-member-remove-a'));
        fireEvent.click(await screen.findByTestId('org-remove-member-confirm'));
        await waitFor(() => expect(screen.queryByTestId('org-remove-member-confirm')).toBeNull());

        fireEvent.click(screen.getByTestId('org-member-remove-b'));
        expect(await screen.findByTestId('org-remove-member-confirm')).toBeEnabled();
    });

    it('Change role opens ready for the next member', async () => {
        mount();
        fireEvent.click(screen.getByTestId('org-member-role-a'));
        fireEvent.click(await screen.findByTestId('org-change-role-submit'));
        await waitFor(() => expect(screen.queryByTestId('org-change-role-submit')).toBeNull());

        fireEvent.click(screen.getByTestId('org-member-role-b'));
        expect(await screen.findByTestId('org-change-role-submit')).toBeEnabled();
    });

    it('Invite opens on an empty form, not on the previous result', async () => {
        mount();
        fireEvent.click(screen.getByTestId('org-members-invite-button'));
        fireEvent.change(await screen.findByTestId('org-invite-member-email'), {
            target: { value: 'new@example.com' },
        });
        fireEvent.click(screen.getByTestId('org-invite-member-submit'));
        fireEvent.click(await screen.findByTestId('org-invite-issued-done'));
        await waitFor(() => expect(screen.queryByTestId('org-invite-issued')).toBeNull());

        fireEvent.click(screen.getByTestId('org-members-invite-button'));
        expect(await screen.findByTestId('org-invite-member-email')).toHaveValue('');
        expect(screen.queryByTestId('org-invite-issued')).toBeNull();
    });
});
