/**
 * THE ASSESSOR PACK RENDERS ALL FIVE REPORTS, AND CAVEATS ITSELF.
 *
 * ── THE CAVEAT IS ASSERTED IN BOTH DIRECTIONS ───────────────────────
 *
 * "The figures describe a register that is not being enforced" is the most
 * important line on this page — and a component that rendered it unconditionally
 * would pass a one-directional test while telling every tenant, including the
 * enforcing ones, that their pack is meaningless. So its ABSENCE under
 * enforcement is asserted too.
 *
 * ── AND THE UNCOVERED LIST, NOT A PERCENTAGE ────────────────────────
 *
 * "A percentage cannot answer 'which risk is open'", and which risk is open is
 * the only thing being asked. The test names the codes.
 */
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = lookup(ns, key);
        if (typeof v !== 'string') return key;
        if (params) for (const [p, val] of Object.entries(params)) {
            v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
        }
        return v;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/reports',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: ({ content }: { content: string }) => <span>{content}</span>,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ReportsClient, type PackView } from '@/app/t/[tenantSlug]/(app)/agents/reports/ReportsClient';
import { METRIC_DEFINITIONS } from '@/lib/agentic/report-definitions';

const def = (id: string) => METRIC_DEFINITIONS[id as keyof typeof METRIC_DEFINITIONS];

function envelope<T>(reportId: string, metricIds: string[], body: T) {
    return {
        reportId,
        generatedAt: '2026-09-12T09:00:00.000Z',
        window: null,
        truncated: false,
        metrics: Object.fromEntries(
            metricIds.map((id) => [id, { state: 'MEASURED' as const, value: 2, basis: null }]),
        ),
        definitions: metricIds.map(def).filter(Boolean) as never[],
        body,
    };
}

function pack(over: Partial<PackView> = {}): PackView {
    return {
        generatedAt: '2026-09-12T09:00:00.000Z',
        tenantId: 'tenant-1',
        inventory: envelope('agent-inventory', ['inventory.registered_agents'], {
            agents: [
                {
                    agentId: 'a1',
                    name: 'Reconciler',
                    status: 'ACTIVE',
                    autonomyLevel: 2,
                    provenance: 'FIRST_PARTY',
                    ownerName: 'Dana',
                    riskTier: 'LOW',
                },
            ],
            legacyPlaceholderPresent: false,
        }),
        asiCoverage: envelope('asi-coverage', ['asi.agents_in_scope'], {
            frameworkInstalled: true,
            framework: { key: 'owasp-asi', name: 'OWASP ASI' },
            agents: [
                {
                    agentId: 'a1',
                    name: 'Reconciler',
                    status: 'ACTIVE',
                    covered: ['ASI01'],
                    partiallyCovered: [],
                    reviewNeeded: ['ASI05'],
                    uncovered: ['ASI07', 'ASI09'],
                    notApplicable: [],
                },
            ],
        }),
        approvals: envelope('approval-statistics', ['approvals.decided'], {
            unobservable: ['whether a reviewer read the diff'],
        }),
        incidents: envelope('incident-history', ['incidents.kill_engagements'], {
            kills: [
                {
                    id: 'k1',
                    scope: 'TENANT' as const,
                    agentName: null,
                    reason: 'runaway tool loop',
                    engagedAt: '2026-09-10T08:00:00.000Z',
                    liftedAt: null,
                    durationMinutes: 30,
                    stillInForce: true,
                },
            ],
            drills: [],
        }),
        thirdParty: envelope('third-party-assessments', ['thirdparty.agents'], {
            agents: [
                {
                    agentId: 'a2',
                    name: 'Supplier bot',
                    vendorId: 'v1',
                    vendorName: 'Acme Supplies',
                    vendorUnresolved: false,
                    latestCompletedAssessment: null,
                    openAssessments: 1,
                },
            ],
        }),
        workpaperReview: {
            ...envelope('workpaper-review', ['assurance.workpaper_reviews_concluded'], { samplePercent: 100 }),
            metrics: {
                'assurance.workpaper_reviews_concluded': { state: 'MEASURED' as const, value: 0, basis: null },
                'assurance.workpaper_reperformance_agreement_rate': {
                    state: 'NOT_ASSESSED' as const,
                    value: null,
                    basis: 'NO_CONCLUDED_WORKPAPER_REVIEWS',
                },
            },
            definitions: [
                def('assurance.workpaper_reviews_concluded'),
                def('assurance.workpaper_reperformance_agreement_rate'),
            ] as never[],
        },
        ...over,
    } as PackView;
}

