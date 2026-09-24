/**
 * A QUEUED RUN EXECUTES AS THE PRINCIPAL THAT STARTED IT — NEVER AS AN ADMIN.
 *
 * ── THE DEFECT THIS EXISTS TO PREVENT ───────────────────────────────────────
 *
 * Moving execution into the worker means the run no longer has a request, and
 * the obvious way to give a job a `RequestContext` is the one several jobs in
 * this repo already use: find the first active OWNER/ADMIN of the tenant and
 * run as them. `risk-appetite-jobs.ts` does exactly that, correctly, because a
 * portfolio sweep belongs to the platform.
 *
 * It would be wrong here, and not by a little. A run's authority is the
 * intersection of the agent's registration, the key's scopes, the autonomy
 * ceiling and the policy card of the principal who STARTED it. Running it as
 * an admin hands it a different — almost certainly wider — authority than the
 * one it was authorised under, inside the subsystem whose entire claim is that
 * multi-step does not mean multi-privilege.
 *
 * The failure would be invisible: the run succeeds, the ledger looks normal,
 * and the only evidence is that a tool the starting principal could not reach
 * returned data. So this is a structural guard, not a behavioural one — it
 * pins the SHAPE of the reconstruction rather than waiting for a run that
 * exercises the difference.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const USECASE = 'src/app-layer/usecases/workflow-runs.ts';

describe('the worker rebuilds the run’s own principal', () => {
    const rebuild = functionBodyOf(read(USECASE), 'rebuildRunContext');

    it('reads the principal off the run row', () => {
        // `startedByUserId` is the whole point: the row records who asked, and
        // that is who the run acts as.
        expect(rebuild).toContain('startedByUserId');
    });

    it('never substitutes an admin', () => {
        // The precedent it must NOT follow. `risk-appetite-jobs` selects the
        // first active OWNER/ADMIN; reaching for that shape here is the defect.
        expect(rebuild).not.toMatch(/OWNER/);
        expect(rebuild).not.toMatch(/'ADMIN'/);
    });

    it('requires an ACTIVE membership and fails closed without one', () => {
        // A queued job must not be a way for authority to outlive the grant
        // that created it.
        expect(rebuild).toContain("status: 'ACTIVE'");
        expect(rebuild).toContain('return null');
    });

    it('re-reads the key rather than trusting the enqueue', () => {
        // Scopes are CURRENT authority. A key narrowed or revoked between
        // enqueue and execution must narrow the run with it — and an expired
        // key is as gone as a revoked one.
        expect(rebuild).toContain('tenantApiKey');
        expect(rebuild).toContain('revokedAt: null');
        expect(rebuild).toContain('expiresAt');
    });

    it('carries the agent id through, so the register still binds', () => {
        // Without this the run executes with no `agentId`, and the deny-by-
        // default tool allowlist keyed on the registered agent stops applying.
        expect(rebuild).toContain('agentId');
    });

    it('does NOT relabel the actor as a job', () => {
        // The worker is only WHERE this runs. The run was asked for by a
        // person or a key, and the audit trail must keep saying so or a review
        // cannot tell an agent's work from a platform sweep's.
        expect(rebuild).not.toContain("actorType: 'JOB'");
    });
});

describe('the queued path resumes rather than restarts', () => {
    const execute = functionBodyOf(read(USECASE), 'executeQueuedWorkflowRun');

    it('derives the resume point from the ledger, not the payload', () => {
        // The steps that call tools are not idempotent, so a retry after a
        // SIGTERM must not re-run one the run already committed.
        expect(execute).toContain('row.stepCount');
    });

    it('is idempotent — a settled run is not restarted', () => {
        // BullMQ can deliver a job more than once, and a human may have
        // aborted the run in between.
        expect(execute).toMatch(/status !== 'RUNNING'/);
    });

    it('measures the wall clock from the RUN’s start, not this attempt’s', () => {
        // Otherwise each retry buys a fresh hour and the cap means nothing.
        expect(execute).toContain('row.startedAt.getTime()');
    });
});

describe('only the reasoning engine goes to the worker', () => {
    const start = functionBodyOf(read(USECASE), 'startWorkflowRun');

    it('enqueues when the resolved driver is flue', () => {
        expect(start).toMatch(/chosenDriver === 'flue'/);
        expect(start).toContain("enqueue('agent-run-execute'");
    });

    it('still executes a static run inline', () => {
        // A static run is a bounded walk over a hand-written step array with
        // no model call in it. Moving it too would change the contract of
        // every existing run — the route returns a terminal status today —
        // for no benefit that engine needs.
        expect(start).toContain('await executeFrom(');
    });

    it('enqueues the ids only, never a resume index', () => {
        // A payload-carried `fromSeq` is how a retry re-executes a committed
        // step. The ledger is the only honest source.
        const payload = start.slice(start.indexOf("enqueue('agent-run-execute'"));
        expect(payload).not.toMatch(/fromSeq/);
    });
});

describe('the RESUME door goes to the worker too', () => {
    // `functionBodyOf` CANNOT be used here, and the reason is worth recording:
    // it mis-bounds on a return type containing braces, and
    // `resumeWorkflowRun` returns `Promise<{ status: string; stepFailures:
    // number }>`. It hands back 136 characters — the signature — so every
    // `toContain` below would have been asserted against a string that holds
    // none of the function, failing for a reason unrelated to the claim.
    const src = read(USECASE);
    const from = src.indexOf('export async function resumeWorkflowRun');
    const rest = src.slice(from + 1);
    const nextTop = rest.indexOf('\nexport async function ');
    const resume = nextTop === -1 ? rest : rest.slice(0, nextTop);

    it('the slice is the function — otherwise every assertion below is vacuous', () => {
        // The denominator. A slice that missed would make the rest of this
        // describe pass or fail on nothing, which is exactly the failure the
        // note above describes.
        expect(from).toBeGreaterThan(-1);
        expect(resume).toContain('resumedFrom');
        expect(resume).toContain('executeFrom(');
        expect(resume.length).toBeGreaterThan(2000);
    });

    it('enqueues a flue resume instead of running it in the request', () => {
        // `startWorkflowRun` moved the reasoning loop to the worker and said
        // why — "never the web tier", and the worker is where the shutdown
        // drain lives. This path branched on the driver for the register gate
        // and then called `executeFrom` inline regardless, so a human approval
        // ran the whole model loop inside a Next.js POST handler.
        expect(resume).toMatch(/resumeDriver === 'flue'/);
        expect(resume).toContain("enqueue('agent-run-execute'");
    });

    it('persists the resume point before handing off', () => {
        // The worker resumes from `row.stepCount`; this path computed
        // `resumedFrom + 1` and passed it as an argument, which does not
        // survive the hop. Writing it is what makes the two the same number.
        const handoff = resume.slice(resume.indexOf("resumeDriver === 'flue'"));
        expect(handoff).toContain('stepCount: resumedFrom + 1');
        expect(handoff.indexOf('stepCount: resumedFrom + 1')).toBeLessThan(
            handoff.indexOf("enqueue('agent-run-execute'"),
        );
    });

    it('still resumes a static run inline', () => {
        // Same argument the start path makes: a bounded walk with no model
        // call in it is finished well inside a request, and moving it would
        // change the contract of every existing run.
        expect(resume).toContain('await executeFrom(');
    });

    it('enqueues the ids only, never a resume index', () => {
        // A payload-carried `fromSeq` is how a retry re-executes a committed
        // step. The ledger is the only honest source — which is why the seq is
        // written to the ROW above rather than put in the message.
        const payload = resume.slice(resume.indexOf("enqueue('agent-run-execute'"));
        expect(payload.slice(0, 200)).not.toMatch(/fromSeq/);
    });
});
