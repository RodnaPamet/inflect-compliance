/**
 * #4816 — the Devices inventory says what it holds in words: whose device it
 * is, when it last reported, its platform and source as labels, a search, and
 * the cap when there are more devices than it shows. The empty state no longer
 * sends anyone to a device-token page or an MDM connection that do not exist.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/devices',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantHref: () => href, useTenantApiUrl: () => (p: string) => `/api/t/acme${p}` };
});

import { DevicesClient, type DeviceRow } from '@/app/t/[tenantSlug]/(app)/admin/devices/DevicesClient';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

const device = (over: Partial<DeviceRow> = {}): DeviceRow => ({
    id: 'd-1',
    serialNumber: 'SN-1',
    hostname: 'ada-mbp',
    platform: 'MACOS',
    source: 'AGENT',
    diskEncrypted: true,
    screenLockEnabled: true,
    antivirusRunning: null,
    passwordManagerPresent: false,
    employee: { fullName: 'Ada Lovelace' },
    lastCheckIn: '2026-10-30T08:00:00.000Z',
    ...over,
});

beforeEach(() => {
    window.history.replaceState({}, '', '/t/acme/admin/devices');
});

describe('a device row', () => {
    it('shows its owner, last check-in, and platform and source as labels', () => {
        render(<DevicesClient initialRows={[device()]} />);
        expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
        expect(screen.getByText(`${en.devices.filterEnums.platform.MACOS} · ${en.devices.source.AGENT}`)).toBeInTheDocument();
        expect(document.body.textContent).not.toContain('MACOS · AGENT');
        expect(screen.queryByText('—')).not.toBeInTheDocument();
    });

    it('reads — for an unlinked device that has never reported', () => {
        render(<DevicesClient initialRows={[device({ employee: null, lastCheckIn: null })]} />);
        expect(screen.getAllByText('—')).toHaveLength(2);
    });
});

describe('the cap', () => {
    it('says when there are more devices than the list shows', () => {
        render(<DevicesClient initialRows={[device()]} truncated />);
        expect(screen.getByTestId('list-truncation-banner')).toBeInTheDocument();
    });

    it('says nothing when the list is whole', () => {
        render(<DevicesClient initialRows={[device()]} />);
        expect(screen.queryByTestId('list-truncation-banner')).not.toBeInTheDocument();
    });
});

describe('search', () => {
    it('narrows the list by name, serial number or owner', async () => {
        render(
            <DevicesClient
                initialRows={[
                    device(),
                    device({ id: 'd-2', hostname: 'grace-tp', serialNumber: 'SN-2', employee: { fullName: 'Grace Hopper' } }),
                ]}
            />,
        );
        const trigger = document.querySelector('[data-filter-trigger]') as HTMLElement;
        fireEvent.click(trigger);
        await waitFor(() => expect(document.querySelector('#devices-search input')).not.toBeNull());
        fireEvent.change(document.querySelector('#devices-search input') as HTMLInputElement, { target: { value: 'hopper' } });
        await waitFor(() => expect(screen.queryByText('ada-mbp')).not.toBeInTheDocument());
        expect(screen.getByText('grace-tp')).toBeInTheDocument();
    });
});

describe('the empty state', () => {
    it('describes how devices arrive, not a token page or an MDM', () => {
        render(<DevicesClient initialRows={[]} />);
        expect(screen.getByText(en.devices.emptyDesc)).toBeInTheDocument();
        expect(en.devices.emptyDesc).not.toMatch(/token|MDM/i);
        expect(bg.devices.emptyDesc).not.toMatch(/токен|MDM/i);
    });
});
