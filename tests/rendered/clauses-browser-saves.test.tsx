/**
 * The ISO 27001 clause tracker saves what it shows, and only that (#4738).
 *
 *   - A refused save leaves the clause as it was and says so. It used to
 *     update the list on any HTTP answer, so a 403 looked saved.
 *   - A role that cannot write sees the status as a badge, with no picker.
 *   - Notes are shown, and saved with the clause's current status.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const toastError = jest.fn();
const toastSuccess = jest.fn();
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        useToast: () => ({ error: toastError, success: toastSuccess, info: jest.fn() }),
    };
});

import { ClausesBrowser } from '@/app/t/[tenantSlug]/(app)/clauses/ClausesBrowser';

const EN = jest.requireActual('../../messages/en.json') as { clauses: Record<string, string> };

const clause = (overrides: Record<string, unknown> = {}) => ({
    id: 'cl_4',
    number: '4',
    title: 'Context of the organization',
    description: 'Understand the organization and its context.',
    artifacts: 'Scope statement',
    sortOrder: 4,
    status: 'NOT_STARTED' as const,
    notes: '',
    checklist: ['Define the scope'],
    progressId: undefined,
    ...overrides,
});

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
});

function open(canEdit: boolean, row = clause()) {
    render(<ClausesBrowser clauses={[row]} tenantSlug="acme" canEdit={canEdit} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(row.title) }));
}

async function chooseStatus(label: string) {
    fireEvent.click(document.getElementById('clause-status-select')!);
    fireEvent.click(await screen.findByRole('option', { name: label }));
}

describe('ClausesBrowser', () => {
    it('keeps the old status, and says so, when the server refuses the change', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
        open(true);

        await chooseStatus(EN.clauses.ready);

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(EN.clauses.saveFailed));
        const list = screen.getByRole('button', { name: /Context of the organization/ });
        expect(within(list).getByText(EN.clauses.notStarted)).toBeInTheDocument();
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('shows the stored status once the server has saved it', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'READY', notes: '' }) });
        open(true);

        await chooseStatus(EN.clauses.ready);

        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(EN.clauses.statusSaved));
        const list = screen.getByRole('button', { name: /Context of the organization/ });
        expect(within(list).getByText(EN.clauses.ready)).toBeInTheDocument();
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ status: 'READY' });
    });

    it('gives a read-only role the status and notes, and no way to change them', () => {
        open(false, clause({ status: 'IN_PROGRESS', notes: 'Scope agreed with the board.' }));

        expect(document.getElementById('clause-status-select')).toBeNull();
        expect(document.getElementById('clause-status-readonly')).toHaveTextContent(EN.clauses.inProgress);
        expect(screen.getByText('Scope agreed with the board.')).toBeInTheDocument();
        expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('saves notes with the clause status as it stands', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ status: 'IN_PROGRESS', notes: 'Scope drafted.' }),
        });
        open(true, clause({ status: 'IN_PROGRESS' }));

        expect(document.getElementById('clause-notes-save')).toBeNull();
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Scope drafted.' } });
        fireEvent.click(screen.getByRole('button', { name: EN.clauses.saveNotes }));

        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(EN.clauses.notesSaved));
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ status: 'IN_PROGRESS', notes: 'Scope drafted.' });
        expect(document.getElementById('clause-notes-save')).toBeNull();
    });
});
