/**
 * READING BACK A QUESTION'S RESULT (#3869).
 *
 * Two properties carry this file, and both are about what a caller gets rather
 * than whether the call succeeds.
 *
 * ## 1. The requester gate is three terms, and the third is load-bearing
 *
 * `startedByUserId` is documented as ATTRIBUTION, not authority: on an
 * automation-started run it holds the RULE'S OWNER, who never asked anything.
 * Matching on it alone would let a rule owner read every run their rules
 * started as if they had asked. So the gate also requires the workflow key and
 * a NULL parent execution, and the tests assert the PREDICATE the query was
 * built with — not just that a read happened.
 *
 * ## 2. Refusal prose never leaves the server
 *
 * A failed step stores the caught exception's `message`. The reader returns the
 * funnel's refusal CODE and drops the prose, because exception text carries
 * module paths and identifiers. The assertion is phrased as an ABSENCE of the
 * prose rather than a presence of the code — a reader that returned
 * `"flue_requires_registered_agent"` and also the sentence would satisfy a
 * presence-only check.
 */
import { makeRequestContext } from '../../helpers/make-context';

const TENANT = 'tenant-result';
const ASKER = 'user-asker';
const RUN = 'run-1';

/** The `where` each read was built with, so the gate can be asserted on shape. */
const queries: Array<{ model: string; where: Record<string, unknown> }> = [];

let runRow: Record<string, unknown> | null = null;
let stepRows: Array<Record<string, unknown>> = [];
let decisionRow: { model: string | null } | null = null;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({
            workflowRun: {
                findFirst: async (args: { where: Record<string, unknown> }) => {
                    queries.push({ model: 'workflowRun', where: args.where });
                    return runRow;
                },
            },
            workflowStep: {
                findMany: async (args: { where: Record<string, unknown> }) => {
                    queries.push({ model: 'workflowStep', where: args.where });
                    return stepRows;
                },
            },
            aiDecisionLog: {
                findFirst: async (args: { where: Record<string, unknown> }) => {
                    queries.push({ model: 'aiDecisionLog', where: args.where });
                    return decisionRow;
                },
            },
        }),
}));

/** The answer reader is J3's and is CALLED, not re-implemented — so it is doubled. */
jest.mock('@/app-layer/usecases/a2a-run-answer', () => ({
    settledRunAnswerText: jest.fn(async () => 'Three controls have no evidence.'),
    A2A_ANSWER_TEXT_MAX: 4000,
}));

import { readAdHocQuestionResult } from '@/app-layer/usecases/ad-hoc-question-result';
import { EMPTY_TOOLSET_MESSAGE } from '@/lib/agentic/flue/empty-toolset-message';

const settledRun = (over: Record<string, unknown> = {}) => ({
    id: RUN,
    status: 'COMPLETED',
    costTokens: 1234,
    errorMessage: null,
    workflowKey: 'ad-hoc-question',
    ...over,
});

const asker = () => makeRequestContext('READER', { tenantId: TENANT, userId: ASKER });

beforeEach(() => {
    queries.length = 0;
    runRow = settledRun();
    stepRows = [];
    decisionRow = { model: 'claude-sonnet-5-5' };
});

const runWhere = () => queries.find((q) => q.model === 'workflowRun')?.where ?? {};

describe('the requester gate is three terms, asserted on the predicate', () => {
    it('narrows a plain reader to their OWN directly-started question run', async () => {
        await readAdHocQuestionResult(asker(), RUN);
        expect(runWhere()).toMatchObject({
            id: RUN,
            tenantId: TENANT,
            startedByUserId: ASKER,
            workflowKey: 'ad-hoc-question',
            // THE LOAD-BEARING TERM. Without it a rule owner reads every run
            // their rules started, because `startedByUserId` on an
            // automation-started run is the rule's owner, not an asker.
            parentExecutionId: null,
        });
    });

    it('does NOT narrow an inventory reader — they read any run', async () => {
        const admin = makeRequestContext('OWNER', { tenantId: TENANT, userId: 'user-admin' });
        await readAdHocQuestionResult(admin, RUN);
        const w = runWhere();
        expect(w).toMatchObject({ id: RUN, tenantId: TENANT });
        // Asserted as ABSENCE of each narrowing term, so a gate that narrowed
        // admins too would fail here rather than quietly making the inventory
        // key useless.
        expect(w).not.toHaveProperty('startedByUserId');
        expect(w).not.toHaveProperty('parentExecutionId');
    });

    it('still scopes on tenantId for both, so RLS is not the only isolation', async () => {
        await readAdHocQuestionResult(asker(), RUN);
        await readAdHocQuestionResult(makeRequestContext('OWNER', { tenantId: TENANT }), RUN);
        for (const q of queries) expect(q.where).toMatchObject({ tenantId: TENANT });
    });

    it('refuses with ONE shape for "no such run" and "not yours"', async () => {
        // Telling them apart would let a caller enumerate which run ids exist.
        runRow = null;
        await expect(readAdHocQuestionResult(asker(), RUN)).rejects.toThrow(/RUN_NOT_READABLE/);
    });

    it('and reads nothing else once the run is not readable', async () => {
        runRow = null;
        await expect(readAdHocQuestionResult(asker(), RUN)).rejects.toThrow();
        expect(queries.filter((q) => q.model !== 'workflowRun')).toEqual([]);
    });
});

