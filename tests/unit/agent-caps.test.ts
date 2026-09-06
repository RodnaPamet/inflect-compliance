/* eslint-disable @typescript-eslint/no-explicit-any -- the in-memory fake DB
 * mirrors runtime Prisma contracts; per-line typing has poor cost/benefit in a
 * test double (codebase convention — see tests/unit/workflow-context-integrity.test.ts). */
/**
 * AGENT RUN CAPS — OWASP ASI08 (cascading failures).
 *
 * Two layers, and both are needed for the claim to mean anything.
 *
 *   • THE LEDGER (`src/lib/agentic/run-caps.ts`) — the composition of the
 *     engine's global ceiling with the agent's own policy card, and the
 *     all-or-nothing charge. Pure, so the boundary can be asserted exactly.
 *   • THE ENGINE (`executeFrom` in `workflow-runs.ts`) — that the ledger is
 *     actually REACHED, that a breach stops the run, and that the stop is
 *     recorded. A cap module nothing is required to use is decoration; this is
 *     the same argument `bounded-exec.ts` makes about its own guard.
 *
 * ## The property under test is HALTING IS NOT TRUNCATION
 *
 * The tempting failure is a cap that trims and continues: give the run the
 * first hundred of its five hundred proposals, or the first forty of its sixty
 * steps, and carry on. The result is a run that LOOKS healthy and reasoned over
 * a subset nobody chose, and nothing downstream can tell it apart from a run
 * that meant to do exactly that — the evidence that would say so is the
 * evidence that was dropped.
 *
 * So every cap test below asserts three things, not one: the work stopped, the
 * cap that stopped it was recorded, and the remaining work is visibly not-done
 * rather than quietly gone.
 *
 * ## The boundary is the test
 *
 * A cap of N that halts at N-1 is a cap that costs a unit of real work for
 * nothing; a cap of N that halts at N+1 is a cap that does not hold. Every
 * counted axis is asserted at all three positions, not just the middle one.
 *
 * ## No real timers, no sleeping
 *
 * The wall-clock cap takes an injected clock at the ledger, and at the engine
 * it is driven by a run's own `startedAt` — so a two-hour-old run is a seeded
 * row, not two hours of waiting. A runtime check proved by sleeping is proved
 * slowly and flakily, and worse: a check that has stopped being made looks
 * exactly like one that is being made, whenever real time has not passed.
 */
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/mcp/auth', () => ({
    resolveMcpInvocation: jest.fn(),
    enforceMcpCapability: jest.fn(),
}));

jest.mock('@/lib/mcp/tools/registry', () => ({ runReadTool: jest.fn() }));
jest.mock('@/lib/mcp/tools/propose-tools', () => ({ runProposeTool: jest.fn() }));

jest.mock('@/lib/observability/metrics', () => ({
    ...jest.requireActual('@/lib/observability/metrics'),
    recordWorkflowContextBytes: jest.fn(),
    recordWorkflowContextIntegrityHalt: jest.fn(),
    recordAgentRunCapHalt: jest.fn(),
    recordAgentRunCapUtilisation: jest.fn(),
}));

import { randomUUID } from 'node:crypto';

