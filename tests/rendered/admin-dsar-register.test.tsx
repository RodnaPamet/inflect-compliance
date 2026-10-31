/**
 * #4818 — the data subject request register can be written from its page: a
 * manager records a request and moves it through the statuses the server
 * allows, and a rejection needs one of the server's reasons. A reader sees the
 * register and every detail, and no control.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/dsar-requests',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantHref: () => href, useTenantApiUrl: () => (p: string) => `/api/t/acme${p}` };
});

// The member picker reads a roster over the network; a plain select stands in.
jest.mock('@/components/ui/user-combobox', () => ({
    UserCombobox: ({ id, onChange }: { id: string; onChange: (v: string | null) => void }) => (
        <select id={id} data-testid="subject-picker" onChange={(e) => onChange(e.target.value || null)}>
            <option value="">—</option>
            <option value="u-1">Ada Lovelace</option>
        </select>
    ),
}));

import { DsarRegisterClient, type DsarRow } from '@/app/t/[tenantSlug]/(app)/admin/dsar-requests/DsarRegisterClient';
import en from '../../messages/en.json';

const dsar = en.admin.dsar;

const req = (over: Partial<DsarRow> = {}): DsarRow => ({
    id: 'r-1',
    type: 'EXPORT',
    status: 'RECEIVED',
    subject: { id: 'u-1', email: 'ada@acme.test', name: 'Ada Lovelace' },
    requestedAt: '2026-10-01T00:00:00.000Z',
    verifiedAt: null,
    completedAt: null,
    rejectionReason: null,
    fulfilmentNotes: null,
    handledBy: null,
    ...over,
});

type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];

function stubFetch(respond: (call: Call) => { status: number; body: unknown }) {
    calls = [];
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
        const call = { method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : {} };
        calls.push(call);
        const { status, body } = respond(call);
        return { ok: status < 400, status, json: async () => body } as Response;
    }) as unknown as typeof fetch;
}

function renderRegister(rows: DsarRow[], canManage = true) {
    return render(<DsarRegisterClient tenantSlug="acme" initial={rows} canManage={canManage} title={dsar.title} />);
}

beforeEach(() => {
    window.history.replaceState({}, '', '/t/acme/admin/dsar-requests');
});

describe('recording a request', () => {
    it('posts the member, the right and the notes, and lists the new request', async () => {
        stubFetch(() => ({ status: 201, body: req({ id: 'r-new', type: 'ERASURE' }) }));
        renderRegister([]);
        fireEvent.click(document.getElementById('dsar-record-btn') as HTMLElement);
        fireEvent.change(await screen.findByTestId('subject-picker'), { target: { value: 'u-1' } });
        fireEvent.click(screen.getByLabelText(dsar.type.ERASURE));
        fireEvent.change(document.getElementById('dsar-record-notes') as HTMLElement, { target: { value: 'By email' } });
        fireEvent.click(document.getElementById('dsar-record-submit') as HTMLElement);

        await waitFor(() => expect(screen.getByTestId('dsar-subject-r-new')).toBeInTheDocument());
        expect(calls[0]).toEqual({ method: 'POST', body: { userId: 'u-1', type: 'ERASURE', notes: 'By email' } });
    });

    it('cannot be submitted without a subject', async () => {
        stubFetch(() => ({ status: 201, body: req() }));
        renderRegister([]);
        fireEvent.click(document.getElementById('dsar-record-btn') as HTMLElement);
        await screen.findByTestId('subject-picker');
        expect(document.getElementById('dsar-record-submit')).toBeDisabled();
    });

    it('shows the server\'s refusal and keeps the dialog open', async () => {
        stubFetch(() => ({ status: 404, body: { error: { message: 'No active member of this tenant with that id.' } } }));
        renderRegister([]);
        fireEvent.click(document.getElementById('dsar-record-btn') as HTMLElement);
        fireEvent.change(await screen.findByTestId('subject-picker'), { target: { value: 'u-1' } });
        fireEvent.click(document.getElementById('dsar-record-submit') as HTMLElement);
        expect(await screen.findByTestId('dsar-record-error')).toHaveTextContent('No active member of this tenant with that id.');
    });
});

describe('moving a request on', () => {
    it('offers exactly the moves the server allows from its status', async () => {
        stubFetch(() => ({ status: 200, body: req() }));
        renderRegister([req({ status: 'VERIFIED' })]);
        fireEvent.click(screen.getByTestId('dsar-subject-r-1'));
        await screen.findByTestId('dsar-request-sheet');
        expect(document.getElementById('dsar-move-IN_PROGRESS')).not.toBeNull();
        expect(document.getElementById('dsar-move-REJECTED')).not.toBeNull();
        expect(document.getElementById('dsar-move-CANCELED')).not.toBeNull();
        expect(document.getElementById('dsar-move-COMPLETED')).toBeNull();
        expect(document.getElementById('dsar-move-VERIFIED')).toBeNull();
    });

    it('a rejection needs a reason, and sends it', async () => {
        stubFetch(() => ({ status: 200, body: req({ status: 'REJECTED', rejectionReason: 'legal_hold' }) }));
        renderRegister([req()]);
        fireEvent.click(screen.getByTestId('dsar-subject-r-1'));
        await screen.findByTestId('dsar-request-sheet');
        const reject = document.getElementById('dsar-move-REJECTED') as HTMLElement;
        expect(reject).toBeDisabled();
        fireEvent.click(screen.getByLabelText(dsar.rejection.legal_hold));
        expect(reject).not.toBeDisabled();
        fireEvent.click(reject);
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].body).toMatchObject({ id: 'r-1', to: 'REJECTED', reason: 'legal_hold' });
        await waitFor(() => expect(screen.getByTestId('dsar-sheet-status')).toHaveTextContent(dsar.status.REJECTED));
        expect(screen.getByTestId('dsar-sheet-reason')).toHaveTextContent(dsar.rejection.legal_hold);
    });

    it('a finished request offers no move, and shows its notes', async () => {
        renderRegister([req({ status: 'COMPLETED', fulfilmentNotes: 'Export sent by post', completedAt: '2026-10-20T00:00:00.000Z' })]);
        fireEvent.click(screen.getByTestId('dsar-subject-r-1'));
        const sheet = await screen.findByTestId('dsar-request-sheet');
        expect(within(sheet).queryByRole('button')).toBeNull();
        expect(screen.getByTestId('dsar-sheet-notes')).toHaveTextContent('Export sent by post');
    });
});

describe('a reader', () => {
    it('sees the register and the details, and no control', async () => {
        renderRegister([req({ fulfilmentNotes: 'Awaiting ID' })], false);
        expect(document.getElementById('dsar-record-btn')).toBeNull();
        expect(screen.getByText(dsar.readOnlyNotice)).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('dsar-subject-r-1'));
        const sheet = await screen.findByTestId('dsar-request-sheet');
        expect(within(sheet).queryByRole('button')).toBeNull();
        expect(screen.getByTestId('dsar-sheet-notes')).toHaveTextContent('Awaiting ID');
    });
});

describe('the cap', () => {
    it('says when the register holds more than it shows', () => {
        render(<DsarRegisterClient tenantSlug="acme" initial={[req()]} canManage title={dsar.title} truncated />);
        expect(screen.getByTestId('list-truncation-banner')).toBeInTheDocument();
    });
});
