/**
 * `<EditEvidenceModal>` — replacing the file keeps the other edits, and a
 * save that never reached the server says so (#4277).
 *
 *   - Choosing a replacement file closed the form with the RAW setter, past
 *     the unsaved-changes guard, and never saved the rest — every other edit
 *     in the form was dropped without asking. With edits pending, the modal
 *     now stays open and says the file was replaced.
 *   - `submit` was `try/finally` with no `catch`, called as `void submit()`,
 *     so a thrown fetch (offline) showed nothing and left the form as it was.
 *   - "Replace file" needs the `evidence.upload` grant (`canReplaceFile`),
 *     which edit access does not imply.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { EditEvidenceModal, type EditEvidenceInitial } from '@/app/t/[tenantSlug]/(app)/evidence/EditEvidenceModal';

jest.mock('next-intl', () => ({
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

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const FILE: EditEvidenceInitial = {
    id: 'ev-1',
    title: 'Q1 access review',
    content: null,
    ownerUserId: null,
    controlLinks: [],
    category: null,
    folder: null,
    tags: [],
    retentionUntil: null,
    type: 'FILE',
    fileRecordId: 'fr-1',
};

const ok = { ok: true, status: 200, json: async () => ({}) } as Response;

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(ok);
});

function mount(props: Partial<React.ComponentProps<typeof EditEvidenceModal>> = {}) {
    const setOpen = jest.fn();
    const onSaved = jest.fn();
    render(
        <EditEvidenceModal
            open
            setOpen={setOpen}
            tenantSlug="acme"
            controls={[]}
            initial={FILE}
            onSaved={onSaved}
            {...props}
        />,
    );
    return { setOpen, onSaved };
}

async function chooseReplacement() {
    const input = document.getElementById('edit-evidence-replace-input') as HTMLInputElement;
    const file = new File(['new bytes'], 'v2.pdf', { type: 'application/pdf' });
    await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() =>
        expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/evidence/ev-1/replace'))).toBe(true),
    );
}

describe('replacing the file', () => {
    it('with other edits pending: stays open, keeps them, and says the file was replaced', async () => {
        const { setOpen, onSaved } = mount();
        const title = document.getElementById('edit-evidence-title-input') as HTMLInputElement;
        fireEvent.change(title, { target: { value: 'Q1 access review — final' } });
        await chooseReplacement();

        await screen.findByText('edit.replacedKeepEditing');
        expect(setOpen).not.toHaveBeenCalledWith(false);
        expect(title.value).toBe('Q1 access review — final');
        // The replacement IS saved, so the list behind it refreshes.
        expect(onSaved).toHaveBeenCalled();
    });

    it('with nothing else edited: closes, as before', async () => {
        const { setOpen } = mount();
        await chooseReplacement();
        await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
        expect(screen.queryByText('edit.replacedKeepEditing')).toBeNull();
    });

    it('is not offered without the upload grant', () => {
        mount({ canReplaceFile: false });
        expect(document.getElementById('edit-evidence-replace-input')).toBeNull();
    });
});

describe('saving when the request never reaches the server', () => {
    it('shows an error instead of nothing', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        const { setOpen } = mount({ initial: { ...FILE, type: 'TEXT', content: 'note' } });
        fireEvent.change(document.getElementById('edit-evidence-title-input')!, {
            target: { value: 'Renamed' },
        });
        await act(async () => {
            fireEvent.click(document.getElementById('edit-evidence-submit-btn')!);
        });
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('edit.updateFailed');
        expect(setOpen).not.toHaveBeenCalledWith(false);
        // The form is usable again for a retry.
        expect(document.getElementById('edit-evidence-submit-btn')).not.toBeDisabled();
    });
});
