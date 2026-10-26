/**
 * `<EditEvidenceModal>` — a link's body is its address.
 *
 * Saving an edit with an empty body sent `content: null`, which the update
 * schema refused (`z.string().optional()`), so every save of a note whose
 * text had been cleared failed with a 400. The schema now takes `null` as
 * "clear", and the server refuses clearing a LINK's URL. The form says so
 * first: for a link the field is labelled as its address, and Save waits
 * for one.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    title: 'Pen test report',
    content: 'https://x.test/report?lang=en&region=us',
    ownerUserId: null,
    controlLinks: [],
    category: null,
    folder: null,
    tags: [],
    retentionUntil: null,
    type: 'LINK',
    fileRecordId: null,
};

const ok = { ok: true, status: 200, json: async () => ({}) } as Response;

function mount(initial: EditEvidenceInitial) {
    render(<EditEvidenceModal open setOpen={() => {}} tenantSlug="acme" controls={[]} canEditControlLinks initial={initial} />);
}
const body = () => document.getElementById('edit-evidence-description') as HTMLTextAreaElement;
const save = () => document.getElementById('edit-evidence-submit-btn') as HTMLButtonElement;

beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(ok);
});

describe('EditEvidenceModal — a link keeps its address', () => {
    it('labels a link\'s body as its address, and will not save it empty', async () => {
        mount(BASE);
        await waitFor(() => expect(body()).not.toBeNull());
        expect(screen.getByText('edit.addressLabel')).toBeInTheDocument();
        expect(screen.queryByText('edit.descriptionLabel')).toBeNull();

        fireEvent.change(body(), { target: { value: '   ' } });
        expect(save()).toBeDisabled();
        expect(screen.getByText('edit.linkNeedsUrl')).toBeInTheDocument();
    });

    it('a note can be cleared: the save sends content null', async () => {
        mount({ ...BASE, type: 'TEXT', content: 'Old note' });
        await waitFor(() => expect(body()).not.toBeNull());
        expect(screen.getByText('edit.descriptionLabel')).toBeInTheDocument();

        fireEvent.change(body(), { target: { value: '' } });
        expect(save()).not.toBeDisabled();
        await userEvent.click(save());

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
        expect(JSON.parse(String((put![1] as RequestInit).body))).toMatchObject({ content: null });
    });
});
