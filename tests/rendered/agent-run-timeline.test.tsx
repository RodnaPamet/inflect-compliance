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
