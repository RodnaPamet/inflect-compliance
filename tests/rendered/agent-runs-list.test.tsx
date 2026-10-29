/**
 * The agent runs list, as an operator reads it (#4472).
 *
 *   · AFTER AN ACTION the rows are the server's: the page re-renders through
 *     the router instead of replacing its rows with the raw API response, whose
 *     different shape made every paused run's hint say nothing was queued.
 *   · A PAUSED run offers Resume, which the server accepts and nothing else
 *     will ever do for it.
 *   · Status is a label and the run is named by its workflow.
 *   · A cut list says so.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkflowRunStatus } from '@prisma/client';

const refreshMock = jest.fn();

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: refreshMock, back: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/runs',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = lookup(ns, key);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) {
                v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            }
            return v;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import {
    AgentRunsClient,
    LABELLED_RUN_STATUSES,
    type RunRow,
} from '@/app/t/[tenantSlug]/(app)/agents/runs/AgentRunsClient';

type Catalogue = Record<string, unknown>;
const EN = jest.requireActual('../../messages/en.json') as Catalogue;
const BG = jest.requireActual('../../messages/bg.json') as Catalogue;
const at = (c: Catalogue, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        c,
    );
const en = (dotted: string) => at(EN, dotted) as string;

const RUN: RunRow = {
    id: 'run-1',
    workflowKey: 'audit-prep',
    workflowName: 'Audit prep',
    status: 'COMPLETED',
    stepCount: 3,
    costTokens: 1200,
    driver: 'STATIC',
    startedAt: '2026-09-01T10:00:00.000Z',
    completedAt: null,
    approvalExpiresAt: null,
    summary: null,
    pendingProposals: 0,
};

type Answer = { status: number; body: unknown };
let answers: Record<string, Answer>;
const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const a = answers[key] ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: `no answer for ${key}` } } };
    return { ok: a.status < 400, status: a.status, json: async () => a.body } as Response;
});

beforeEach(() => {
    jest.clearAllMocks();
    answers = {
        'POST /api/t/acme/agent-runs': { status: 201, body: { runId: 'run-new', status: 'COMPLETED' } },
    };
    global.fetch = fetchMock as unknown as typeof fetch;
});

function renderRuns({
    runs = [RUN],
    workflows = [],
    canOperate = true,
    truncated,
}: {
    runs?: RunRow[];
    workflows?: Array<{ key: string; name: string; description: string; requiredInput?: readonly string[] }>;
    canOperate?: boolean;
    truncated?: boolean;
} = {}) {
    return render(
        <AgentRunsClient tenantSlug="acme" runs={runs} truncated={truncated} workflows={workflows} canOperate={canOperate} />,
    );
}

const postsTo = (url: string) =>
    fetchMock.mock.calls.filter(([u, init]) => u === url && init?.method === 'POST');
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

describe('after an action the rows are still the server’s', () => {
    /** A run with proposals waiting, and the RAW list row the API would answer with. */
    function resumeAWaitingRun() {
        // The raw `GET /agent-runs` row carries `_count.proposals` and no
        // `pendingProposals`. A client that rendered it would drop the link.
        answers['POST /api/t/acme/agent-runs/run-1/resume'] = { status: 200, body: { status: 'AWAITING_APPROVAL' } };
        answers['GET /api/t/acme/agent-runs'] = {
            status: 200,
            body: [{ ...RUN, status: 'AWAITING_APPROVAL', pendingProposals: undefined, _count: { proposals: 2 } }],
        };
        renderRuns({ runs: [{ ...RUN, status: 'AWAITING_APPROVAL', pendingProposals: 2 }] });
        fireEvent.click(screen.getByTestId('agent-run-resume-run-1'));
    }

    it('the waiting run still points at its proposals once the action settles', async () => {
        resumeAWaitingRun();
        await waitFor(() => expect(postsTo('/api/t/acme/agent-runs/run-1/resume')).toHaveLength(1));
        // Let anything the action does afterwards — a re-fetch included — land.
        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });
        const row = document.getElementById('run-run-1') as HTMLElement;
        expect(within(row).getByText(en('agents.runs.proposalsLink'))).toBeInTheDocument();
        expect(within(row).queryByText(en('agents.runs.awaitingApprovalNoProposals'))).toBeNull();
    });

    it('the page is re-rendered through the router, and the list is never re-fetched here', async () => {
        resumeAWaitingRun();
        await waitFor(() => expect(refreshMock).toHaveBeenCalled());
        expect(fetchMock.mock.calls.some(([u, init]) => u === '/api/t/acme/agent-runs' && !init?.method)).toBe(false);
    });
});