const renderPack = (over: Partial<PackView> = {}, enforcing = true) =>
    render(
        <ReportsClient
            tenantSlug="acme"
            pack={pack(over)}
            enforcing={enforcing}
            canReviewProposals
            canInvestigate
            canExport
        />,
    );

describe('all six reports render', () => {
    it('each section is present', () => {
        renderPack();
        expect(screen.getByTestId('reports-stamp')).toBeInTheDocument();
        expect(screen.getByTestId('reports-asi-agents')).toBeInTheDocument();
        expect(screen.getByTestId('reports-kills')).toBeInTheDocument();
        expect(screen.getByTestId('reports-third-party')).toBeInTheDocument();
        expect(screen.getByTestId('reports-approvals-unobservable')).toBeInTheDocument();
        expect(screen.getByTestId('reports-workpaper-review-scope')).toBeInTheDocument();
    });

    it("report 6 states what the agreement rate leaves out, and shows no rate over nothing concluded (#3677)", () => {
        renderPack();
        const scope = screen.getByTestId('reports-workpaper-review-scope');
        expect(scope.textContent).toContain('100%');
        expect(scope.textContent).toMatch(/never counted as agreement/);
        // NOT a 100 and not a 0: the basis, in words.
        const rate = screen.getByTestId('metric-absent-assurance.workpaper_reperformance_agreement_rate');
        expect(rate.textContent).toMatch(/This is not 100% agreement/);
        expect(screen.queryByTestId('metric-value-assurance.workpaper_reperformance_agreement_rate')).not.toBeInTheDocument();
        // The definition is on screen beside the figure.
        expect(screen.getByTestId('metric-definition-assurance.workpaper_reperformance_agreement_rate').textContent).toContain(
            'CONCURRED over (CONCURRED + DISSENTED)',
        );
    });

    it('the stamp carries workspace, moment and population', () => {
        // An assessor screenshots this; it must carry its own provenance.
        const stamp = screen.queryByTestId('reports-stamp') ?? (renderPack(), screen.getByTestId('reports-stamp'));
        expect(stamp.textContent).toMatch(/acme/);
        expect(stamp.textContent).toMatch(/1 registered agent/);
    });
});

describe('the gate-off caveat, asserted BOTH ways', () => {
    it('renders when registration is not enforced', () => {
        renderPack({}, false);
        const caveat = screen.getByTestId('reports-not-enforcing');
        // It has to draw the distinction, not merely warn.
        expect(caveat.textContent).toMatch(/RECORDED/);
        expect(caveat.textContent).toMatch(/ENFORCED/);
    });

    it('is ABSENT when registration IS enforced', () => {
        // The direction that matters: a component rendering it unconditionally
        // would pass the test above while telling every enforcing tenant their
        // pack is meaningless.
        renderPack({}, true);
        expect(screen.queryByTestId('reports-not-enforcing')).not.toBeInTheDocument();
    });
});

