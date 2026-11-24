/**
 * THE AGENT PAGE'S NINE SECTIONS ARE FOUR TABS, AND EVERY OLD ADDRESS STILL
 * LANDS (#5898).
 *
 * Nine tabs in one strip meant a phone reader scrolled it hunting for the one
 * they wanted. The sections are grouped — Overview, Assessment (risk,
 * coverage), Authority (policy card, tools, skills, behaviour), Activity
 * (runs, breaker) — and a group with several sections shows them in a second
 * strip. Every section stays reachable, and a `?tab=` link naming one of the
 * nine (or a group) opens it.
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

jest.setTimeout(120_000);

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
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

// Each section renders a marker naming itself, so a test can tell which one
// the panel holds without any section fetching.
const mockSection = (name: string) => {
    const Section = () => <div data-testid={`section-${name}`} />;
    Section.displayName = `Section(${name})`;
    return Section;
};
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OverviewTab', () => ({ OverviewTab: mockSection('overview') }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/ServicePrincipalLinkCard', () => ({ ServicePrincipalLinkCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/BehaviourFingerprintCard', () => ({ BehaviourFingerprintCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/SpendingAuthorityCard', () => ({ SpendingAuthorityCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OwnershipTransferCard', () => ({ OwnershipTransferCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/RiskAssessmentTab', () => ({ RiskAssessmentTab: mockSection('risk') }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/PolicyCardTab', () => ({ PolicyCardTab: mockSection('policy') }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/ToolsTab', () => ({ ToolsTab: mockSection('tools') }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/CoverageTab', () => ({ CoverageTab: mockSection('coverage') }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/SkillsTab', () => ({ SkillsTab: mockSection('skills') }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/BehaviourTab', () => ({ BehaviourTab: mockSection('behaviour') }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/RunsTab', () => ({ RunsTab: mockSection('runs') }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/CircuitBreakerTab', () => ({ CircuitBreakerTab: mockSection('breaker') }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentKillSwitchAction', () => ({
    AgentKillSwitchAction: () => null,
    AgentKillSwitchBanner: () => null,
}));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentAmendModal', () => ({ AgentAmendModal: () => null }));

import { AgentDetailClient, type AgentDetailPermissions } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient';
import {
    AGENT_DETAIL_GROUPS,
    AGENT_DETAIL_TAB_KEYS,
    agentDetailGroupOf,
    resolveAgentDetailTab,
    type AgentDetailTabKey,
} from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/agent-detail-tabs';

const DETAIL = (require('../../messages/en.json') as { admin: { agentDetail: Record<string, string> } }).admin.agentDetail;

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

const ALL: AgentDetailPermissions = {
    canReadRegistry: true,
    canManageRegistry: true,
    canEditPolicyCard: true,
    canGrantTools: true,
    canKill: true,
    canCloseBreaker: true,
};

function renderPage(initialTab?: string, perms: AgentDetailPermissions = ALL) {
    return render(
        <AgentDetailClient
            tenantSlug="acme"
            agent={AGENT}
            perms={perms}
            owners={[]}
            vendors={[]}
            profilesEnabled
            initialTab={initialTab}
        />,
    );
}

const pageTabs = () => within(screen.getByTestId('entity-detail-tabs')).getAllByRole('tab');
const selected = (el: HTMLElement) => el.getAttribute('aria-selected') === 'true';

beforeEach(() => {
    window.history.replaceState(null, '', '/t/acme/agents/agent-1');
});

describe('the page tab bar', () => {
    it('holds four groups, not nine sections', () => {
        renderPage();
        expect(pageTabs().map((t) => t.textContent)).toEqual([
            DETAIL.tabOverview,
            DETAIL.tabGroupAssessment,
            DETAIL.tabGroupAuthority,
            DETAIL.tabGroupActivity,
        ]);
        expect(screen.getByTestId('section-overview')).toBeInTheDocument();
        // Overview is one section, so it has no second strip.
        expect(screen.queryByTestId('agent-section-tabs')).toBeNull();
    });

    it('opens a group on its first section, in a panel labelled by that section', () => {
        renderPage();
        fireEvent.click(document.getElementById('tab-activity')!);
        expect(selected(document.getElementById('tab-activity')!)).toBe(true);
        const sectionTabs = within(screen.getByTestId('agent-section-tabs')).getAllByRole('tab');
        expect(sectionTabs.map((t) => t.textContent)).toEqual([DETAIL.tabRuns, DETAIL.tabBreaker]);
        expect(selected(document.getElementById('tab-runs')!)).toBe(true);
        expect(screen.getByTestId('agent-section-panel')).toHaveAttribute('aria-labelledby', 'tab-runs');
        expect(screen.getByTestId('section-runs')).toBeInTheDocument();
    });

    it('returns to the section last open in a group', () => {
        renderPage();
        fireEvent.click(document.getElementById('tab-authority')!);
        fireEvent.click(document.getElementById('tab-skills')!);
        fireEvent.click(document.getElementById('tab-overview')!);
        fireEvent.click(document.getElementById('tab-authority')!);
        expect(selected(document.getElementById('tab-skills')!)).toBe(true);
        expect(screen.getByTestId('section-skills')).toBeInTheDocument();
    });
});

describe('every section is reachable, and its old address opens it', () => {
    it.each(AGENT_DETAIL_TAB_KEYS.map((k) => [k]))('?tab=%s', (key) => {
        renderPage(key);
        const group = agentDetailGroupOf(key as AgentDetailTabKey);
        expect(selected(document.getElementById(`tab-${group}`)!)).toBe(true);
        expect(screen.getByTestId(`section-${key}`)).toBeInTheDocument();
        if (group !== key) expect(selected(document.getElementById(`tab-${key}`)!)).toBe(true);
    });

    it('by clicking: each section from its group', () => {
        renderPage();
        for (const key of AGENT_DETAIL_TAB_KEYS) {
            const group = agentDetailGroupOf(key);
            fireEvent.click(document.getElementById(`tab-${group}`)!);
            if (group !== key) fireEvent.click(document.getElementById(`tab-${key}`)!);
            expect(screen.getByTestId(`section-${key}`)).toBeInTheDocument();
            // The address follows, so the section can be linked to again.
            const tabParam = new URL(window.location.href).searchParams.get('tab');
            expect(tabParam).toBe(key === 'overview' ? null : key);
        }
    });

    it('a group key opens the group, and an unknown value opens Overview', () => {
        const { unmount } = renderPage('assessment');
        expect(screen.getByTestId('section-risk')).toBeInTheDocument();
        unmount();
        renderPage('nonsense');
        expect(screen.getByTestId('section-overview')).toBeInTheDocument();
    });
});

describe('resolveAgentDetailTab', () => {
    const open = (closed: AgentDetailTabKey[] = []) => (k: AgentDetailTabKey) => !closed.includes(k);

    it('maps every section to itself and every group to its first section', () => {
        for (const k of AGENT_DETAIL_TAB_KEYS) expect(resolveAgentDetailTab(k, open())).toBe(k);
        for (const [g, keys] of Object.entries(AGENT_DETAIL_GROUPS)) {
            expect(resolveAgentDetailTab(g, open())).toBe(keys[0]);
        }
    });

    it('falls back within the group when the section is closed to the reader, then to Overview', () => {
        expect(resolveAgentDetailTab('policy', open(['policy']))).toBe('tools');
        expect(resolveAgentDetailTab('runs', open(['runs', 'breaker']))).toBe('overview');
        expect(resolveAgentDetailTab(undefined, open())).toBe('overview');
    });

    it('opens a closed section\'s neighbour on the page too', () => {
        renderPage('policy', { ...ALL, canEditPolicyCard: false });
        expect(selected(document.getElementById('tab-tools')!)).toBe(true);
        expect((document.getElementById('tab-policy') as HTMLButtonElement).disabled).toBe(true);
    });
});
