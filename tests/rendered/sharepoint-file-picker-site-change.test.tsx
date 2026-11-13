/**
 * Changing the site in the SharePoint picker moves to THAT site's library
 * (#5173).
 *
 * Choosing a new site set the site and nothing else: the library, the listing
 * and the breadcrumb stayed on the previous site's library, so the picker kept
 * browsing it and "Use folder" returned the old drive under the new site's
 * name. The comboboxes are stubbed as native selects — the property under test
 * is what the picker does with the choice, not how the dropdown is drawn.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// A STABLE `t`: the picker's load effect depends on it, and a fresh function
// each render would re-run the effect for ever.
jest.mock('next-intl', () => {
    const t = (k: string) => k;
    return { useTranslations: () => t, useLocale: () => 'en' };
});
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    return { useTenantApiUrl: () => apiUrl };
});
jest.mock('@/components/ui/modal', () => {
    const Modal = ({ showModal, children }: { showModal: boolean; children: React.ReactNode }) =>
        showModal ? <div>{children}</div> : null;
    function Header() {
        return null;
    }
    function Section({ children }: { children: React.ReactNode }) {
        return <div>{children}</div>;
    }
    Modal.Header = Header;
    Modal.Body = Section;
    Modal.Actions = Section;
    Modal.Footer = Section;
    return { Modal };
});
jest.mock('@/components/ui/combobox', () => ({
    Combobox: ({
        id,
        options,
        selected,
        setSelected,
    }: {
        id: string;
        options: Array<{ value: string; label: string }>;
        selected: { value: string } | null;
        setSelected: (o: { value: string; label: string } | null) => void;
    }) => (
        <select
            data-testid={id}
            value={selected?.value ?? ''}
            onChange={(e) => setSelected(options.find((o) => o.value === e.target.value) ?? null)}
        >
            <option value="">none</option>
            {options.map((o) => (
                <option key={o.value} value={o.value}>
                    {o.label}
                </option>
            ))}
        </select>
    ),
}));

import { SharePointFilePicker } from '@/components/integrations/sharepoint/SharePointFilePicker';

const browsed: string[] = [];

beforeEach(() => {
    browsed.length = 0;
    global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/sites?')) {
            return {
                ok: true,
                json: async () => ({
                    sites: [
                        { id: 's1', name: 'Finance' },
                        { id: 's2', name: 'Legal' },
                    ],
                    drives: { s1: [{ id: 'd1', name: 'Finance docs' }], s2: [{ id: 'd2', name: 'Legal docs' }] },
                }),
            };
        }
        const driveId = new URL(url, 'http://x').searchParams.get('driveId') ?? '';
        browsed.push(driveId);
        return {
            ok: true,
            json: async () => ({
                items: [{ id: `${driveId}-f`, name: `${driveId} folder`, isFolder: true, hasChildren: false }],
            }),
        };
    }) as unknown as typeof fetch;
});

it('browses the new site’s library and drops the old listing when the site changes', async () => {
    render(
        <SharePointFilePicker showModal setShowModal={() => {}} connectionId="c1" onConfirm={() => {}} />,
    );
    await screen.findByText('d1 folder');

    fireEvent.change(screen.getByTestId('sp-site'), { target: { value: 's2' } });

    expect((screen.getByTestId('sp-drive') as HTMLSelectElement).value).toBe('d2');
    await screen.findByText('d2 folder');
    expect(screen.queryByText('d1 folder')).toBeNull();
    await waitFor(() => expect(browsed).toEqual(['d1', 'd2']));
});
