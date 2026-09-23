/**
 * A guard verdict on the Flue engine reaches the controls that exist for it.
 *
 * ── THE TWO HOLES THIS CLOSES ───────────────────────────────────────────────
 *
 * Both are the same defect seen from different ends: a Flue guard outcome
 * produced nothing any surrounding control could read.
 *
 * 1. THE RUN STATUS. `review.check` leaves by THROWING on both of its refusal
 *    paths, so every block and every flag arrived in `executeFlueRun`'s catch
 *    and was settled `flue_run_failed: <the throw's message>` — a control
 *    outcome reported as a crash, sending an operator to debug a workflow that
 *    worked perfectly. And `policy.ts` states the FLAGGED contract as "allow,
 *    but force human review; NEVER auto-commit", while nothing in this engine
 *    could produce `AWAITING_APPROVAL` at all.
 *
 * 2. THE CIRCUIT BREAKER. `latchOnGuardBlock` counted `AgentProposal` rows with
 *    `guardVerdict: 'QUARANTINED'`. The static driver's guard fires on a
 *    proposal, so that was the whole story for it. The Flue guard fires in the
 *    tool sandwich BEFORE the funnel — deliberately — so a blocked call queues
 *    no proposal AND never reaches `authorize.ts`, where the per-call ledger is
 *    written. A Flue agent was invisible on both of the breaker's inputs, which
 *    means the control that exists to stop a rogue agent could not see the
 *    engine most able to be one.
 *
 * ── WHY THESE ARE SOURCE ASSERTIONS ─────────────────────────────────────────
 *
 * `executeFlueRun` cannot be imported under the `node` jest project at all:
 * it reaches `@flue/runtime`, which is ESM-only. So the wiring is read off the
 * source, bound to the functions that own it. The parts that CAN be exercised
 * — the settle arm's own choice of status, and the breaker's arithmetic — are
 * tested behaviourally in `tests/unit/`.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { codeOf, functionBodyOf } from '../helpers/source-blocks';

/**
 * `ROOT` computed LOCALLY — `tests/helpers/assertion-reach.ts` constant-folds a
 * `path.resolve(__dirname, …)` and declines an imported identifier, which would
 * put every assertion here in the Class D un-analysable set.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(readFileSync(path.join(ROOT, rel), 'utf8'));

const EXECUTE = 'src/lib/agentic/flue/execute.ts';
const SETTLEMENT = 'src/lib/agentic/drivers/run-settlement.ts';
const BREAKER = 'src/lib/agentic/circuit-breaker-store.ts';

const dispatch = functionBodyOf(read(EXECUTE), 'executeFlueRun');
const guardSettle = functionBodyOf(read(SETTLEMENT), 'haltRunAtGuard');
/**
 * WHOLE-FILE, not `functionBodyOf`.
 *
 * `latchOnGuardBlock`'s signature returns
 * `Promise<{ blocksInWindow: number; latched: boolean }>`, and a return type
 * carrying braces is precisely what `functionBodyOf` mis-bounds on — it stops
 * at the type's closing brace and hands back the signature. Every assertion
 * below would then have been satisfied by nothing, which is the failure mode
 * that reads as a pass. The needles used against it are each unique in the
 * file (verified: 1 occurrence apiece), so a whole-file read costs no
 * precision here.
 */
const breakerSrc = read(BREAKER);

describe('a guard verdict settles the run as a guard verdict', () => {
    it('both exit paths consult the guard, not just the thrown one', () => {
        // TWO call sites, and that is the assertion. A flag on the LAST tool
        // call lets the dispatch finish tidily, so a fix applied only to the
        // catch would settle a thrown flag correctly and report a tidy one
        // COMPLETED — the same "guard ran and changed nothing" shape, just
        // narrower.
        const calls = dispatch.split('await settleAtGuard()').length - 1;
        expect(calls).toBe(2);
    });

    it('and the cap still wins, because a run that hit the cap hit the cap', () => {
        // Ordering, asserted by position. `latch.halt` is checked first on both
        // paths; a guard arm placed above it would relabel a capped run as a
        // guard halt and hide the ceiling an operator set.
        const firstCap = dispatch.indexOf('haltRunAtCap(');
        const firstGuard = dispatch.indexOf('await settleAtGuard()');
        expect(firstCap).toBeGreaterThan(-1);
        expect(firstGuard).toBeGreaterThan(firstCap);
    });

    it('the verdict is folded where it happens, not read back from `seen`', () => {
        // `seen` is CONSUMED — `takeVerdict` removes each entry as its step is
        // recorded — so by settle time it is empty and cannot answer "did a
        // guard fire". A fix that read it back would be green on a one-call run
        // and wrong on every other.
        expect(dispatch).toContain("let worst: StepGuardObservation['verdict'] = 'CLEAN'");
        expect(dispatch).toContain('if (RANK[o.verdict] > RANK[worst])');
    });

    it('a clean run is not settled by this arm at all', () => {
        expect(functionBodyOf(read(EXECUTE), 'executeFlueRun')).toContain(
            "if (worst === 'CLEAN') return null;",
        );
    });
});

