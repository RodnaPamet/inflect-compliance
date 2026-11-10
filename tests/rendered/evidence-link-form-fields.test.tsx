/**
 * The Link evidence form sends every control, the category and the description
 * the person entered (#5018). It used to send one control at most, offered no
 * category list and had no description at all, so the methodology acceptance
 * could be filed against only one of its three Annex A controls.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.setTimeout(60_000);

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => (key: string, values?: Record<string, unknown>) => {
        const v = walk(walk(en, ns), key);
        if (typeof v !== 'string') return key;
        return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/evidence',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { NewEvidenceLinkModal } from '@/app/t/[tenantSlug]/(app)/evidence/NewEvidenceLinkModal';

const CONTROLS = [
    { id: 'c19', name: 'Information security in supplier relationships', annexId: 'A.5.19', code: null },
    { id: 'c20', name: 'Addressing information security within supplier agreements', annexId: 'A.5.20', code: null },
    { id: 'c22', name: 'Monitoring, review and change management of supplier services', annexId: 'A.5.22', code: null },
];

function renderForm() {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'ev-1' }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(
        <NewEvidenceLinkModal
            open
            setOpen={() => undefined}
            tenantSlug="acme"
            apiUrl={(p) => `/api/t/acme${p}`}
            controls={CONTROLS}
            canEditControlLinks
            existingCategories={['integration']}
        />,
    );
    return fetchMock;
}

/** Open a Combobox by its trigger id and click the option with this text. */
async function pick(triggerId: string, optionText: string) {
    fireEvent.click(document.getElementById(triggerId)!);
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByText(optionText));
}

describe('Link evidence form (#5018)', () => {
    it('sends every control picked, the chosen category and the description', async () => {
        const fetchMock = renderForm();

        fireEvent.change(document.getElementById('link-evidence-title-input')!, {
            target: { value: 'Methodology v1 accepted' },
        });
        fireEvent.change(document.getElementById('link-evidence-url-input')!, {
            target: { value: 'https://example.test/methodology' },
        });
        // A multi-select stays open between picks: open it once, pick three.
        for (const label of [
            'A.5.19: Information security in supplier relationships',
            'A.5.20: Addressing information security within supplier agreements',
            'A.5.22: Monitoring, review and change management of supplier services',
        ]) {
            // Re-read the list each time: it re-renders when the selection changes.
            if (!screen.queryByRole('listbox')) {
                fireEvent.click(document.getElementById('link-evidence-control-select')!);
            }
            fireEvent.click(within(await screen.findByRole('listbox')).getByText(label));
            // Let the selection land before the next pick: each pick is computed
            // from the selection the list was last rendered with.
            await act(async () => {});
        }
        if (screen.queryByRole('listbox')) fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
        await pick('link-evidence-category-input', 'Approval or sign-off');
        fireEvent.change(document.getElementById('link-evidence-description-input')!, {
            target: { value: '  Accepted by the practice lead on 2026-10-20.  ' },
        });

        fireEvent.click(document.getElementById('create-link-evidence-btn')!);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(body).toMatchObject({
            type: 'LINK',
            content: 'https://example.test/methodology',
            controlIds: ['c19', 'c20', 'c22'],
            category: 'Approval or sign-off',
            description: 'Accepted by the practice lead on 2026-10-20.',
        });
    });

    it('offers the ten standard categories, then the workspace\'s own', async () => {
        renderForm();
        fireEvent.click(document.getElementById('link-evidence-category-input')!);
        const listbox = await screen.findByRole('listbox');
        const labels = within(listbox).getAllByRole('option').map((o) => o.textContent?.trim());
        expect(labels.slice(0, 2)).toEqual(['Policy or procedure', 'Configuration or screenshot']);
        expect(labels).toContain('Other');
        expect(labels[labels.length - 1]).toBe('integration');
    });

    it('sends no description and no controls when none were given', async () => {
        const fetchMock = renderForm();
        fireEvent.change(document.getElementById('link-evidence-title-input')!, { target: { value: 'A link' } });
        fireEvent.change(document.getElementById('link-evidence-url-input')!, {
            target: { value: 'https://example.test/x' },
        });
        fireEvent.click(document.getElementById('create-link-evidence-btn')!);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(body).toMatchObject({ controlIds: [], category: null, description: null });
    });
});
