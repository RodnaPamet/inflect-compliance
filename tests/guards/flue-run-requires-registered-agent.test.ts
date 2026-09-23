/**
 * A FLUE RUN IS VOUCHED FOR BY THE REGISTER, OR IT DOES NOT START.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 *
 * Plan point 1: "A Flue run must resolve an ACTIVE RegisteredAgent and stamp
 * WorkflowRun.agentId." The stamp was there. The RESOLVE was not, and nothing
 * else on the path supplied it — `agent-runs/route.ts` calls `getTenantCtx`
 * and then `startWorkflowRun`, and `planFlueRun` refuses only on driver, steps
 * and model. An adversarial review of Phase 1 found it, with a positive
 * control proving the search could see a gate if one existed.
 *
 * ── AND THE THIRD DOOR, FOUND LATER ─────────────────────────────────────────
 *
 * This file originally pinned TWO entry points and rested on the premise that
 * they were all of them. They were not. `resumeWorkflowRun` — the human
 * approve-and-continue path — re-resolved the driver and went straight to
 * `executeFrom` with a signed-in human's context, carrying no `agentId` at
 * all. The continuation of an already-authorised run therefore ran with the
 * whole register dropped: no allowlist term, an UNCLAMPED ceiling, no breaker
 * counting, no AI system on the Art 12 row.
 *
 * It was reachable by design rather than by accident: `haltRunAtGuard` settles
 * a FLAGGED verdict to `AWAITING_APPROVAL` precisely so a human comes and
 * resumes it. Flag, approve, and the segment ran unvouched.
 *
 * The lesson is the shape, not the instance — a gate that names the doors it
 * guards is only as good as the enumeration, so the third describe block below
 * pins the resume path and `everyExecuteFromCaller` counts the doors rather
 * than trusting a list.
 *
 * Two callers could therefore start a reasoning loop:
 *
 *   · a key bound to a SUSPENDED or RETIRED agent — an operator had stopped
 *     it, and the engine did not ask;
 *   · a signed-in human with no binding at all, which is worse: with
 *     `ctx.agentId` null, `buildMcpInvocation` leaves `grantedTools` null,
 *     and that is NO ALLOWLIST TERM. The deny-by-default tool list is keyed
 *     on the registered agent, so an unbound caller skips it rather than
 *     being narrowed by it.
 *
 * ── WHY STRUCTURAL ──────────────────────────────────────────────────────────
 *
 * The failing version starts a run that then behaves normally. There is no
 * assertion about the run's OUTPUT that distinguishes it — the difference is
 * which caller was allowed in, and that is a property of the code path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const USECASE = 'src/app-layer/usecases/workflow-runs.ts';

describe('starting a flue run', () => {
    const start = functionBodyOf(read(USECASE), 'startWorkflowRun');

    it('asks the register before the run exists', () => {
        expect(start).toContain('evaluateAgentRegistration');
    });

    it('accepts only a VOUCHED standing — resolved AND active', () => {
        // Not `reason == null`, which honours the tenant's enforcement toggle.
        // A tenant that has not switched enforcement on is not a reason to let
        // an autonomous loop start unvouched.
        expect(start).toMatch(/standing !== 'vouched'/);
    });

    it('gates only the FLUE driver, leaving static runs unchanged', () => {
        // A static run walks a hand-written step array and carries the key's
        // own scopes — the same posture any direct MCP call has. Gating it
        // here would change every existing run's contract for no new safety.
        const gate = start.slice(start.indexOf('evaluateAgentRegistration') - 400);
        expect(gate).toMatch(/chosenDriver === 'flue'/);
    });

    it('refuses ABOVE the row creation, not after it', () => {
        // A refusal after `createSealedRun` leaves a RUNNING row nothing will
        // advance, which the reaper later reports as a crashed executor — a
        // refusal wearing the costume of an outage.
        expect(start.indexOf('evaluateAgentRegistration')).toBeLessThan(
            start.indexOf('createSealedRun('),
        );
    });
});

describe('resuming a flue run in the worker', () => {
    const queued = functionBodyOf(read(USECASE), 'executeQueuedWorkflowRun');
    const check = functionBodyOf(read(USECASE), 'runAgentStillInService');

    it('re-validates the agent, as it already re-validates the member and the key', () => {
        // The gap the review found: membership and key were both re-read and
        // both failed closed, and the one principal that IS an agent was the
        // one not re-checked.
        expect(queued).toContain('runAgentStillInService');
    });

    it('accepts only an ACTIVE agent', () => {
        expect(check).toMatch(/status: 'ACTIVE'/);
    });

    it('settles the run rather than leaving it RUNNING for the reaper', () => {
        // "The agent was stopped" is an answer an operator wants; a wedged row
        // is not.
        const arm = queued.slice(queued.indexOf('runAgentStillInService'));
        expect(arm).toContain('failRun');
        expect(arm).toContain('AGENT_NOT_ACTIVE');
    });

    it('has nothing to say about a run with no agent', () => {
        // A run with no `agentId` cannot be a flue run — the start gate
        // refuses those — so this is the static engine's row and the register
        // does not govern it. Asserted so the check cannot quietly start
        // failing static runs.
        expect(check).toMatch(/if \(!agentId\) return true;/);
    });
});

describe('the justification that was false is corrected', () => {
    // RAW, not `read()`. Every other assertion in this file masks comments,
    // because code is the subject and a comment quoting a pattern must not
    // satisfy a check for it. Here the COMMENT IS THE SUBJECT: it vouched for
    // a gate that did not exist, which is how the absence survived review — a
    // reader asking whether the funnel should assert found a sentence saying
    // someone else already had. Masking would blank the very thing under test.
    const raw = fs.readFileSync(path.join(ROOT, 'src/lib/mcp/auth.ts'), 'utf8');

    it('no longer claims the engine route already gated the register', () => {
        expect(raw).not.toContain(
            "engine's own route has already decided whether the caller may start a run",
        );
    });

    it('says plainly that the claim was wrong, rather than quietly deleting it', () => {
        // A silent correction loses the reason the next reader needs: that the
        // sentence was believed, and that believing it is what let the gap sit.
        expect(raw).toContain('has been CORRECTED');
    });
});

describe('resuming a flue run as a HUMAN — the third door', () => {
    /**
     * WHOLE-FILE, not `functionBodyOf`.
     *
     * `resumeWorkflowRun` returns
     * `Promise<{ status: string; stepFailures: number }>`, and a return type
     * carrying braces is exactly what that helper mis-bounds on — it stops at
     * the type's closing brace and hands back the signature. Every assertion
     * below would then have been satisfied by nothing, which is the failure
     * shape that reads as a pass. Each needle used here was verified unique in
     * the file (1 occurrence apiece), so the wider read costs no precision.
     */
    const resume = read(USECASE);

    it('re-checks the agent is still in service', () => {
        // The worker's resume does this; the human's did not. An agent
        // suspended while the run sat at a checkpoint must not have the run
        // continue on its behalf — suspension is an operator stopping an
        // agent, and an approval is not a way around it.
        expect(resume).toContain('runAgentStillInService(ctx.tenantId, run.agentId)');
        expect(resume).toContain('resume_agent_no_longer_in_service');
    });

    it('and refuses BEFORE the checkpoint is closed', () => {
        // Ordering, asserted by position. A refusal after the step is DONE and
        // the row is RUNNING leaves a run nothing will advance, which the
        // reaper later reports as a crashed executor. The start path makes the
        // same argument for putting its gate above `createSealedRun`.
        const gate = resume.indexOf('resume_agent_no_longer_in_service');
        const close = resume.indexOf('status: \'DONE\', actorUserId: ctx.userId');
        expect(gate).toBeGreaterThan(-1);
        expect(close).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(close);
    });

    it('restores the run\'s agent binding onto the executing context', () => {
        // The human stays the ACTOR — the audit entry and the checkpoint step
        // both take their userId — while the EXECUTION carries the agent the
        // run was authorised under, so every register term applies to the
        // continuation as it did to the first segment.
        expect(resume).toContain('const execCtx: RequestContext = run.agentId ? { ...ctx, agentId: run.agentId } : ctx');
    });

    it('and hands THAT context to the engine, not the bare one', () => {
        // The assertion with teeth. Building `execCtx` and then passing `ctx`
        // would look completely correct at a glance and change nothing at all.
        // `await executeFrom(` occurs three times in this file, so the slice
        // is anchored on `execCtx` — the one thing unique to the resume's
        // call — rather than on the first match, which is the start path's.
        const at = resume.indexOf('execCtx,');
        expect(at).toBeGreaterThan(-1);
        const before = resume.slice(Math.max(0, at - 300), at);
        expect(before).toContain('await executeFrom(');
    });
});

describe('the doors are counted, not listed', () => {
    it('every caller of executeFrom is one this file pins', () => {
        // THE ASSERTION THAT WOULD HAVE CAUGHT THE THIRD DOOR. The file used
        // to name two entry points and assume that was all of them; a fourth
        // caller added tomorrow would inherit the same blind spot. Counting
        // the callers turns "we listed the doors" into "there are exactly
        // these doors", which is a claim that can go red.
        const src = read(USECASE);
        const callers = src.split('await executeFrom(').length - 1;
        expect({ executeFromCallSites: callers }).toEqual({ executeFromCallSites: 3 });
    });
});