describe('the two verdicts settle differently, because they mean different things', () => {
    it('a block ABORTS — there is nothing to approve', () => {
        expect(guardSettle).toContain("const blocked = verdict === 'QUARANTINED'");
        expect(guardSettle).toContain("blocked ? 'ABORTED' : 'AWAITING_APPROVAL'");
    });

    it('a flag goes to AWAITING_APPROVAL, which is what its contract says', () => {
        // `policy.ts`: "allow, but force human review; NEVER auto-commit".
        // AWAITING_APPROVAL is the one status that means that, and
        // `resumeWorkflowRun` accepts it.
        expect(guardSettle).toContain('AWAITING_APPROVAL');
        expect(read('src/app-layer/usecases/workflow-runs.ts')).toContain(
            "run.status !== 'AWAITING_APPROVAL' && run.status !== 'PAUSED'",
        );
    });

    it('a flagged run is NOT stamped completed — a human is still expected', () => {
        // The reaper leaves AWAITING_APPROVAL alone however old it is, which
        // only makes sense if the run is genuinely unfinished.
        expect(guardSettle).toContain('...(blocked ? { completedAt: new Date() } : {})');
    });

    it('it is not `failRun`, and says why in its own message', () => {
        // The distinction `haltRunAtCap` already draws: `failRun` says a step
        // went wrong. Nothing went wrong here.
        expect(guardSettle).toContain('flue_run_guard_blocked:');
        expect(guardSettle).toContain('flue_run_guard_flagged:');
        expect(guardSettle).not.toContain("status: 'FAILED'");
    });

    it('carries the RULE IDS and not the content that tripped them', () => {
        expect(guardSettle).toContain('ruleIds.join(', );
        // The content is the thing the guard exists to contain; it must not be
        // copied into an errorMessage an operator surface renders.
        expect(guardSettle).not.toContain('outcome.text');
        expect(guardSettle).not.toContain('reply.text');
    });

    it('and leaves an audit row naming which way it went', () => {
        expect(guardSettle).toContain("action: blocked ? 'WORKFLOW_RUN_GUARD_BLOCKED' : 'WORKFLOW_RUN_GUARD_FLAGGED'");
    });

    it('adds no new WorkflowRunStatus value', () => {
        // `haltRunAtCap`'s docstring carries the argument: an enum member is
        // safe to WRITE under a rolling deploy and unsafe to READ. Both values
        // this arm uses already ship.
        const schema = read('prisma/schema/enums.prisma');
        expect(schema).toContain('AWAITING_APPROVAL');
        expect(schema).toContain('ABORTED');
        expect(guardSettle).not.toContain('GUARD_BLOCKED\n');
    });
});

describe('the circuit breaker can see a Flue block', () => {
    it('counts the step ledger as well as the proposal queue', () => {
        // The proposal count alone was blind to the entire Flue engine.
        //
        // The SUM line is the needle that carries the whole claim: it names
        // both operands, so it cannot be satisfied unless both populations are
        // counted and combined. `prisma.agentProposal.count(` on its own would
        // be a poor needle anyway — it occurs five times in this file.
        expect(breakerSrc).toContain('prisma.workflowStep.count(');
        expect(breakerSrc).toContain('const blocksInWindow = proposalBlocks + stepBlocks;');
    });

    it('scopes the step count to THIS agent, through the run that owns it', () => {
        // Without the relation filter the count would be every tenant step,
        // and one noisy agent would trip every other agent's breaker.
        expect(breakerSrc).toContain('run: { agentId }');
    });

    it("windows on the STEP's own stamp, not the run's start", () => {
        // A run that began before this window and was blocked inside it was
        // blocked inside it.
        expect(breakerSrc).toContain('at: { gte: since }');
    });

    it('and the engine actually calls it on a block', () => {
        // The count is only reachable if something invokes the latch. Before
        // this, `latchOnGuardBlock` had exactly one caller and it was the
        // proposal path.
        expect(dispatch).toContain('await latchOnGuardBlock(ctx.tenantId, ctx.agentId, new Date())');
        expect(dispatch).toContain("if (worst === 'QUARANTINED' && ctx.agentId)");
    });

    it('only on a block — a flag is not a breaker signal', () => {
        // The breaker's threshold is three BLOCKS. Counting flags would trip it
        // on traffic the policy explicitly allows subject to review.
        const arm = dispatch.slice(dispatch.indexOf('const settleAtGuard'));
        const call = arm.indexOf('latchOnGuardBlock');
        const guardCond = arm.indexOf("worst === 'QUARANTINED'");
        expect(guardCond).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(guardCond);
    });
});
