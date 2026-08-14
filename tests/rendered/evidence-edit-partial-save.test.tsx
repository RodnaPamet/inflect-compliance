/**
 * `<EditEvidenceModal>` — a half-succeeded save has to say which half.
 *
 * Saving runs TWO requests: a PUT that persists every metadata field, then —
 * only when the date changed — a POST to the retention endpoint. When the PUT
 * succeeds and the retention POST fails, the details ARE committed. Two things
 * then made that read as a total failure:
 *
 *   - `apiErrorMessage(body, fallback)` returns the SERVER's message whenever
 *     there is one, so passing "Saved details, but failed to update retention"
 *     as the FALLBACK meant it was displaced by e.g. "Evidence not found" on
 *     every real failure — the one case it existed for.
 *   - `onSaved` was never called, so the list behind the modal kept showing
 *     the pre-save values while the database held the new ones.
 *
 * The fix does not make the write atomic — the retention endpoint has its own
 * authorisation and audit path, and folding it into the PUT would change the
 * public API contract. It makes the REPORT honest, which is where the harm was.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { EditEvidenceModal, type EditEvidenceInitial } from '@/app/t/[tenantSlug]/(app)/evidence/EditEvidenceModal';

jest.mock('next-intl', () => ({
    // Return the key so assertions can anchor on it without depending on copy.
    useTranslations: () => (k: string) => k,
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/evidence',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/ui/user-combobox', () => ({
    UserCombobox: () => <div data-mock="user-combobox" />,
}));

// The shared <DatePicker> is exercised by tests/rendered/date-pickers.test.tsx.
// Here it is only the lever that makes the retention request fire, so drive it
// as a plain input rather than through the calendar popover.
jest.mock('@/components/ui/date-picker/date-picker', () => ({
    DatePicker: ({
        id,
        value,
        onChange,
    }: {
        id?: string;
        value?: Date | null;
        onChange?: (d: Date | null) => void;
    }) => (
        <input
            id={id}
            data-testid="retention-date"
            value={value ? value.toISOString().slice(0, 10) : ''}
            onChange={(e) =>
                onChange?.(e.target.value ? new Date(`${e.target.value}T00:00:00.000Z`) : null)
            }
        />
    ),
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
    tags: [],
    // A starting retention date so changing it triggers the second request.
    retentionUntil: '2026-01-01T00:00:00.000Z',
    type: 'FILE',
    fileRecordId: 'fr-1',
};

const ok = { ok: true, status: 200, json: async () => ({}) } as Response;

/** PUT succeeds; the retention POST fails with a server-supplied message. */
function metadataOkRetentionFails(serverError: unknown) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (String(url).includes('/retention')) {
            return Promise.resolve({
                ok: false,
                status: 404,
                json: async () => serverError,
            } as Response);
        }
        if (init?.method === 'PUT') return Promise.resolve(ok);
        return Promise.resolve(ok);
    });
}

async function openChangeRetentionAndSave(onSaved?: () => void) {
    render(
        <EditEvidenceModal
            open
            setOpen={() => {}}
            tenantSlug="acme"
            controls={[]}
            initial={BASE}
            onSaved={onSaved}
        />,
    );
    // Change the retention date so the second request fires at all.
    const date = await screen.findByTestId('retention-date');
    fireEvent.change(date, { target: { value: '2027-06-30' } });
    await userEvent.click(
        await screen.findByRole('button', { name: /save|edit\.save/i }),
    );
    await waitFor(() =>
        expect(
            fetchMock.mock.calls.some(([u]) => String(u).includes('/retention')),
        ).toBe(true),
    );
}

beforeEach(() => {
    fetchMock.mockReset();
});

describe('EditEvidenceModal — partial save reporting', () => {
    it('leads with "details were saved" even when the server supplies its own message', async () => {
        // The regression: the server's message REPLACED the honest one,
        // because it was passed as apiErrorMessage's fallback.
        metadataOkRetentionFails({ error: 'Evidence not found' });
        await openChangeRetentionAndSave();

        const msg = await screen.findByText(/edit\.retentionFailed/);
        expect(msg).toBeInTheDocument();
        // The server's detail is kept, but AFTER the fact that matters.
        expect(msg.textContent).toContain('Evidence not found');
        expect(msg.textContent!.indexOf('edit.retentionFailed')).toBeLessThan(
            msg.textContent!.indexOf('Evidence not found'),
        );
    });

    it('still reports honestly when the server supplies NO message', async () => {
        metadataOkRetentionFails({});
        await openChangeRetentionAndSave();

        expect(await screen.findByText(/edit\.retentionFailed/)).toBeInTheDocument();
    });

    it('refreshes the list, because the metadata really was persisted', async () => {
        // Without this the row behind the modal shows pre-save values while
        // the database holds the new ones — which is what made an honest
        // message still look like a total failure.
        const onSaved = jest.fn();
        metadataOkRetentionFails({ error: 'Evidence not found' });
        await openChangeRetentionAndSave(onSaved);

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });

    it('does not fire the retention request when the date is untouched', async () => {
        // Guards the other direction: this whole path must stay off the
        // common save, or every save would risk a partial failure.
        fetchMock.mockResolvedValue(ok);
        render(
            <EditEvidenceModal
                open
                setOpen={() => {}}
                tenantSlug="acme"
                controls={[]}
                initial={BASE}
            />,
        );
        await userEvent.click(
            await screen.findByRole('button', { name: /save|edit\.save/i }),
        );
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        expect(
            fetchMock.mock.calls.some(([u]) => String(u).includes('/retention')),
        ).toBe(false);
    });
});
