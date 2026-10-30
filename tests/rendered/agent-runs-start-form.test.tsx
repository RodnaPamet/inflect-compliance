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

// The DESKTOP dialog, which carries the close button the form relies on for
// dismissal (it has no Cancel of its own); jsdom would otherwise get the
// mobile drawer, which is dismissed by dragging.
jest.mock('@inflect/ui/components/ui/hooks/use-media-query', () => ({
    useMediaQuery: () => ({ device: 'desktop', width: 1280, height: 851, isMobile: false, isTablet: false, isDesktop: true }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import { AgentRunsClient, type RunRow } from '@/app/t/[tenantSlug]/(app)/agents/runs/AgentRunsClient';
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import type { StartAbilities } from '@/lib/agentic/workflow-start-plan';

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
const NOT_HERE = { key: 'sap-transaction-review', name: 'SAP transaction review', description: 'Reviews', requiredInput: ['question', 'facts'] };
const ASK = { key: 'ad-hoc-question', name: 'Ad-hoc question', description: 'Answers', requiredInput: ['question'] };
const PICKER_FORM = { key: 'discovered-agent-review', name: 'Discovered agent review', description: 'Reviews one', requiredInput: ['discoveredAgentId'] };

/** A caller who may list discovered agents and open the Ask page. */
const ALL: StartAbilities = { discoveredAgents: true, askPage: true, frameworks: true };
const NONE: StartAbilities = { discoveredAgents: false, askPage: false, frameworks: false };

const DISCOVERED_LIST = '/api/t/acme/admin/agents/discovered';
const discoveredRow = (id: string, discoveredId: string, extra: Record<string, unknown> = {}) => ({
    id,
    discoveredId,
    discoveredVia: ['entra-sp'],
    lastSeenAt: '2026-10-28T09:00:00.000Z',
    registeredAgentName: null,
    ...extra,
});

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
        [`GET ${DISCOVERED_LIST}`]: {
            status: 200,
            body: {
                rows: [
                    discoveredRow('da-1', 'okta:app:payroll-bot', { discoveredVia: ['okta-app'] }),
                    discoveredRow('da-2', 'entra:sp:reconciler', { registeredAgentName: 'Reconciler' }),
                ],
                truncated: false,
            },
        },
    };
    global.fetch = fetchMock as unknown as typeof fetch;
});

function renderRuns({
    runs = [RUN],
    workflows = [ONE_CLICK, PERIOD_FORM, FRAMEWORK_FORM, NOT_HERE, ASK, PICKER_FORM],
    canOperate = true,
    truncated,
    startAbilities = ALL,
}: {
    runs?: RunRow[];
    workflows?: Array<{ key: string; name: string; description: string; requiredInput?: readonly string[] }>;
    canOperate?: boolean;
    truncated?: boolean;
    startAbilities?: StartAbilities;
} = {}) {
    return render(
        <AgentRunsClient
            tenantSlug="acme"
            runs={runs}
            truncated={truncated}
            workflows={workflows}
            canOperate={canOperate}
            startAbilities={startAbilities}
        />,
    );
}

const gateLabelOf = (key: string) =>
    screen.getByTestId(`workflow-start-${key}`).closest('[data-testid="permission-gated"]')?.getAttribute('aria-label') ?? null;

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

    it('can be dismissed without starting anything', async () => {
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-audit-narrative'));
        // The dialog's own close button — the form has no Cancel of its own.
        fireEvent.click(screen.getByRole('dialog').querySelector('[data-modal-close]')!);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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

    it.each([
        ['sap-transaction-review', 'HOST_SYSTEM_FACTS'],
        ['agent-recertification-pack', 'ACCESS_REVIEW_PREPARATION'],
    ] as const)('%s is present, disabled, and says why (%s)', (key, reason) => {
        const recert = { key: 'agent-recertification-pack', name: 'Agent recertification pack', description: 'Packs', requiredInput: ['accessReviewId', 'page', 'subject'] };
        renderRuns({ workflows: [NOT_HERE, recert] });
        expect(screen.getByTestId(`workflow-start-${key}`)).toBeDisabled();
        expect(gateLabelOf(key)).toContain(en(`agents.runs.notHere.${reason}`));
    });

    it('a reader is told the write tier first for a run start', () => {
        renderRuns({ canOperate: false });
        expect(gateLabelOf('sap-transaction-review')).toContain(en('agents.runs.needsWrite'));
        expect(gateLabelOf('discovered-agent-review')).toContain(en('agents.runs.needsWrite'));
    });

    it.each([
        ['every ability', ALL],
        ['no ability', NONE],
    ] as const)('over the REAL registry, with %s, no enabled button posts a run without the input it declares', async (_label, startAbilities) => {
        // The defect, measured over every workflow the page actually lists.
        const workflows = listWorkflowDefinitions().map((w) => ({
            key: w.key,
            name: w.name,
            description: w.description,
            requiredInput: [...(w.requiredInput ?? [])],
        }));
        const view = renderRuns({ runs: [], workflows, startAbilities });
        for (const w of workflows.filter((x) => x.requiredInput.length > 0)) {
            const button = screen.getByTestId(`workflow-start-${w.key}`);
            // A link starts nothing here — the Ask page is where it is asked.
            if (button.tagName === 'A') continue;
            if (!(button as HTMLButtonElement).disabled) {
                fireEvent.click(button);
                // Opened the form — close it again for the next one.
                expect(screen.getByRole('dialog')).toBeInTheDocument();
                fireEvent.click(screen.getByRole('dialog').querySelector('[data-modal-close]')!);
                await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            }
        }
        expect(postsTo('/api/t/acme/agent-runs')).toHaveLength(0);
        view.unmount();
    });
});

describe('the ad-hoc question is a link to the Ask page, not a run start', () => {
    it('links to the Ask page, and is not a Start button', () => {
        // Asserted as markup, not clicked: a real anchor navigates, which jsdom
        // does not implement — and that it is a real anchor is the point.
        renderRuns();
        const link = screen.getByRole('link', { name: 'Ad-hoc question' });
        expect(link).toBe(screen.getByTestId('workflow-start-ad-hoc-question'));
        expect(link.getAttribute('href')).toBe('/t/acme/agents/ask');
        expect(screen.queryByRole('button', { name: 'Ad-hoc question' })).toBeNull();
    });

    it('is a link for a reader too: following it starts nothing, and the Ask page is reader-level', () => {
        renderRuns({ canOperate: false });
        expect(screen.getByTestId('workflow-start-ad-hoc-question').getAttribute('href')).toBe('/t/acme/agents/ask');
    });

    it('is not a link for a person the Ask page refuses, and says why — to a reader as well', () => {
        for (const canOperate of [true, false]) {
            const view = renderRuns({ canOperate, startAbilities: { ...ALL, askPage: false } });
            const control = screen.getByTestId('workflow-start-ad-hoc-question');
            expect(control.tagName).toBe('BUTTON');
            expect(control).toBeDisabled();
            expect(gateLabelOf('ad-hoc-question')).toContain(en('agents.runs.notHere.NEEDS_ASK_ACCESS'));
            view.unmount();
        }
    });
});

describe('the discovered-agent review picks its agent from the inventory', () => {
    it('lists the discovered agents and starts the run with the chosen one', async () => {
        const user = userEvent.setup();
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-discovered-agent-review'));
        await user.click(document.getElementById('workflow-start-discoveredAgentId')!);
        const listbox = await screen.findByRole('listbox');
        expect(fetchMock.mock.calls.some(([u, init]) => u === DISCOVERED_LIST && !init?.method)).toBe(true);
        expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual([
            expect.stringContaining('okta:app:payroll-bot'),
            expect.stringContaining('entra:sp:reconciler'),
        ]);
        await user.click(within(listbox).getByRole('option', { name: /entra:sp:reconciler/ }));
        fireEvent.click(screen.getByTestId('workflow-start-submit'));
        await waitFor(() => expect(postsTo('/api/t/acme/agent-runs')).toHaveLength(1));
        expect(bodyOf(postsTo('/api/t/acme/agent-runs')[0])).toEqual({
            workflowKey: 'discovered-agent-review',
            input: { discoveredAgentId: 'da-2' },
        });
    });

    it('names a linked register row beside the agent', async () => {
        const user = userEvent.setup();
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-discovered-agent-review'));
        await user.click(document.getElementById('workflow-start-discoveredAgentId')!);
        const listbox = await screen.findByRole('listbox');
        const option = within(listbox).getByRole('option', { name: /entra:sp:reconciler/ });
        expect(option.textContent).toContain(en('agents.runs.startForm.discoveredRegistered').replace('{name}', 'Reconciler'));
    });

    it('says when the list is cut', async () => {
        answers[`GET ${DISCOVERED_LIST}`] = {
            status: 200,
            body: { rows: [discoveredRow('da-1', 'okta:app:payroll-bot')], truncated: true },
        };
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-discovered-agent-review'));
        expect((await screen.findByTestId('workflow-start-discovered-truncated')).textContent).toContain(
            en('agents.runs.startForm.discoveredTruncated').replace('{shown}', '1'),
        );
    });

    it('says nothing about a cut when the list is whole', async () => {
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-discovered-agent-review'));
        await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === DISCOVERED_LIST)).toBe(true));
        expect(screen.queryByTestId('workflow-start-discovered-truncated')).toBeNull();
    });

    it('shows the list’s refusal in the server’s words', async () => {
        answers[`GET ${DISCOVERED_LIST}`] = {
            status: 403,
            body: { error: { code: 'FORBIDDEN', message: 'Permission denied: agent inventory.' } },
        };
        renderRuns();
        fireEvent.click(screen.getByTestId('workflow-start-discovered-agent-review'));
        expect(await within(screen.getByRole('dialog')).findByText('Permission denied: agent inventory.')).toBeInTheDocument();
    });

    it('is not offered to a caller who cannot list discovered agents — no picker, no request, and the reason', () => {
        renderRuns({ startAbilities: { ...ALL, discoveredAgents: false } });
        const button = screen.getByTestId('workflow-start-discovered-agent-review');
        expect(button).toBeDisabled();
        expect(gateLabelOf('discovered-agent-review')).toContain(en('agents.runs.notHere.NEEDS_AGENT_INVENTORY'));
        fireEvent.click(button);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(fetchMock.mock.calls.some(([u]) => u === DISCOVERED_LIST)).toBe(false);
    });

    it('the framework picker is not offered to a caller who cannot view frameworks — no form, no request, and the reason (#4533)', () => {
        renderRuns({ startAbilities: { ...ALL, frameworks: false } });
        const button = screen.getByTestId('workflow-start-audit-prep');
        expect(button).toBeDisabled();
        expect(gateLabelOf('audit-prep')).toContain(en('agents.runs.notHere.NEEDS_FRAMEWORK_ACCESS'));
        fireEvent.click(button);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(fetchMock.mock.calls.some(([u]) => u === '/api/t/acme/frameworks')).toBe(false);
    });

    it('a page that passes no abilities offers neither the picker nor the link', () => {
        render(
            <AgentRunsClient tenantSlug="acme" runs={[]} workflows={[ASK, PICKER_FORM]} canOperate />,
        );
        expect(screen.getByTestId('workflow-start-discovered-agent-review')).toBeDisabled();
        expect(screen.getByTestId('workflow-start-ad-hoc-question').tagName).toBe('BUTTON');
    });
});
