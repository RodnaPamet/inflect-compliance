/**
 * How the agent surfaces show an AI system that has not been classified yet
 * (#3691, UNCLASSIFIED, deploy 1 of 2).
 *
 * Two surfaces, one claim each:
 *
 *   • **the register's EU AI Act badge is a warning, never MINIMAL's neutral.**
 *     The register tones that column from the same table as the AI-system
 *     register (`lib/eu-ai-act/tier-display.ts`). A neutral UNCLASSIFIED badge
 *     would read as "minimal risk" — the one answer nobody has given.
 *   • **the detail header says "Unclassified", never the enum.** A provisional
 *     entry is shown exactly as an agent with no AI system is, so the header
 *     never presents UNCLASSIFIED as if it were a tier of the Regulation.
 *
 * Every negative assertion has a positive companion from the same render.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

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

import { AgentsClient, type AgentRow } from '@/app/t/[tenantSlug]/(app)/agents/AgentsClient';
import { AgentDetailClient, type AgentSummary } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient';
import { statusBadgeVariants } from '@/components/ui/status-badge';

const DETAIL = (require('../../messages/en.json') as { admin: { agentDetail: Record<string, string> } }).admin
    .agentDetail;

const badgeClasses = (variant: 'neutral' | 'warning'): string[] =>
    statusBadgeVariants({ variant }).split(' ').filter(Boolean);

// ─── The register ───────────────────────────────────────────────────────────

function row(id: string, aiActTier: string): AgentRow {
    return {
        id,
        name: `Agent ${id}`,
        status: 'ACTIVE',
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        riskTier: 'MODERATE',
        isLegacyPlaceholder: false,
        owner: { id: 'user-1', name: 'Dana Iveagh', email: 'dana@acme.test' },
        aiSystem: { id: `sys-${id}`, riskTier: aiActTier, classificationClauseId: null },
        _count: { apiKeys: 0 },
    };
}

function renderRegister(rows: AgentRow[]) {
    return render(
        <AgentsClient
            initialRows={rows}
            tenantSlug="acme"
            owners={[{ id: 'user-1', label: 'Dana Iveagh' }]}
            vendors={[]}
            kpiCounts={{ total: 0, active: 0, unscored: 0, egress: 0 }}
            governance={{
                enforcing: true,
                unboundCredentials: 0,
                unboundCredentialSamples: [],
                concurrency: { cap: null, inFlight: 0 },
            }}
            assurance={null}
            proposalsAwaitingReview={null}
            canWrite
            canReviewProposals
        />,
    );
}

/** The AI Act badge in one agent's row. */
function aiActBadge(agentId: string, tier: string): HTMLElement {
    const tr = screen.getByTestId(`agent-row-${agentId}`).closest('tr');
    if (!tr) throw new Error(`no table row around agent-row-${agentId}`);
    return within(tr as HTMLElement).getByText(tier);
}

describe('the agent register', () => {
    it("tones an UNCLASSIFIED AI system's badge as a warning, never as MINIMAL's neutral", () => {
        renderRegister([row('minimal', 'MINIMAL'), row('provisional', 'UNCLASSIFIED')]);

        const minimal = aiActBadge('minimal', 'MINIMAL').className.split(' ');
        const unclassified = aiActBadge('provisional', 'UNCLASSIFIED').className.split(' ');

        // Positive anchor: MINIMAL really is the neutral badge, so the absence
        // below is measured against the tone it would fall back to.
        expect(minimal).toEqual(expect.arrayContaining(badgeClasses('neutral')));
        expect(unclassified).toEqual(expect.arrayContaining(badgeClasses('warning')));
        expect(unclassified).not.toEqual(expect.arrayContaining(badgeClasses('neutral')));
    });

    it('tones a tier this client does not know as a warning too', () => {
        // A value from a later deploy, read by a container that predates it.
        renderRegister([row('minimal', 'MINIMAL'), row('future', 'SOME_LATER_TIER')]);

        expect(aiActBadge('minimal', 'MINIMAL').className.split(' ')).toEqual(
            expect.arrayContaining(badgeClasses('neutral')),
        );
        const future = aiActBadge('future', 'SOME_LATER_TIER').className.split(' ');
        expect(future).toEqual(expect.arrayContaining(badgeClasses('warning')));
        expect(future).not.toEqual(expect.arrayContaining(badgeClasses('neutral')));
    });
});

// ─── The detail header ──────────────────────────────────────────────────────

function agent(aiActRiskTier: string | null): AgentSummary {
    return {
        id: 'agent-1',
        name: 'Control reconciler',
        status: 'ACTIVE',
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        riskTier: 'MODERATE',
        aiActRiskTier,
        description: null,
        modelRef: null,
        ownerUserId: 'user-1',
        vendorId: null,
        registrationEnforced: true,
    };
}

function renderDetail(aiActRiskTier: string | null) {
    return render(
        <AgentDetailClient
            tenantSlug="acme"
            agent={agent(aiActRiskTier)}
            perms={{
                canManageRegistry: true,
                canEditPolicyCard: true,
                canGrantTools: true,
                canKill: true,
                canCloseBreaker: true,
            }}
            owners={[{ id: 'user-1', label: 'Dana Iveagh' }]}
            vendors={[]}
        />,
    );
}

/** The text of the header's EU AI Act meta item: its label's parent, minus the label. */
function aiActMeta(): string {
    const label = screen.getByText(DETAIL.metaAiAct);
    const item = label.parentElement;
    if (!item) throw new Error('the EU AI Act label has no meta item around it');
    return (item.textContent ?? '').replace(DETAIL.metaAiAct, '').trim();
}

describe('the agent detail header', () => {
    it('shows a classified tier as the tier', () => {
        renderDetail('HIGH');
        expect(aiActMeta()).toBe('HIGH');
    });

    it('shows UNCLASSIFIED exactly as it shows no AI system, never as the enum', () => {
        const { unmount } = renderDetail(null);
        const none = aiActMeta();
        unmount();

        renderDetail('UNCLASSIFIED');
        const provisional = aiActMeta();

        expect(none).toBe(DETAIL.unclassified);
        expect(provisional).toBe(none);
        expect(provisional).not.toContain('UNCLASSIFIED');
    });
});