import { startWorkflowRun, resumeWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import {
    createRunBudget,
    resolveRunCaps,
    ENGINE_RUN_CAPS,
    ENGINE_MAX_PROPOSALS_PER_RUN,
    RUN_CAP_KINDS,
    type CountedRunCapKind,
    type EffectiveRunCap,
    type EffectiveRunCaps,
    type RunCapKind,
} from '@/lib/agentic/run-caps';
import { ACTION_CAP_LADDER } from '@/lib/agentic/policy-card';
import {
    computeContextLink,
    CONTEXT_ENVELOPE_VERSION,
} from '@/lib/agentic/context-integrity';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { appendAuditEntry } from '@/lib/audit';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { runProposeTool } from '@/lib/mcp/tools/propose-tools';
import {
    recordAgentRunCapHalt,
    recordAgentRunCapUtilisation,
} from '@/lib/observability/metrics';
import { makeRequestContext } from '../helpers/make-context';

const mockRunInTenant = runInTenantContext as jest.MockedFunction<any>;
const mockResolveInvocation = resolveMcpInvocation as jest.MockedFunction<any>;
const mockReadTool = runReadTool as jest.MockedFunction<any>;
const mockProposeTool = runProposeTool as jest.MockedFunction<any>;
const mockCapHalt = recordAgentRunCapHalt as jest.MockedFunction<any>;
const mockCapUtilisation = recordAgentRunCapUtilisation as jest.MockedFunction<any>;
const mockAudit = appendAuditEntry as jest.MockedFunction<any>;

const TENANT = 'tenant-caps';
const ctx = () => makeRequestContext('ADMIN', { tenantId: TENANT });

const HOUR_MS = 60 * 60 * 1000;

// ─── The ledger, in isolation ────────────────────────────────────────

/** Caps with one axis pinned to `limit`, everything else out of the way. */
function capsWith(kind: RunCapKind, limit: number): EffectiveRunCaps {
    const base: Record<RunCapKind, EffectiveRunCap> = { ...resolveRunCaps(null) };
    base[kind] = { limit, source: 'ENGINE' };
    return base;
}

const COUNTED_KINDS: readonly CountedRunCapKind[] = [
    'STEPS',
    'TOOL_CALLS',
    'PROPOSALS',
    'TOKENS',
];

describe('composing the engine ceiling with the agent policy card', () => {
    it('takes the STRICTEST of the two, and says which one bound', () => {
        const narrow = resolveRunCaps({ maxActionsPerRun: 10 });
        expect(narrow.TOOL_CALLS).toStrictEqual({ limit: 10, source: 'POLICY_CARD' });
    });

    it('a card can NARROW the engine ceiling but never widen it', () => {
        // 1000 is the top rung of ACTION_CAP_LADDER — the most permissive card
        // this product can express. It must not lift the engine's 50.
        const top = ACTION_CAP_LADDER[ACTION_CAP_LADDER.length - 1];
        expect(top).toBeGreaterThan(ENGINE_RUN_CAPS.TOOL_CALLS);
        const permissive = resolveRunCaps({ maxActionsPerRun: top });
        expect(permissive.TOOL_CALLS).toStrictEqual({
            limit: ENGINE_RUN_CAPS.TOOL_CALLS,
            source: 'ENGINE',
        });
    });

    it('a TIE names the ENGINE, because widening the card would change nothing', () => {
        const tied = resolveRunCaps({ maxActionsPerRun: ENGINE_RUN_CAPS.TOOL_CALLS });
        expect(tied.TOOL_CALLS.source).toBe('ENGINE');
    });

    it('an agent with NO CARD gets the engine ceiling, never an absent one', () => {
        const uncarded = resolveRunCaps(null);
        for (const kind of RUN_CAP_KINDS) {
            expect(uncarded[kind].limit).toBe(ENGINE_RUN_CAPS[kind]);
            expect(Number.isFinite(uncarded[kind].limit)).toBe(true);
        }
    });

    it('deleting a card can never RAISE what a run may spend', () => {
        // The hole this composition closes: an absent card contributes no term,
        // and on the per-run action axis there was no other term — so an agent
        // with a card was bounded and an agent without one was not.
        const top = ACTION_CAP_LADDER[ACTION_CAP_LADDER.length - 1];
        const mostPermissiveCard = resolveRunCaps({ maxActionsPerRun: top });
        const uncarded = resolveRunCaps(null);
        for (const kind of RUN_CAP_KINDS) {
            expect(uncarded[kind].limit).toBeLessThanOrEqual(mostPermissiveCard[kind].limit);
        }
    });

    it('the proposal axis is bounded independently of the tool-call axis', () => {
        // One propose CALL can carry five hundred items, so a card capping an
        // agent at a single action per run bounds proposal flooding not at all.
        const oneCall = resolveRunCaps({ maxActionsPerRun: 1 });
        expect(oneCall.TOOL_CALLS.limit).toBe(1);
        expect(oneCall.PROPOSALS.limit).toBe(ENGINE_MAX_PROPOSALS_PER_RUN);
    });
});

describe.each(COUNTED_KINDS)('a %s cap of N halts at N — not N-1, not N+1', (kind) => {
    const N = 3;
    const budget = () =>
        createRunBudget({ caps: capsWith(kind, N), now: () => 0, startedAtMs: 0 });

    it('grants every unit up to and including the Nth', () => {
        const b = budget();
        for (let i = 0; i < N; i++) expect(b.charge(kind, 1)).toBeNull();
        expect(b.used(kind)).toBe(N);
        expect(b.remaining(kind)).toBe(0);
    });

    it('does not halt EARLY: with N-1 spent, the next unit is still granted', () => {
        const b = budget();
        for (let i = 0; i < N - 1; i++) expect(b.charge(kind, 1)).toBeNull();
        expect(b.charge(kind, 1)).toBeNull();
    });

    it('halts on the unit that would make N+1, naming the cap and the source', () => {
        const b = budget();
        for (let i = 0; i < N; i++) b.charge(kind, 1);
        const halt = b.charge(kind, 1);
        expect(halt).not.toBeNull();
        expect(halt?.kind).toBe(kind);
        expect(halt?.limit).toBe(N);
        expect(halt?.source).toBe('ENGINE');
        expect(halt?.used).toBe(N);
        expect(halt?.refused).toBe(1);
    });
});

describe('the wall-clock cap, on an injected clock', () => {
    const N = 1_000;
    let clockMs = 0;
    const budget = () =>
        createRunBudget({
            caps: capsWith('RUNTIME_MS', N),
            now: () => clockMs,
            startedAtMs: 0,
        });

    it('is inside the budget at N-1 and at exactly N', () => {
        const b = budget();
        clockMs = N - 1;
        expect(b.charge('RUNTIME_MS', 0)).toBeNull();
        clockMs = N;
        expect(b.charge('RUNTIME_MS', 0)).toBeNull();
    });

    it('halts at N+1, naming RUNTIME_MS', () => {
        const b = budget();
        clockMs = N + 1;
        const halt = b.charge('RUNTIME_MS', 0);
        expect(halt?.kind).toBe('RUNTIME_MS');
        expect(halt?.limit).toBe(N);
        expect(halt?.used).toBe(N + 1);
    });

    it('reads the clock every time rather than once at construction', () => {
        // A budget that snapshotted the clock would report a run as forever
        // young, and the deadline would never fire.
        const b = budget();
        clockMs = 0;
        expect(b.charge('RUNTIME_MS', 0)).toBeNull();
        clockMs = N * 10;
        expect(b.charge('RUNTIME_MS', 0)).not.toBeNull();
    });
});

describe('a charge is ALL OR NOTHING — the ledger never trims to fit', () => {
    it('refuses every unit of an over-budget charge, not the remainder', () => {
        const b = createRunBudget({
            caps: capsWith('PROPOSALS', 100),
            now: () => 0,
            startedAtMs: 0,
        });
        const halt = b.charge('PROPOSALS', 101);
        expect(halt?.refused).toBe(101);
        // The refused units are reported IN FULL. A `refused: 1` here would be
        // the truncating design wearing a halt's clothes: 100 granted, one
        // over, carry on.
        expect(halt?.used).toBe(0);
    });

    it('leaves the unspent balance unspent, so nothing was partially applied', () => {
        const b = createRunBudget({
            caps: capsWith('PROPOSALS', 100),
            now: () => 0,
            startedAtMs: 0,
        });
        expect(b.charge('PROPOSALS', 60)).toBeNull();
        const halt = b.charge('PROPOSALS', 60);
        expect(halt).not.toBeNull();
        // 40 were available and 60 were asked for. A truncating ledger would
        // now read 100/100 having quietly granted the 40.
        expect(b.used('PROPOSALS')).toBe(60);
        expect(b.remaining('PROPOSALS')).toBe(40);
    });

    it('a run resumed after a checkpoint does not get a fresh budget', () => {
        const b = createRunBudget({
            caps: capsWith('TOOL_CALLS', 5),
            now: () => 0,
            startedAtMs: 0,
            spent: { TOOL_CALLS: 5 },
        });
        expect(b.charge('TOOL_CALLS', 1)).not.toBeNull();
    });
});

// ─── The engine ──────────────────────────────────────────────────────
// Rows are returned as COPIES, exactly as a real read does.

interface Store {
    runs: Map<string, any>;
    steps: any[];
}

let store: Store;
let idSeq = 0;

function makeDb() {
    return {
        workflowRun: {
            create: async ({ data, select }: any) => {
                const id = `run-${++idSeq}`;
                const row = {
                    id,
                    stepCount: 0,
                    costTokens: 0,
                    contextJson: null,
                    contextHash: null,
                    summary: null,
                    errorMessage: null,
                    completedAt: null,
                    startedAt: new Date(),
                    ...data,
                };
                store.runs.set(id, row);
                return select ? { id } : { ...row };
            },
            update: async ({ where, data }: any) => {
                const row = store.runs.get(where.id);
                if (!row) throw new Error(`no such run ${where.id}`);
                Object.assign(row, data);
                return { ...row };
            },
            findFirst: async ({ where }: any) => {
                const row = store.runs.get(where.id);
                if (!row || row.tenantId !== where.tenantId) return null;
                return { ...row };
            },
        },
        workflowStep: {
            aggregate: async ({ where }: any) => {
                const seqs = store.steps
                    .filter((s) => s.runId === where.runId && s.tenantId === where.tenantId)
                    .map((s) => s.contextSeq)
                    .filter((n) => typeof n === 'number');
                return { _max: { contextSeq: seqs.length ? Math.max(...seqs) : null } };
            },
            create: async ({ data }: any) => {
                const row = { id: `step-${store.steps.length}`, ...data };
                store.steps.push(row);
                return { ...row };
            },
            findMany: async ({ where }: any) =>
                store.steps
                    .filter(
                        (s) =>
                            s.runId === where.runId &&
                            s.tenantId === where.tenantId &&
                            (where.kind === undefined || s.kind === where.kind) &&
                            (where.status === undefined || s.status === where.status),
                    )
                    .map((s) => ({ ...s })),
            findFirst: async ({ where }: any) => {
                const hits = store.steps.filter(
                    (s) =>
                        s.runId === where.runId &&
                        s.tenantId === where.tenantId &&
                        s.status === where.status,
                );
                return hits.length ? { ...hits[hits.length - 1] } : null;
            },
            update: async ({ where, data }: any) => {
                const row = store.steps.find((s) => s.id === where.id);
                Object.assign(row, data);
                return { ...row };
            },
        },
    };
}

function toolResult(payload: unknown) {
    return { content: [{ text: JSON.stringify(payload) }] };
}

/** The audit rows this run wrote, by action. */
function auditActions(): string[] {
    return mockAudit.mock.calls.map((c: any[]) => c[0].action);
}

function capHaltDetails(): any {
    const call = mockAudit.mock.calls
        .map((c: any[]) => c[0])
        .find((e: any) => e.action === 'WORKFLOW_RUN_CAP_HALTED');
    return call?.detailsJson;
}

beforeEach(() => {
    jest.clearAllMocks();
    store = { runs: new Map(), steps: [] };
    const db = makeDb();
    mockRunInTenant.mockImplementation((_ctx: any, fn: any) => fn(db));
    mockReadTool.mockResolvedValue(toolResult({ ok: true }));
    mockProposeTool.mockResolvedValue(toolResult({ queued: 1 }));
    // An UNCARDED agent by default — the case that used to have no per-run
    // action bound at all.
    mockResolveInvocation.mockResolvedValue({ invocation: 'test' });
});

// ─── Fixtures ────────────────────────────────────────────────────────

const SMALL_WF = `caps-small-${randomUUID().slice(0, 8)}`;
const FLOOD_WF = `caps-flood-${randomUUID().slice(0, 8)}`;
const LONG_WF = `caps-long-${randomUUID().slice(0, 8)}`;
const TWO_READ_WF = `caps-tworead-${randomUUID().slice(0, 8)}`;
const PAUSED_WF = `caps-paused-${randomUUID().slice(0, 8)}`;
const SPLIT_PROPOSE_WF = `caps-split-${randomUUID().slice(0, 8)}`;

const OVER_PROPOSAL_CAP = ENGINE_MAX_PROPOSALS_PER_RUN + 1;
const OVER_STEP_CAP = ENGINE_RUN_CAPS.STEPS + 1;

registerWorkflow({
    key: SMALL_WF,
    name: 'read → synthesis',
    description: 'Comfortably inside every cap — the positive control.',
    steps: [
        { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
        {
            kind: 'SYNTHESIS',
            label: 'summary',
            synthesize: () => ({ text: 'done' }),
        },
    ],
});

registerWorkflow({
    key: FLOOD_WF,
    name: 'propose too much → synthesis',
    description: 'One PROPOSE step carrying more items than the run may propose.',
    steps: [
        {
            kind: 'PROPOSE',
            label: 'flood',
            tool: 'propose_controls',
            buildItems: () =>
                Array.from({ length: OVER_PROPOSAL_CAP }, (_unused, i) => ({ title: `c-${i}` })),
        },
        { kind: 'SYNTHESIS', label: 'after', synthesize: () => ({ text: 'never' }) },
    ],
});

registerWorkflow({
    key: LONG_WF,
    name: 'one step past the step cap',
    description: 'Pure synthesis, so only the STEP axis can be what stops it.',
    steps: Array.from({ length: OVER_STEP_CAP }, (_unused, i) => ({
        kind: 'SYNTHESIS' as const,
        label: `s${i}`,
        synthesize: () => ({ text: 'x' }),
    })),
});

registerWorkflow({
    key: TWO_READ_WF,
    name: 'read → read',
    description: 'Two tool calls, for a card that permits one.',
    steps: [
        { kind: 'READ', label: 'first', tool: 'get_compliance_posture' },
        { kind: 'READ', label: 'second', tool: 'get_compliance_posture' },
    ],
});

/** Two-thirds of the proposal cap, twice — under it alone, over it together. */
const HALF_ISH_PROPOSALS = Math.ceil(ENGINE_MAX_PROPOSALS_PER_RUN * 0.6);

registerWorkflow({
    key: SPLIT_PROPOSE_WF,
    name: 'propose → checkpoint → propose',
    description:
        'Each PROPOSE step is inside the cap on its own; together they are over it. ' +
        'The run must not get a fresh proposal budget on the far side of the pause.',
    steps: [
        {
            kind: 'PROPOSE',
            label: 'first',
            tool: 'propose_controls',
            buildItems: () =>
                Array.from({ length: HALF_ISH_PROPOSALS }, (_unused, i) => ({ title: `a-${i}` })),
        },
        { kind: 'HUMAN_CHECKPOINT', label: 'review' },
        {
            kind: 'PROPOSE',
            label: 'second',
            tool: 'propose_controls',
            buildItems: () =>
                Array.from({ length: HALF_ISH_PROPOSALS }, (_unused, i) => ({ title: `b-${i}` })),
        },
    ],
});

registerWorkflow({
    key: PAUSED_WF,
    name: 'read → checkpoint → read',
    description: 'A run that can be resumed hours after it started.',
    steps: [
        { kind: 'READ', label: 'before', tool: 'get_compliance_posture' },
        { kind: 'HUMAN_CHECKPOINT', label: 'review' },
        { kind: 'READ', label: 'after', tool: 'get_compliance_posture' },
    ],
});

// ─── Positive control ────────────────────────────────────────────────

describe('a run inside every cap', () => {
    it('completes, halts on nothing, and reports how much of each cap it used', () => {
        // Without this, an implementation that halted EVERY run would satisfy
        // every cap test below while being completely broken.
        return startWorkflowRun(ctx(), SMALL_WF, {}).then((started) => {
            expect(started.status).toBe('COMPLETED');
            expect(mockCapHalt).not.toHaveBeenCalled();
            expect(auditActions()).not.toContain('WORKFLOW_RUN_CAP_HALTED');
            // The utilisation histogram is the warning that arrives BEFORE the
            // counter moves — a cap only ever visible as halts is one nobody
            // can plan around.
            const axes = mockCapUtilisation.mock.calls.map((c: any[]) => c[0].cap);
            expect(axes).toEqual(expect.arrayContaining([...RUN_CAP_KINDS]));
        });
    });
});

// ─── PROPOSALS ───────────────────────────────────────────────────────

describe('a run that proposes more than its proposal cap', () => {
    it('HALTS, and records which cap fired', async () => {
        const started = await startWorkflowRun(ctx(), FLOOD_WF, {});

        expect(started.status).toBe('FAILED');
        const row = store.runs.get(started.runId)!;
        expect(row.status).toBe('FAILED');
        expect(row.errorMessage).toContain('PROPOSALS');
        expect(mockCapHalt).toHaveBeenCalledWith({ cap: 'PROPOSALS', source: 'ENGINE' });
        expect(auditActions()).toContain('WORKFLOW_RUN_CAP_HALTED');
    });

    it('proposes NOTHING — it does not queue the first N and drop the rest', async () => {
        await startWorkflowRun(ctx(), FLOOD_WF, {});

        // THE load-bearing assertion of this file. A truncating engine would
        // have called the propose tool once with ENGINE_MAX_PROPOSALS_PER_RUN
        // items, producing a review queue that reads as the agent's considered
        // output over a subset nobody chose.
        expect(mockProposeTool).not.toHaveBeenCalled();
    });

    it('records the work that did NOT happen, rather than dropping it silently', async () => {
        const started = await startWorkflowRun(ctx(), FLOOD_WF, {});

        const details = capHaltDetails();
        expect(details.cap).toBe('PROPOSALS');
        expect(details.limit).toBe(ENGINE_MAX_PROPOSALS_PER_RUN);
        expect(details.used).toBe(0);
        // All of them refused, not "one over the line".
        expect(details.refused).toBe(OVER_PROPOSAL_CAP);
        // Both remaining steps are named as not-run. A halted run and a
        // completed one are otherwise indistinguishable from the row.
        expect(details.stepsNotRun).toBe(2);
        // ...and nothing was recorded as a DONE propose step either.
        const done = store.steps.filter(
            (s) => s.runId === started.runId && s.kind === 'PROPOSE' && s.status === 'DONE',
        );
        expect(done).toHaveLength(0);
    });
});

describe('the proposal budget is a property of the RUN, not of a segment', () => {
    it('carries what earlier segments proposed across a human checkpoint', async () => {
        // Seeded from the APPEND-ONLY step ledger rather than from an in-memory
        // counter, because `executeFrom` is re-entered per segment: a counter
        // starting at zero here would hand a run with three checkpoints four
        // proposal budgets, and the flood would arrive one pause at a time.
        const started = await startWorkflowRun(ctx(), SPLIT_PROPOSE_WF, {});
        expect(started.status).toBe('AWAITING_APPROVAL');
        expect(mockProposeTool).toHaveBeenCalledTimes(1);

        const resumed = await resumeWorkflowRun(ctx(), started.runId);

        expect(resumed.status).toBe('FAILED');
        expect(mockCapHalt).toHaveBeenCalledWith({ cap: 'PROPOSALS', source: 'ENGINE' });
        // Still ONE call: the second segment's items were refused whole.
        expect(mockProposeTool).toHaveBeenCalledTimes(1);
        const details = capHaltDetails();
        expect(details.used).toBe(HALF_ISH_PROPOSALS);
        expect(details.refused).toBe(HALF_ISH_PROPOSALS);
    });
});

// ─── STEPS ───────────────────────────────────────────────────────────

describe('a run longer than the step cap', () => {
    it('halts at exactly the cap, having executed the capped number of steps', async () => {
        const started = await startWorkflowRun(ctx(), LONG_WF, {});

        expect(started.status).toBe('FAILED');
        expect(mockCapHalt).toHaveBeenCalledWith({ cap: 'STEPS', source: 'ENGINE' });
        const details = capHaltDetails();
        expect(details.cap).toBe('STEPS');
        expect(details.limit).toBe(ENGINE_RUN_CAPS.STEPS);
        expect(details.used).toBe(ENGINE_RUN_CAPS.STEPS);
        expect(details.stepsNotRun).toBe(OVER_STEP_CAP - ENGINE_RUN_CAPS.STEPS);
        // The cap BINDS at N rather than at N-1: the run got its full budget of
        // steps before it stopped.
        const ran = store.steps.filter((s) => s.runId === started.runId);
        expect(ran).toHaveLength(ENGINE_RUN_CAPS.STEPS);
    });
});

// ─── TOOL CALLS, from the policy card ────────────────────────────────

describe('a run whose policy card permits one tool call', () => {
    beforeEach(() => {
        mockResolveInvocation.mockResolvedValue({
            invocation: 'test',
            policyCard: { inForce: { cardId: 'c1', version: 4, value: { maxActionsPerRun: 1 } } },
        });
    });

    it('runs the first call, halts the second, and blames the CARD not the engine', async () => {
        const started = await startWorkflowRun(ctx(), TWO_READ_WF, {});

        expect(started.status).toBe('FAILED');
        expect(mockReadTool).toHaveBeenCalledTimes(1);
        expect(mockCapHalt).toHaveBeenCalledWith({ cap: 'TOOL_CALLS', source: 'POLICY_CARD' });
        const details = capHaltDetails();
        expect(details.limit).toBe(1);
        expect(details.capSource).toBe('POLICY_CARD');
        expect(details.stepsNotRun).toBe(1);
    });
});

// ─── RUNTIME ─────────────────────────────────────────────────────────

describe('a run resumed after its wall clock has run out', () => {
    /** A paused run with a valid sealed context, started `ageMs` ago. */
    function seedPausedRun(ageMs: number): string {
        const id = `run-paused-${++idSeq}`;
        const context = { input: {}, outputs: { before: { ok: true } } };
        const envelope = {
            v: CONTEXT_ENVELOPE_VERSION,
            seq: 1,
            prev: 'a'.repeat(64),
            input: context.input,
            outputs: context.outputs,
        };
        store.runs.set(id, {
            id,
            tenantId: TENANT,
            workflowKey: PAUSED_WF,
            status: 'AWAITING_APPROVAL',
            stepCount: 2,
            costTokens: 0,
            contextJson: JSON.stringify(envelope),
            contextHash: computeContextLink({
                tenantId: TENANT,
                runId: id,
                seq: envelope.seq,
                previousHash: envelope.prev,
                context,
            }),
            summary: null,
            errorMessage: null,
            completedAt: null,
            startedAt: new Date(Date.now() - ageMs),
            agentId: null,
        });
        return id;
    }

    it('halts on RUNTIME_MS without calling another tool', async () => {
        const runId = seedPausedRun(2 * HOUR_MS);

        const result = await resumeWorkflowRun(ctx(), runId);

        expect(result.status).toBe('FAILED');
        expect(mockReadTool).not.toHaveBeenCalled();
        expect(mockCapHalt).toHaveBeenCalledWith({ cap: 'RUNTIME_MS', source: 'ENGINE' });
        const details = capHaltDetails();
        expect(details.cap).toBe('RUNTIME_MS');
        expect(details.limit).toBe(ENGINE_RUN_CAPS.RUNTIME_MS);
        expect(details.stepsNotRun).toBe(1);
    });

    it('measures from the RUN\'s start, not the resume\'s', async () => {
        // The defect this pins: `executeFrom(..., Date.now())` at the resume
        // site handed every resumed segment a fresh hour, so a workflow with
        // two checkpoints could span three hours with every segment reporting
        // itself well inside an hour-long ceiling.
        const fresh = seedPausedRun(1_000);

        const result = await resumeWorkflowRun(ctx(), fresh);

        expect(result.status).toBe('COMPLETED');
        expect(mockCapHalt).not.toHaveBeenCalled();
    });
});
