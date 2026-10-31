/**
 * "Use for Ask" on the agent's page (#4629).
 *
 * Nothing in the product could designate the agent that answers on Ask, so
 * every question was refused `NO_AGENT_DESIGNATED`. The control is register
 * authority (owner decision, 2026-10-30): offered with the register flag,
 * never to a view-key reader, and never to choose a retired agent. The badge
 * saying which agent answers is shown to every reader of the page.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.setTimeout(180_000);

const mockRefresh = jest.fn();
const toastError = jest.fn();
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: (...a: unknown[]) => toastError(...a), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

// next-intl is ESM (jest cannot parse it); resolve real en.json values. `make`
// is memoised per namespace so the column `useMemo([t])` stays stable.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const walk = (root: unknown, dotted: string): unknown =>
        dotted.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: mockRefresh,
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

// The detail shell's tabs and actions fetch on mount. None of them is under
// test: the claim is about the header's meta strip, which the shell computes
// from its `agent` prop alone.
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OverviewTab', () => ({ OverviewTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/ServicePrincipalLinkCard', () => ({ ServicePrincipalLinkCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/RiskAssessmentTab', () => ({ RiskAssessmentTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/PolicyCardTab', () => ({ PolicyCardTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/ToolsTab', () => ({ ToolsTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/CoverageTab', () => ({ CoverageTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/SkillsTab', () => ({ SkillsTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/BehaviourTab', () => ({ BehaviourTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/RunsTab', () => ({ RunsTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/CircuitBreakerTab', () => ({ CircuitBreakerTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentKillSwitchAction', () => ({
    AgentKillSwitchAction: () => null,
    AgentKillSwitchBanner: () => null,
}));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentAmendModal', () => ({ AgentAmendModal: () => null }));

import { AgentDetailClient, type AgentDetailPermissions } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient';

const AGENT = {
    id: 'agent-1', name: 'Agent one', status: 'ACTIVE', autonomyLevel: 2,
    dataAccessScope: 'READ_TENANT_DATA', reversibility: 'COMPENSABLE', provenance: 'FIRST_PARTY',
    riskTier: 'MODERATE', aiActRiskTier: 'HIGH', description: null, modelRef: null,
    ownerUserId: 'user-1', vendorId: null, registrationEnforced: true,
};
const VIEW_ONLY: AgentDetailPermissions = {
    canReadRegistry: false, canManageRegistry: false, canEditPolicyCard: false,
    canGrantTools: false, canKill: false, canCloseBreaker: false,
};
const MANAGER: AgentDetailPermissions = { ...VIEW_ONLY, canReadRegistry: true, canManageRegistry: true };

const fetchMock = jest.fn();
beforeEach(() => {
    mockRefresh.mockReset();
    toastError.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

function renderWith(perms: AgentDetailPermissions, agent: Partial<typeof AGENT> & { isInteractiveAgent?: boolean } = {}) {
    return render(
        <AgentDetailClient tenantSlug="acme" agent={{ ...AGENT, ...agent }} perms={perms} owners={[]} vendors={[]} />,
    );
}

describe('Use for Ask (#4629)', () => {
    it('is not offered to a view-key reader, who still sees which agent answers', () => {
        renderWith(VIEW_ONLY, { isInteractiveAgent: true });
        expect(screen.queryByTestId('agent-interactive-action')).toBeNull();
        expect(screen.getByTestId('agent-interactive-badge').textContent).toBe('Answers on Ask');
    });

    it('designates the agent with a PUT and refreshes the page', async () => {
        renderWith(MANAGER);
        expect(screen.queryByTestId('agent-interactive-badge')).toBeNull();
        const action = screen.getByTestId('agent-interactive-action');
        expect(action.textContent).toBe('Use for Ask');
        await act(async () => { fireEvent.click(action); });
        await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/admin/agents/agent-1/interactive', { method: 'PUT' });
    });

    it('stops it with a DELETE when it is the designated agent', async () => {
        renderWith(MANAGER, { isInteractiveAgent: true });
        const action = screen.getByTestId('agent-interactive-action');
        expect(action.textContent).toBe('Stop using for Ask');
        await act(async () => { fireEvent.click(action); });
        await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/admin/agents/agent-1/interactive', { method: 'DELETE' });
    });

    it('never offers to choose a retired agent, but lets a retired designation be stopped', () => {
        const { unmount } = renderWith(MANAGER, { status: 'RETIRED' });
        expect(screen.queryByTestId('agent-interactive-action')).toBeNull();
        unmount();
        renderWith(MANAGER, { status: 'RETIRED', isInteractiveAgent: true });
        expect(screen.getByTestId('agent-interactive-action').textContent).toBe('Stop using for Ask');
    });

    it("shows the server's reason when the change is refused, and does not refresh", async () => {
        fetchMock.mockResolvedValue({
            ok: false, status: 409,
            json: async () => ({ error: { code: 'CONFLICT', message: 'A retired agent cannot answer questions. Choose another agent.' } }),
        });
        renderWith(MANAGER);
        await act(async () => { fireEvent.click(screen.getByTestId('agent-interactive-action')); });
        await waitFor(() => expect(toastError).toHaveBeenCalled());
        expect(toastError.mock.calls[0][0]).toBe('A retired agent cannot answer questions. Choose another agent.');
        expect(mockRefresh).not.toHaveBeenCalled();
    });
});
