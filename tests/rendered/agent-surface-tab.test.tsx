/**
 * THE AGENT SURFACE TAB ON /agents/reports, rendered.
 *
 *   1. NO SCAN IS A FINDING. With no agent-surface rules scan the tab renders
 *      an alert, never an empty table, and names a trusted scanner that has
 *      sent nothing.
 *   2. CLEAN IS SAID ONLY OF A COMPLETE READ OF SOMETHING. A read of nothing is
 *      an alert; a read in part says its reason; "no rule fired" appears only
 *      for a complete read that held tools.
 *   3. THE FINDINGS SAY WHERE, NEVER WHAT. Each open finding shows its code,
 *      rule, tool and field, beside the origins the scan read; there is no
 *      text of a definition to show.
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
    useSearchParams: () => new URLSearchParams('tab=integrations'),
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

import { AgentSurfaceTab } from '@/app/t/[tenantSlug]/(app)/agents/reports/agent-surface/AgentSurfaceTab';
import type { AgentRuleInventoryView, AgentRuleSection } from '@/lib/agentic/agent-rule-read-model';

const CRM = 'mcp:https://mcp.acme.example/crm/mcp';
const TICKETS = 'mcp:https://mcp.acme.example/tickets/mcp';

function section(over: Partial<AgentRuleSection> = {}, scan: Partial<AgentRuleSection['scan']> = {}): AgentRuleSection {
    return {
        scannerAgentId: 'agent_scanner',
        scannerName: 'Estate scanner',
        scan: {
            scanRef: 'scan-1',
            asOf: '2026-11-22T03:00:00.000Z',
            scannerVersion: '0.17.0',
            complete: true,
            outcome: 'FINDINGS',
            subjects: 4,
            flagged: 1,
            findingCount: 1,
            incompleteReason: null,
            ...scan,
        },
        origins: [
            { ref: CRM, status: 'COMPLETE', reason: null, subjects: 3 },
            { ref: TICKETS, status: 'COMPLETE', reason: null, subjects: 1 },
        ],
        findings: [
            {
                findingId: 'f1',
                code: 'MCP_PROMPT_INJECTION',
                ruleId: 'cisco-mcp:instruction-override',
                severity: 'HIGH',
                originRef: CRM,
                subjectRef: `${CRM}:tool:lookup_account`,
                locator: `mcp-tool:${CRM}:tool:lookup_account#description`,
                field: 'description',
            },
        ],
        findingsTruncated: false,
        ...over,
    };
}

const view = (over: Partial<AgentRuleInventoryView> = {}): AgentRuleInventoryView => ({
    sections: [section()],
    scannersWithoutScan: [],
    scannersNotShown: 0,
    scansTruncated: false,
    ...over,
});

describe('1. no scan is a finding', () => {
    it('renders an alert and names the trusted scanner that sent nothing', () => {
        render(<AgentSurfaceTab view={view({ sections: [], scannersWithoutScan: [{ agentId: 'agent_x', name: 'Silent scanner' }] })} />);
        expect(screen.getByTestId('agent-surface-no-scans')).toHaveTextContent('No agent-surface rules scan');
        expect(screen.getByTestId('agent-surface-scanners-without-scan')).toHaveTextContent('Silent scanner');
        expect(screen.queryByTestId('agent-surface-section-scan-1')).not.toBeInTheDocument();
        expect(screen.getByTestId('agent-surface-read-only')).toBeInTheDocument();
    });
});

describe('2. clean is said only of a complete read of something', () => {
    it('a complete read with no rule firing is clean, and lists no finding', () => {
        render(<AgentSurfaceTab view={view({ sections: [section({ findings: [] }, { outcome: 'NO_FINDING_ON_A_COMPLETE_READ', flagged: 0, findingCount: 0 })] })} />);
        expect(screen.getByTestId('agent-surface-state-scan-1')).toHaveTextContent('No rule fired on a complete read');
        expect(screen.getByTestId('agent-surface-no-open-scan-1')).toBeInTheDocument();
    });

    it('a read of nothing is an alert, never clean', () => {
        render(<AgentSurfaceTab view={view({ sections: [section({ origins: [], findings: [] }, { outcome: 'NOTHING_READ', subjects: 0, flagged: 0, findingCount: 0 })] })} />);
        expect(screen.getByTestId('agent-surface-state-scan-1')).toHaveTextContent('Nothing was read');
        expect(screen.getByTestId('agent-surface-nothing-read-scan-1')).toBeInTheDocument();
        expect(screen.queryByText('No rule fired on a complete read')).not.toBeInTheDocument();
    });

    it('a read in part says so, with its reason, on the scan and on the server', () => {
        render(
            <AgentSurfaceTab
                view={view({
                    sections: [
                        section(
                            { origins: [{ ref: CRM, status: 'INCOMPLETE', reason: 'AUTH_FAILED', subjects: 0 }], findings: [] },
                            { outcome: 'NOT_CONCLUDED', complete: false, incompleteReason: 'AUTH_FAILED', flagged: 0, findingCount: 0 },
                        ),
                    ],
                })}
            />,
        );
        expect(screen.getByTestId('agent-surface-state-scan-1')).toHaveTextContent('Not concluded');
        expect(screen.getByTestId('agent-surface-incomplete-scan-1')).toBeInTheDocument();
        expect(screen.getByTestId(`agent-surface-origin-${CRM}`)).toHaveTextContent('read in part');
    });
});

describe('3. the findings say where, never what', () => {
    it('shows the code, rule, tool and field of each open finding, beside the origins read', () => {
        render(<AgentSurfaceTab view={view()} />);
        const table = screen.getByTestId('agent-surface-findings-scan-1');
        expect(within(table).getByText('Possible prompt injection')).toBeInTheDocument();
        expect(within(table).getByText('cisco-mcp:instruction-override')).toBeInTheDocument();
        expect(screen.getByTestId('agent-surface-where-f1')).toHaveTextContent(`${CRM}:tool:lookup_account`);
        expect(screen.getByTestId('agent-surface-where-f1')).toHaveTextContent('description');
        expect(screen.getByTestId(`agent-surface-origin-${TICKETS}`)).toHaveTextContent('read in full');
        expect(screen.queryByTestId('agent-surface-no-open-scan-1')).not.toBeInTheDocument();
    });
});

describe('4. a skill read from a code folder', () => {
    it('names the code folder as a place read, and the skill finding by its own code', () => {
        const REPO = 'code:support-repo';
        const skill = `${REPO}/skills/report/SKILL.md`;
        render(
            <AgentSurfaceTab
                view={view({
                    sections: [
                        section({
                            origins: [{ ref: REPO, status: 'COMPLETE', reason: null, subjects: 2 }],
                            findings: [
                                {
                                    findingId: 'f2',
                                    code: 'SKILL_PROMPT_INJECTION',
                                    ruleId: 'cisco-skill:ignore-instructions',
                                    severity: 'HIGH',
                                    originRef: REPO,
                                    subjectRef: skill,
                                    locator: `skill:${skill}#instructions`,
                                    field: 'instructions',
                                },
                            ],
                        }),
                    ],
                })}
            />,
        );
        expect(screen.getByTestId(`agent-surface-origin-${REPO}`)).toHaveTextContent('code folder, read in full');
        const table = screen.getByTestId('agent-surface-findings-scan-1');
        expect(within(table).getByText('Possible prompt injection in a skill')).toBeInTheDocument();
        expect(screen.getByTestId('agent-surface-where-f2')).toHaveTextContent(skill);
        expect(screen.getByTestId('agent-surface-where-f2')).toHaveTextContent('instructions');
    });
});
