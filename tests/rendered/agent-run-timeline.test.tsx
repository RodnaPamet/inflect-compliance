/**
 * The run's step ledger, on a surface a person can open.
 *
 * `getWorkflowRun` has always returned the run WITH its ordered steps, and the
 * API route has always served them — its docstring calls the result "a single
 * run with its ordered step timeline". Nothing read it. The ledger the engine
 * writes on every step was reachable by curl and by nothing else.
 *
 * ── WHAT THIS FILE PINS ─────────────────────────────────────────────
 *
 * It pins ORDER, the per-step status axis, that payloads are rendered as inert
 * text behind a disclosure, and — since the Flue driver shipped — what each of
 * the two RECORD-ONLY kinds is allowed to claim about itself.
 *
 * That last half used to be absent on purpose, and the note saying so had
 * rotted through BOTH of its premises. It read: "no driver writes them —
 * `recordStep`'s kind parameter is typed to the other four and
 * `DRIVER_IMPLEMENTED.flue` is false". Both have flipped. `recordStep` takes
 * the full `WorkflowStepKind` enum and says so at its own signature,
 * `DRIVER_IMPLEMENTED.flue` is `true`, and `src/lib/agentic/flue/execute.ts`
 * records a `MODEL_CALL` per dispatch and a `TOOL_CALL` per tool invocation.
 * A readiness claim that has become a shipped path is just an untested path,
 * so the last describe block below tests it.
 */
