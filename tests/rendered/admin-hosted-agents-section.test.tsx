/**
 * The Owner's opt-in to agents hosted by Inflect on Admin → AI features
 * (Step 6b of `docs/claude-managed-agents-design.md`, shape MA-C1).
 *
 * What reaches the DOM, against the real `messages/en.json`:
 *   - nothing at all while the deployment does not offer hosting and the
 *     workspace has not opted in, which is every workspace while
 *     `HOSTED_MANAGED_AGENTS_ACTIVE` is false;
 *   - when it is offered, the terms in plain words (stored in the US, without
 *     Zero Data Retention, until the run ends; agent objects holding only
 *     Inflect's own instructions, archived and never deleted);
 *   - a workspace that opted in can always opt out, even when hosting is no
 *     longer offered;
 *   - the opt-in is not offered when the plan does not include it.
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

import { HostedAgentsSection } from '@/app/t/[tenantSlug]/(app)/admin/ai-features/HostedAgentsSection';

const OFFERED = {
    optedIn: false,
    offered: true,
    entitled: true,
    residency: 'EXTERNAL',
    workspace: 'NONE',
    hostedRefusal: 'HOSTED_NOT_OPTED_IN',
};

const fetchMock = jest.fn();
beforeEach(() => {
    swrState.data = { setting: OFFERED };
    swrState.error = undefined;
    mutate.mockClear();
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

describe('HostedAgentsSection', () => {
    it('renders nothing while hosting is not offered and the workspace has not opted in', () => {
        swrState.data = { setting: { ...OFFERED, offered: false, hostedRefusal: 'HOSTED_NOT_ACTIVE' } };
        const { container } = render(<HostedAgentsSection />);
        expect(container).toBeEmptyDOMElement();
    });

    it('says in plain words where the data goes, for how long, and what is never deleted', () => {
        render(<HostedAgentsSection />);
        const terms = screen.getByTestId('hosted-agents-terms');
        expect(terms).toHaveTextContent('in the US, without Zero Data Retention, until the run ends');
        expect(terms).toHaveTextContent('hold only Inflect\'s own instructions and tool descriptions');
        expect(terms).toHaveTextContent('archived when they are no longer needed and are never deleted');
        expect(screen.getByTestId('hosted-agents-toggle')).toHaveTextContent('Opt in');
        expect(screen.getByTestId('hosted-agents-toggle')).toBeEnabled();
    });

    it('opting in sends exactly the opt-in', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        render(<HostedAgentsSection />);
        fireEvent.click(screen.getByTestId('hosted-agents-toggle'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/admin/hosted-managed-agents', expect.objectContaining({
            method: 'PUT',
            body: JSON.stringify({ optIn: true }),
        }));
        await waitFor(() => expect(mutate).toHaveBeenCalled());
    });

    it('a plan without hosting is told so, and is not offered the opt-in', () => {
        swrState.data = { setting: { ...OFFERED, entitled: false, hostedRefusal: 'HOSTED_NOT_ENTITLED' } };
        render(<HostedAgentsSection />);
        expect(screen.getByTestId('hosted-agents-notice-notEntitled')).toBeInTheDocument();
        expect(screen.getByTestId('hosted-agents-toggle')).toBeDisabled();
    });

    it('a workspace that opted in can always opt out, even when hosting is no longer offered', () => {
        swrState.data = { setting: { ...OFFERED, optedIn: true, offered: false, hostedRefusal: 'HOSTED_NOT_ACTIVE' } };
        render(<HostedAgentsSection />);
        expect(screen.getByTestId('hosted-agents-notice-notOffered')).toBeInTheDocument();
        expect(screen.getByTestId('hosted-agents-toggle')).toHaveTextContent('Opt out');
        expect(screen.getByTestId('hosted-agents-toggle')).toBeEnabled();
    });

    it('a refusal is shown, not swallowed', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 409,
            json: async () => ({ error: { message: 'HOSTED_NOT_OFFERED: This deployment does not offer agents hosted in Inflect\'s Anthropic organisation.' } }),
        });
        render(<HostedAgentsSection />);
        fireEvent.click(screen.getByTestId('hosted-agents-toggle'));
        await waitFor(() => expect(screen.getByTestId('hosted-agents-save-failed')).toBeInTheDocument());
    });
});
