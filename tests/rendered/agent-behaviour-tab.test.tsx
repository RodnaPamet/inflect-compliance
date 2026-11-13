/**
 * Step 1b (#4144) — THE BEHAVIOUR TAB: an agent's profile, written, submitted,
 * reviewed and approved in the product.
 *
 * One test per state the tab can show (no profile, draft, submitted as seen by
 * a reviewer and by its author, approved, rejected), and the claims the step's
 * hardening checklist makes about the surface:
 *
 *   • instructions and a rejection reason render as text: `<img onerror>` in
 *     either is characters on the screen and creates no element;
 *   • the author is never offered Approve on their own submission;
 *   • the tool picker offers exactly the tools the agent is granted;
 *   • Test run (Step 2c) starts the version's run and opens the Runs tab when
 *     it can, and otherwise is disabled, says why, and starts nothing;
 *   • a refusal from the save is shown beside the field it concerns;
 *   • a drawn flow, which the approval hash covers, is shown and diffed for
 *     the reviewer like the instructions, and its Test run is disabled;
 *   • a version's sub-agents (Step 2e), which the hash also covers, are shown
 *     and diffed in full, and the editor's sub-agent pickers offer only the
 *     version's own tools and skills.
 */
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const walk = (root: unknown, path: string): unknown =>
        path.split('.').reduce<unknown>(
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

jest.mock('@inflect/ui/components/ui/hooks/use-media-query', () => ({
    useMediaQuery: () => ({ device: 'desktop', width: 1280, height: 851, isMobile: false, isTablet: false, isDesktop: true }),
}));

const swr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => swr(key),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));
const toastError = jest.fn();
const toastSuccess = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({ error: toastError, success: toastSuccess }),
}));

import { BehaviourTab } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/BehaviourTab';
import type { ProfileVersionView, ProfileView } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/behaviour-types';

const EN = jest.requireActual('../../messages/en.json') as { agents: { behaviour: Record<string, unknown> } };
const EDITOR = EN.agents.behaviour.editor as Record<string, string>;
const copy = (path: string, params: Record<string, string | number> = {}): string => {
    let v = path.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        EN.agents.behaviour,
    );
    if (typeof v !== 'string') throw new Error(`messages/en.json has no agents.behaviour.${path}`);
    for (const [p, val] of Object.entries(params)) v = (v as string).replace(`{${p}}`, String(val));
    return v as string;
};

const HASH_1 = 'a'.repeat(64);
const HASH_2 = 'b'.repeat(64);
const XSS = 'Summarise risks. <img src=x onerror="window.__pwned=1"> Then stop.';

function version(over: Partial<ProfileVersionView> = {}): ProfileVersionView {
    return {
        id: 'ver-1',
        version: 1,
        status: 'APPROVED',
        instructions: 'Summarise the open risks for the weekly review.',
        instructionsHash: HASH_1,
        toolNames: ['list_risks'],
        flow: null,
        subagents: [],
        skillRefs: [],
        modelTier: 'balanced',
        effort: 'medium',
        maxTurns: 10,
        compactionThresholdTokens: null,
        outputKind: 'ANSWER_ONLY',
        allowedTriggers: ['TEST_RUN'],
        author: { label: 'Avery Author', isViewer: false },
        submittedAt: '2026-10-25T09:00:00.000Z',
        decidedBy: { label: 'Riley Reviewer', isViewer: false },
        decidedAt: '2026-10-25T10:00:00.000Z',
        rejectionReason: null,
        retiredAt: null,
        createdAt: '2026-10-25T08:00:00.000Z',
        canDecide: false,
        ...over,
    };
}

function view(versions: ProfileVersionView[], over: Partial<ProfileView> = {}): ProfileView {
    const approved = versions.find((v) => v.status === 'APPROVED');
    return {
        profile: versions.length
            ? { profileId: 'prof-1', currentApprovedVersion: approved?.version ?? null, runKey: approved ? `agent-profile:prof-1@v${approved.version}` : null }
            : null,
        versions,
        options: {
            tools: ['list_controls', 'list_risks'],
            skills: [{ origin: 'repository', name: 'risk-register-review', catalogueBytes: 300 }],
        },
        testRun: { available: false, reason: 'ENGINE_DOES_NOT_RUN_PROFILES', engine: 'STATIC' },
        limits: {
            instructionsMaxChars: 16_000,
            maxTurns: 50,
            rejectionReasonMaxChars: 1_000,
            skillCatalogueBudgetBytes: 2_048,
            compactionThreshold: {
                min: 10_000,
                maxByTier: { balanced: 150_000, deep: 150_000 },
                engineDefaultByTier: { balanced: 30_000, deep: 30_000 },
            },
        },
        ...over,
    };
}

const SUBMITTED = (over: Partial<ProfileVersionView> = {}) =>
    version({
        id: 'ver-2',
        version: 2,
        status: 'SUBMITTED',
        instructions: 'Summarise the open risks for the weekly review. Group them by owner.',
        instructionsHash: HASH_2,
        decidedBy: null,
        decidedAt: null,
        canDecide: true,
        ...over,
    });

