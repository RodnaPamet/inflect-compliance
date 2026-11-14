/**
 * The SharePoint picker follows Graph paging (#5309).
 *
 * A folder holding more children than one Graph page used to show the first
 * page as if it were the whole folder: files past it could not be picked and
 * nothing said the list was partial. The picker now says so and loads the
 * next page on request, and drops a page that arrives after the user moved on.
 */
import * as React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

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

const browsed: URLSearchParams[] = [];
// Each folder answers with a page of items; folder `big` has a second page.
let holdBigPage2: (() => void) | null = null;

beforeEach(() => {
    browsed.length = 0;
    holdBigPage2 = null;
    global.fetch = jest.fn(async (url: string) => {
        if (url.includes('/sites?')) {
            return {
                ok: true,
                json: async () => ({
                    sites: [{ id: 's1', name: 'Finance' }],
                    drives: { s1: [{ id: 'd1', name: 'Finance docs' }] },
                }),
            };
        }
        const q = new URL(url, 'http://x').searchParams;
        browsed.push(q);
        const item = q.get('itemId');
        const page = q.get('pageToken');
        if (!item) {
            return {
                ok: true,
                json: async () => ({
                    items: [
                        { id: 'big', name: 'Big folder', isFolder: true, hasChildren: true },
                        { id: 'small', name: 'Small folder', isFolder: true, hasChildren: true },
                    ],
                }),
            };
        }
        if (item === 'big' && !page) {
            return {
                ok: true,
                json: async () => ({
                    items: [{ id: 'f1', name: 'page-one.pdf', isFolder: false, mimeType: 'application/pdf' }],
                    nextPageToken: 'cursor-2',
                }),
            };
        }
        if (item === 'big' && page === 'cursor-2') {
            if (holdBigPage2 === null) {
                return {
                    ok: true,
                    json: async () => ({
                        items: [{ id: 'f2', name: 'page-two.pdf', isFolder: false, mimeType: 'application/pdf' }],
                    }),
                };
            }
            // A held page: resolves only when the test says so.
            return new Promise((resolve) => {
                holdBigPage2 = () =>
                    resolve({
                        ok: true,
                        json: async () => ({
                            items: [{ id: 'f2', name: 'page-two.pdf', isFolder: false, mimeType: 'application/pdf' }],
                        }),
                    });
            });
        }
        return {
            ok: true,
            json: async () => ({ items: [{ id: 's-f', name: 'small.pdf', isFolder: false, mimeType: 'application/pdf' }] }),
        };
    }) as unknown as typeof fetch;
});

function mount() {
    render(<SharePointFilePicker showModal setShowModal={() => {}} connectionId="c1" onConfirm={() => {}} />);
}

it('offers the next page of a folder larger than one Graph page, and appends it (#5309)', async () => {
    mount();
    fireEvent.click(await screen.findByText('Big folder'));
    await screen.findByText('page-one.pdf');

    // The listing says it is partial, and can be continued.
    expect(screen.getByText('morePages')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sp-load-more'));

    await screen.findByText('page-two.pdf');
    expect(screen.getByText('page-one.pdf')).toBeTruthy();
    const last = browsed[browsed.length - 1];
    expect(last.get('itemId')).toBe('big');
    expect(last.get('pageToken')).toBe('cursor-2');
    // The last page carries no cursor: nothing more is offered.
    expect(screen.queryByTestId('sp-load-more')).toBeNull();
});

it('drops a next page that lands after the user moved to another folder (#5309)', async () => {
    mount();
    fireEvent.click(await screen.findByText('Big folder'));
    await screen.findByText('page-one.pdf');

    holdBigPage2 = () => {};
    fireEvent.click(screen.getByTestId('sp-load-more'));
    await waitFor(() => expect(browsed[browsed.length - 1].get('pageToken')).toBe('cursor-2'));

    // Back to the root, into another folder, while page two is in flight.
    fireEvent.click(screen.getByText('library'));
    fireEvent.click(await screen.findByText('Small folder'));
    await screen.findByText('small.pdf');

    await act(async () => {
        holdBigPage2?.();
    });
    expect(screen.queryByText('page-two.pdf')).toBeNull();
    expect(screen.getByText('small.pdf')).toBeTruthy();
});
