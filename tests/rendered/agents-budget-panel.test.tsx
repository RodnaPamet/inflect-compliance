/**
 * #3777 — the monthly token budget, set beside the concurrency cap, as an
 * operator meets it.
 *
 * Two states that mean opposite things must survive the form: "no budget" is a
 * named choice that sends `null`, and a budget of 0 sends `0`, which refuses
 * every run. And the budget's own trap: a value above 0 and below one run's
 * ceiling refuses every run while reading as a budget, so the panel will not
 * send it, and says why.
 */
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));

import { BudgetPanel } from '@/app/t/[tenantSlug]/(app)/agents/AgentsClient';
import { BUDGET_RUN_TOKEN_CEILING } from '@/lib/agentic/monthly-budget';

const EN = jest.requireActual('../../messages/en.json') as Record<string, unknown>;

afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
});

function renderPanel(budget: number | null, spentThisMonth = 0, canEdit?: boolean) {
    return render(
        <NextIntlClientProvider locale="en" messages={EN}>
            <BudgetPanel budget={budget} spentThisMonth={spentThisMonth} tenantSlug="acme" canEdit={canEdit} />
        </NextIntlClientProvider>,
    );
}

function mockFetch(ok = true, body: unknown = { budget: 1_000_000 }) {
    const fn = jest.fn().mockResolvedValue({ ok, json: async () => body } as Response);
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

/** The stepper's text input, set to an exact value. */
function setValue(n: number) {
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: String(n) } });
    fireEvent.blur(input);
}

const sent = (fetchMock: jest.Mock, i = 0) => JSON.parse(String((fetchMock.mock.calls[i] as [string, RequestInit])[1].body));

describe('the monthly token budget panel', () => {
    it('shows NO BUDGET, quotes no spend, and offers no stepper when none is configured', () => {
        // Spend is summed only against a budget; a figure here would be a false zero.
        renderPanel(null, 777);
        expect(screen.getByTestId('agents-budget-state')).toHaveTextContent(/no budget/i);
        expect(screen.getByTestId('agents-budget-state')).not.toHaveTextContent('777');
        expect(screen.queryByRole('spinbutton')).toBeNull();
        // Nothing to save until something changes.
        expect(screen.getByTestId('agents-budget-save')).toBeDisabled();
    });

    it('quotes the budget and this month\'s spend once a budget exists', () => {
        renderPanel(5_000_000, 1_234);
        const state = screen.getByTestId('agents-budget-state');
        expect(state).toHaveTextContent(/5,000,000|5000000/);
        expect(state).toHaveTextContent(/1,234|1234/);
    });

    it('choosing a budget sends a number that admits runs, to the budget route', async () => {
        const fetchMock = mockFetch();
        renderPanel(null);
        await userEvent.click(screen.getByTestId('agents-budget-mode-set'));
        await userEvent.click(screen.getByTestId('agents-budget-save'));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/t/acme/admin/agents/budget');
        expect(init.method).toBe('PATCH');
        const { budget } = sent(fetchMock);
        expect(budget).toBeGreaterThanOrEqual(BUDGET_RUN_TOKEN_CEILING);
    });

    it('choosing NO BUDGET sends null, not zero', async () => {
        const fetchMock = mockFetch();
        renderPanel(2_000_000);
        await userEvent.click(screen.getByTestId('agents-budget-mode-none'));
        await userEvent.click(screen.getByTestId('agents-budget-save'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(sent(fetchMock)).toEqual({ budget: null });
    });

    it('a budget of 0 sends 0, and the panel says it refuses every run', async () => {
        const fetchMock = mockFetch();
        renderPanel(2_000_000);
        setValue(0);
        expect(screen.getByTestId('agents-budget-zero')).toHaveTextContent(/every new agentic run/i);
        await userEvent.click(screen.getByTestId('agents-budget-save'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(sent(fetchMock)).toEqual({ budget: 0 });
    });

    it('will not send a budget below one run\'s ceiling, and names the ceiling', async () => {
        const fetchMock = mockFetch();
        renderPanel(2_000_000);
        setValue(BUDGET_RUN_TOKEN_CEILING - 1);
        const notice = screen.getByTestId('agents-budget-below-one-run');
        expect(notice).toHaveTextContent(/every run/i);
        expect(notice.textContent).toMatch(/200,000|200000/);
        expect(screen.getByTestId('agents-budget-save')).toBeDisabled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts exactly one run\'s ceiling, the smallest budget that admits a run', async () => {
        const fetchMock = mockFetch();
        renderPanel(2_000_000);
        setValue(BUDGET_RUN_TOKEN_CEILING);
        expect(screen.queryByTestId('agents-budget-below-one-run')).toBeNull();
        await userEvent.click(screen.getByTestId('agents-budget-save'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(sent(fetchMock)).toEqual({ budget: BUDGET_RUN_TOKEN_CEILING });
    });

    it('shows the SERVER\'s message when the save is refused', async () => {
        mockFetch(false, { error: { message: 'Forbidden: admin.agent_registry is required' } });
        renderPanel(null);
        await userEvent.click(screen.getByTestId('agents-budget-mode-set'));
        await userEvent.click(screen.getByTestId('agents-budget-save'));
        expect(await screen.findByTestId('agents-budget-error')).toHaveTextContent(/admin\.agent_registry/);
    });

    it('shows the edge\'s flat refusal rather than the generic save-failed text (#4471)', async () => {
        // The middleware refuses an admin path with `{ error: 'Admin access
        // required' }` — a string, which `body.error.message` never reached.
        mockFetch(false, { error: 'Admin access required' });
        renderPanel(null);
        await userEvent.click(screen.getByTestId('agents-budget-mode-set'));
        await userEvent.click(screen.getByTestId('agents-budget-save'));
        expect(await screen.findByTestId('agents-budget-error')).toHaveTextContent('Admin access required');
    });

    it('names the concurrent-run cap, so a refused run can be attributed to the right limit', () => {
        renderPanel(null);
        expect(screen.getByTestId('agents-budget')).toHaveTextContent(/concurrent/i);
    });

    it('shows a view-only reader the budget, and no control to change it', () => {
        renderPanel(3_000_000, 10, false);
        expect(screen.getByTestId('agents-budget-state')).toBeInTheDocument();
        expect(screen.queryByRole('spinbutton')).toBeNull();
        expect(screen.queryByTestId('agents-budget-mode-set')).toBeNull();
        expect(screen.queryByTestId('agents-budget-save')).toBeNull();
    });
});
