/**
 * THE PROPOSAL POINTS BACK AT THE STEP THAT PRODUCED IT.
 *
 * `AgentProposal.(runId, stepSeq)` exists, the writer fills it, the usecase
 * returns it and `AgentProposalsClient` renders a link out of it — the chain is
 * implemented end to end. What it did not have was a single test that ever
 * SUPPLIED a `runId`: every `ProposalRow` fixture in `tests/rendered` —
 * `proposal-diff`, `agent-proposal-guard-verdict`,
 * `agentic-permission-affordances` — sets `runId: null`, because none of them
 * is about provenance. So the whole conditional block was dead code as far as
 * the suite was concerned: deleting it left every test green, and the reviewer
 * silently lost the shortest path from "should I approve this" to the reasoning
 * that produced it.
 *
 * ── THE ANCHOR IS THE PART THAT CAN BE CONFIDENTLY WRONG ────────────────────
 *
 * The link is not `/agents/runs/{runId}` — it is `#step-{stepSeq}` on that
 * page, and the two surfaces number steps DIFFERENTLY ON PURPOSE:
 *
 *   · the fragment is the ZERO-based `stepSeq`, because the run timeline gives
 *     each row `id="step-{seq}"` and `seq` is what the driver recorded;
 *   · the LABEL says `stepSeq + 1`, because a person counting steps starts at
 *     one.
 *
 * An off-by-one in either direction still renders a link, still opens a page,
 * and lands on the wrong step or on nothing at all. So the fragment is not
 * asserted as a string here alone: the run timeline is rendered beside the
 * queue and the fragment is RESOLVED against the ids it actually emits. That is
 * the difference between "a link was rendered" and "a link reaches the row it
 * names" — the failure this repo keeps finding (#2774, #2783).
 *
 * ── AND ABSENCE IS AN ANSWER ────────────────────────────────────────────────
 *
 * A propose tool called outside a workflow has no run, and `runId` is NULL for
 * it legitimately. The negative cases below are what keep the fix from being "a
 * link is always rendered", which would invent a run for every direct MCP
 * proposal and hand the reviewer a dead end.
 */
import * as React from 'react';
import { render, screen, within, cleanup } from '@testing-library/react';

// next-intl is ESM (jest cannot parse it); resolve real `en.json` values
// through a MEMOISED `t` — a fresh `t` identity per render invalidates the
// label memos downstream and turns a render into a loop rather than a failure.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key
            .split('.')
            .reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en[ns],
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
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/agents/proposals',
    useSearchParams: () => new URLSearchParams(),
    notFound: () => {
        throw new Error('notFound() — the fixture should always resolve a run');
    },
}));

// ── The server half of the run page, for the second describe ────────────────
//
// `next-intl/server` is ESM with no manual mock in this repo (the checked-in
// `__mocks__/next-intl.js` covers the CLIENT entrypoint only), and the page is
// an async server component, so both its context read and its one data load are
// replaced here. The page's other imports — `getWorkflowDefinition`,
// `declaredStepFor`, `resolveStepTool`, `baseDataScopeForTool` — stay REAL:
// they are pure, and stubbing them would remove the derivations the projection
// is made of.
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

const getWorkflowRunMock = jest.fn();
jest.mock('@/app-layer/usecases/workflow-runs', () => ({
    __esModule: true,
    getWorkflowRun: (...a: unknown[]) => getWorkflowRunMock(...a),
}));

