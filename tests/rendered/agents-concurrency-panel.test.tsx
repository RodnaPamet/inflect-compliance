/**
 * #3484 — the concurrent-run cap, as an operator actually meets it.
 *
 * The enforcement is covered against a real database elsewhere. What a
 * rendered test can cover and nothing else does is the part where the two
 * values that mean OPPOSITE things have to survive a form:
 *
 *   - An EMPTY input means "no cap". A `0` means "no agentic run may start".
 *     A control that initialised the empty state to `'0'`, or submitted `''`
 *     as `0`, would turn one into the other — and the one that turns "stop"
 *     into "unlimited" is the dangerous direction.
 *   - The PATCH body carries `null` for empty, not an omitted field: the route
 *     distinguishes clearing from setting, and a missing key would be neither.
 */
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));

import { ConcurrencyPanel } from '@/app/t/[tenantSlug]/(app)/agents/AgentsClient';

const EN = jest.requireActual('../../messages/en.json') as Record<string, unknown>;

afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
});

function renderPanel(cap: number | null, inFlight = 0) {
    return render(
        <NextIntlClientProvider locale="en" messages={EN}>
            <ConcurrencyPanel cap={cap} inFlight={inFlight} tenantSlug="acme" />
        </NextIntlClientProvider>,
    );
}

function mockFetch(ok = true, body: unknown = { cap: 3 }) {
    const fn = jest.fn().mockResolvedValue({
        ok,
        json: async () => body,
    } as Response);
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

describe('the concurrent-run cap panel', () => {
    it('shows NO CAP and the live count when none is configured', () => {
        renderPanel(null, 2);
        expect(screen.getByTestId('agents-concurrency-state')).toHaveTextContent(/no cap/i);
        expect(screen.getByTestId('agents-concurrency-state')).toHaveTextContent('2');
        // The input is EMPTY, not '0'. Initialising it to zero would offer an
        // operator a form that reads "stop every run" for a tenant with no cap.
        expect(screen.getByTestId('agents-concurrency-input')).toHaveValue(null);
    });

    it('shows a cap of ZERO as zero, not as "no cap"', () => {
        renderPanel(0, 0);
        const input = screen.getByTestId('agents-concurrency-input');
        expect(input).toHaveValue(0);
        expect(screen.getByTestId('agents-concurrency-state')).toHaveTextContent('0');
    });

    it('sends the typed cap as a number', async () => {
        const fetchMock = mockFetch();
        renderPanel(null);
        await userEvent.type(screen.getByTestId('agents-concurrency-input'), '3');
        await userEvent.click(screen.getByTestId('agents-concurrency-save'));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/t/acme/admin/agents/concurrency');
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(String(init.body))).toEqual({ cap: 3 });
    });

    it('sends NULL for an emptied input — clearing is a value, not an omission', async () => {
        const fetchMock = mockFetch();
        renderPanel(5);
        await userEvent.clear(screen.getByTestId('agents-concurrency-input'));
        await userEvent.click(screen.getByTestId('agents-concurrency-save'));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        // `{ cap: null }`, and the assertion is on the PARSED body so an
        // omitted key fails rather than matching a substring.
        expect(JSON.parse(String(init.body))).toEqual({ cap: null });
    });

    it('sends ZERO for a typed 0 — the opposite instruction, and not null', async () => {
        const fetchMock = mockFetch();
        renderPanel(null);
        await userEvent.type(screen.getByTestId('agents-concurrency-input'), '0');
        await userEvent.click(screen.getByTestId('agents-concurrency-save'));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({ cap: 0 });
    });

    it('refuses a negative before it reaches the server', async () => {
        const fetchMock = mockFetch();
        renderPanel(null);
        await userEvent.type(screen.getByTestId('agents-concurrency-input'), '-2');
        await userEvent.click(screen.getByTestId('agents-concurrency-save'));

        expect(await screen.findByTestId('agents-concurrency-error')).toBeInTheDocument();
        // The server would refuse it too (a zod `min(0)` and a CHECK
        // constraint). Refusing here as well means the operator is told what
        // is wrong rather than reading a 400.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('shows the SERVER\'s message when the save is refused', async () => {
        // Not a generic "something went wrong": the route refuses a cap above
        // its sanity rail, and that is the sentence an operator needs.
        mockFetch(false, { error: { message: 'cap must be 1000 or less' } });
        renderPanel(null);
        await userEvent.type(screen.getByTestId('agents-concurrency-input'), '99999');
        await userEvent.click(screen.getByTestId('agents-concurrency-save'));

        expect(await screen.findByTestId('agents-concurrency-error')).toHaveTextContent(
            /1000 or less/,
        );
    });

    it('names the monthly budget, so a refused run can be attributed to the right limit', () => {
        // Two limits refuse runs. An operator reading one panel has to be able
        // to tell which one stopped them.
        renderPanel(null);
        expect(screen.getByTestId('agents-concurrency')).toHaveTextContent(/budget/i);
    });
});
