/**
 * The notifications page's "Mark read" — what the user sees, and what it sends.
 *
 * The page used to send a bare PATCH that its route does not accept. The
 * optimistic overlay hid the failure for a moment, then rolled back, so a
 * notification marked read came back unread. This file mounts the real page:
 * it checks the request is the one the route's own test replays
 * (tests/unit/notifications-mark-read-route.test.ts), that a notification
 * stays read when the server agrees, and that it comes back when it does not.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// One instance each: the page fetches its list in an effect keyed on
// `apiUrl`, so a fresh function per render would refetch forever.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`;
    const href = (p: string) => `/t/acme${p}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => (key: string) => {
        const v = ns.split('.').concat(key.split('.')).reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
        return typeof v === 'string' ? v : key;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/notifications',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import NotificationsPage from '@/app/t/[tenantSlug]/(app)/notifications/page';
import { MARK_NOTIFICATION_READ_REQUEST } from '@/lib/notifications/mark-read';

const MARK_READ = require('../../messages/en.json').notifications.markRead as string;

const UNREAD = {
    id: 'n1',
    type: 'EVIDENCE',
    message: 'Evidence for A.5.1 is due for review',
    createdAt: '2026-10-20T09:00:00.000Z',
    read: false,
};

function installFetch(markReadStatus: number) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const isList = url.endsWith('/notifications');
        const status = isList ? 200 : markReadStatus;
        const body = isList ? [UNREAD] : { success: status === 200 };
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
        } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
}

async function clickMarkRead() {
    const button = await screen.findByRole('button', { name: MARK_READ });
    await act(async () => {
        fireEvent.click(button);
    });
}

describe('Notifications page — Mark read', () => {
    it('sends the request the route accepts, and the notification stays read', async () => {
        const calls = installFetch(200);
        render(<NotificationsPage />);
        await screen.findByText(UNREAD.message);

        await clickMarkRead();

        const markRead = calls.find((c) => c.url === '/api/t/acme/notifications/n1');
        expect(markRead?.init).toEqual(MARK_NOTIFICATION_READ_REQUEST);
        await waitFor(() => expect(screen.queryByRole('button', { name: MARK_READ })).not.toBeInTheDocument());
        expect(screen.getByText(UNREAD.message)).toBeInTheDocument();
    });

    it('comes back unread when the server refuses', async () => {
        installFetch(405);
        render(<NotificationsPage />);
        await screen.findByText(UNREAD.message);

        await clickMarkRead();

        expect(await screen.findByRole('button', { name: MARK_READ })).toBeInTheDocument();
    });
});
