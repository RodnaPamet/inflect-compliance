/**
 * THE WORKSPACE'S PER-TURN LIMITS SAY WHICH VALUE APPLIES, AND MAY ONLY NARROW (#4594).
 *
 *   1. Each cap shows the value that applies and why: the organization's
 *      limit, this workspace's own, or the product default with no
 *      organization.
 *   2. A stored value above a ceiling the organization lowered says
 *      "narrowed by your organization", naming both numbers.
 *   3. The stepper is bounded by the organization's ceiling: it cannot be
 *      stepped above it.
 *   4. Choosing a lower limit and saving PUTs that key alone; choosing to
 *      follow the organization PUTs an explicit `null`.
 *   5. A refused save shows the server's sentence.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = resolve(`${ns}.${key}`);
        if (typeof v !== 'string') return key;
        if (params)
            for (const [p, val] of Object.entries(params))
                v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
        return v as string;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl };
});

import { AgentTurnCapsCard } from '@/app/t/[tenantSlug]/(app)/admin/security/AgentTurnCapsCard';
import { resolveTurnCaps, type TurnCapInputs } from '@/lib/agentic/turn-caps';

const EN = (
    require('../../messages/en.json') as { admin: { security: { agentTurnCaps: Record<string, string> } } }
).admin.security.agentTurnCaps;
const fill = (s: string, params: Record<string, number>) =>
    Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), s);

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

/** The payload the route returns, resolved by the real resolver. */
function settings(input: TurnCapInputs) {
    return {
        agentMaxSubagentsPerTurn: input.workspace?.delegationsPerTurn ?? null,
        agentMaxToolCallsPerTurn: input.workspace?.toolCallsPerTurn ?? null,
        turnCaps: resolveTurnCaps(input),
    };
}

/** GET answers `input`; a PUT merges what it was sent and re-resolves, or refuses. */
function stub(input: TurnCapInputs, refuseWith?: string): void {
    calls = [];
    let current = input;
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, number | null>) : undefined;
        calls.push({ url, method, body });
        if (method === 'GET') return { ok: true, json: async () => settings(current) };
        if (refuseWith) return { ok: false, json: async () => ({ error: { code: 'BAD_REQUEST', message: refuseWith } }) };
        const ws = current.workspace ?? { delegationsPerTurn: null, toolCallsPerTurn: null };
        current = {
            organization: current.organization,
            workspace: {
                delegationsPerTurn: body && 'agentMaxSubagentsPerTurn' in body ? body.agentMaxSubagentsPerTurn : ws.delegationsPerTurn,
                toolCallsPerTurn: body && 'agentMaxToolCallsPerTurn' in body ? body.agentMaxToolCallsPerTurn : ws.toolCallsPerTurn,
            },
        };
        return { ok: true, json: async () => settings(current) };
    }) as unknown as typeof fetch;
}

afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

const ORG = (delegationsPerTurn: number, toolCallsPerTurn: number) => ({ delegationsPerTurn, toolCallsPerTurn });

