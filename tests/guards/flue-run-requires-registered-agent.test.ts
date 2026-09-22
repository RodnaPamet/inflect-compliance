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
