/**
 * `<EditEvidenceModal>` — tags must survive a save that never touched them.
 *
 * The list row's Edit button seeded this modal WITHOUT `tags`. That field is
 * optional on `EditEvidenceInitial`, so the omission type-checked; the input
 * then rendered empty, and submit sent `tags: []`. `updateEvidence` reconciles
 * tags to exactly what it receives (`if (data.tags !== undefined) setTags(...)`),
 * so every tag on the row was deleted by a save the user made for an unrelated
 * reason. The detail sheet's edit button always passed them, which is why the
 * same modal behaved correctly from there and the bug looked like it could not
 * exist.
 *
 * These drive the real component and assert on the PAYLOAD, because that is
 * where the defect lived — a source scan for `tags:` would have passed against
 * the broken code, and a test of "does the bug come back" would only re-check a
 * diagnosis we already had. What needs proving is the remedy: that an unseeded
 * modal omits the key, and a seeded one round-trips it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { EditEvidenceModal, type EditEvidenceInitial } from '@/app/t/[tenantSlug]/(app)/evidence/EditEvidenceModal';

jest.mock('next-intl', () => ({
    useTranslations: () => (k: string) => k,
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));

// The shared <Modal> calls useRouter() for its close-on-back behaviour, which
// needs an app-router context jsdom does not provide.
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/evidence',
    useSearchParams: () => new URLSearchParams(),
}));

// The modal loads the control list + the member list on open; neither is
// under test here and both would otherwise hit the network.
jest.mock('@/components/ui/user-combobox', () => ({
    UserCombobox: () => <div data-mock="user-combobox" />,
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const BASE: EditEvidenceInitial = {
    id: 'ev-1',
    title: 'Q1 access review',
    content: null,
    ownerUserId: null,
    controlLinks: [],
    category: null,
    folder: null,
    retentionUntil: null,
    type: 'FILE',
    fileRecordId: 'fr-1',
};

/** The body the modal PUT to /evidence/:id, parsed. */
function submittedBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(
        ([url, init]) =>
            String(url).includes('/evidence/ev-1') &&
            (init as RequestInit | undefined)?.method === 'PUT',
    );
    if (!call) throw new Error('no PUT to /evidence/ev-1 was made');
    return JSON.parse(String((call[1] as RequestInit).body));
}

async function openAndSave(initial: EditEvidenceInitial) {
    render(
        <EditEvidenceModal
            open
            setOpen={() => {}}
            tenantSlug="acme"
            controls={[]}
            initial={initial}
        />,
    );
    const save = await screen.findByRole('button', { name: /save|edit\.save/i });
    await userEvent.click(save);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
}

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
    } as Response);
});

describe('EditEvidenceModal — tag reconciliation', () => {
    it('OMITS tags entirely when the caller never seeded them', async () => {
        // The list-row case. The modal has not been told the current tags, so
        // it has no business reconciling them — omitting the key leaves them
        // untouched server-side.
        await openAndSave(BASE);

        const body = submittedBody();
        expect(body).not.toHaveProperty('tags');
    });

    it('round-trips seeded tags when the user does not touch the field', async () => {
        await openAndSave({ ...BASE, tags: ['soc2', 'q1'] });

        // Order-independent: the repository normalises and re-sorts.
        expect(new Set(submittedBody().tags as string[])).toEqual(
            new Set(['soc2', 'q1']),
        );
    });

    it('still sends an EMPTY set when a seeded modal has its tags cleared', async () => {
        // The deliberate-clear path must keep working — this is the case the
        // omission above must not swallow. Seeded means the modal knows the
        // current set, so an empty field is a real instruction to remove them.
        render(
            <EditEvidenceModal
                open
                setOpen={() => {}}
                tenantSlug="acme"
                controls={[]}
                initial={{ ...BASE, tags: ['soc2'] }}
            />,
        );
        const field = await screen.findByDisplayValue('soc2');
        await userEvent.clear(field);
        await userEvent.click(
            await screen.findByRole('button', { name: /save|edit\.save/i }),
        );
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        expect(submittedBody().tags).toEqual([]);
    });
});