const fetchMock = jest.fn();
beforeEach(() => {
    swr.mockReset();
    fetchMock.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(cleanup);

function renderTab(data: ProfileView, props: { retired?: boolean; onOpenRuns?: () => void } = {}) {
    const mutate = jest.fn().mockResolvedValue(undefined);
    swr.mockReturnValue({ data, error: undefined, isLoading: false, mutate });
    render(
        <BehaviourTab
            tenantSlug="acme"
            agentId="agent-1"
            retired={props.retired ?? false}
            onOpenRuns={props.onOpenRuns}
        />,
    );
    return { mutate };
}

const ok = (body: unknown = {}) => ({ ok: true, json: async () => body });
const refused = (reason: string, message: string, status = 400) => ({
    ok: false,
    status,
    json: async () => ({ error: { code: 'BAD_REQUEST', message, details: { reason } } }),
});

describe('the Behaviour tab, state by state', () => {
    it('no profile: says nothing is in force and offers the first version', () => {
        renderTab(view([]));
        expect(swr).toHaveBeenCalledWith('/admin/agents/agent-1/profile');
        expect(screen.getByTestId('behaviour-in-force-empty').textContent).toContain(copy('inForce.noProfileDescription'));
        expect(screen.getByTestId('behaviour-write').textContent).toBe(copy('createAction'));
        expect(screen.queryByTestId('behaviour-open')).toBeNull();
        expect(within(screen.getByTestId('behaviour-history')).getByText(copy('history.empty'))).toBeTruthy();
    });

    it('draft: offers Submit, which posts to the version\'s submit route', async () => {
        const { mutate } = renderTab(view([version({ status: 'DRAFT', decidedBy: null, decidedAt: null, submittedAt: null })]));
        expect(within(screen.getByTestId('behaviour-open')).getByText(copy('status.DRAFT'))).toBeTruthy();
        expect(screen.queryByTestId('behaviour-approve')).toBeNull();
        fetchMock.mockResolvedValue(ok({ status: 'SUBMITTED' }));
        await act(async () => {
            fireEvent.click(screen.getByTestId('behaviour-submit'));
        });
        expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/admin/agents/agent-1/profile/versions/1/submit', expect.objectContaining({ method: 'POST' }));
        expect(mutate).toHaveBeenCalled();
    });

    it('submitted, seen by a reviewer: the diff against the version in force, and Approve sends the hash on screen', async () => {
        renderTab(view([SUBMITTED(), version()]));
        const open = screen.getByTestId('behaviour-open');
        expect(within(open).getByTestId('behaviour-review-diff')).toBeTruthy();
        expect(within(open).getByTestId('version-diff-body').textContent).toContain('Group them by owner.');
        expect(within(open).getByTestId('behaviour-reject')).toBeTruthy();
        fetchMock.mockResolvedValue(ok({ status: 'APPROVED' }));
        await act(async () => {
            fireEvent.click(within(open).getByTestId('behaviour-approve'));
        });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/agents/agent-1/profile/versions/2/approve');
        expect(JSON.parse(init.body)).toEqual({ instructionsHash: HASH_2 });
    });

    it('submitted, seen by its author: no Approve and no Reject, and the panel says why', () => {
        renderTab(view([SUBMITTED({ canDecide: false, author: { label: 'Avery Author', isViewer: true } }), version()]));
        expect(screen.queryByTestId('behaviour-approve')).toBeNull();
        expect(screen.queryByTestId('behaviour-reject')).toBeNull();
        expect(screen.queryByTestId('behaviour-review-diff')).toBeNull();
        expect(screen.getByTestId('behaviour-author-note').textContent).toBe(copy('review.authorCannotDecide'));
    });

    it('approved: read-only, with the approver and the date, and every version in the history', () => {
        renderTab(view([version()]));
        const inForce = screen.getByTestId('behaviour-in-force');
        expect(within(inForce).getByTestId('behaviour-version-1-instructions').textContent).toBe(
            'Summarise the open risks for the weekly review.',
        );
        expect(within(inForce).getByTestId('behaviour-version-1-tools').textContent).toBe('list_risks');
        expect(screen.getByTestId('behaviour-in-force-approval').textContent).toContain('Riley Reviewer');
        expect(within(inForce).queryAllByRole('textbox')).toHaveLength(0);
        expect(screen.getByTestId('behaviour-version-1-hash').textContent).toBe(HASH_1);
        expect(screen.getByTestId('behaviour-version-1-decider').textContent).toContain('Riley Reviewer');
        expect(screen.getByTestId('behaviour-write').textContent).toBe(copy('editAction'));
    });

    it('rejected: the reason is shown on the version, as text', () => {
        renderTab(
            view([
                version({
                    status: 'REJECTED',
                    rejectionReason: `Too broad. ${XSS}`,
                    decidedBy: { label: 'Riley Reviewer', isViewer: false },
                }),
            ]),
        );
        expect(screen.getByTestId('behaviour-version-1-status').textContent).toBe(copy('status.REJECTED'));
        expect(screen.getByTestId('behaviour-version-1-reason').textContent).toBe(`Too broad. ${XSS}`);
        expect(document.querySelector('img')).toBeNull();
    });

    it('a retired agent: no authoring, and Reject is still offered on a version waiting for review', () => {
        renderTab(view([SUBMITTED(), version()]), { retired: true });
        expect(screen.queryByTestId('behaviour-write')).toBeNull();
        expect(screen.queryByTestId('behaviour-approve')).toBeNull();
        expect(screen.getByTestId('behaviour-reject')).toBeTruthy();
        expect(screen.getByTestId('behaviour-retired')).toBeTruthy();
    });
});

describe('instructions are text everywhere', () => {
    it('<img onerror> in the instructions creates no element, in force, open, in the diff or in the editor', async () => {
        renderTab(view([SUBMITTED({ instructions: XSS }), version({ instructions: `${XSS} Old.` })]));
        expect(document.querySelector('img')).toBeNull();
        expect(screen.getByTestId('behaviour-version-2-instructions').textContent).toBe(XSS);
        expect(screen.getByTestId('behaviour-version-1-instructions').textContent).toBe(`${XSS} Old.`);
        expect(screen.getByTestId('version-diff-body').textContent).toContain('<img src=x onerror=');
        fireEvent.click(screen.getByTestId('behaviour-write'));
        const editor = await screen.findByTestId('behaviour-editor');
        expect((within(editor).getByRole('textbox', { name: copy('field.instructions') }) as HTMLTextAreaElement).value).toBe(XSS);
        expect(document.querySelector('img')).toBeNull();
        expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    });
});

const FLOW_V1 = {
    nodes: [
        { key: 'risks', kind: 'read' as const, label: 'Gather the open risks', tool: 'list_risks' },
        { key: 'answer', kind: 'synthesis' as const, label: 'Summarise by owner' },
    ],
    edges: [{ from: 'risks', to: 'answer' }],
};
const FLOW_V2 = {
    nodes: [
        { key: 'risks', kind: 'read' as const, label: `Read every risk ${XSS}`, tool: 'list_risks' },
        { key: 'rate', kind: 'subagent' as const, label: 'Ask the risk agent to rate each risk', profileRef: 'prof-rater' },
        { key: 'answer', kind: 'synthesis' as const, label: 'Summarise by owner' },
    ],
    edges: [
        { from: 'risks', to: 'rate' },
        { from: 'rate', to: 'answer' },
    ],
};

describe('a drawn flow is shown to the person who approves it', () => {
    it('every step, tool, profile reference and connection the hash covers is on screen and in a diff, as text', async () => {
        renderTab(view([SUBMITTED({ flow: FLOW_V2, toolNames: ['list_risks'] }), version({ flow: FLOW_V1 })]));
        const open = screen.getByTestId('behaviour-open');
        const body = within(open).getByTestId('behaviour-version-2-flow').textContent ?? '';
        expect(body).toContain('[READ] Read every risk');
        expect(body).toContain('(tool: list_risks)');
        expect(body).toContain('[SUBAGENT] Ask the risk agent to rate each risk {rate} (profile: prof-rater)');
        expect(body).toContain('rate -> answer');
        // Labels are text, as the instructions are.
        expect(body).toContain('<img src=x onerror=');
        expect(document.querySelector('img')).toBeNull();

        const flowDiff = within(open).getByTestId('behaviour-review-flow-diff');
        expect(flowDiff.textContent).toContain('Ask the risk agent to rate each risk');
        expect(within(open).getByText(copy('review.flowDiffIntro', { from: 1, to: 2 }))).toBeTruthy();
        expect(open.textContent).toContain(copy('review.hashNoteWithFlow'));
        expect(open.textContent).not.toContain(copy('review.hashNote'));

        fetchMock.mockResolvedValue(ok({ status: 'APPROVED' }));
        await act(async () => {
            fireEvent.click(within(open).getByTestId('behaviour-approve'));
        });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ instructionsHash: HASH_2 });
    });

    it('a flow added where the version in force had none is diffed from nothing', () => {
        renderTab(view([SUBMITTED({ flow: FLOW_V1 }), version()]));
        expect(screen.getByTestId('behaviour-review-flow-diff').textContent).toContain('Gather the open risks');
        expect(screen.getByTestId('behaviour-version-2-flow').textContent).toContain('risks -> answer');
        expect(screen.queryByTestId('behaviour-version-1-flow')).toBeNull();
    });

    it('a version with no flow shows no flow, no flow diff, and the plain hash note', () => {
        renderTab(view([SUBMITTED(), version()]));
        expect(screen.queryByTestId('behaviour-version-2-flow')).toBeNull();
        expect(screen.queryByTestId('behaviour-review-flow-diff')).toBeNull();
        expect(screen.getByTestId('behaviour-open').textContent).toContain(copy('review.hashNote'));
    });

    it('a flow version\'s Test run is disabled and says no engine runs a drawn flow yet', () => {
        renderTab(view([SUBMITTED({ flow: FLOW_V1 }), version()], { testRun: { available: true } }));
        expect((screen.getByTestId('behaviour-test-run-2-button') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('behaviour-test-run-2-reason').textContent).toBe(copy('testRun.reason.FLOW_NOT_RUNNABLE'));
        expect((screen.getByTestId('behaviour-test-run-1-button') as HTMLButtonElement).disabled).toBe(false);
    });
});

describe('Test run (Step 2c)', () => {
    it('on an engine that does not run profiles: disabled on both versions, names the engine and where to change it, starts nothing', () => {
        renderTab(view([SUBMITTED(), version()], { testRun: { available: false, reason: 'ENGINE_DOES_NOT_RUN_PROFILES', engine: 'FLUE' } }));
        const expected = copy('testRun.reason.ENGINE_DOES_NOT_RUN_PROFILES', { engine: copy('testRun.engine.FLUE') });
        for (const n of [1, 2]) {
            const button = screen.getByTestId(`behaviour-test-run-${n}-button`) as HTMLButtonElement;
            expect(button.disabled).toBe(true);
            fireEvent.click(button);
            expect(screen.getByTestId(`behaviour-test-run-${n}-reason`).textContent).toBe(expected);
        }
        expect(expected).toContain('Flue engine');
        expect(expected).toContain('Agent engines');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['ENGINE_NOT_IN_FORCE', 'AGENT_NOT_READY'] as const)('%s: disabled, with its own sentence', (reason) => {
        renderTab(view([version()], { testRun: { available: false, reason } }));
        expect((screen.getByTestId('behaviour-test-run-1-button') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('behaviour-test-run-1-reason').textContent).toBe(copy(`testRun.reason.${reason}`));
    });

    it('a version that does not allow Test runs is disabled, though the engine is ready', () => {
        renderTab(view([version({ allowedTriggers: ['ASK'] })], { testRun: { available: true } }));
        expect((screen.getByTestId('behaviour-test-run-1-button') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('behaviour-test-run-1-reason').textContent).toBe(copy('testRun.reason.TRIGGER_NOT_ALLOWED'));
    });

    it('when it can start: POSTs that version\'s Test run, says so, and opens the Runs tab', async () => {
        const onOpenRuns = jest.fn();
        fetchMock.mockResolvedValue(ok({ runId: 'run-1', status: 'RUNNING' }));
        renderTab(view([SUBMITTED(), version()], { testRun: { available: true } }), { onOpenRuns });
        const button = screen.getByTestId('behaviour-test-run-2-button') as HTMLButtonElement;
        expect(button.disabled).toBe(false);
        expect(screen.queryByTestId('behaviour-test-run-2-reason')).toBeNull();
        fireEvent.click(button);
        await waitFor(() => expect(onOpenRuns).toHaveBeenCalledTimes(1));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('/api/t/acme/admin/agents/agent-1/profile/versions/2/test-run');
        expect(fetchMock.mock.calls[0][1].method).toBe('POST');
        expect(toastSuccess).toHaveBeenCalledWith(copy('testRun.started'));
    });

    it('a refusal from the server is shown, and the Runs tab is not opened', async () => {
        const onOpenRuns = jest.fn();
        fetchMock.mockResolvedValue(refused('AGENT_KILL_SWITCHED', 'A kill switch is in force for this agent (scope: AGENT).', 409));
        renderTab(view([version()], { testRun: { available: true } }), { onOpenRuns });
        fireEvent.click(screen.getByTestId('behaviour-test-run-1-button'));
        await waitFor(() => expect(toastError).toHaveBeenCalledWith('A kill switch is in force for this agent (scope: AGENT).'));
        expect(onOpenRuns).not.toHaveBeenCalled();
    });

    it('a version naming only propose tools is disabled, since a Test run is read-only (#5374)', () => {
        renderTab(
            view([SUBMITTED({ toolNames: ['propose_risks'] }), version({ toolNames: ['list_risks', 'propose_risks'] })], {
                testRun: { available: true },
            }),
        );
        expect((screen.getByTestId('behaviour-test-run-2-button') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('behaviour-test-run-2-reason').textContent).toBe(copy('testRun.reason.NO_READ_TOOL'));
        // One read tool is enough: the in-force version can still be tried.
        expect((screen.getByTestId('behaviour-test-run-1-button') as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(screen.getByTestId('behaviour-test-run-2-button'));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is not offered on a draft', () => {
        renderTab(view([version({ status: 'DRAFT', decidedBy: null, decidedAt: null })]));
        expect(screen.queryByTestId('behaviour-test-run-1')).toBeNull();
    });
});

describe('the editor', () => {
    it('the tool picker offers exactly the tools the agent is granted', async () => {
        const user = userEvent.setup();
        renderTab(view([version()]));
        await user.click(screen.getByTestId('behaviour-write'));
        await screen.findByTestId('behaviour-editor');
        await user.click(document.getElementById('behaviour-tools') as HTMLElement);
        const listbox = await screen.findByRole('listbox');
        // The chosen ones are listed first; the set is what matters.
        expect(within(listbox).getAllByRole('option').map((o) => o.textContent?.trim()).sort()).toEqual(['list_controls', 'list_risks']);
    });

    it('a tool the starting version named and the agent has lost is left out and named', async () => {
        renderTab(view([version({ toolNames: ['list_risks', 'list_vendors'] })]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        expect((await screen.findByTestId('behaviour-editor-lost')).textContent).toContain('list_vendors');
    });

    it('saving posts a whole version, and a refusal is shown beside the field it concerns', async () => {
        renderTab(view([version()]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        const editor = await screen.findByTestId('behaviour-editor');
        // Nothing is open, so the save retires nothing.
        expect(screen.queryByTestId('behaviour-editor-supersedes')).toBeNull();
        const message = 'The agent is not granted list_vendors.';
        fetchMock.mockResolvedValue(refused('TOOL_NOT_GRANTED', message));
        await act(async () => {
            fireEvent.click(within(editor).getByTestId('behaviour-editor-save'));
        });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/agents/agent-1/profile/versions');
        expect(JSON.parse(init.body)).toEqual({
            instructions: 'Summarise the open risks for the weekly review.',
            toolNames: ['list_risks'],
            skillRefs: [],
            modelTier: 'balanced',
            effort: 'medium',
            maxTurns: 10,
            compactionThresholdTokens: null,
            outputKind: 'ANSWER_ONLY',
            allowedTriggers: ['TEST_RUN'],
        });
        // Beside the tools field (its FormField error, which the picker is
        // described by), not in the form-level notice, and not beside another.
        expect(document.getElementById('behaviour-tools-error')?.textContent).toBe(message);
        expect(document.getElementById('behaviour-tools')?.getAttribute('aria-describedby')).toContain('behaviour-tools-error');
        expect(document.getElementById('behaviour-instructions-error')).toBeNull();
        expect(screen.queryByTestId('behaviour-editor-error')).toBeNull();
    });

    it('editing a version with a drawn flow keeps the flow, and sends it in place of a tool list (#5374)', async () => {
        renderTab(view([version({ flow: FLOW_V1, toolNames: ['list_risks'] })]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        const editor = await screen.findByTestId('behaviour-editor');
        // Said before the save, and the flow's tools are shown, not offered.
        expect(within(editor).getByTestId('behaviour-editor-flow-kept').textContent).toBe(copy('editor.flowKept', { nodes: 2 }));
        expect(within(editor).getByTestId('behaviour-editor-flow-tools').textContent).toBe('list_risks');
        expect(document.getElementById('behaviour-tools')).toBeNull();
        fetchMock.mockResolvedValue(ok({ version: 2 }));
        await act(async () => {
            fireEvent.click(within(editor).getByTestId('behaviour-editor-save'));
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.flow).toEqual(FLOW_V1);
        // Never both: the save refuses a tool list beside a flow.
        expect(body).not.toHaveProperty('toolNames');
    });

    describe('the skill catalogue budget (#4590)', () => {
        const SKILLS = [
            { origin: 'repository' as const, name: 'risk-register-review', catalogueBytes: 1_500 },
            { origin: 'tenant' as const, name: 'our-own-skill', catalogueBytes: 1_000 },
        ];
        const withSkills = (skillRefs: ProfileVersionView['skillRefs']) =>
            view([version({ skillRefs })], { options: { tools: ['list_controls', 'list_risks'], skills: SKILLS } });

        it('shows the running total of the chosen skills against the budget', async () => {
            renderTab(withSkills([{ origin: 'repository', name: 'risk-register-review' }]));
            fireEvent.click(screen.getByTestId('behaviour-write'));
            await screen.findByTestId('behaviour-editor');
            expect(screen.getByTestId('behaviour-skills-budget').textContent).toBe(
                EDITOR.skillsBudget.replace('{used}', '1500').replace('{budget}', '2048'),
            );
            expect(screen.getByTestId('behaviour-editor-save')).toBeEnabled();
        });

        it('over the budget, says so beside the skills field and does not let the save happen', async () => {
            renderTab(
                withSkills([
                    { origin: 'repository', name: 'risk-register-review' },
                    { origin: 'tenant', name: 'our-own-skill' },
                ]),
            );
            fireEvent.click(screen.getByTestId('behaviour-write'));
            const editor = await screen.findByTestId('behaviour-editor');
            expect(document.getElementById('behaviour-skills-error')?.textContent).toBe(
                EDITOR.skillsOverBudget.replace('{used}', '2500').replace('{budget}', '2048'),
            );
            expect(within(editor).getByTestId('behaviour-editor-save')).toBeDisabled();
            await act(async () => {
                fireEvent.submit(editor);
            });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('sends each chosen skill as its ref only, never the cost the view carried', async () => {
            renderTab(withSkills([{ origin: 'tenant', name: 'our-own-skill' }]));
            fireEvent.click(screen.getByTestId('behaviour-write'));
            const editor = await screen.findByTestId('behaviour-editor');
            fetchMock.mockResolvedValue(ok({ profileId: 'prof-1', versionId: 'ver-9', version: 9 }));
            await act(async () => {
                fireEvent.click(within(editor).getByTestId('behaviour-editor-save'));
            });
            expect(JSON.parse(fetchMock.mock.calls[0][1].body).skillRefs).toEqual([{ origin: 'tenant', name: 'our-own-skill' }]);
        });

        it('a server refusal over the budget is shown beside the skills field', async () => {
            renderTab(withSkills([]));
            fireEvent.click(screen.getByTestId('behaviour-write'));
            const editor = await screen.findByTestId('behaviour-editor');
            const message = 'These 2 skills would cost 2500 bytes of catalogue on every turn, over the 2048 budget.';
            fetchMock.mockResolvedValue(refused('SKILL_CATALOGUE_OVER_BUDGET', message, 409));
            await act(async () => {
                fireEvent.click(within(editor).getByTestId('behaviour-editor-save'));
            });
            expect(document.getElementById('behaviour-skills-error')?.textContent).toBe(message);
            expect(screen.queryByTestId('behaviour-editor-error')).toBeNull();
        });

        /** #4589's refusal as the server sends it: a 409 whose details carry the figures. */
        const SERVER_SENTENCE = 'These 2 skills would cost 2600 bytes of catalogue on every turn, over the 2048 budget.';
        const overBudget = () => ({
            ok: false,
            status: 409,
            json: async () => ({
                error: {
                    code: 'CONFLICT',
                    message: SERVER_SENTENCE,
                    details: {
                        reason: 'SKILL_CATALOGUE_OVER_BUDGET',
                        bytes: 2_600,
                        budget: 2_048,
                        skills: ['repository:risk-register-review', 'tenant:our-own-skill'],
                    },
                },
            }),
        });
        const TRANSLATED = copy('refusal.SKILL_CATALOGUE_OVER_BUDGET', { used: 2_600, budget: 2_048 });

        it('a save the server refuses over the budget is worded from its figures, beside the skills field', async () => {
            // Within the budget by the view's figures, so Save is open: the
            // skills cost more by the time the save prices them.
            renderTab(withSkills([{ origin: 'tenant', name: 'our-own-skill' }]));
            fireEvent.click(screen.getByTestId('behaviour-write'));
            const editor = await screen.findByTestId('behaviour-editor');
            fetchMock.mockResolvedValue(overBudget());
            await act(async () => {
                fireEvent.click(within(editor).getByTestId('behaviour-editor-save'));
            });
            expect(TRANSLATED).toContain('2600');
            expect(TRANSLATED).toContain('2048');
            expect(document.getElementById('behaviour-skills-error')?.textContent).toBe(TRANSLATED);
            expect(screen.queryByText(SERVER_SENTENCE)).toBeNull();
            expect(screen.queryByTestId('behaviour-editor-error')).toBeNull();
            expect(toastError).toHaveBeenCalledWith(TRANSLATED);
        });

        it('an approval the server refuses over the budget is worded from its figures', async () => {
            renderTab(
                view([SUBMITTED({ skillRefs: [{ origin: 'tenant', name: 'our-own-skill' }] }), version()], {
                    options: { tools: ['list_controls', 'list_risks'], skills: SKILLS },
                }),
            );
            fetchMock.mockResolvedValue(overBudget());
            await act(async () => {
                fireEvent.click(screen.getByTestId('behaviour-approve'));
            });
            expect(screen.getByTestId('behaviour-act-error').textContent).toBe(TRANSLATED);
            expect(screen.queryByText(SERVER_SENTENCE)).toBeNull();
            expect(toastError).toHaveBeenCalledWith(TRANSLATED);
        });

        it('the Bulgarian refusal words the same figures', () => {
            const BG = jest.requireActual('../../messages/bg.json') as { agents: { behaviour: { refusal: Record<string, string> } } };
            const text = BG.agents.behaviour.refusal.SKILL_CATALOGUE_OVER_BUDGET;
            expect(text.length).toBeGreaterThan(0);
            expect(text).not.toBe(copy('refusal.SKILL_CATALOGUE_OVER_BUDGET'));
            expect(text.includes('{used}') && text.includes('{budget}')).toBe(true);
        });
    });

    it('starts from the open version and says that saving retires it', async () => {
        renderTab(view([SUBMITTED(), version()]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        const editor = await screen.findByTestId('behaviour-editor');
        expect(screen.getByTestId('behaviour-editor-supersedes').textContent).toBe(copy('editor.supersedes', { version: 2 }));
        expect((within(editor).getByRole('textbox', { name: copy('field.instructions') }) as HTMLTextAreaElement).value).toBe(
            SUBMITTED().instructions,
        );
    });

    it('the first version creates the profile', async () => {
        renderTab(view([]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        await screen.findByTestId('behaviour-editor');
        expect(screen.queryByTestId('behaviour-editor-supersedes')).toBeNull();
        // No tool chosen yet: nothing can be saved.
        expect((screen.getByTestId('behaviour-editor-save') as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('Summarise long conversations (Step 2g, #5531)', () => {
    it('the approval view shows the version\'s choice: the engine default, off, or the lower threshold', () => {
        renderTab(
            view([
                SUBMITTED({ compactionThresholdTokens: 12_000 }),
                version({ compactionThresholdTokens: 0 }),
            ]),
        );
        expect(screen.getAllByTestId('behaviour-version-2-compaction')[0].textContent).toBe(copy('compaction.atTokens', { count: 12000 }));
        expect(screen.getAllByTestId('behaviour-version-1-compaction')[0].textContent).toBe(copy('compaction.off'));
    });

    it('a version that leaves it to the engine says so', () => {
        renderTab(view([version()]));
        expect(screen.getAllByTestId('behaviour-version-1-compaction')[0].textContent).toBe(copy('compaction.default'));
    });

    it('the editor keeps the starting version\'s lower threshold, bounded by the tier, and saves the value chosen', async () => {
        renderTab(view([version({ compactionThresholdTokens: 12_000 })]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        const editor = await screen.findByTestId('behaviour-editor');
        expect(within(editor).getByTestId('behaviour-editor-compaction').textContent).toContain(
            copy('editor.compactionThresholdHint', { min: 10000, max: 150000 }),
        );
        const input = within(editor).getByRole('spinbutton', { name: copy('editor.compactionThresholdLabel') });
        expect(input).toHaveValue('12000');
        fireEvent.change(input, { target: { value: '11000' } });
        fetchMock.mockResolvedValue(ok({ version: 2 }));
        await act(async () => {
            fireEvent.click(within(editor).getByTestId('behaviour-editor-save'));
        });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).compactionThresholdTokens).toBe(11_000);
    });

    it('a version that turned it off saves 0, and a refusal is shown beside the control', async () => {
        renderTab(view([version({ compactionThresholdTokens: 0 })]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        const editor = await screen.findByTestId('behaviour-editor');
        expect(within(editor).queryByRole('spinbutton', { name: copy('editor.compactionThresholdLabel') })).toBeNull();
        const message = 'A version may lower the engine\'s compaction threshold, never raise it.';
        fetchMock.mockResolvedValue(refused('COMPACTION_THRESHOLD_ABOVE_TIER', message));
        await act(async () => {
            fireEvent.click(within(editor).getByTestId('behaviour-editor-save'));
        });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).compactionThresholdTokens).toBe(0);
        expect(within(editor).getByTestId('behaviour-editor-compaction-error').textContent).toBe(message);
        expect(screen.queryByTestId('behaviour-editor-error')).toBeNull();
    });
});

describe('Reject', () => {
    it('needs a reason, sends it, and shows a refusal beside it', async () => {
        renderTab(view([SUBMITTED(), version()]));
        fireEvent.click(screen.getByTestId('behaviour-reject'));
        const confirm = (await screen.findByTestId('behaviour-reject-confirm')) as HTMLButtonElement;
        expect(confirm.textContent).toBe(copy('reject.confirm', { version: 2 }));
        expect(confirm.disabled).toBe(true);
        const reason = screen.getByRole('textbox', { name: copy('reject.reason') });
        fireEvent.change(reason, { target: { value: 'Name the owner field.' } });
        expect(confirm.disabled).toBe(false);

        fetchMock.mockResolvedValueOnce(refused('REJECTION_REASON_TOO_LONG', 'A rejection reason is at most 1000 characters.'));
        await act(async () => {
            fireEvent.click(confirm);
        });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/agents/agent-1/profile/versions/2/reject');
        expect(JSON.parse(init.body)).toEqual({ reason: 'Name the owner field.' });
        expect(screen.getByText('A rejection reason is at most 1000 characters.')).toBeTruthy();

        fetchMock.mockResolvedValueOnce(ok({ status: 'REJECTED' }));
        await act(async () => {
            fireEvent.click(confirm);
        });
        await waitFor(() => expect(screen.queryByTestId('behaviour-reject-confirm')).toBeNull());
    });
});

describe('sub-agents (Step 2e, #4594)', () => {
    const READER = {
        name: 'risk_reader',
        instructions: 'Read the open risks. <img src=x onerror="window.__pwned=1"> List each owner.',
        toolNames: ['list_risks'],
        skillRefs: [],
        maxTurns: 4,
    };

    it('the approval view shows every sub-agent in full, as text, diffs it, and names it in the hash note', async () => {
        renderTab(view([SUBMITTED({ subagents: [READER] }), version()]));
        const open = screen.getByTestId('behaviour-open');
        const body = within(open).getByTestId('behaviour-version-2-subagents').textContent ?? '';
        expect(body).toContain('Sub-agent: risk_reader');
        expect(body).toContain('Tools: list_risks');
        expect(body).toContain('Turn limit: 4');
        expect(body).toContain('List each owner.');
        expect(body).toContain('<img src=x onerror=');
        expect(document.querySelector('img')).toBeNull();
        expect(within(open).getByTestId('behaviour-review-subagents-diff').textContent).toContain('List each owner.');
        expect(within(open).getByText(copy('review.subagentsDiffIntro', { from: 1, to: 2 }))).toBeTruthy();
        expect(open.textContent).toContain(copy('review.hashNoteWithSubagents'));
        fetchMock.mockResolvedValue(ok({ status: 'APPROVED' }));
        await act(async () => {
            fireEvent.click(within(open).getByTestId('behaviour-approve'));
        });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ instructionsHash: HASH_2 });
    });

    it('a version with none shows no sub-agents and no sub-agent diff; the history counts them', () => {
        renderTab(view([SUBMITTED({ subagents: [READER, { ...READER, name: 'owner_finder' }] }), version()]));
        expect(screen.queryByTestId('behaviour-version-1-subagents')).toBeNull();
        expect(screen.getByTestId('behaviour-version-2-subagent-count').textContent).toBe('2');
        expect(screen.getByTestId('behaviour-version-1-subagent-count').textContent).toBe(copy('none'));
    });

    it('a version with sub-agents can be Test-run on the Tool Runner engine, which runs them', () => {
        renderTab(view([SUBMITTED({ subagents: [READER] }), version()], { testRun: { available: true } }));
        expect((screen.getByTestId('behaviour-test-run-2-button') as HTMLButtonElement).disabled).toBe(false);
        expect(screen.queryByTestId('behaviour-test-run-2-reason')).toBeNull();
    });

    it('the editor\'s sub-agent tool picker offers only the tools this version has chosen, never the wider grants', async () => {
        const user = userEvent.setup();
        // The agent is granted two tools; the version chose one.
        renderTab(view([version({ toolNames: ['list_risks'] })]));
        await user.click(screen.getByTestId('behaviour-write'));
        await screen.findByTestId('behaviour-editor');
        expect(screen.getByTestId('behaviour-subagents-none')).toBeTruthy();
        await user.click(screen.getByTestId('behaviour-subagent-add'));
        await user.click(document.getElementById('behaviour-subagent-0-tools') as HTMLElement);
        const listbox = await screen.findByRole('listbox');
        expect(within(listbox).getAllByRole('option').map((o) => o.textContent?.trim())).toEqual(['list_risks']);
    });

    it('saving sends the sub-agents with the version, and a sub-agent outside the version is marked and blocks the save', async () => {
        renderTab(view([version({ toolNames: ['list_risks', 'list_controls'], subagents: [{ ...READER, toolNames: ['list_controls'] }] })]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        const editor = await screen.findByTestId('behaviour-editor');
        expect((document.getElementById('behaviour-subagent-0-name') as HTMLInputElement).value).toBe('risk_reader');
        expect(within(editor).queryByTestId('behaviour-subagent-0-outside')).toBeNull();

        fetchMock.mockResolvedValue(ok({ version: 2 }));
        await act(async () => {
            fireEvent.click(within(editor).getByTestId('behaviour-editor-save'));
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.subagents).toEqual([{ ...READER, toolNames: ['list_controls'] }]);
        expect(Object.keys(body.subagents[0]).sort()).toEqual(['instructions', 'maxTurns', 'name', 'skillRefs', 'toolNames']);
    });

    it('a sub-agent naming a tool the version no longer has is marked in place, and Save stays shut', async () => {
        // The starting version's sub-agent names a tool the version (and so
        // the editor's selection) does not hold.
        renderTab(view([version({ toolNames: ['list_risks'], subagents: [{ ...READER, toolNames: ['list_controls'] }] })]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        const editor = await screen.findByTestId('behaviour-editor');
        expect(within(editor).getByTestId('behaviour-subagent-0-outside').textContent).toContain('list_controls');
        expect((within(editor).getByTestId('behaviour-editor-save') as HTMLButtonElement).disabled).toBe(true);
    });

    it('offers at most four, and none beside a drawn flow', async () => {
        const four = ['a_one', 'b_two', 'c_three', 'd_four'].map((name) => ({ ...READER, name }));
        renderTab(view([version({ subagents: four })]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        await screen.findByTestId('behaviour-editor');
        expect((screen.getByTestId('behaviour-subagent-add') as HTMLButtonElement).disabled).toBe(true);
        cleanup();
        renderTab(view([version({ flow: FLOW_V1, toolNames: ['list_risks'] })]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        await screen.findByTestId('behaviour-editor');
        expect(screen.queryByTestId('behaviour-subagents')).toBeNull();
    });
});