describe('the workspace\'s agent per-turn limits', () => {
    it('shows the value that applies and why, for each cap', async () => {
        stub({ organization: ORG(3, 4), workspace: { delegationsPerTurn: 1, toolCallsPerTurn: null } });
        render(<AgentTurnCapsCard />);
        const delegations = await screen.findByTestId('agent-turn-cap-delegationsPerTurn-state');
        expect(delegations).toHaveTextContent(fill(EN.applies, { value: 1 }));
        expect(delegations).toHaveTextContent(EN.basisWorkspace);
        const tools = screen.getByTestId('agent-turn-cap-toolCallsPerTurn-state');
        expect(tools).toHaveTextContent(fill(EN.applies, { value: 4 }));
        expect(tools).toHaveTextContent(EN.basisOrganization);
        // Following the organization offers no stepper for a number nobody chose.
        expect(within(screen.getByTestId('agent-turn-cap-toolCallsPerTurn-row')).queryByRole('spinbutton')).toBeNull();
    });

    it('a workspace with no organization follows the product default, and says so', async () => {
        stub({ organization: null, workspace: null });
        render(<AgentTurnCapsCard />);
        expect(await screen.findByTestId('agent-turn-cap-delegationsPerTurn-state')).toHaveTextContent(EN.basisNoOrganization);
        expect(screen.getByTestId('agent-turn-cap-toolCallsPerTurn-row')).toHaveTextContent(fill(EN.followNoOrg, { ceiling: 1 }));
    });

    it('a stored value above a lowered ceiling says the organization narrowed it, naming both numbers', async () => {
        stub({ organization: ORG(1, 1), workspace: { delegationsPerTurn: 3, toolCallsPerTurn: null } });
        render(<AgentTurnCapsCard />);
        expect(await screen.findByTestId('agent-turn-cap-delegationsPerTurn-narrowed')).toHaveTextContent(
            fill(EN.narrowedByOrg, { stored: 3, ceiling: 1 }),
        );
        expect(screen.getByTestId('agent-turn-cap-delegationsPerTurn-state')).toHaveTextContent(fill(EN.applies, { value: 1 }));
        expect(screen.queryByTestId('agent-turn-cap-toolCallsPerTurn-narrowed')).toBeNull();
    });

    it('a lower limit is bounded by the ceiling, and saving PUTs that key alone', async () => {
        const user = userEvent.setup();
        stub({ organization: ORG(3, 2), workspace: null });
        render(<AgentTurnCapsCard />);
        const row = await screen.findByTestId('agent-turn-cap-toolCallsPerTurn-row');
        await user.click(within(row).getByTestId('agent-turn-cap-toolCallsPerTurn-mode-custom'));
        const stepper = within(row).getByRole('spinbutton');
        // Starts at the ceiling and cannot be stepped above it.
        expect(stepper).toHaveValue('2');
        expect(within(row).getByRole('button', { name: EN.increase })).toBeDisabled();
        await user.click(within(row).getByRole('button', { name: EN.decrease }));
        await user.click(screen.getByTestId('agent-turn-cap-toolCallsPerTurn-save'));
        expect(calls.filter((c) => c.method === 'PUT')).toEqual([
            { url: '/api/t/acme/admin/security-settings', method: 'PUT', body: { agentMaxToolCallsPerTurn: 1 } },
        ]);
        expect(await within(row).findByText(EN.saved)).toBeInTheDocument();
        expect(screen.getByTestId('agent-turn-cap-toolCallsPerTurn-state')).toHaveTextContent(EN.basisWorkspace);
    });

    it('following the organization PUTs an explicit null', async () => {
        const user = userEvent.setup();
        stub({ organization: ORG(3, 2), workspace: { delegationsPerTurn: 1, toolCallsPerTurn: null } });
        render(<AgentTurnCapsCard />);
        const row = await screen.findByTestId('agent-turn-cap-delegationsPerTurn-row');
        await user.click(within(row).getByTestId('agent-turn-cap-delegationsPerTurn-mode-follow'));
        await user.click(screen.getByTestId('agent-turn-cap-delegationsPerTurn-save'));
        expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ agentMaxSubagentsPerTurn: null }]);
    });

    it('a refused save shows the server\'s sentence', async () => {
        const user = userEvent.setup();
        stub({ organization: ORG(3, 2), workspace: null }, 'agentMaxToolCallsPerTurn cannot be above your organization\'s limit of 2');
        render(<AgentTurnCapsCard />);
        const row = await screen.findByTestId('agent-turn-cap-toolCallsPerTurn-row');
        await user.click(within(row).getByTestId('agent-turn-cap-toolCallsPerTurn-mode-custom'));
        await user.click(within(row).getByRole('button', { name: EN.decrease }));
        await user.click(screen.getByTestId('agent-turn-cap-toolCallsPerTurn-save'));
        expect(await within(row).findByText(/cannot be above your organization's limit of 2/)).toBeInTheDocument();
    });
});
