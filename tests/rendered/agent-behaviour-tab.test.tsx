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
 *   • the skills picker shows the chosen skills' catalogue bytes against the
 *     per-run budget, from the server's figures, and a refusal on that budget,
 *     at save or at approval, is worded by the tab from its figures (#4523).
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
        skillRefs: [],
        modelTier: 'balanced',
        effort: 'medium',
        maxTurns: 10,
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
        limits: { instructionsMaxChars: 16_000, maxTurns: 50, rejectionReasonMaxChars: 1_000, skillCatalogueBudgetBytes: 2_048 },
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

describe('the catalogue budget (#4523)', () => {
    const SKILLS: ProfileView['options']['skills'] = [
        { origin: 'repository', name: 'alpha-skill', catalogueBytes: 900 },
        { origin: 'repository', name: 'beta-skill', catalogueBytes: 1_000 },
        { origin: 'tenant', name: 'gamma-skill', catalogueBytes: 200 },
    ];
    const withSkills = (versions: ProfileVersionView[]) => view(versions, { options: { tools: ['list_risks'], skills: SKILLS } });
    const ALPHA_BETA = [
        { origin: 'repository' as const, name: 'alpha-skill' },
        { origin: 'repository' as const, name: 'beta-skill' },
    ];
    /** The server's English sentence, which the tab must not show for this refusal. */
    const SERVER_SENTENCE = 'These skills put 2049 bytes in every prompt of a run, over the 2048-byte budget.';
    const overBudget = (status = 400) => ({
        ok: false,
        status,
        json: async () => ({
            error: {
                code: 'BAD_REQUEST',
                message: SERVER_SENTENCE,
                details: { reason: 'SKILL_CATALOGUE_OVER_BUDGET', catalogueBytes: 2_049, budgetBytes: 2_048 },
            },
        }),
    });
    const TRANSLATED = copy('refusal.SKILL_CATALOGUE_OVER_BUDGET', { used: 2_049, budget: 2_048 });

    it('the picker shows the chosen skills\' bytes against the budget, from the server\'s figures, and says when they are over', async () => {
        const user = userEvent.setup();
        renderTab(withSkills([version({ skillRefs: ALPHA_BETA })]));
        await user.click(screen.getByTestId('behaviour-write'));
        await screen.findByTestId('behaviour-editor');
        expect(screen.getByTestId('behaviour-editor-catalogue').textContent).toBe(copy('editor.catalogue', { used: 1_900, budget: 2_048 }));

        await user.click(document.getElementById('behaviour-skills') as HTMLElement);
        const listbox = await screen.findByRole('listbox');
        await user.click(within(listbox).getByRole('option', { name: copy('editor.skillOption.tenant', { name: 'gamma-skill' }) }));
        expect(screen.getByTestId('behaviour-editor-catalogue').textContent).toBe(
            copy('editor.catalogueOver', { used: 2_100, budget: 2_048 }),
        );
        // The total informs; the save decides. Save is not held back on it.
        expect((screen.getByTestId('behaviour-editor-save') as HTMLButtonElement).disabled).toBe(false);
    });

    it('a save refused on the budget is worded from its figures, beside the skills, and posts only names', async () => {
        renderTab(withSkills([version({ skillRefs: ALPHA_BETA })]));
        fireEvent.click(screen.getByTestId('behaviour-write'));
        const editor = await screen.findByTestId('behaviour-editor');
        fetchMock.mockResolvedValue(overBudget());
        await act(async () => {
            fireEvent.click(within(editor).getByTestId('behaviour-editor-save'));
        });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).skillRefs).toEqual(ALPHA_BETA);
        expect(document.getElementById('behaviour-skills-error')?.textContent).toBe(TRANSLATED);
        expect(TRANSLATED).toContain('2049');
        expect(TRANSLATED).toContain('2048');
        expect(screen.queryByText(SERVER_SENTENCE)).toBeNull();
        expect(screen.queryByTestId('behaviour-editor-error')).toBeNull();
        expect(toastError).toHaveBeenCalledWith(TRANSLATED);
    });

    it('an approval refused on the budget is worded from its figures', async () => {
        renderTab(withSkills([SUBMITTED({ skillRefs: ALPHA_BETA }), version()]));
        fetchMock.mockResolvedValue(overBudget());
        await act(async () => {
            fireEvent.click(screen.getByTestId('behaviour-approve'));
        });
        expect(screen.getByTestId('behaviour-act-error').textContent).toBe(TRANSLATED);
        expect(screen.queryByText(SERVER_SENTENCE)).toBeNull();
    });

    it('the Bulgarian catalogue words the same figures', () => {
        const BG = jest.requireActual('../../messages/bg.json') as { agents: { behaviour: Record<string, Record<string, string>> } };
        const texts = [
            BG.agents.behaviour.refusal.SKILL_CATALOGUE_OVER_BUDGET,
            BG.agents.behaviour.editor.catalogue,
            BG.agents.behaviour.editor.catalogueOver,
        ];
        expect(texts.every((text) => typeof text === 'string' && text.length > 0)).toBe(true);
        expect(texts.filter((text) => !text.includes('{used}') || !text.includes('{budget}'))).toEqual([]);
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
