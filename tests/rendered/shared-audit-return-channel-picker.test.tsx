/** @jest-environment jsdom */

/**
 * The shared audit pack's return channel: the reviewer picks what a comment
 * is about by searching, and the comment kinds never wrap into a ragged pile
 * on a phone (#5897).
 *
 * The "About" picker rendered one chip per pack item, so a large pack was a
 * wall of chips. It is the shared, searchable `Combobox` (which virtualises a
 * long list), with "the whole pack" pinned first. The four kinds sit in a
 * two-by-two grid of full tap rows below md.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next/navigation', () => ({
    useParams: () => ({ token: 'tok' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/audit/shared/tok',
    useSearchParams: () => new URLSearchParams(),
}));

import SharedPackPage from '@/app/audit/shared/[token]/page';

const EN = jest.requireActual('../../messages/en.json') as {
    external: { auditShare: { returnChannel: Record<string, unknown> } };
};
const RC = EN.external.auditShare.returnChannel as Record<string, string> & { kind: Record<string, string> };

const ITEMS = Array.from({ length: 60 }, (_, i) => ({
    id: `item-${i}`,
    entityType: 'CONTROL',
    entityId: `ctl-${i}`,
    snapshotJson: JSON.stringify({ code: `A.${i}.1`, title: `Control ${i}` }),
}));

const PACK = {
    pack: { id: 'p1', name: 'Q4 pack', status: 'FROZEN', frozenAt: null },
    cycle: { name: 'FY26', frameworkKey: 'ISO27001', frameworkVersion: '2022' },
    items: ITEMS,
};

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
        Promise.resolve({
            ok: true,
            json: async () => (init?.method === 'POST' ? { id: 'sub-1' } : PACK),
        } as Response),
    );
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

async function renderPage() {
    render(<SharedPackPage />);
    await screen.findByText('Q4 pack');
}

describe('the return channel', () => {
    it('asks what a comment is about with one searchable picker, not a chip per item', async () => {
        await renderPage();
        const channel = document.getElementById('return-channel')!;
        // The chips were aria-pressed buttons: only the four kinds are now.
        expect(channel.querySelectorAll('button[aria-pressed]')).toHaveLength(4);
        const picker = document.getElementById('return-channel-attach')!;
        expect(picker).toHaveTextContent(RC.attachWholePack);
    });

    it('finds an item by searching, and sends the comment about it', async () => {
        const user = userEvent.setup();
        await renderPage();
        await user.click(document.getElementById('return-channel-attach')!);
        const search = await screen.findByPlaceholderText(RC.attachSearch);
        await user.type(search, 'A.42.1');
        await user.click(await screen.findByRole('option', { name: /A\.42\.1/ }));
        expect(document.getElementById('return-channel-attach')).toHaveTextContent('A.42.1');

        await user.type(screen.getByLabelText(RC.messageLabel), 'Please attach the latest review.');
        await act(async () => {
            fireEvent.click(document.getElementById('return-channel-submit')!);
        });
        await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(true));
        const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
        expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({ auditPackItemId: 'item-42' });
        // The comment is echoed under the form, named by its item.
        expect(await screen.findByText('Please attach the latest review.')).toBeInTheDocument();
    });

    it('lays the four kinds out two by two on a phone, as full tap rows', async () => {
        await renderPage();
        const kinds = screen.getByTestId('return-channel-kinds');
        expect(kinds.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-md:grid', 'max-md:grid-cols-2']));
        const buttons = within(kinds).getAllByRole('button');
        expect(buttons.map((b) => b.textContent)).toEqual(
            ['COMMENT', 'EVIDENCE_REQUEST', 'FINDING', 'QUESTION'].map((k) => RC.kind[k]),
        );
        for (const b of buttons) expect(b.className).toContain('max-md:min-h-11');
    });
});
