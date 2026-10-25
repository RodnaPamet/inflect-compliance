/** @jest-environment jsdom */

/**
 * `<NotificationsBell>` — stored links that predate the `/t/<slug>` prefix.
 *
 * Several senders stored a tenant page path with no workspace prefix
 * (`/policies/<id>`, `/evidence`, `/framework-updates`, `/vendors/<id>`,
 * `/audits/nis2-gap/respond/<id>`), and the bell rendered `linkUrl` as-is, so
 * clicking one 404'd (#4128). The senders are fixed, but rows already in the
 * table keep the old link — so the bell resolves exactly those shapes against
 * the workspace the reader is in, and leaves every other link alone.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

let mockParams: Record<string, string> = { tenantSlug: 'acme' };
jest.mock('next/navigation', () => ({
    useParams: () => mockParams,
}));

import { NotificationsBell } from '@/components/layout/notifications-bell';

const fetchMock = jest.fn();

const ROWS: Array<[id: string, linkUrl: string]> = [
    ['policy', '/policies/p1'],
    ['evidence', '/evidence'],
    ['framework', '/framework-updates'],
    ['vendor', '/vendors/v1'],
    ['nis2', '/audits/nis2-gap/respond/a1'],
    ['prefixed', '/t/other/tasks/t1'],
    ['org', '/org/acme-group'],
    ['absolute', 'https://example.com/policies/p1'],
    ['protocol-relative', '//example.com/policies/p1'],
    ['account', '/account/security'],
    ['not-a-segment', '/policiesx/p1'],
    ['other-audit', '/audits/cycles/c1'],
];

beforeEach(() => {
    mockParams = { tenantSlug: 'acme' };
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () =>
            ROWS.map(([id, linkUrl]) => ({
                id,
                type: 'GENERAL',
                title: `Row ${id}`,
                message: 'm',
                read: false,
                linkUrl,
                createdAt: new Date().toISOString(),
            })),
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

afterEach(cleanup);

async function openBellAndReadHrefs(): Promise<Record<string, string | null>> {
    const user = userEvent.setup();
    render(<NotificationsBell />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('top-chrome-notifications-bell'));
    await screen.findByTestId('notification-row-policy');
    return Object.fromEntries(
        ROWS.map(([id]) => [id, screen.getByTestId(`notification-row-${id}`).getAttribute('href')]),
    );
}

describe('<NotificationsBell> — legacy tenant-relative links', () => {
    it('resolves the legacy tenant paths against the CURRENT workspace', async () => {
        const hrefs = await openBellAndReadHrefs();
        expect(hrefs.policy).toBe('/t/acme/policies/p1');
        expect(hrefs.evidence).toBe('/t/acme/evidence');
        expect(hrefs.framework).toBe('/t/acme/framework-updates');
        expect(hrefs.vendor).toBe('/t/acme/vendors/v1');
        expect(hrefs.nis2).toBe('/t/acme/audits/nis2-gap/respond/a1');
    });

    it('leaves every other link exactly as stored', async () => {
        const hrefs = await openBellAndReadHrefs();
        expect(hrefs.prefixed).toBe('/t/other/tasks/t1');
        expect(hrefs.org).toBe('/org/acme-group');
        expect(hrefs.absolute).toBe('https://example.com/policies/p1');
        expect(hrefs['protocol-relative']).toBe('//example.com/policies/p1');
        expect(hrefs.account).toBe('/account/security');
        expect(hrefs['not-a-segment']).toBe('/policiesx/p1');
        expect(hrefs['other-audit']).toBe('/audits/cycles/c1');
    });

    it('rewrites nothing where there is no current workspace (the org chrome)', async () => {
        mockParams = { orgSlug: 'acme-group' };
        const hrefs = await openBellAndReadHrefs();
        expect(hrefs.policy).toBe('/policies/p1');
        expect(hrefs.evidence).toBe('/evidence');
    });
});
