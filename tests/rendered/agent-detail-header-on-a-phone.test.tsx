/**
 * The agent detail header on a phone — the owner's own complaint (#5815).
 *
 * The owner opened this page on an iPhone and found five ungrouped actions
 * wrapped into a ragged three-row stack, with the kill switch rendered as a
 * ghost text button among them. The rule now, for a phone:
 *
 *   • Amend first (the primary), then Stop agent, then a "⋯" menu;
 *   • Use for Ask, Connect and Open on canvas are in that menu;
 *   • Stop agent is NEVER in the menu, and it is a destructive button.
 *
 * Desktop keeps all five buttons in their old order; the overflow actions are
 * the same buttons, hidden only below md.
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

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
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

// The kill switch reads the in-force list; none is in force here.
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: { inForce: [] }, error: undefined, mutate: jest.fn() }),
}));

// Tabs fetch on mount and are not under test.
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OverviewTab', () => ({ OverviewTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/ServicePrincipalLinkCard', () => ({ ServicePrincipalLinkCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/BehaviourFingerprintCard', () => ({ BehaviourFingerprintCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/SpendingAuthorityCard', () => ({ SpendingAuthorityCard: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/RiskAssessmentTab', () => ({ RiskAssessmentTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/PolicyCardTab', () => ({ PolicyCardTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/ToolsTab', () => ({ ToolsTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/CoverageTab', () => ({ CoverageTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/SkillsTab', () => ({ SkillsTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/BehaviourTab', () => ({ BehaviourTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/RunsTab', () => ({ RunsTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/CircuitBreakerTab', () => ({ CircuitBreakerTab: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentAmendModal', () => ({ AgentAmendModal: () => null }));
jest.mock('@/app/t/[tenantSlug]/(app)/agents/[agentId]/ConnectAgentSheet', () => ({
    // Mounted only while connecting, so being in the DOM means "open".
    ConnectAgentSheet: () => <div data-testid="connect-sheet-open" />,
}));

import { AgentDetailClient } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: false },
};

const EN = require('../../messages/en.json') as {
    admin: { agentDetail: Record<string, Record<string, string>> };
    processes: { canvas: Record<string, string> };
};

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

const ALL = {
    canReadRegistry: true,
    canManageRegistry: true,
    canEditPolicyCard: true,
    canGrantTools: true,
    canKill: true,
    canCloseBreaker: true,
};

function renderPage() {
    return render(
        <TenantProvider value={TENANT_CTX}>
            <AgentDetailClient
                tenantSlug="acme"
                agent={AGENT}
                perms={ALL}
                owners={[]}
                vendors={[]}
                canvasHref="/t/acme/processes/agents/agent-1/flow"
            />
        </TenantProvider>,
    );
}

describe('the agent header on a phone', () => {
    it('puts Use for Ask, Connect and Open on canvas in the "⋯" menu, in that order', async () => {
        renderPage();
        // The menu loads with next/dynamic, a tick after mount.
        fireEvent.click(await screen.findByTestId('page-actions-more'));
        const menu = screen.getByTestId('page-actions-menu');
        expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
            EN.admin.agentDetail.interactive.use,
            EN.admin.agentDetail.connect.action,
            expect.any(String), // the canvas label, from the processes namespace
        ]);
        expect(within(menu).getByTestId('agent-open-on-canvas-menu-item')).toHaveAttribute(
            'href',
            '/t/acme/processes/agents/agent-1/flow',
        );
    });

    it('Connect from the menu opens the same sheet as the desktop button', async () => {
        renderPage();
        // The menu loads with next/dynamic, a tick after mount.
        fireEvent.click(await screen.findByTestId('page-actions-more'));
        fireEvent.click(screen.getByTestId('agent-connect-menu-item'));
        expect(screen.getByTestId('connect-sheet-open')).toBeInTheDocument();
    });

    it('keeps Stop agent out of the menu, as a visible destructive button', async () => {
        renderPage();
        const stop = screen.getByTestId('agent-kill-engage-open');
        expect(stop).toHaveTextContent(EN.admin.agentDetail.kill.engageAction);
        // Not inside an overflow slot (which a phone hides)…
        expect(stop.closest('[data-page-action="overflow"]')).toBeNull();
        // …and painted with the danger fill, not a ghost tinted red.
        expect(stop.className).toContain('bg-[var(--btn-still-danger)]');

        // The menu loads with next/dynamic, a tick after mount.
        fireEvent.click(await screen.findByTestId('page-actions-more'));
        expect(
            within(screen.getByTestId('page-actions-menu')).queryByText(EN.admin.agentDetail.kill.engageAction),
        ).toBeNull();
    });

    it('leads with Amend, and hides only the three overflow buttons below md', () => {
        renderPage();
        expect(screen.getByTestId('agent-amend-action').closest('[data-page-action="primary"]')).not.toBeNull();
        for (const id of ['agent-interactive-action', 'agent-connect-action']) {
            expect(screen.getByTestId(id).closest('[data-page-action="overflow"]')).not.toBeNull();
        }
        expect(document.getElementById('agent-open-on-canvas')!.closest('[data-page-action="overflow"]')).not.toBeNull();
    });
});
