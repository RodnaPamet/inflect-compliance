/** @jest-environment jsdom */

/**
 * #4643 — the bell lists the OPEN workspace's notifications, links to the
 * workspace's inbox, and the inbox says what it is doing.
 *
 * The bell read `/api/notifications`, which resolves the session's FIRST
 * workspace, so a person in several workspaces saw the first one's
 * notifications in every bell and never the open one's. The inbox page had no
 * link anywhere, hid each notification's title and link, and showed "No
 * notifications" while it loaded and when it failed.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

let mockParams: Record<string, string> = { tenantSlug: 'acme' };
jest.mock('next/navigation', () => ({
    useParams: () => mockParams,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/notifications',
    useSearchParams: () => new URLSearchParams(),
}));

// One instance each: the inbox fetches in an effect keyed on `apiUrl`.
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`;
    const href = (p: string) => `/t/acme${p}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

import { NotificationsBell } from '@/components/layout/notifications-bell';
import NotificationsPage from '@/app/t/[tenantSlug]/(app)/notifications/page';
import { MARK_NOTIFICATION_READ_REQUEST } from '@/lib/notifications/mark-read';

const fetchMock = jest.fn();
const ROW = {
    id: 'n1', type: 'GENERAL', title: 'Acknowledge the access policy', message: 'A new version was published.',
    read: false, linkUrl: '/policies/p1', createdAt: new Date().toISOString(),
};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
    mockParams = { tenantSlug: 'acme' };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ok([ROW]));
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});
afterEach(cleanup);

const calledUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

describe('the bell — the open workspace (#4643)', () => {
    it("lists the open workspace's notifications, not the session's first workspace's", async () => {
        render(<NotificationsBell />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(calledUrls()).toContain('/api/t/acme/notifications');
        expect(calledUrls()).not.toContain('/api/notifications');
    });

    it('marks read in the open workspace, with the request that route accepts', async () => {
        const user = userEvent.setup();
        render(<NotificationsBell />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await user.click(screen.getByTestId('top-chrome-notifications-bell'));
        await user.click(await screen.findByTestId('notifications-mark-all-read'));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/notifications/n1', expect.objectContaining({
                method: MARK_NOTIFICATION_READ_REQUEST.method,
                body: MARK_NOTIFICATION_READ_REQUEST.body,
            })),
        );
    });

    it("links to the workspace's inbox", async () => {
        const user = userEvent.setup();
        render(<NotificationsBell />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await user.click(screen.getByTestId('top-chrome-notifications-bell'));
        const link = await screen.findByTestId('notifications-view-all');
        expect(link.getAttribute('href')).toBe('/t/acme/notifications');
        expect(link.textContent).toBe('View all notifications');
    });

    it('keeps the session-wide route in the org chrome, which has no workspace and no inbox', async () => {
        mockParams = { orgSlug: 'acme-group' };
        const user = userEvent.setup();
        render(<NotificationsBell />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(calledUrls()).toContain('/api/notifications');
        await user.click(screen.getByTestId('top-chrome-notifications-bell'));
        await screen.findByTestId('notification-row-n1');
        expect(screen.queryByTestId('notifications-view-all')).toBeNull();
    });
});

describe('the inbox page (#4643)', () => {
    it('says it is loading rather than that there is nothing', async () => {
        let release!: (v: unknown) => void;
        fetchMock.mockImplementation(() => new Promise((r) => { release = r; }));
        render(<NotificationsPage />);
        expect(screen.getByText('Loading notifications...')).toBeTruthy();
        expect(screen.queryByText('No notifications')).toBeNull();
        await act(async () => { release(ok([])); });
        expect(await screen.findByText('No notifications')).toBeTruthy();
    });

    it("shows each notification's title and opens its link in this workspace", async () => {
        render(<NotificationsPage />);
        expect(await screen.findByText('Acknowledge the access policy')).toBeTruthy();
        expect(screen.getByText('A new version was published.')).toBeTruthy();
        // A stored link without the workspace prefix resolves into this one.
        expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/t/acme/policies/p1');
    });

    it('says the load failed, and does not crash on an error body', async () => {
        fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL' } }) }));
        const { unmount } = render(<NotificationsPage />);
        expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load the notifications. Reload the page to try again.");
        unmount();

        // A 200 whose body is not a list — the shape that used to be stored
        // as the list and crash `.map`.
        fetchMock.mockImplementation(async () => ok({ error: { code: 'X' } }));
        render(<NotificationsPage />);
        expect(await screen.findByRole('alert')).toBeTruthy();
    });
});