describe('a PAUSED run', () => {
    it('offers Resume, enabled for an operator, and resumes through the server', async () => {
        answers['POST /api/t/acme/agent-runs/run-1/resume'] = { status: 200, body: { status: 'COMPLETED' } };
        renderRuns({ runs: [{ ...RUN, status: 'PAUSED' }] });
        const resume = screen.getByTestId('agent-run-resume-run-1');
        expect(resume).not.toBeDisabled();
        fireEvent.click(resume);
        await waitFor(() => expect(postsTo('/api/t/acme/agent-runs/run-1/resume')).toHaveLength(1));
    });

    it('says why it is paused and that nothing else will resume it', () => {
        renderRuns({ runs: [{ ...RUN, status: 'PAUSED' }] });
        const row = document.getElementById('run-run-1') as HTMLElement;
        expect(within(row).getByText(en('agents.runs.pausedHint'))).toBeInTheDocument();
    });

    it('a finished run offers no Resume', () => {
        renderRuns({ runs: [{ ...RUN, status: 'COMPLETED' }] });
        expect(screen.queryByTestId('agent-run-resume-run-1')).toBeNull();
    });
});

describe('labels, not codes', () => {
    it.each(Object.values(WorkflowRunStatus))('%s renders its label', (status) => {
        renderRuns({ runs: [{ ...RUN, status }] });
        const row = document.getElementById('run-run-1') as HTMLElement;
        expect(within(row).getByText(en(`agents.runs.status.${status}`))).toBeInTheDocument();
        if (en(`agents.runs.status.${status}`) !== status) expect(within(row).queryByText(status)).toBeNull();
    });

    it('a status this build does not know shows its stored code rather than a key path', () => {
        renderRuns({ runs: [{ ...RUN, status: 'HALTED' }] });
        expect(within(document.getElementById('run-run-1') as HTMLElement).getByText('HALTED')).toBeInTheDocument();
    });

    it('the labelled set is exactly the generated enum, with a label in both catalogues', () => {
        expect([...LABELLED_RUN_STATUSES].sort()).toEqual([...Object.values(WorkflowRunStatus)].sort());
        for (const s of LABELLED_RUN_STATUSES) {
            expect({ s, en: typeof at(EN, `agents.runs.status.${s}`), bg: typeof at(BG, `agents.runs.status.${s}`) }).toEqual({
                s,
                en: 'string',
                bg: 'string',
            });
        }
    });

    it('the run is linked by its workflow’s name, not its key', () => {
        renderRuns();
        const link = document.querySelector('a[href="/t/acme/agents/runs/run-1"]') as HTMLElement;
        expect(link.textContent).toBe('Audit prep');
    });

    it('the abort dialog names the workflow too', async () => {
        renderRuns({ runs: [{ ...RUN, status: 'RUNNING' }] });
        await act(async () => {
            fireEvent.click(screen.getByTestId('agent-run-abort-run-1'));
        });
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain('Audit prep');
        expect(dialog.textContent).not.toContain('audit-prep');
    });
});

describe('a cut list says so', () => {
    it('shows how many are listed when the page read past its cap', () => {
        renderRuns({ truncated: true });
        expect(screen.getByTestId('agent-runs-truncated').textContent).toContain(
            en('agents.runs.truncated').replace('{shown}', '1'),
        );
    });

    it('says nothing when the list is whole', () => {
        renderRuns({ truncated: false });
        expect(screen.queryByTestId('agent-runs-truncated')).toBeNull();
    });
});
