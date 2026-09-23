/**
 * The run's step ledger, on a surface a person can open.
 *
 * `getWorkflowRun` has always returned the run WITH its ordered steps, and the
 * API route has always served them — its docstring calls the result "a single
 * run with its ordered step timeline". Nothing read it. The ledger the engine
 * writes on every step was reachable by curl and by nothing else.
 *
 * ── WHAT THIS FILE PINS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
 *
 * It pins ORDER, the per-step status axis, and that payloads are rendered as
 * inert text behind a disclosure. It does NOT assert anything about
 * `MODEL_CALL` or `TOOL_CALL` steps: no driver writes them — `recordStep`'s
 * kind parameter is typed to the other four and `DRIVER_IMPLEMENTED.flue` is
 * false — so a test asserting they appear would be asserting against data no
 * writer in the product can produce. The switch renders them if they ever
 * arrive; that is a readiness claim, not a tested one, and saying so here is
 * cheaper than a green test that proves nothing.
 */
import { render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/runs/run-1',
    useSearchParams: () => new URLSearchParams(),
}));

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

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import {
    AgentRunDetailClient,
    type RunStepRow,
    type RunHeader,
} from '@/app/t/[tenantSlug]/(app)/agents/runs/[runId]/AgentRunDetailClient';

const EN = jest.requireActual('../../messages/en.json') as {
    agents: {
        runs: {
            detail: {
                kind: Record<string, string>;
                scope: Record<string, string>;
                guard: Record<string, string>;
                stepTokens: string;
                inputLabel: string;
                outputLabel: string;
                decisionLink: string;
                emptyTitle: string;
            };
        };
    };
};
const D = EN.agents.runs.detail;

const RUN: RunHeader = {
    id: 'run-1',
    workflowKey: 'nightly-review',
    workflowName: 'Nightly review',
    status: 'COMPLETED',
    driver: 'STATIC',
    stepCount: 3,
    costTokens: 1200,
    startedAt: '2026-09-01T10:00:00.000Z',
    completedAt: '2026-09-01T10:04:00.000Z',
    summary: null,
    errorMessage: null,
};

