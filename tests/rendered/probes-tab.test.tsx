/**
 * THE PROBES TAB ON /agents/reports, rendered (active flavour, step 8b).
 *
 *   1. NO RUN IS A FINDING. With no probe run the tab renders an alert, never
 *      an empty table, and names a prober key holder that has sent nothing.
 *   2. "EVERY PROBE RESISTED" IS SAID ONLY OF A RUN THAT REACHED AN AGENT, RAN
 *      TO ITS END AND RESISTED EVERY PROBE. A run of nothing, a stopped run and
 *      an acting agent each say so.
 *   3. THE EXCERPT IS TEXT, AND WITHHELD IS NOT EMPTY. A register-key holder
 *      reads the agent's reply as plain text; anybody else is told it was
 *      withheld.
 *   4. A KEY CARD RENDERS ONLY WHEN THE SERVER READ IT FOR THIS VIEWER, and
 *      an empty register is a stated condition.
 *
 * Every absence is asserted beside something present from the same render.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
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
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/reports',
    useSearchParams: () => new URLSearchParams('tab=probes'),
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

import { ProbesTab } from '@/app/t/[tenantSlug]/(app)/agents/reports/probes/ProbesTab';
import type {
    ProbeRunDetailView,
    ProbeRunInventoryView,
    ProbeRunSection,
    ProbeRunView,
} from '@/lib/agentic/probe-run-read-model';

const ORIGIN = 'https://agents.acme.example';

function run(over: Partial<ProbeRunView> = {}): ProbeRunView {
    return {
        runId: 'run-1',
        engagementId: 'eng-acme-0001',
        startedAt: '2026-11-25T09:00:00.000Z',
        endedAt: '2026-11-25T09:01:00.000Z',
        stopReason: null,
        concluded: true,
        targetCount: 1,
        targetsReached: 1,
        outcomeCount: 2,
        actedCount: 0,
        disclosedCount: 0,
        resistedCount: 2,
        inconclusiveCount: 0,
        findingCount: 0,
        ...over,
    };
}

function section(over: Partial<ProbeRunSection> = {}): ProbeRunSection {
    return {
        proberAgentId: 'agent_prober',
        proberName: 'Red team prober',
        runs: [run()],
        runsTruncated: false,
        findings: [],
        findingsTruncated: false,
        ...over,
    };
}

function inventory(over: Partial<ProbeRunInventoryView> = {}): ProbeRunInventoryView {
    return { sections: [section()], probersWithoutRun: [], probersNotShown: 0, runsTruncated: false, ...over };
}

function detail(over: Partial<ProbeRunDetailView> = {}): ProbeRunDetailView {
    return {
        run: { ...run({ actedCount: 1, resistedCount: 1, findingCount: 1 }), proberAgentId: 'agent_prober', proberName: 'Red team prober', catalogueProbes: 11 },
        targets: [
            { targetId: 't1', origin: ORIGIN, kind: 'http-chat', reached: true, reason: 'REACHED', endpoint: `${ORIGIN}/support/chat` },
        ],
        outcomes: [
            {
                outcomeId: 'o1',
                targetId: 't1',
                probeId: 'canary.instruction-override.1',
                probeClass: 'canary',
                verdict: 'ACTED',
                verdictReason: 'CANARY_RETURNED',
                tool: null,
                excerpt: '<script>alert(1)</script> The joined code is ZEBRA-41.',
                findingId: 'f1',
            },
        ],
        outcomesTruncated: false,
        excerptsShown: true,
        ...over,
    };
}

const noKeys = { proberKeys: null, approverKeys: null, detail: null };

describe('ProbesTab', () => {
    it('states that there is no run, never an empty table, and names a key holder that sent nothing', () => {
        render(
            <ProbesTab
                view={inventory({ sections: [], probersWithoutRun: [{ agentId: 'agent_idle', name: 'Idle prober' }] })}
                {...noKeys}
            />,
        );
        expect(screen.getByTestId('probes-no-runs')).toHaveTextContent('No probe run');
        expect(screen.getByTestId('probes-probers-without-run')).toHaveTextContent('Idle prober');
        expect(screen.queryByTestId('probe-runs-agent_prober')).toBeNull();
    });

    it('says "every probe resisted" only of a complete run that resisted every probe', () => {
        render(
            <ProbesTab
                view={inventory({
                    sections: [
                        section({
                            runs: [
                                run({ runId: 'clean' }),
                                run({ runId: 'nothing', targetsReached: 0, outcomeCount: 0, resistedCount: 0, concluded: false }),
                                run({ runId: 'stopped', stopReason: 'STOPPED' }),
                                run({ runId: 'acted', actedCount: 1, resistedCount: 1 }),
                                run({ runId: 'partial', resistedCount: 1, inconclusiveCount: 1 }),
                            ],
                        }),
                    ],
                })}
                {...noKeys}
            />,
        );
        expect(screen.getByTestId('probe-run-state-clean')).toHaveTextContent('Every probe resisted');
        expect(screen.getByTestId('probe-run-state-nothing')).toHaveTextContent('No agent was reached');
        expect(screen.getByTestId('probe-run-state-stopped')).toHaveTextContent('Stopped early');
        expect(screen.getByTestId('probe-run-state-acted')).toHaveTextContent('An agent acted or disclosed');
        expect(screen.getByTestId('probe-run-state-partial')).toHaveTextContent('some probes inconclusive');
    });

    it('names a finding by its probe, origin and tool', () => {
        render(
            <ProbesTab
                view={inventory({
                    sections: [
                        section({
                            findings: [
                                {
                                    findingId: 'f1',
                                    severity: 'HIGH',
                                    probeId: 'canary.tool-arguments.1',
                                    probeClass: 'canary',
                                    origin: 'https://mcp.acme.example',
                                    kind: 'mcp',
                                    tool: 'lookup_account',
                                    verdictReason: 'CANARY_RETURNED',
                                },
                            ],
                        }),
                    ],
                })}
                {...noKeys}
            />,
        );
        const where = screen.getByTestId('probe-finding-where-f1');
        expect(where).toHaveTextContent('https://mcp.acme.example');
        expect(where).toHaveTextContent('lookup_account');
        expect(screen.queryByTestId('probe-no-open-agent_prober')).toBeNull();
    });

    it('renders an excerpt as text for a register-key holder', () => {
        render(<ProbesTab view={inventory()} proberKeys={null} approverKeys={null} detail={detail()} />);
        const excerpt = screen.getByTestId('probe-outcome-excerpt-o1');
        expect(excerpt.textContent).toContain('<script>alert(1)</script>');
        expect(excerpt.querySelector('script')).toBeNull();
        expect(screen.getByTestId('probe-target-t1')).toHaveTextContent(`${ORIGIN}/support/chat`);
        expect(screen.queryByTestId('probe-run-detail-withheld')).toBeNull();
    });

    it('says the excerpt and the endpoint were withheld from anybody else', () => {
        const d = detail({
            excerptsShown: false,
            targets: [{ targetId: 't1', origin: ORIGIN, kind: 'http-chat', reached: true, reason: 'REACHED', endpoint: null }],
            outcomes: detail().outcomes.map((o) => ({ ...o, excerpt: null })),
        });
        render(<ProbesTab view={inventory()} proberKeys={null} approverKeys={null} detail={d} />);
        expect(screen.getByTestId('probe-run-detail-withheld')).toBeInTheDocument();
        expect(screen.queryByTestId('probe-outcome-excerpt-o1')).toBeNull();
        expect(within(screen.getByTestId('probe-target-t1')).getByText(ORIGIN)).toBeInTheDocument();
    });

    it('renders a key card only when the server read it, and says an empty register refuses every report', () => {
        const { rerender } = render(<ProbesTab view={inventory()} {...noKeys} />);
        expect(screen.queryByTestId('prober-keys')).toBeNull();
        expect(screen.queryByTestId('approver-keys')).toBeNull();

        rerender(
            <ProbesTab
                view={inventory()}
                proberKeys={{ keys: { rows: [], truncated: false }, candidates: { rows: [], truncated: false } }}
                approverKeys={{ rows: [], truncated: false }}
                detail={null}
            />,
        );
        expect(screen.getByTestId('prober-keys-empty')).toHaveTextContent('no probe report can be accepted');
        expect(screen.getByTestId('approver-keys-empty')).toHaveTextContent('every probe report will be refused');
    });
});
