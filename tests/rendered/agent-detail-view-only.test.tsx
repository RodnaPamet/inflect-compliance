/**
 * THE AGENT DETAIL PAGE FOR A READER HOLDING ONLY THE INVENTORY VIEW KEY (#3710).
 *
 * The page renders for the inventory read (the view key, or the register key),
 * so a tab may no longer assume the register key. The shell disables every tab
 * whose own GET is gated on that key, and offers no write: an AUDITOR opens the
 * agent's row and its runs, and is never handed a control the server refuses.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

// Mounting the register mounts the table, the filter system and the create
// modal's form stack, which is slow on a loaded machine. Nothing here is about
// speed.
jest.setTimeout(180_000);

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
        refresh: jest.fn(),
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
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/RunsTab', () => ({ RunsTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/CircuitBreakerTab', () => ({ CircuitBreakerTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentKillSwitchAction', () => ({
    AgentKillSwitchAction: () => null,
    AgentKillSwitchBanner: () => null,
}));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentAmendModal', () => ({ AgentAmendModal: () => null }));

import { AgentDetailClient, type AgentDetailPermissions } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient';

const AGENT = {
    id: 'agent-1',
    name: 'Agent one',
    status: 'ACTIVE',
    autonomyLevel: 2,
    dataAccessScope: 'READ_TENANT_DATA',
    reversibility: 'COMPENSABLE',
    provenance: 'FIRST_PARTY',
    riskTier: 'MODERATE',
    aiActRiskTier: 'HIGH',
    description: null,
    modelRef: null,
    ownerUserId: 'user-1',
    vendorId: null,
    registrationEnforced: true,
};

const VIEW_ONLY: AgentDetailPermissions = {
    canReadRegistry: false,
    canManageRegistry: false,
    canEditPolicyCard: false,
    canGrantTools: false,
    canKill: false,
    canCloseBreaker: false,
};

function renderWith(perms: AgentDetailPermissions) {
    return render(<AgentDetailClient tenantSlug="acme" agent={AGENT} perms={perms} owners={[]} vendors={[]} />);
}

const tab = (key: string) => document.getElementById(`tab-${key}`) as HTMLButtonElement | null;

describe('a view-key-only reader', () => {
    it('opens Overview and Runs, and finds every register-key tab disabled', () => {
        renderWith(VIEW_ONLY);
        const disabled = ['overview', 'risk', 'policy', 'tools', 'skills', 'coverage', 'runs', 'breaker'].filter(
            (k) => tab(k)?.disabled,
        );
        expect(disabled).toEqual(['risk', 'policy', 'tools', 'skills', 'coverage', 'breaker']);
    });

    it('is offered no amend action', () => {
        renderWith(VIEW_ONLY);
        expect(screen.queryByTestId('agent-amend-action')).toBeNull();
    });

    it('Tools opens for a holder of the tool-exposure key without the register key — the grants are theirs', () => {
        renderWith({ ...VIEW_ONLY, canGrantTools: true });
        expect(tab('tools')?.disabled).toBe(false);
        expect(tab('risk')?.disabled).toBe(true);
    });

    it('the paired positive: a register-key holder has every tab the narrow keys do not close', () => {
        renderWith({ ...VIEW_ONLY, canReadRegistry: true, canManageRegistry: true });
        const disabled = ['overview', 'risk', 'policy', 'tools', 'skills', 'coverage', 'runs', 'breaker'].filter(
            (k) => tab(k)?.disabled,
        );
        expect(disabled).toEqual(['policy']);
        expect(screen.getByTestId('agent-amend-action')).toBeTruthy();
    });
});
