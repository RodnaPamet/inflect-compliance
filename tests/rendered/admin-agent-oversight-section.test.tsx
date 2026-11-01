/**
 * The Owner's agent oversight switches on Admin → AI features (round 15).
 *
 * What reaches the DOM, against the real `messages/en.json`:
 *   - each of the five switches renders with its own name and its state;
 *   - a button offers the opposite of the state it shows;
 *   - pressing one sends ONLY that switch, so two owners changing different
 *     switches do not overwrite each other;
 *   - a refusal is shown, not swallowed.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns?: string) => (key: string) => {
            const dotted = ns ? `${ns}.${key}` : key;
            let cur: unknown = en;
            for (const part of dotted.split('.')) {
                cur = (cur as Record<string, unknown> | undefined)?.[part];
            }
            return typeof cur === 'string' ? cur : dotted;
        },
    };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

const mutate = jest.fn(async () => undefined);
const swrState: { data: unknown; isLoading: boolean; error: unknown; mutate: typeof mutate } = {
    data: undefined,
    isLoading: false,
    error: undefined,
    mutate,
};
jest.mock('@/lib/hooks/use-tenant-swr', () => ({ useTenantSWR: () => swrState }));

import { AgentOversightSection } from '@/app/t/[tenantSlug]/(app)/admin/ai-features/AgentOversightSection';

const DEFAULTS = {
    composeNeedsSecondApprover: true,
    exactParameterEditNeedsSecondApprover: false,
    auditorReadsDecisionLog: false,
    auditorReadsReceipts: false,
    auditorReadsQuarantine: false,
};

const fetchMock = jest.fn();
beforeEach(() => {
    swrState.data = { settings: DEFAULTS };
    swrState.error = undefined;
    mutate.mockClear();
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

describe('AgentOversightSection', () => {
    it('renders every switch with its name and state', () => {
        render(<AgentOversightSection />);
        expect(screen.getByText('A second person approves composed requests')).toBeInTheDocument();
        expect(screen.getByText('Auditors can read quarantined proposals')).toBeInTheDocument();
        expect(screen.getByTestId('agent-oversight-composeNeedsSecondApprover')).toHaveTextContent('On');
        expect(screen.getByTestId('agent-oversight-auditorReadsReceipts')).toHaveTextContent('Off');
        expect(screen.getByTestId('agent-oversight-toggle-composeNeedsSecondApprover')).toHaveTextContent('Turn off');
        expect(screen.getByTestId('agent-oversight-toggle-auditorReadsReceipts')).toHaveTextContent('Turn on');
    });

    it('sends only the switch that was pressed', async () => {
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
        render(<AgentOversightSection />);
        fireEvent.click(screen.getByTestId('agent-oversight-toggle-auditorReadsReceipts'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
        expect(url).toBe('/api/t/acme/admin/agent-oversight');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({ auditorReadsReceipts: true });
        await waitFor(() => expect(mutate).toHaveBeenCalled());
    });

    it('shows a refusal', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 403,
            json: async () => ({ error: { message: 'Only an owner can view or change the agent oversight settings.' } }),
        });
        render(<AgentOversightSection />);
        fireEvent.click(screen.getByTestId('agent-oversight-toggle-composeNeedsSecondApprover'));
        expect(await screen.findByTestId('agent-oversight-save-failed')).toBeInTheDocument();
        expect(mutate).not.toHaveBeenCalled();
    });

    it('a load failure renders the error state, not five dead buttons', () => {
        swrState.data = undefined;
        swrState.error = new Error('boom');
        render(<AgentOversightSection />);
        expect(screen.getByText('Couldn’t load the agent oversight settings.')).toBeInTheDocument();
        expect(screen.queryByTestId('agent-oversight-toggle-composeNeedsSecondApprover')).toBeNull();
    });
});
