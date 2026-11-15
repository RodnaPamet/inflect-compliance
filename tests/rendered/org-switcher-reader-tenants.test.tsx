/** @jest-environment jsdom */

/**
 * #5309 item 16 (owner decision 2026-11-15): the org switcher lists an
 * ORG_READER only the tenants they are a member of, read off the API's
 * `isMember`. An ORG_READER is provisioned no tenant membership, so every
 * other row was a link that refused them. Org admins and owners still see
 * every tenant.
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    usePathname: () => '/org/globex',
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

import { OrgSwitcher } from '@/components/org-switcher';

const TENANTS = [
    { id: 't1', slug: 'mine', name: 'Mine', isMember: true },
    { id: 't2', slug: 'theirs', name: 'Theirs', isMember: false },
];

beforeEach(() => {
    global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ tenants: TENANTS }),
    })) as unknown as typeof fetch;
});

async function openSwitcher(orgRole: string | undefined) {
    render(<OrgSwitcher orgSlug="globex" orgName="Globex" orgRole={orgRole} currentKind="org" />);
    await act(async () => {
        fireEvent.click(screen.getByTestId('org-switcher-trigger'));
    });
    await screen.findByTestId('org-switcher-portfolio');
}

it('an ORG_READER is listed only the tenants they are a member of', async () => {
    await openSwitcher('ORG_READER');
    expect(await screen.findByTestId('org-switcher-tenant-mine')).toBeInTheDocument();
    expect(screen.queryByTestId('org-switcher-tenant-theirs')).toBeNull();
});

it.each(['ORG_ADMIN', 'ORG_OWNER'])('an %s still sees every tenant', async (role) => {
    await openSwitcher(role);
    expect(await screen.findByTestId('org-switcher-tenant-mine')).toBeInTheDocument();
    expect(screen.getByTestId('org-switcher-tenant-theirs')).toBeInTheDocument();
});

it('a viewer whose role is not given is listed only their own tenants', async () => {
    await openSwitcher(undefined);
    expect(await screen.findByTestId('org-switcher-tenant-mine')).toBeInTheDocument();
    expect(screen.queryByTestId('org-switcher-tenant-theirs')).toBeNull();
});