describe('ASI coverage names which risks are open', () => {
    it('renders the UNCOVERED codes, not a percentage', () => {
        renderPack();
        const uncovered = screen.getByTestId('asi-uncovered-a1');
        expect(uncovered.textContent).toContain('ASI07');
        expect(uncovered.textContent).toContain('ASI09');
    });

    it('keeps claimed-but-unverified distinct from both covered and open', () => {
        renderPack();
        // By HANDLE, not a `.*` span across the whole list: an unbounded
        // interior regex reaches out of the block it names, which is what
        // `assertion-span-reach-ratchet` counts — and it would also pass if the
        // codes landed under the wrong agent.
        const review = screen.getByTestId('asi-review-needed-a1');
        expect(review.textContent).toMatch(/unverified/i);
        expect(review.textContent).toContain('ASI05');
    });

    it('says which "ASI coverage" number this is', () => {
        // Two unrelated figures in this product share the name; an auditor
        // handed the wrong one is the failure the label prevents.
        renderPack();
        expect(screen.getByTestId('reports-asi-which-number').textContent).toMatch(
            /not the other/i,
        );
    });
});

describe('an empty register is a complete answer', () => {
    it('renders the empty state, not an error', () => {
        renderPack({
            inventory: envelope('agent-inventory', ['inventory.registered_agents'], {
                agents: [],
                legacyPlaceholderPresent: false,
            }) as PackView['inventory'],
        });
        expect(screen.getByText(/No agents are registered/i)).toBeInTheDocument();
        expect(screen.getByText(/complete answer, not a missing one/i)).toBeInTheDocument();
    });
});

describe('a third-party agent with no assurance is called out', () => {
    it('says there is no completed assessment', () => {
        renderPack();
        expect(screen.getByTestId('third-party-a2').textContent).toMatch(/no completed assessment/i);
    });
});

// ─── #4474 ──────────────────────────────────────────────────────────────────

const CATALOGUE = {
    en: jest.requireActual('../../messages/en.json') as Record<string, unknown>,
    bg: jest.requireActual('../../messages/bg.json') as Record<string, unknown>,
};
const msg = (lang: 'en' | 'bg', dotted: string): string => {
    const v = dotted
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), CATALOGUE[lang]);
    if (typeof v !== 'string') throw new Error(`no string at ${lang}:${dotted}`);
    return v;
};

describe('the review-quality link follows that page’s own gate (#4474)', () => {
    // `/agents/review-quality` refuses anybody without `admin.agent_registry`,
    // which is what `canInvestigate` carries. An Auditor reads the pack on the
    // inventory view key alone and must not be handed a link to a refusal.
    const renderWith = (canInvestigate: boolean) =>
        render(
            <ReportsClient
                tenantSlug="acme"
                pack={pack()}
                enforcing
                canReviewProposals
                canInvestigate={canInvestigate}
                canExport={false}
            />,
        );

    it('is offered to a reader holding the register key', () => {
        renderWith(true);
        expect(screen.getByTestId('reports-approvals-detail-link')).toHaveAttribute(
            'href',
            '/t/acme/agents/review-quality',
        );
    });

    it('is not offered to a reader with the inventory view key alone, who still reads the report', () => {
        renderWith(false);
        expect(screen.queryByTestId('reports-approvals-detail-link')).not.toBeInTheDocument();
        expect(screen.getByTestId('reports-approvals-unobservable')).toBeInTheDocument();
    });
});

describe('the not-enforcing notice names the page and the control that exist (#4474)', () => {
    it('names "Security & MFA" and "Enforce registration", as the security page labels them', () => {
        renderPack({}, false);
        const notice = screen.getByTestId('reports-not-enforcing');
        expect(notice).toHaveTextContent(msg('en', 'admin.security.title'));
        expect(notice).toHaveTextContent(msg('en', 'admin.security.agentEnforcement.enableAction'));
        expect(notice.textContent).not.toMatch(/Security settings/);
    });

    it('does the same in Bulgarian', () => {
        const body = msg('bg', 'agents.reports.notEnforcingBody');
        expect(body).toContain(msg('bg', 'admin.security.title'));
        expect(body).toContain(msg('bg', 'admin.security.agentEnforcement.enableAction'));
        expect(body).not.toMatch(/настройките за сигурност/);
    });
});

