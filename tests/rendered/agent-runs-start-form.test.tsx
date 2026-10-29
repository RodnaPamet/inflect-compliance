/**
 * Starting a workflow from the agent runs page (#4472, owner decision
 * 2026-10-29).
 *
 * A workflow that declares `requiredInput` opens a start form built from that
 * declaration and posts the input; a workflow that needs nothing still starts
 * in one click; a workflow whose input this page cannot collect stays on the
 * page, disabled, saying why. Seven of the ten buttons used to post
 * `{ workflowKey }` alone to workflows that refuse to start without input.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

import { AgentRunsClient, type RunRow } from '@/app/t/[tenantSlug]/(app)/agents/runs/AgentRunsClient';
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';

type Catalogue = Record<string, unknown>;
const EN = jest.requireActual('../../messages/en.json') as Catalogue;
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

const ONE_CLICK = { key: 'diagnostic', name: 'Posture diagnostic', description: 'Reads posture', requiredInput: [] };
const PERIOD_FORM = { key: 'audit-narrative', name: 'Audit workpaper narrative', description: 'Narrates', requiredInput: ['periodLabel'] };
const FRAMEWORK_FORM = { key: 'audit-prep', name: 'Audit prep', description: 'Preps', requiredInput: ['frameworkKey'] };
const NOT_HERE = { key: 'ad-hoc-question', name: 'Ad-hoc question', description: 'Answers', requiredInput: ['question'] };

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
        'GET /api/t/acme/frameworks': {
            status: 200,
            body: [
                { key: 'ISO27001', name: 'ISO/IEC 27001' },
                { key: 'SOC2', name: 'SOC 2' },
            ],
        },
    };
    global.fetch = fetchMock as unknown as typeof fetch;
});

function renderRuns({
    runs = [RUN],
    workflows = [ONE_CLICK, PERIOD_FORM, FRAMEWORK_FORM, NOT_HERE],
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

describe('starting a workflow', () => {
    it('a workflow that needs nothing starts in one click, posting no input', async () => {
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-diagnostic'));
        await waitFor(() => expect(postsTo('/api/t/acme/agent-runs')).toHaveLength(1));
        expect(bodyOf(postsTo('/api/t/acme/agent-runs')[0])).toEqual({ workflowKey: 'diagnostic' });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('a workflow that declares input opens its start form instead of posting', () => {
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-audit-narrative'));
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getAllByText('Start Audit workpaper narrative').length).toBeGreaterThan(0);
        expect(within(dialog).getByLabelText(new RegExp(en('agents.runs.startForm.field.periodLabel.label')))).toBeInTheDocument();
        expect(postsTo('/api/t/acme/agent-runs')).toHaveLength(0);
    });

    it('refuses a blank value itself, as admission would, and sends nothing', async () => {
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-audit-narrative'));
        fireEvent.click(screen.getByTestId('workflow-start-submit'));
        expect(await screen.findByText(en('agents.runs.startForm.required'))).toBeInTheDocument();
        expect(postsTo('/api/t/acme/agent-runs')).toHaveLength(0);
    });

    it('refuses a period the run’s first step would reject', async () => {
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-audit-narrative'));
        fireEvent.change(document.getElementById('workflow-start-periodLabel')!, { target: { value: 'Q3 2026' } });
        fireEvent.click(screen.getByTestId('workflow-start-submit'));
        expect(await screen.findByText(en('agents.runs.startForm.field.periodLabel.invalid'))).toBeInTheDocument();
        expect(postsTo('/api/t/acme/agent-runs')).toHaveLength(0);
    });

    it('posts the declared input, closes, and re-renders the page', async () => {
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-audit-narrative'));
        fireEvent.change(document.getElementById('workflow-start-periodLabel')!, { target: { value: ' 2026-Q3 ' } });
        fireEvent.click(screen.getByTestId('workflow-start-submit'));
        await waitFor(() => expect(postsTo('/api/t/acme/agent-runs')).toHaveLength(1));
        expect(bodyOf(postsTo('/api/t/acme/agent-runs')[0])).toEqual({
            workflowKey: 'audit-narrative',
            input: { periodLabel: '2026-Q3' },
        });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(refreshMock).toHaveBeenCalled();
    });

    it('a framework is picked from the catalogue, and its key is what is sent', async () => {
        const user = userEvent.setup();
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-audit-prep'));
        await user.click(document.getElementById('workflow-start-frameworkKey')!);
        const listbox = await screen.findByRole('listbox');
        await user.click(within(listbox).getByRole('option', { name: 'SOC 2' }));
        fireEvent.click(screen.getByTestId('workflow-start-submit'));
        await waitFor(() => expect(postsTo('/api/t/acme/agent-runs')).toHaveLength(1));
        expect(bodyOf(postsTo('/api/t/acme/agent-runs')[0])).toEqual({
            workflowKey: 'audit-prep',
            input: { frameworkKey: 'SOC2' },
        });
    });

    it('shows the server’s refusal in the form, in its words, and stays open', async () => {
        answers['POST /api/t/acme/agent-runs'] = {
            status: 403,
            body: { error: { code: 'FORBIDDEN', message: 'monthly_token_budget_exhausted: the workspace budget is spent.' } },
        };
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-audit-narrative'));
        fireEvent.change(document.getElementById('workflow-start-periodLabel')!, { target: { value: '2026-09' } });
        fireEvent.click(screen.getByTestId('workflow-start-submit'));
        const dialog = await screen.findByRole('dialog');
        expect(await within(dialog).findByText(/monthly_token_budget_exhausted/)).toBeInTheDocument();
        expect(refreshMock).not.toHaveBeenCalled();
    });

    it('a one-click refusal is shown on the page in the server’s words', async () => {
        answers['POST /api/t/acme/agent-runs'] = {
            status: 403,
            body: { error: { code: 'FORBIDDEN', message: 'flue_requires_registered_agent: refused.' } },
        };
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-diagnostic'));
        expect(await screen.findByText('flue_requires_registered_agent: refused.')).toBeInTheDocument();
    });

    it('a workflow whose input is collected elsewhere is present, disabled, and says where', () => {
        renderRuns();
        const button = screen.getByTestId('workflow-start-ad-hoc-question');
        expect(button).toBeDisabled();
        const gate = button.closest('[data-testid="permission-gated"]');
        expect(gate).not.toBeNull();
        expect(gate!.getAttribute('aria-label')).toContain(en('agents.runs.notHere.ASK_PAGE'));
    });

    it('a reader is told the write tier first, whatever the workflow', () => {
        renderRuns({ canOperate: false });
        const gate = screen.getByTestId('workflow-start-ad-hoc-question').closest('[data-testid="permission-gated"]');
        expect(gate!.getAttribute('aria-label')).toContain(en('agents.runs.needsWrite'));
    });

    it('over the REAL registry, no enabled button posts a run without the input it declares', async () => {
        // The defect, measured over every workflow the page actually lists.
        const workflows = listWorkflowDefinitions().map((w) => ({
            key: w.key,
            name: w.name,
            description: w.description,
            requiredInput: [...(w.requiredInput ?? [])],
        }));
        const view = renderRuns({ runs: [], workflows });
        for (const w of workflows.filter((x) => x.requiredInput.length > 0)) {
            const button = screen.getByTestId(`workflow-start-${w.key}`);
            if (!(button as HTMLButtonElement).disabled) {
                fireEvent.click(button);
                // Opened the form — close it again for the next one.
                expect(screen.getByRole('dialog')).toBeInTheDocument();
                fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en('common.cancel') }));
                await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            }
        }
        expect(postsTo('/api/t/acme/agent-runs')).toHaveLength(0);
        view.unmount();
    });
});