describe('refusal prose never leaves the server', () => {
    const PROSE =
        'a Flue run must be started by an ACTIVE registered agent at /srv/app/src/lib/mcp/authorize.ts:1231';

    it('returns the CODE and not one word of the message', async () => {
        stepRows = [
            {
                seq: 1,
                toolCalled: 'list_controls',
                status: 'FAILED',
                outputJson: JSON.stringify({ error: `flue_requires_registered_agent: ${PROSE}` }),
                guardVerdict: null,
            },
        ];
        const out = await readAdHocQuestionResult(asker(), RUN);
        expect(out.toolCalls[0].refusal).toBe('flue_requires_registered_agent');
        // THE DISCLOSURE ASSERTION, phrased as an absence: a reader that
        // returned the code AND the sentence would satisfy a presence-only
        // check. The whole serialised result is searched, not just the field.
        expect(JSON.stringify(out)).not.toContain('authorize.ts');
        expect(JSON.stringify(out)).not.toContain(PROSE);
    });

    it('an unrecognised message yields REFUSED rather than being forwarded', async () => {
        stepRows = [
            {
                seq: 1,
                toolCalled: 'list_risks',
                status: 'FAILED',
                outputJson: JSON.stringify({ error: 'ECONNREFUSED 10.0.3.14:5432' }),
                guardVerdict: null,
            },
        ];
        const out = await readAdHocQuestionResult(asker(), RUN);
        expect(out.toolCalls[0].refusal).toBe('REFUSED');
        // An internal address is exactly the shape a pass-through would leak.
        expect(JSON.stringify(out)).not.toContain('10.0.3.14');
    });

    it('unparseable output yields REFUSED, not a guess from the raw bytes', async () => {
        stepRows = [
            { seq: 1, toolCalled: 't', status: 'FAILED', outputJson: '{not json', guardVerdict: null },
        ];
        const out = await readAdHocQuestionResult(asker(), RUN);
        expect(out.toolCalls[0].refusal).toBe('REFUSED');
        expect(JSON.stringify(out)).not.toContain('not json');
    });

    it('a successful call carries no refusal at all', async () => {
        stepRows = [
            { seq: 1, toolCalled: 'list_controls', status: 'DONE', outputJson: '{"rows":3}', guardVerdict: null },
        ];
        const out = await readAdHocQuestionResult(asker(), RUN);
        expect(out.toolCalls[0].refusal).toBeNull();
    });

    it('but a guard verdict IS reported, because it is a classification not prose', async () => {
        stepRows = [
            { seq: 1, toolCalled: 'list_controls', status: 'FAILED', outputJson: null, guardVerdict: 'BLOCK' },
        ];
        const out = await readAdHocQuestionResult(asker(), RUN);
        expect(out.toolCalls[0].guardVerdict).toBe('BLOCK');
    });
});

describe('the calls come back in execution order', () => {
    it('orders by seq, and the query says so rather than the array happening to be sorted', async () => {
        stepRows = [
            { seq: 1, toolCalled: 'a', status: 'DONE', outputJson: null, guardVerdict: null },
            { seq: 2, toolCalled: 'b', status: 'DONE', outputJson: null, guardVerdict: null },
        ];
        const out = await readAdHocQuestionResult(asker(), RUN);
        expect(out.toolCalls.map((c) => c.seq)).toEqual([1, 2]);
        // Only TOOL_CALL steps: a SYNTHESIS step is not a call the model made.
        expect(queries.find((q) => q.model === 'workflowStep')?.where).toMatchObject({ kind: 'TOOL_CALL' });
    });
});

describe('an empty catalogue is detected two ways, and both are needed', () => {
    it('by the EMPTY_CATALOGUE status, which deploy 2 writes', async () => {
        runRow = settledRun({ status: 'EMPTY_CATALOGUE' });
        expect((await readAdHocQuestionResult(asker(), RUN)).catalogueWasEmpty).toBe(true);
    });

    it('and by the message, which every run BEFORE that deploy carries', async () => {
        // Reading only the status would report `false` for every historical run
        // that actually had the problem — the condition has been recorded in
        // `errorMessage` all along, with the status wrongly COMPLETED.
        runRow = settledRun({ status: 'COMPLETED', errorMessage: EMPTY_TOOLSET_MESSAGE });
        expect((await readAdHocQuestionResult(asker(), RUN)).catalogueWasEmpty).toBe(true);
    });

    it('and a normal run is not reported as empty', async () => {
        expect((await readAdHocQuestionResult(asker(), RUN)).catalogueWasEmpty).toBe(false);
    });
});

describe('the model reported is the one that RAN', () => {
    it('comes from the decision log, keyed on the run', async () => {
        decisionRow = { model: 'claude-opus-5' };
        const out = await readAdHocQuestionResult(asker(), RUN);
        expect(out.model).toBe('claude-opus-5');
        expect(queries.find((q) => q.model === 'aiDecisionLog')?.where).toMatchObject({ sessionRef: RUN });
    });

    it('is null when nothing ran, rather than falling back to what the agent DECLARES', async () => {
        // `RegisteredAgent.modelRef` is a declaration. Reporting it for a run
        // that called no model would state as fact something that did not
        // happen — the same class as an answer-shaped string from a run that
        // consulted nothing.
        decisionRow = null;
        expect((await readAdHocQuestionResult(asker(), RUN)).model).toBeNull();
    });
});

describe('the rest of the result', () => {
    it('carries the answer through J3 reader, the status and the token cost', async () => {
        const out = await readAdHocQuestionResult(asker(), RUN);
        expect(out).toMatchObject({
            runId: RUN,
            status: 'COMPLETED',
            answer: 'Three controls have no evidence.',
            costTokens: 1234,
        });
    });
});