function step(over: Partial<RunStepRow> = {}): RunStepRow {
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

function renderDetail(steps: RunStepRow[], run: RunHeader = RUN) {
    return render(<AgentRunDetailClient tenantSlug="acme" run={run} steps={steps} />);
}

describe('the run detail renders the step ledger', () => {
    it('renders every step, in seq order', () => {
        // Order is the claim a ledger makes. Asserting presence alone would
        // pass a component that rendered them sorted by id or by status.
        // The statuses are chosen so that ANY re-sort visibly disagrees with
        // seq order: alphabetically they are DONE(1), FAILED(2), SKIPPED(0),
        // so a component sorting by status yields 1,2,0. A fixture where every
        // step shared one status would make a re-sort a no-op and this
        // assertion would pass against a component that had stopped preserving
        // order at all — which is exactly what the first draft did.
        renderDetail([
            step({ seq: 0, id: 's-0', kind: 'READ', status: 'SKIPPED' }),
            step({ seq: 1, id: 's-1', kind: 'PROPOSE', status: 'DONE' }),
            step({ seq: 2, id: 's-2', kind: 'SYNTHESIS', status: 'FAILED' }),
        ]);

        // Scoped to the timeline's own id: `EntityDetailLayout` renders the
        // breadcrumb trail as an <ol> too, and a bare `ol > li` counts those.
        const items = Array.from(
            document.querySelectorAll('#run-step-timeline > li'),
        ).map((el) => el.id);
        expect(items).toEqual(['step-0', 'step-1', 'step-2']);
    });

    it('labels each step with ITS OWN kind', () => {
        renderDetail([
            step({ seq: 0, id: 's-0', kind: 'READ' }),
            step({ seq: 1, id: 's-1', kind: 'HUMAN_CHECKPOINT', tool: null, label: 'review' }),
        ]);

        const first = document.getElementById('step-0') as HTMLElement;
        const second = document.getElementById('step-1') as HTMLElement;
        expect(within(first).getByText(D.kind.READ)).toBeInTheDocument();
        expect(within(second).getByText(D.kind.HUMAN_CHECKPOINT)).toBeInTheDocument();
        expect(within(second).queryByText(D.kind.READ)).toBeNull();
    });

    it('shows the STEP status, which is a different axis from the run status', () => {
        // A step is PENDING while the run is AWAITING_APPROVAL. Collapsing the
        // two would make the checkpoint that is waiting look like the run that
        // is, which is the one thing this page is opened to disentangle.
        renderDetail(
            [step({ seq: 0, id: 's-0', kind: 'HUMAN_CHECKPOINT', status: 'PENDING', tool: null })],
            { ...RUN, status: 'AWAITING_APPROVAL' },
        );

        const row = document.getElementById('step-0') as HTMLElement;
        expect(within(row).getByText('PENDING')).toBeInTheDocument();
    });

    it('renders a payload as INERT TEXT behind a disclosure', () => {
        // Step payloads are decrypted, agent-authored tenant content. They are
        // escaped by React and never interpreted; the disclosure keeps a long
        // blob from burying the ledger.
        const injected = '{"note":"<img src=x onerror=alert(1)>"}';
        renderDetail([step({ seq: 0, id: 's-0', outputJson: injected })]);

        const row = document.getElementById('step-0') as HTMLElement;
        expect(within(row).getByText(D.outputLabel)).toBeInTheDocument();
        expect(within(row).getByText(injected)).toBeInTheDocument();
        // The decisive half: escaped, not parsed into a live element.
        expect(row.querySelector('img')).toBeNull();
    });

    it('omits the payload disclosure entirely when there is none', () => {
        // A SYNTHESIS has no input; a checkpoint has neither. An empty
        // disclosure would invite a reader to open nothing.
        renderDetail([step({ seq: 0, id: 's-0', inputJson: null, outputJson: null })]);
        const row = document.getElementById('step-0') as HTMLElement;
        expect(within(row).queryByText(D.inputLabel)).toBeNull();
        expect(within(row).queryByText(D.outputLabel)).toBeNull();
    });

    it('renders the tool the projection resolved, including on a failed step', () => {
        // The server projection falls back to the definition when a failed step
        // recorded no tool (see `resolveStepTool`). What this asserts is the
        // client half: whatever the projection resolved is actually shown.
        renderDetail([
            step({ seq: 0, id: 's-0', status: 'FAILED', tool: 'get_compliance_posture' }),
        ]);
        const row = document.getElementById('step-0') as HTMLElement;
        expect(within(row).getByText('get_compliance_posture')).toBeInTheDocument();
        expect(within(row).getByText('FAILED')).toBeInTheDocument();
    });

    it('says so when a run recorded no steps at all', () => {
        renderDetail([]);
        expect(screen.getByText(D.emptyTitle)).toBeInTheDocument();
        expect(document.getElementById('run-step-timeline')).toBeNull();
    });

    it('surfaces the run error where a failed run needs explaining', () => {
        renderDetail([step({ seq: 0, id: 's-0', status: 'FAILED' })], {
            ...RUN,
            status: 'FAILED',
            errorMessage: 'run_action_cap_exceeded',
        });
        expect(screen.getByText('run_action_cap_exceeded')).toBeInTheDocument();
    });
});

/**
 * The step ⟷ proposal link, on the run side.
 *
 * A PROPOSE step's own payload records `{"count": N}` and NOT the items — the
 * driver deliberately keeps proposed content off the step row. So without this
 * list the ledger says a propose happened and says nothing whatever about what
 * it proposed, which is the half a reviewer needs.
 */
describe('a step names the proposals it queued', () => {
    it('renders one link per proposal the step produced', () => {
        // SEVERAL, not one: a single `buildItems` can queue many, which is
        // precisely why `AgentProposal.stepSeq` carries no unique constraint.
        // A renderer that showed only the first would pass a single-item test.
        renderDetail([
            step({
                seq: 0,
                id: 's-0',
                kind: 'PROPOSE',
                proposals: [
                    { id: 'p-1', kind: 'RISK', status: 'PENDING', guardVerdict: 'CLEAN' },
                    { id: 'p-2', kind: 'RISK', status: 'PENDING', guardVerdict: 'CLEAN' },
                ],
            }),
        ]);

        const row = document.getElementById('step-0') as HTMLElement;
        expect(within(row).getByTestId('step-proposal-p-1')).toBeInTheDocument();
        expect(within(row).getByTestId('step-proposal-p-2')).toBeInTheDocument();
    });

    it('links each proposal to its anchor on the proposals queue', () => {
        renderDetail([
            step({
                seq: 0,
                id: 's-0',
                kind: 'PROPOSE',
                proposals: [{ id: 'p-1', kind: 'RISK', status: 'PENDING', guardVerdict: 'CLEAN' }],
            }),
        ]);

        const link = screen.getByTestId('step-proposal-p-1');
        expect(link.getAttribute('href')).toBe('/t/acme/agents/proposals#proposal-p-1');
    });

    it('renders NOTHING for a step that queued none', () => {
        // A READ step has no proposals and must not grow an empty list — an
        // empty affordance reads as "none yet" where the truth is "never any".
        renderDetail([step({ seq: 0, id: 's-0', kind: 'READ', proposals: [] })]);
        const row = document.getElementById('step-0') as HTMLElement;
        expect(within(row).queryByTestId(/step-proposal-/)).toBeNull();
        expect(row.querySelector('ul')).toBeNull();
    });

    it('attaches each proposal to ITS OWN step, not to the first', () => {
        // The grouping assertion. A projection that put every proposal on
        // step 0 — or that used `find` instead of a group — passes all three
        // cases above.
        renderDetail([
            step({
                seq: 0,
                id: 's-0',
                kind: 'READ',
                proposals: [],
            }),
            step({
                seq: 1,
                id: 's-1',
                kind: 'PROPOSE',
                proposals: [{ id: 'p-9', kind: 'RISK', status: 'PENDING', guardVerdict: 'CLEAN' }],
            }),
        ]);

        const first = document.getElementById('step-0') as HTMLElement;
        const second = document.getElementById('step-1') as HTMLElement;
        expect(within(first).queryByTestId('step-proposal-p-9')).toBeNull();
        expect(within(second).getByTestId('step-proposal-p-9')).toBeInTheDocument();
    });

    it('shows the data rung beside the tool that reaches it', () => {
        // The chip an assessor reads to answer "what did this step touch".
        // Asserted against the REAL catalogue string from `en.json`, not a
        // literal retyped here — a test that restates the copy passes when
        // the copy and the key drift apart.
        renderDetail([step({ seq: 0, tool: 'list_risks', scope: 'READ_TENANT_DATA' })]);
        expect(screen.getByText(D.scope.READ_TENANT_DATA)).toBeInTheDocument();
    });

    it('shows NO rung for a step that reaches no tool', () => {
        // A checkpoint evaluates no rung. Rendering one would claim an
        // evaluation that never happened — the absence is the assertion.
        renderDetail([step({ seq: 0, kind: 'HUMAN_CHECKPOINT', tool: null, scope: null })]);
        expect(screen.queryByText(D.scope.READ_TENANT_DATA)).not.toBeInTheDocument();
        expect(screen.queryByText(D.scope.NONE)).not.toBeInTheDocument();
    });

    it('renders the rung each step carries, not one rung for the whole run', () => {
        // Two steps, two different rungs. A single shared chip — or one read
        // off the run rather than the step — passes every assertion above and
        // fails this one.
        renderDetail([
            step({ seq: 0, tool: 'list_risks', scope: 'READ_TENANT_DATA' }),
            step({ seq: 1, tool: 'get_counts', scope: 'READ_METADATA' }),
        ]);
        expect(screen.getByText(D.scope.READ_TENANT_DATA)).toBeInTheDocument();
        expect(screen.getByText(D.scope.READ_METADATA)).toBeInTheDocument();
    });

    it('shows the guard verdict on a step that was scanned', () => {
        renderDetail([step({ seq: 0, guardVerdict: 'FLAGGED', guardRuleIds: ['inj.001'] })]);
        expect(screen.getByText(D.guard.FLAGGED)).toBeInTheDocument();
    });

    it('shows NO verdict on a step no guard ran on', () => {
        // The load-bearing absence. A step with no verdict was never scanned,
        // and a chip reading "clean" there would tell a reviewer the guard
        // looked at something it never examined. CLEAN and NULL are different
        // facts and the row must not merge them.
        renderDetail([step({ seq: 0, kind: 'HUMAN_CHECKPOINT', guardVerdict: null })]);
        expect(screen.queryByText(D.guard.CLEAN)).not.toBeInTheDocument();
        expect(screen.queryByText(D.guard.FLAGGED)).not.toBeInTheDocument();
    });

    it('shows which rules fired, as text an assessor can read without hovering', () => {
        renderDetail([
            step({ seq: 0, guardVerdict: 'QUARANTINED', guardRuleIds: ['egress.pii', 'inj.002'] }),
        ]);
        // Visible text, not a hover attribute — see the component comment.
        expect(screen.getByText('egress.pii, inj.002')).toBeInTheDocument();
    });

    it('shows what a step spent, including a genuine zero', () => {
        // `0` is a real measurement — a model call the runtime reported no
        // usage for. A truthiness test would hide exactly that row, which is
        // the one worth asking about.
        renderDetail([step({ seq: 0, kind: 'MODEL_CALL', costTokens: 0 })]);
        expect(screen.getByText(EN.agents.runs.detail.stepTokens.replace('{count}', '0')))
            .toBeInTheDocument();
    });

    it('shows no per-step cost on a step that spent nothing measurable', () => {
        renderDetail([step({ seq: 0, costTokens: null })]);
        expect(
            screen.queryByText(EN.agents.runs.detail.stepTokens.replace('{count}', '0')),
        ).not.toBeInTheDocument();
    });
});

describe('a step reaches the Art 12 decision it produced', () => {
    const DIGEST = `sha256:${'a1b2c3d4'.repeat(8)}`;
    const href = (d: string) => `/t/acme/agents/decisions?digest=${encodeURIComponent(d)}`;

    it('a MODEL_CALL step links to its decision row', () => {
        renderDetail([step({ seq: 0, kind: 'MODEL_CALL', decisionDigest: DIGEST })]);
        const link = document.querySelector(`a[href="${href(DIGEST)}"]`);
        expect(link).not.toBeNull();
        expect(link?.textContent).toBe(EN.agents.runs.detail.decisionLink);
    });

    it('carries THAT step’s digest, not a shared one', () => {
        // The assertion with teeth. A link built once outside the row, or
        // keyed off anything but the step, renders correctly for one step and
        // sends every other reviewer to somebody else’s decision — which is
        // worse than no link, because it is confidently wrong.
        const other = `sha256:${'f0f0f0f0'.repeat(8)}`;
        renderDetail([
            step({ seq: 0, kind: 'MODEL_CALL', decisionDigest: DIGEST }),
            step({ seq: 1, kind: 'MODEL_CALL', decisionDigest: other }),
        ]);
        expect(document.querySelector(`a[href="${href(DIGEST)}"]`)).not.toBeNull();
        expect(document.querySelector(`a[href="${href(other)}"]`)).not.toBeNull();
    });

    it('a TOOL_CALL step offers NO link, even with a guard verdict', () => {
        // The half that must not over-reach. A tool call is guarded and has no
        // Art 12 row; linking it would land the reviewer on an empty table.
        renderDetail([
            step({ seq: 0, kind: 'TOOL_CALL', guardVerdict: 'FLAGGED', decisionDigest: null }),
        ]);
        expect(document.querySelector('a[href*="/agents/decisions"]')).toBeNull();
    });

    it('and a static-driver step offers none either', () => {
        // Every pre-existing run has no digest. The link must be absent rather
        // than pointing at a query that matches nothing.
        renderDetail([step({ seq: 0, kind: 'READ', decisionDigest: null })]);
        expect(document.querySelector('a[href*="/agents/decisions"]')).toBeNull();
    });
});
