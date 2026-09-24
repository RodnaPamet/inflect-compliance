/**
 * THE PROPOSAL CAP'S CROSS-SEGMENT SEED SEES BOTH ENGINES.
 *
 * `proposedItemsSoFar` is the only thing that carries a run's proposal spend
 * across segments. Without it a run that pauses — at a checkpoint, or on a
 * guard flag — starts its next segment with an empty PROPOSALS budget and can
 * queue its whole cap again.
 *
 * It filtered on `kind: 'PROPOSE'`, which is what the STATIC driver writes.
 * The Flue driver records every tool call as `kind: 'TOOL_CALL'` carrying the
 * model's raw args, because the run timeline is built from MODEL_CALL and
 * TOOL_CALL. So the query matched nothing a Flue run had written and the seed
 * was structurally always 0.
 *
 * ── WHY THIS FILE IS BEHAVIOURAL ────────────────────────────────────────────
 *
 * The protection that existed was a source-text needle — `flue-propose-charges
 * -the-cap` asserts `execute.ts` CONTAINS the string
 * `proposedItemsSoFar(ctx, runId)`. That line was present throughout, and the
 * seed it names returned 0 for every Flue run ever executed. A test that
 * asserts a call site exists cannot see that the call answers nothing.
 */
const findMany = jest.fn();

// PARTIAL. `@/lib/prisma` reaches this module for its extension chain
// (`withRlsTripwireExtension` and friends), so replacing it wholesale makes
// the suite fail to LOAD — and a suite that cannot load reports `Tests: 0
// total`, which every aggregate scores as a pass.
jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ workflowStep: { findMany } }),
    ),
}));

import { proposedItemsSoFar } from '@/lib/agentic/drivers/run-store';
import { makeRequestContext } from '../helpers/make-context';

const CTX = makeRequestContext('ADMIN');

/** A step row as the STATIC driver records a proposal. */
const staticPropose = (count: number) => ({
    kind: 'PROPOSE',
    toolCalled: 'propose_risks',
    inputJson: JSON.stringify({ count }),
});

/** A step row as the FLUE driver records the same thing: raw args. */
const fluePropose = (items: number) => ({
    kind: 'TOOL_CALL',
    toolCalled: 'propose_risks',
    inputJson: JSON.stringify({ items: Array.from({ length: items }, () => ({})) }),
});

beforeEach(() => jest.clearAllMocks());

describe('the seed counts what each engine actually wrote', () => {
    it('counts a Flue run — the case that was always zero', async () => {
        findMany.mockResolvedValue([fluePropose(3), fluePropose(2)]);
        expect(await proposedItemsSoFar(CTX, 'run-1')).toBe(5);
    });

    it('still counts a static run', async () => {
        findMany.mockResolvedValue([staticPropose(4)]);
        expect(await proposedItemsSoFar(CTX, 'run-1')).toBe(4);
    });

    it('counts a run that switched engines mid-flight', async () => {
        // `WorkflowRun.driver` records the engine a run OPENED under and
        // deliberately does not move, so a definition retargeted between
        // segments leaves both shapes on one run.
        findMany.mockResolvedValue([staticPropose(4), fluePropose(3)]);
        expect(await proposedItemsSoFar(CTX, 'run-1')).toBe(7);
    });

    it('ignores a TOOL_CALL that was not a propose tool', async () => {
        // The discriminator. Counting every tool call would make the cap fire
        // on a run that only ever read.
        findMany.mockResolvedValue([
            { kind: 'TOOL_CALL', toolCalled: 'list_risks', inputJson: JSON.stringify({ items: [{}, {}] }) },
            fluePropose(2),
        ]);
        expect(await proposedItemsSoFar(CTX, 'run-1')).toBe(2);
    });

    it('charges a malformed propose call ONE, never free', async () => {
        // Matches the funnel's own counter: a propose call with no `items`
        // array is still a propose call, and free is the answer a cap cannot
        // recover from.
        findMany.mockResolvedValue([
            { kind: 'TOOL_CALL', toolCalled: 'propose_risks', inputJson: JSON.stringify({ rationale: 'no items key' }) },
        ]);
        expect(await proposedItemsSoFar(CTX, 'run-1')).toBe(1);
    });

    it('reads unparseable args as zero rather than halting a blameless run', async () => {
        findMany.mockResolvedValue([
            { kind: 'TOOL_CALL', toolCalled: 'propose_risks', inputJson: 'not json' },
            { kind: 'TOOL_CALL', toolCalled: 'propose_risks', inputJson: null },
        ]);
        expect(await proposedItemsSoFar(CTX, 'run-1')).toBe(0);
    });

    it('asks the database for BOTH kinds', async () => {
        // The query is the fix. A reader that counted correctly but still
        // filtered on PROPOSE alone would never see a Flue row to count.
        findMany.mockResolvedValue([]);
        await proposedItemsSoFar(CTX, 'run-1');
        const where = findMany.mock.calls[0][0].where;
        expect(where.OR).toEqual([{ kind: 'PROPOSE' }, { kind: 'TOOL_CALL' }]);
    });
});