jest.mock('next-intl/server', () => ({
    __esModule: true,
    getTranslations: async () => (key: string) => key,
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import {
    AgentProposalsClient,
    type ProposalRow,
} from '@/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient';
import {
    AgentRunDetailClient,
    type RunStepRow,
    type RunHeader,
} from '@/app/t/[tenantSlug]/(app)/agents/runs/[runId]/AgentRunDetailClient';
import AgentRunDetailPage from '@/app/t/[tenantSlug]/(app)/agents/runs/[runId]/page';
import { computeProposalDiff } from '@/lib/agentic/proposal-diff';

/**
 * The catalogue string a key resolves to, read from `messages/en.json` the same
 * way the component's `useTranslations('agents')` does.
 *
 * Read through this rather than against literal text, and emphatically not
 * against the KEY PATH: next-intl renders a missing key as its own dotted path,
 * so asserting `'proposals.fromRunStep'` would pass only while the catalogue
 * was broken.
 */
function en(dotted: string, params: Record<string, unknown> = {}): string {
    const messages = require('../../messages/en.json') as Record<string, unknown>;
    const value = `agents.${dotted}`
        .split('.')
        .reduce<unknown>(
            (node, part) =>
                node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
            messages,
        );
    if (typeof value !== 'string') {
        throw new Error(`messages/en.json has no string at agents.${dotted}`);
    }
    return Object.entries(params).reduce(
        (s, [k, v]) => s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v)),
        value,
    );
}

const RUN_ID = 'run-1';

function row(overrides: Partial<ProposalRow> = {}): ProposalRow {
    return {
        id: 'p-1',
        kind: 'RISK',
        operation: 'CREATE',
        status: 'PENDING',
        targetEntityId: null,
        rationale: 'Observed three failed backups in the last quarter.',
        proposedViaKeyId: 'key-abcdef12',
        createdAt: '2026-09-01T10:00:00.000Z',
        runId: RUN_ID,
        stepSeq: 2,
        guardVerdict: 'CLEAN',
        guardRuleIds: [],
        guardInputDigest: 'sha256:0123456789abcdef0123456789abcdef',
        diff: computeProposalDiff({
            operation: 'CREATE',
            payloadJson: JSON.stringify({ title: 'Backup failure risk', impact: 8 }),
        }),
        ...overrides,
    };
}

function renderQueue(rows: ProposalRow[]) {
    return render(<AgentProposalsClient tenantSlug="acme" initialProposals={rows} canOperate />);
}

const RUN: RunHeader = {
    id: RUN_ID,
    workflowKey: 'nightly-review',
    workflowName: 'Nightly review',
    status: 'AWAITING_APPROVAL',
    driver: 'STATIC',
    stepCount: 3,
    costTokens: 1200,
    startedAt: '2026-09-01T10:00:00.000Z',
    completedAt: null,
    summary: null,
    errorMessage: null,
};

function runStep(over: Partial<RunStepRow> = {}): RunStepRow {
    return {
        id: `s-${over.seq ?? 0}`,
        seq: 0,
        kind: 'READ',
        status: 'DONE',
        tool: 'list_risks',
        scope: 'READ_TENANT_DATA',
        guardVerdict: null,
        guardRuleIds: [],
        costTokens: null,
        label: 'posture',
        at: '2026-09-01T10:00:05.000Z',
        actorUserId: null,
        inputJson: null,
        outputJson: null,
        decisionDigest: null,
        proposals: [],
        ...over,
    };
}

describe('a queued proposal links back to the run that produced it', () => {
    it('renders the backlink when the proposal names a run and a step', () => {
        renderQueue([row()]);

        const link = screen.getByTestId('proposal-run-link-p-1');
        expect(link.getAttribute('href')).toBe('/t/acme/agents/runs/run-1#step-2');
    });

    it('numbers the step for a PERSON (1-based) while the fragment stays 0-based', () => {
        // Both halves in one assertion, because they are the same off-by-one
        // seen from two sides and a test that pinned only one of them would go
        // green on a "fix" that broke the other. The label is what the reviewer
        // reads; the fragment is what the browser resolves.
        renderQueue([row({ stepSeq: 2 })]);

        const link = screen.getByTestId('proposal-run-link-p-1');
        expect({
            label: link.textContent,
            fragment: new URL(link.getAttribute('href')!, 'http://x').hash,
        }).toEqual({
            label: en('proposals.fromRunStep', { seq: 3 }),
            fragment: '#step-2',
        });
    });

    it('and that fragment RESOLVES to the step row the run timeline emits', () => {
        // The cross-surface claim, and the only one that can catch a link that
        // renders perfectly and lands nowhere. The two components number steps
        // independently — the queue from `stepSeq`, the timeline from `seq` —
        // so the fragment is checked against the ids the timeline ACTUALLY
        // renders rather than against the string this test would like them to
        // be. An off-by-one on either side leaves `getElementById` null.
        renderQueue([row({ stepSeq: 2 })]);
        const fragment = new URL(
            screen.getByTestId('proposal-run-link-p-1').getAttribute('href')!,
            'http://x',
        ).hash;
        cleanup();

        render(
            <AgentRunDetailClient
                tenantSlug="acme"
                run={RUN}
                steps={[
                    runStep({ seq: 0, id: 's-0', kind: 'READ' }),
                    runStep({ seq: 1, id: 's-1', kind: 'READ' }),
                    runStep({ seq: 2, id: 's-2', kind: 'PROPOSE', tool: 'propose_risks' }),
                ]}
            />,
        );

        const target = document.getElementById(fragment.slice(1));
        // Present AND the right row: `#step-2` existing is satisfied by a
        // timeline that gave every row the same id, so the row is identified
        // by the step it contains.
        expect(target).not.toBeNull();
        expect(within(target as HTMLElement).getByText('propose_risks')).toBeInTheDocument();
    });

    it('links to the RUN with no fragment when the proposal names no step', () => {
        // `stepSeq` can be NULL with a `runId` set — the CHECK only forbids the
        // reverse. A fragment built from `null` would read `#step-null` and
        // resolve to nothing.
        renderQueue([row({ stepSeq: null })]);

        const link = screen.getByTestId('proposal-run-link-p-1');
        expect({ href: link.getAttribute('href'), label: link.textContent }).toEqual({
            href: '/t/acme/agents/runs/run-1',
            label: en('proposals.fromRun'),
        });
    });

    it('renders NO backlink for a proposal made outside a run', () => {
        // The load-bearing negative. NULL here is a real answer — a propose
        // tool called outside a workflow genuinely has no step — and a link
        // rendered anyway would imply a run existed and was unreachable.
        renderQueue([row({ runId: null, stepSeq: null })]);

        expect(screen.queryByTestId('proposal-run-link-p-1')).toBeNull();
        // And the queue still rendered the proposal: without this, "no link"
        // is satisfied by a component that rendered nothing at all.
        expect(screen.getByTestId('proposal-rationale-p-1')).toBeInTheDocument();
    });
});

/**
 * ── THE SAME LINK, WALKED THE OTHER WAY ─────────────────────────────────────
 *
 * `getWorkflowRun` returns a run's proposals as ONE FLAT LIST at the run level
 * — it cannot do otherwise, because `WorkflowStep` and `AgentProposal` have no
 * relation between them; the pair `(runId, stepSeq)` is the only join and
 * `stepSeq` carries no foreign key. So the server component is where the flat
 * list becomes per-step lists, and `AgentRunDetailClient` is handed the result
 * already grouped.
 *
 * `tests/rendered/agent-run-timeline.test.tsx` covers the client half well —
 * including that a proposal lands on ITS OWN step rather than the first. What
 * it cannot cover is the grouping itself: it constructs `RunStepRow.proposals`
 * by hand, so a page that put every proposal on step 0, or dropped them
 * entirely, leaves that file fully green.
 *
 * Which makes these the assertions over the seam: the usecase's output goes in
 * flat, and what comes out is read off the RENDERED timeline.
 */
describe('the run page groups a flat proposal list onto the steps that made them', () => {
    /** A `WorkflowStep` row as `getWorkflowRun` returns it. */
    const dbStep = (seq: number, kind: string, toolCalled: string | null) => ({
        id: `s-${seq}`,
        seq,
        kind,
        status: 'DONE',
        toolCalled,
        guardVerdict: null,
        guardRuleIds: [],
        costTokens: null,
        at: new Date('2026-09-01T10:00:05.000Z'),
        actorUserId: null,
        inputJson: null,
        outputJson: null,
    });

    /** An `AgentProposal` as the usecase's explicit select returns it. */
    const dbProposal = (id: string, stepSeq: number | null) => ({
        id,
        kind: 'RISK',
        operation: 'CREATE',
        status: 'PENDING',
        stepSeq,
        guardVerdict: 'CLEAN',
        createdAt: new Date('2026-09-01T10:00:06.000Z'),
    });

    async function mountRunPage(proposals: ReturnType<typeof dbProposal>[]) {
        getTenantCtxMock.mockResolvedValue({
            tenantId: 't-acme',
            tenantSlug: 'acme',
            appPermissions: { admin: { view: true } },
        });
        getWorkflowRunMock.mockResolvedValue({
            id: RUN_ID,
            // Deliberately not a registered key: `getWorkflowDefinition` then
            // answers undefined, which is the FLUE shape — a run whose `seq` is
            // a counter of steps recorded and indexes no declared array. The
            // grouping must not depend on a definition being available.
            workflowKey: 'unregistered-for-this-test',
            status: 'AWAITING_APPROVAL',
            driver: 'STATIC',
            stepCount: 4,
            costTokens: 1200,
            startedAt: new Date('2026-09-01T10:00:00.000Z'),
            completedAt: null,
            summary: null,
            errorMessage: null,
            steps: [
                dbStep(0, 'READ', 'list_risks'),
                dbStep(1, 'PROPOSE', 'propose_risks'),
                dbStep(2, 'READ', 'list_controls'),
                dbStep(3, 'PROPOSE', 'propose_controls'),
            ],
            proposals,
        });

        const element = await AgentRunDetailPage({
            params: Promise.resolve({ tenantSlug: 'acme', runId: RUN_ID }),
        });
        render(<>{element}</>);
    }

    /** The proposal testids rendered inside one step row, in DOM order. */
    const proposalsOn = (seq: number): string[] =>
        Array.from(
            (document.getElementById(`step-${seq}`) as HTMLElement).querySelectorAll(
                '[data-testid^="step-proposal-"]',
            ),
        ).map((el) => el.getAttribute('data-testid')!);

    afterEach(() => {
        getTenantCtxMock.mockReset();
        getWorkflowRunMock.mockReset();
    });

    it('puts each proposal on its OWN step, with two propose steps to tell them apart', async () => {
        // TWO propose steps and THREE proposals, deliberately: a grouping that
        // collapsed onto the first step, or that used `find` instead of a
        // group, or that attached the whole list to every step, is green on any
        // fixture with one propose step and one proposal. The middle step
        // legitimately queued two — one `buildItems` can — which is the case a
        // `Map<seq, one>` would silently drop.
        await mountRunPage([
            dbProposal('p-a', 1),
            dbProposal('p-b', 1),
            dbProposal('p-c', 3),
        ]);

        expect({
            step0: proposalsOn(0),
            step1: proposalsOn(1),
            step2: proposalsOn(2),
            step3: proposalsOn(3),
        }).toEqual({
            step0: [],
            step1: ['step-proposal-p-a', 'step-proposal-p-b'],
            step2: [],
            step3: ['step-proposal-p-c'],
        });
    });

    it('attaches a run-level proposal — one naming no step — to no step at all', async () => {
        // `stepSeq` is NULL for a proposal made outside a step, and the usecase
        // orders `stepSeq` ASC so NULL sorts FIRST — it is the row a grouping
        // that read the head of the list would attach to everything.
        await mountRunPage([dbProposal('p-null', null), dbProposal('p-c', 3)]);

        expect({
            step0: proposalsOn(0),
            step1: proposalsOn(1),
            step2: proposalsOn(2),
            step3: proposalsOn(3),
        }).toEqual({
            step0: [],
            step1: [],
            step2: [],
            step3: ['step-proposal-p-c'],
        });
    });
});