import { render, screen, within, fireEvent } from '@testing-library/react';

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
                skillVersion: string;
                skillsNone: string;
                skillsNotRecorded: string;
                stepStatus: Record<string, string>;
                proposalStatus: Record<string, string>;
            };
            status: Record<string, string>;
        };
        proposals: { kind: Record<string, string> };
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
    parentExecutionId: null,
    mountedSkills: null,
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
        // #3473 part 3 — null for every step that is not a delegation, which
        // is every step in these fixtures.
        delegation: null,
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
        // In words, not the stored code (#4532).
        expect(within(row).getByText(D.stepStatus.PENDING)).toBeInTheDocument();
        expect(within(row).queryByText('PENDING')).toBeNull();
    });

    it('names every step status, and shows one this build does not know as stored (#4532)', () => {
        const statuses = ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED'];
        renderDetail([
            ...statuses.map((status, i) => step({ seq: i, id: `s-${i}`, status })),
            step({ seq: 9, id: 's-9', status: 'PARKED' }),
        ]);
        statuses.forEach((status, i) => {
            const row = document.getElementById(`step-${i}`) as HTMLElement;
            expect(within(row).getByText(D.stepStatus[status])).toBeInTheDocument();
            expect(within(row).queryByText(status)).toBeNull();
        });
        expect(within(document.getElementById('step-9') as HTMLElement).getByText('PARKED')).toBeInTheDocument();
    });

    it('the meta strip names the run status in words (#4532)', () => {
        renderDetail([step({ seq: 0, id: 's-0' })], { ...RUN, status: 'AWAITING_APPROVAL' });
        expect(screen.getAllByText(EN.agents.runs.status.AWAITING_APPROVAL).length).toBeGreaterThan(0);
        expect(screen.queryByText('AWAITING_APPROVAL')).toBeNull();
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
        expect(within(row).getByText(D.stepStatus.FAILED)).toBeInTheDocument();
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

    it('names a proposal’s kind and status in words, as the queue does (#4532)', () => {
        renderDetail([
            step({
                seq: 0,
                id: 's-0',
                kind: 'PROPOSE',
                proposals: [
                    { id: 'p-1', kind: 'EXTERNAL_WRITE', status: 'EDITED', guardVerdict: 'CLEAN' },
                    { id: 'p-2', kind: 'NEW_KIND', status: 'NEW_STATUS', guardVerdict: 'CLEAN' },
                ],
            }),
        ]);
        expect(screen.getByTestId('step-proposal-p-1')).toHaveTextContent(
            `${EN.agents.proposals.kind.EXTERNAL_WRITE} · ${D.proposalStatus.EDITED}`,
        );
        // A kind or status this build does not know is shown as stored.
        expect(screen.getByTestId('step-proposal-p-2')).toHaveTextContent('NEW_KIND · NEW_STATUS');
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

/**
 * THE TWO RECORD-ONLY KINDS, AND WHAT EACH ROW MAY CLAIM ABOUT ITSELF.
 *
 * ── THE AFFORDANCES ARE DATA-DRIVEN, AND THAT IS THE RIGHT DESIGN ───────────
 *
 * The plan asks that the timeline give the two kinds "distinct affordances —
 * model calls show token cost, tool calls show args and result". The component
 * contains no switch on `kind` that does any of that, and should not grow one.
 * Every chip is gated on the FIELD it renders: the token chip on
 * `costTokens != null`, the tool and rung chips on `tool`/`scope`, the two
 * payload disclosures on `inputJson`/`outputJson`. `kind` is rendered as a
 * label and decides nothing else.
 *
 * The distinctness is real all the same, because it comes from the WRITER. In
 * `flue/execute.ts` a `MODEL_CALL` is recorded with `tokens` and no
 * `toolCalled`; a `TOOL_CALL` is recorded with `toolCalled`, the arguments the
 * model chose as `input`, and no `tokens`. Two kinds, two shapes, one
 * renderer — and the rows come out looking different without anyone writing a
 * switch.
 *
 * Gating on the data is also the only version that stays honest: a step of
 * some other kind that really did spend tokens should show them, and a kind
 * switch would hide exactly that row. So what is pinned below is the OUTCOME
 * the bullet asks for — given the rows the writer produces, the two kinds look
 * different and neither claims the other's facts — plus the gate itself, so
 * that nobody "fixes" it into a switch on kind and calls that the feature.
 *
 * ── ONE THING THE BULLET OVERSTATES ─────────────────────────────────────────
 *
 * "tool calls show args and result" is true of the args and half true of the
 * result. The DONE arm records `input: context.data` and NO output — the
 * tool's return value is tenant content, already guarded on its way back
 * through the adapter, and the write site declines to copy it into the ledger
 * a second time. The FAILED arm records the error as `output`. So the
 * renderer's job is to show a result WHERE THERE IS ONE, which is what the
 * data-gated disclosure does and what the failed-call test pins. Symmetrically
 * a MODEL_CALL does carry an `input` — its usage counters and the Art 12
 * digest — so the honest claim about that row is that it shows no RESULT, not
 * that it shows no payload at all.
 *
 * ── WHY THIS MATTERS MORE HERE THAN ANYWHERE ELSE ON THE PAGE ───────────────
 *
 * #2774: Flue steps inherited an unrelated step's tool and rung, because the
 * projection indexed `def.steps[s.seq]` and a Flue `seq` counts steps RECORDED
 * rather than indexing the definition. A MODEL_CALL wore another step's tool
 * name and a data-access claim about content it never touched — on a
 * governance surface, a specific false statement about what an agent did.
 * `declaredStepFor` carries the server-side rule and
 * `tests/unit/run-step-view.test.ts` pins it. What follows is the CLIENT half
 * of the same class: a row must render the tool and the rung of the step it
 * IS. Every test here therefore renders SEVERAL steps, because one row cannot
 * tell "its own tool" apart from "the first step's tool" or from a constant.
 */
describe('the two Flue step kinds claim only what they did', () => {
    // `label: null` on every tool fixture below, and that is load-bearing
    // rather than lazy. The driver records a TOOL_CALL's label AS the tool
    // name, so a fixture carrying both would print the string twice and an
    // assertion that the string is present would stay green with the chip
    // deleted — the label alone would satisfy it. One occurrence means the
    // absence is detectable, which is the whole point of the assertion.
    const toolStep = (seq: number, tool: string, scope: string) =>
        step({ seq, kind: 'TOOL_CALL', tool, scope, label: null });

    it('each tool call names ITS OWN tool and rung, not a neighbour’s', () => {
        renderDetail([
            toolStep(0, 'list_risks', 'READ_TENANT_DATA'),
            toolStep(1, 'get_counts', 'READ_METADATA'),
            toolStep(2, 'propose_risk', 'WRITE_TENANT_DATA'),
        ]);

        const tools = ['list_risks', 'get_counts', 'propose_risk'];
        const rungs = [D.scope.READ_TENANT_DATA, D.scope.READ_METADATA, D.scope.WRITE_TENANT_DATA];

        tools.forEach((tool, i) => {
            const row = document.getElementById(`step-${i}`) as HTMLElement;
            expect(within(row).getByText(tool)).toBeInTheDocument();
            expect(within(row).getByText(rungs[i])).toBeInTheDocument();
            // The half with teeth. A chip built from `steps[0]`, or hoisted
            // out of the map, or read off the run, renders correctly in
            // exactly one row and wrongly in the rest — and a single-step
            // test cannot tell the two apart.
            for (let j = 0; j < tools.length; j++) {
                if (j === i) continue;
                expect(within(row).queryByText(tools[j])).toBeNull();
                expect(within(row).queryByText(rungs[j])).toBeNull();
            }
        });
    });

    it('a model call between two tool calls claims neither tool nor rung', () => {
        // The #2774 shape exactly: the bug put a neighbouring step's tool —
        // and the data-access claim derived from that tool — onto a MODEL_CALL
        // row. Sandwiched between two tool calls on purpose, so a renderer
        // reaching either forwards or backwards is caught.
        renderDetail([
            toolStep(0, 'list_risks', 'READ_TENANT_DATA'),
            step({ seq: 1, kind: 'MODEL_CALL', tool: null, scope: null, label: null, costTokens: 812 }),
            toolStep(2, 'propose_risk', 'WRITE_TENANT_DATA'),
        ]);

        const model = document.getElementById('step-1') as HTMLElement;
        expect(within(model).getByText(D.kind.MODEL_CALL)).toBeInTheDocument();
        expect(within(model).getByText(D.stepTokens.replace('{count}', '812'))).toBeInTheDocument();
        expect(within(model).queryByText('list_risks')).toBeNull();
        expect(within(model).queryByText('propose_risk')).toBeNull();

        // Swept over EVERY rung the catalogue can render, not just the two in
        // the fixture: the claim is that this row evaluated no rung AT ALL,
        // and naming two of five would leave three ways to be wrong.
        const rungs = Object.values(D.scope);
        // An empty sweep is a vacuous pass, so the denominator is asserted too.
        expect(rungs.length).toBeGreaterThanOrEqual(3);
        for (const rung of rungs) {
            expect(within(model).queryByText(rung)).toBeNull();
        }
    });

    it('the two kinds look different because they carry different data', () => {
        // Both fixtures are the shapes `flue/execute.ts` actually writes: a
        // MODEL_CALL with `tokens` and no `toolCalled`, a TOOL_CALL with
        // `toolCalled`, the args the model chose as its input, and no tokens.
        //
        // AND NO OUTPUT ON THE SUCCESSFUL ONE. This fixture used to carry
        // `outputJson: '[{"id":"r-1"}]'` and assert the result panel rendered,
        // directly under the sentence above claiming it was the shape the
        // engine writes. It is not: `wrapForLedger`'s DONE arm passes
        // `toolCalled/status/label/guardVerdict/guardRuleIds/input` and no
        // `output` at all (execute.ts), and `step-recorder` writes
        // `outputJson` only when `output !== undefined` — so a Flue tool call
        // that SUCCEEDS always stores null there. Only the catch arm passes an
        // output, and it passes the error.
        //
        // A file whose stated job is pinning the two record-only row shapes
        // was pinning a third one nothing produces.
        renderDetail([
            step({
                seq: 0,
                kind: 'MODEL_CALL',
                tool: null,
                scope: null,
                label: null,
                costTokens: 4120,
                inputJson: '{"toolCalls":2,"failedToolCalls":0}',
                outputJson: null,
            }),
            step({
                seq: 1,
                kind: 'TOOL_CALL',
                tool: 'list_risks',
                scope: 'READ_TENANT_DATA',
                label: null,
                costTokens: null,
                guardVerdict: 'CLEAN',
                inputJson: '{"status":"OPEN"}',
                outputJson: null,
            }),
        ]);

        const model = document.getElementById('step-0') as HTMLElement;
        const call = document.getElementById('step-1') as HTMLElement;

        // THE MODEL CALL: its cost, and nothing borrowed from the row below.
        expect(within(model).getByText(D.stepTokens.replace('{count}', '4120'))).toBeInTheDocument();
        expect(within(model).queryByText('list_risks')).toBeNull();
        expect(within(model).queryByText(D.scope.READ_TENANT_DATA)).toBeNull();
        // No RESULT panel — the reply text is deliberately never recorded, so
        // a row offering one would invite a reader to open a fact that was
        // never captured.
        expect(within(model).queryByText(D.outputLabel)).toBeNull();

        // THE TOOL CALL: the tool, the rung it reaches, the arguments it was
        // called with, the result it returned — and no token chip, because it
        // reported no usage and inventing one would be a fabricated cost.
        expect(within(call).getByText('list_risks')).toBeInTheDocument();
        expect(within(call).getByText(D.scope.READ_TENANT_DATA)).toBeInTheDocument();
        expect(within(call).getByText(D.inputLabel)).toBeInTheDocument();
        expect(within(call).getByText('{"status":"OPEN"}')).toBeInTheDocument();
        // The result panel is ABSENT, because there is no result to show. The
        // FAILED-tool-call test below pins the panel where one does exist, so
        // dropping it here loses no coverage of the panel itself.
        expect(within(call).queryByText(D.outputLabel)).toBeNull();
        expect(within(call).queryByText(D.stepTokens.replace('{count}', '4120'))).toBeNull();
    });

    it('a failed tool call shows the error it returned as its result', () => {
        // The DONE arm records args and NO output on purpose — the return
        // value is tenant content, guarded on its way back through the
        // adapter, and the write site declines to copy it into the ledger.
        // The FAILED arm is where a result exists, and it is the row an
        // operator opened this page to read.
        renderDetail([
            step({
                seq: 0,
                kind: 'TOOL_CALL',
                status: 'FAILED',
                tool: 'propose_risk',
                scope: 'WRITE_TENANT_DATA',
                label: null,
                guardVerdict: 'QUARANTINED',
                guardRuleIds: ['egress.pii'],
                inputJson: '{"title":"Vendor drift"}',
                outputJson: '{"error":"guard_quarantined"}',
            }),
        ]);

        const row = document.getElementById('step-0') as HTMLElement;
        expect(within(row).getByText('propose_risk')).toBeInTheDocument();
        expect(within(row).getByText('{"title":"Vendor drift"}')).toBeInTheDocument();
        expect(within(row).getByText('{"error":"guard_quarantined"}')).toBeInTheDocument();
        expect(within(row).getByText(D.guard.QUARANTINED)).toBeInTheDocument();
    });

    it('the token chip is gated on the NUMBER, not on the kind', () => {
        // Pins the design decision itself, which the plan bullet read
        // literally would undo. `kind === 'MODEL_CALL' && costTokens != null`
        // satisfies "model calls show token cost" and hides any other step
        // that genuinely spent tokens — the row whose cost is exactly the
        // thing worth asking about, because nobody expected it to have one.
        renderDetail([step({ seq: 0, kind: 'PROPOSE', costTokens: 7 })]);
        expect(screen.getByText(D.stepTokens.replace('{count}', '7'))).toBeInTheDocument();
    });
});

/**
 * #3537 — the page says WHAT caused the run, not only under whose authority it
 * ran.
 *
 * An automation-started run's `startedByUserId` is the rule's OWNER, so the
 * header named a person for work a rule scheduled. These two cases are the
 * whole claim: the line appears when there is a cause, and stays absent when
 * there is not — a run a person genuinely started must not grow a sentence
 * saying a rule did.
 */
describe('what caused the run', () => {
    it('names the automation execution when a rule caused it', () => {
        renderDetail([step()], { ...RUN, parentExecutionId: 'exec-xyz' });
        const line = screen.getByTestId('run-caused-by');
        expect(line).toHaveTextContent('exec-xyz');
        // …and says why the name above is not the cause, because that is the
        // confusion the line exists to remove.
        expect(line).toHaveTextContent(/rule owner/i);
    });

    it('says nothing when nothing caused it', () => {
        renderDetail([step()], { ...RUN, parentExecutionId: null });
        expect(screen.queryByTestId('run-caused-by')).toBeNull();
    });
});

/**
 * #3666 — what the run was taught, from its write-once pin.
 *
 * Three states, and the page keeps them apart: a list of skills by name,
 * version and hash; "mounted no skill" for an empty pin; and "not recorded" for
 * a run that predates the pin. Collapsing the last two would tell a reader an
 * old run was taught nothing, which nobody checked.
 */
describe('what the run was taught', () => {
    const pin = { name: 'soa-authoring', version: '1', contentHash: `sha256:${'a'.repeat(64)}` };

    it('lists each mounted skill with its version and hash', () => {
        renderDetail([step()], { ...RUN, driver: 'FLUE', mountedSkills: [pin] });
        const section = screen.getByTestId('run-mounted-skills');
        expect(section).toHaveTextContent('soa-authoring');
        expect(section).toHaveTextContent(D.skillVersion.replace('{version}', '1'));
        expect(section).toHaveTextContent(pin.contentHash);
    });

    it('says the run mounted nothing for an empty pin', () => {
        renderDetail([step()], { ...RUN, mountedSkills: [] });
        expect(screen.getByTestId('run-mounted-skills')).toHaveTextContent(D.skillsNone);
    });

    it('says the pin was not recorded, rather than "nothing", for an older run', () => {
        renderDetail([step()], { ...RUN, mountedSkills: null });
        const section = screen.getByTestId('run-mounted-skills');
        expect(section).toHaveTextContent(D.skillsNotRecorded);
        expect(section).not.toHaveTextContent(D.skillsNone);
    });
});

/**
 * #3472 — stepping through a run one step at a time.
 *
 * ── WHAT THE SCRUBBER MUST NOT DO ───────────────────────────────────────────
 *
 * Selection is ADDITIVE. Every step stays rendered and the selected one is
 * emphasised, because hiding the others would make the scrubber the only way
 * to read the run — worse for anyone scanning, and it would break the
 * `#step-N` anchors the decisions page links into. The first assertion below
 * is that the list length does not change.
 *
 * ── AND WHY IT STEPS BY POSITION, NOT BY `seq` ──────────────────────────────
 *
 * A Flue run's `seq` counts steps RECORDED and a static run's indexes the
 * definition, so neither is guaranteed contiguous. Stepping by `seq ± 1` would
 * skip or stall on a gap, so the control walks the rendered ORDER — and the
 * gap case is asserted directly, with seqs 0, 5, 9.
 */
describe('the timeline scrubber', () => {
    const gappy = [
        step({ id: 's0', seq: 0 }),
        step({ id: 's5', seq: 5 }),
        step({ id: 's9', seq: 9 }),
    ];
    const pos = () => screen.getByTestId('run-scrubber-position');

    it('starts with NOTHING selected — the first paint is the whole timeline', () => {
        // Defaulting to step 1 would emphasise a step nobody asked about, and
        // somebody arriving from a `#step-N` link wants their own step.
        renderDetail(gappy);
        expect(pos()).toHaveTextContent(/none selected/i);
        expect(document.querySelectorAll('[data-selected="true"]')).toHaveLength(0);
    });

    it('selects the first step, and keeps every step rendered', () => {
        renderDetail(gappy);
        fireEvent.click(screen.getByTestId('run-scrubber-next'));
        expect(pos()).toHaveTextContent('Step 1 of 3');
        const selected = document.querySelectorAll('[data-selected="true"]');
        expect(selected).toHaveLength(1);
        // THE CLASS TOO, and a mutation run is why. The attribute is for
        // tests; the ring is what a user sees — deleting the ring left every
        // other assertion here green, so the emphasis could have been dropped
        // silently.
        expect(selected[0].className).toContain('ring-brand-default');
        // ADDITIVE, not a filter — the other two are still in the DOM.
        expect(document.querySelectorAll('#run-step-timeline > li')).toHaveLength(3);
    });

    it('walks NON-CONTIGUOUS seqs by position', () => {
        // seq 0 → 5 → 9. Stepping by `seq + 1` would land on a step that does
        // not exist and emphasise nothing.
        renderDetail(gappy);
        const next = screen.getByTestId('run-scrubber-next');
        fireEvent.click(next);
        fireEvent.click(next);
        expect(pos()).toHaveTextContent('Step 2 of 3');
        expect(document.getElementById('step-5')).toHaveAttribute('data-selected', 'true');
        fireEvent.click(next);
        expect(document.getElementById('step-9')).toHaveAttribute('data-selected', 'true');
    });

    it('disables the buttons at both ends', () => {
        renderDetail(gappy);
        const next = screen.getByTestId('run-scrubber-next');
        for (let i = 0; i < 5; i++) fireEvent.click(next);
        expect(pos()).toHaveTextContent('Step 3 of 3');
        expect(next).toBeDisabled();

        const prev = screen.getByTestId('run-scrubber-prev');
        for (let i = 0; i < 5; i++) fireEvent.click(prev);
        expect(pos()).toHaveTextContent('Step 1 of 3');
        expect(prev).toBeDisabled();
    });

    it('does not WRAP past the end — and only the keyboard can prove it', () => {
        /*
            A mutation run found this gap. Making `go()` wrap left the test
            above GREEN, because at the last step the Next BUTTON is
            `disabled` and a click on it does nothing — so the clicks proved
            the disabled attribute, not the bounds check.

            `onKeyDown` calls `go()` directly and is NOT gated by `disabled`,
            so the keyboard is the only path that reaches the guard. Which also
            means the guard is load-bearing rather than belt-and-braces: without
            it, a keyboard user at the last step would silently jump to the
            first, with no visible cause.
        */
        renderDetail(gappy);
        const group = screen.getByTestId('run-scrubber');
        for (let i = 0; i < 5; i++) fireEvent.keyDown(group, { key: 'ArrowRight' });
        expect(pos()).toHaveTextContent('Step 3 of 3');
        expect(document.getElementById('step-9')).toHaveAttribute('data-selected', 'true');

        for (let i = 0; i < 5; i++) fireEvent.keyDown(group, { key: 'ArrowLeft' });
        expect(pos()).toHaveTextContent('Step 1 of 3');
        expect(document.getElementById('step-0')).toHaveAttribute('data-selected', 'true');
    });

    it('clears back to nothing selected', () => {
        // Without this, selecting a step is a one-way door — an operator who
        // wants the plain list back would have to reload.
        renderDetail(gappy);
        fireEvent.click(screen.getByTestId('run-scrubber-next'));
        fireEvent.click(screen.getByTestId('run-scrubber-clear'));
        expect(pos()).toHaveTextContent(/none selected/i);
        expect(document.querySelectorAll('[data-selected="true"]')).toHaveLength(0);
    });

    it('steps with the arrow keys', () => {
        // Stepping a sequence with a mouse is the slower half of the
        // interaction, and the group scopes the keys so they do not fight the
        // page's own scrolling.
        renderDetail(gappy);
        const group = screen.getByTestId('run-scrubber');
        fireEvent.keyDown(group, { key: 'ArrowRight' });
        expect(pos()).toHaveTextContent('Step 1 of 3');
        fireEvent.keyDown(group, { key: 'ArrowRight' });
        expect(pos()).toHaveTextContent('Step 2 of 3');
        fireEvent.keyDown(group, { key: 'ArrowLeft' });
        expect(pos()).toHaveTextContent('Step 1 of 3');
    });

    it('is not rendered for a run with no steps', () => {
        // The empty state is the whole panel there; a scrubber over zero steps
        // would offer two disabled buttons and a count of none.
        renderDetail([]);
        expect(screen.queryByTestId('run-scrubber')).toBeNull();
    });
});

/*
    ═══ WHAT THIS RUN DELEGATED (#3473 part 3) ═══

    The owner's decision was to group a delegate's steps by SEQUENCE, with a
    delegation step marking the span. `tests/unit/agentic/delegation-spans` owns
    the rule; this owns what a reader is actually told.

    THE CLAIM THAT MATTERS IS THE ONE ABOUT ATTRIBUTION. The steps in a span
    are the run's OWN rows — a delegate runs the parent's tool objects, so its
    reads land in the parent's ledger and are charged to it. So the page must
    say which steps were a specialist's without implying the run did not do
    them, and must not claim a precision the ledger lacks when two delegations
    interleave.
*/
describe('the delegation section', () => {
    const delegation = (
        agent: string,
        fromSeq: number | null,
        over: Partial<RunStepRow> = {},
    ): RunStepRow =>
        step({
            kind: 'TOOL_CALL',
            tool: 'task',
            status: 'DONE',
            delegation: { agent, taskId: `task_${agent}`, fromSeq },
            ...over,
        });

    it('is ABSENT for a run that delegated nothing', () => {
        // Every run until a workflow uses a specialist. A heading over an empty
        // list would tell an operator to look for something that is not there.
        renderDetail([step({ seq: 0, kind: 'READ' }), step({ seq: 1, kind: 'SYNTHESIS' })]);
        expect(screen.queryByTestId('run-delegations')).toBeNull();
    });

    it('names the specialist, the step count and the token rollup', () => {
        renderDetail([
            step({ seq: 0, kind: 'READ', costTokens: 10 }),
            step({ seq: 1, kind: 'READ', costTokens: 100 }),
            step({ seq: 2, kind: 'READ', costTokens: 200 }),
            delegation('evidence_assessor', 0, { seq: 3 }),
            step({ seq: 4, kind: 'SYNTHESIS', costTokens: 20 }),
        ]);
        const card = screen.getByTestId('delegation-evidence_assessor');
        expect(card).toBeInTheDocument();
        // TWO steps between the bounds, and 300 tokens — the parent's 10 and 20
        // are its own, and a rollup that swept them would make the specialist
        // look more expensive than it was.
        expect(card).toHaveTextContent('2 step(s) between');
        expect(card).toHaveTextContent('300 tokens');
    });

    it('says the answer was REFUSED when the guard blocked it', () => {
        // The one outcome a reader cannot infer from the delegation existing.
        renderDetail([
            step({ seq: 0, kind: 'READ' }),
            delegation('risk_analyst', 0, { seq: 1, status: 'FAILED' }),
        ]);
        const card = screen.getByTestId('delegation-risk_analyst');
        expect(card).toHaveTextContent(/refused/i);
        expect(card).not.toHaveTextContent(/Answer accepted/i);
    });

    it('says it cannot attribute steps when no bound was recorded', () => {
        // `fromSeq` is null for a run bound by a caller predating delegation.
        // The delegation is still listed — it happened — and the page says what
        // it cannot say rather than showing "0 steps", which reads as a
        // specialist that did nothing.
        renderDetail([
            step({ seq: 0, kind: 'READ', costTokens: 9 }),
            delegation('policy_drafter', null, { seq: 1 }),
        ]);
        const card = screen.getByTestId('delegation-policy_drafter');
        expect(card).toHaveTextContent(/not attributable/i);
        expect(card).not.toHaveTextContent('0 step(s)');
        // AND IT CLAIMS NO TOKENS. An unbounded span sweeping earlier steps
        // would report the whole run's spend as one delegate's.
        expect(card).toHaveTextContent(/unreported/i);
    });

    it('warns when two delegations overlap, and names BOTH on a shared step', () => {
        // Concurrent fan-out. Each span's bounds are exact; their ranges are
        // not disjoint, and a step inside both belongs to both as far as the
        // ledger can say. The notice exists because the two rollups then do not
        // sum to the run's total — a reader comparing them with the header
        // would otherwise conclude the arithmetic is broken.
        renderDetail([
            step({ seq: 0, kind: 'READ' }),
            step({ seq: 1, kind: 'READ', costTokens: 40 }),
            delegation('risk_analyst', 0, { seq: 2 }),
            delegation('vendor_reviewer', 0, { seq: 3 }),
        ]);
        expect(screen.getByTestId('delegation-risk_analyst'))
            .toHaveAttribute('data-overlapping', 'true');
        expect(screen.getAllByText(/do not sum to the run/i).length).toBeGreaterThan(0);

        // The shared step names both, comma-joined — picking one would be a
        // guess, and on a governance surface the wrong specialist is the error
        // that matters.
        const shared = document.getElementById('step-1');
        expect(shared).toHaveAttribute('data-delegates', 'risk_analyst,vendor_reviewer');
    });

    it('marks a delegated step and leaves the parent\'s own unmarked', () => {
        renderDetail([
            step({ seq: 0, kind: 'READ' }),
            step({ seq: 1, kind: 'READ' }),
            delegation('risk_analyst', 0, { seq: 2 }),
            step({ seq: 3, kind: 'SYNTHESIS' }),
        ]);
        expect(document.getElementById('step-1'))
            .toHaveAttribute('data-delegates', 'risk_analyst');
        // The parent's last step before delegating, and its first after, are
        // ITS OWN — strict bounds, so neither is claimed.
        expect(document.getElementById('step-0')).not.toHaveAttribute('data-delegates');
        expect(document.getElementById('step-3')).not.toHaveAttribute('data-delegates');
        // And the marker itself is not its own delegate's work.
        expect(document.getElementById('step-2')).not.toHaveAttribute('data-delegates');
    });
});

