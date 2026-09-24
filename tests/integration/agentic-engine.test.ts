/**
 * Integration coverage: the agentic workflow engine end-to-end (real DB, real
 * RLS, real MCP tools). Proves the load-bearing properties:
 *   - a trivial READ → SYNTHESIS run COMPLETES with an audited step trail;
 *   - a run with a PROPOSE step queues a PENDING proposal (commits NOTHING) and
 *     PAUSES at its HUMAN_CHECKPOINT (AWAITING_APPROVAL) until a human resumes;
 *   - resume continues the run to completion;
 *   - abort mid-run stops cleanly (ABORTED), nothing half-applied.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import {
    startWorkflowRun,
    resumeWorkflowRun,
    abortWorkflowRun,
    getWorkflowRun,
} from '@/app-layer/usecases/workflow-runs';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `wfe-${randomUUID().slice(0, 8)}`;
const TENANT = `wf-${SUITE}`;
const USER = `u-${TENANT}`;
const PROPOSE_WF = `test-propose-${SUITE}`;
const READ_WF = `test-read-${SUITE}`;
const SYNTH_WF = `test-synth-${SUITE}`;
const CHECKPOINT_ONLY_WF = `test-checkpoint-${SUITE}`;

const ctx = () => makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

describeFn('Agentic workflow engine (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: TENANT, slug: TENANT } });
        const email = `${TENANT}@example.test`;
        await prisma.user.upsert({ where: { id: USER }, update: {}, create: { id: USER, email, emailHash: hashForLookup(email) } });
        for (let i = 0; i < 2; i++) {
            await prisma.risk.create({
                data: { tenantId: TENANT, title: `${TENANT}-risk-${i}`, description: 'x', category: 'Cybersecurity', impact: 3, likelihood: 3, score: 9, inherentScore: 9, status: 'OPEN', createdByUserId: USER },
            });
        }
        // A test workflow with a PROPOSE step + a HUMAN_CHECKPOINT.
        registerWorkflow({
            key: READ_WF,
            name: 'read only',
            description: 'one READ step, so the READ charge can be attributed to it alone',
            steps: [{ kind: 'READ', label: 'posture', tool: 'get_compliance_posture' }],
        });
        registerWorkflow({
            key: SYNTH_WF,
            name: 'synthesis only',
            description: 'one SYNTHESIS step, the kind a token counter is most likely to forget',
            steps: [{ kind: 'SYNTHESIS', label: 'summary', synthesize: () => ({ text: 'a synthesised answer long enough to estimate' }) }],
        });
        registerWorkflow({
            key: CHECKPOINT_ONLY_WF,
            name: 'checkpoint only',
            description: 'one HUMAN_CHECKPOINT, which must spend nothing',
            steps: [{ kind: 'HUMAN_CHECKPOINT', label: 'review', approvalWindow: '24h' }],
        });
        registerWorkflow({
            key: PROPOSE_WF,
            name: 'Test propose workflow',
            description: 'read → propose a risk → checkpoint → synthesis',
            steps: [
                { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
                {
                    kind: 'PROPOSE', label: 'proposed', tool: 'propose_risks',
                    buildItems: () => [{ title: 'Agentic proposed risk', description: 'from a workflow' }],
                },
                { kind: 'HUMAN_CHECKPOINT', label: 'review', approvalWindow: '24h' },
                { kind: 'SYNTHESIS', label: 'summary', synthesize: () => ({ text: 'workflow complete' }) },
            ],
        });
    });

    afterAll(async () => {
        await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.risk.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.user.deleteMany({ where: { id: USER } }).catch(() => {});
        await prisma.$disconnect();
    });

    it('a trivial diagnostic run COMPLETES with an audited step trail', async () => {
        const result = await startWorkflowRun(ctx(), 'diagnostic', {});
        expect(result.status).toBe('COMPLETED');

        const run = await getWorkflowRun(ctx(), result.runId);
        expect(run.status).toBe('COMPLETED');
        expect(run.steps.map((s) => s.kind)).toEqual(['READ', 'SYNTHESIS']);
        expect(run.steps.every((s) => s.status === 'DONE')).toBe(true);
        expect(run.summary).toMatch(/Posture snapshot/);

        // Every step audited.
        const auditRows = await prisma.auditLog.count({ where: { tenantId: TENANT, action: 'WORKFLOW_STEP' } });
        expect(auditRows).toBeGreaterThanOrEqual(2);
    });

    it('a PROPOSE step queues a PENDING proposal + PAUSES at the checkpoint (commits nothing)', async () => {
        const risksBefore = await prisma.risk.count({ where: { tenantId: TENANT } });
        const result = await startWorkflowRun(ctx(), PROPOSE_WF, {});
        // Ran READ + PROPOSE, then paused at the HUMAN_CHECKPOINT.
        expect(result.status).toBe('AWAITING_APPROVAL');

        // A PENDING proposal was queued — but NO real risk was created.
        const proposal = await prisma.agentProposal.findFirst({ where: { tenantId: TENANT, kind: 'RISK', status: 'PENDING' } });
        expect(proposal).toBeTruthy();
        const risksAfter = await prisma.risk.count({ where: { tenantId: TENANT } });
        expect(risksAfter).toBe(risksBefore);

        // The run is parked awaiting a human.
        const run = await getWorkflowRun(ctx(), result.runId);
        expect(run.status).toBe('AWAITING_APPROVAL');
        expect(run.steps.some((s) => s.kind === 'PROPOSE' && s.status === 'DONE')).toBe(true);
        expect(run.steps.some((s) => s.kind === 'HUMAN_CHECKPOINT' && s.status === 'PENDING')).toBe(true);

        // Resume → continues to completion.
        const resumed = await resumeWorkflowRun(ctx(), result.runId);
        expect(resumed.status).toBe('COMPLETED');
        const done = await getWorkflowRun(ctx(), result.runId);
        expect(done.status).toBe('COMPLETED');
        expect(done.steps.find((s) => s.kind === 'HUMAN_CHECKPOINT')?.status).toBe('DONE');
    });

    it('the queued proposal traces back to the exact step that produced it', async () => {
        // `AgentProposal.(runId, stepSeq)` has existed since the provenance
        // migration and NOTHING WROTE IT — the implementation note said so
        // outright: "nothing in the product writes to any of it yet". So every
        // row carried NULL in both columns, and the question the pair exists to
        // answer — which step decided this — was unanswerable for every
        // proposal the engine had ever queued.
        const result = await startWorkflowRun(ctx(), PROPOSE_WF, {});
        const run = await getWorkflowRun(ctx(), result.runId);

        const proposal = await prisma.agentProposal.findFirst({
            where: { tenantId: TENANT, runId: result.runId },
            select: { runId: true, stepSeq: true },
        });
        expect(proposal).not.toBeNull();

        // BOTH halves, and the pair addressing a step that REALLY EXISTS in
        // this run's ledger. Asserting `runId` alone would pass against a
        // stepSeq of null, which the database would have refused anyway; the
        // claim worth making is that the ordinal lands on a recorded step.
        const target = run.steps.find((s) => s.seq === proposal?.stepSeq);
        expect({
            runId: proposal?.runId,
            landsOnARecordedStep: target !== undefined,
            thatStepsKind: target?.kind,
        }).toEqual({
            runId: result.runId,
            landsOnARecordedStep: true,
            // …and it is the PROPOSE step, not merely some step. A writer that
            // passed the loop index, or the step count, or zero would satisfy
            // every assertion above and point at the wrong row.
            thatStepsKind: 'PROPOSE',
        });
    });

    it('the RUN carries the proposals it produced, and only the columns a browser may see', async () => {
        // THE OTHER DIRECTION of the backlink, and the half nothing exercised.
        //
        // The test above asks `prisma.agentProposal` directly, which proves the
        // COLUMNS are written and says nothing about whether the run surface
        // can reach them. `/agents/runs/[runId]` does not query proposals — it
        // reads `run.proposals` off this usecase and groups them onto steps, so
        // an include that returns an empty array leaves the page rendering a
        // PROPOSE step that names nothing, with every rendered test still
        // green: they are handed already-grouped props.
        const result = await startWorkflowRun(ctx(), PROPOSE_WF, {});
        const run = await getWorkflowRun(ctx(), result.runId);

        const proposeStep = run.steps.find((s) => s.kind === 'PROPOSE');
        expect({
            arrived: run.proposals.length,
            allNameTheProposeStep:
                run.proposals.length > 0 &&
                run.proposals.every((p) => p.stepSeq === proposeStep?.seq),
        }).toEqual({ arrived: 1, allNameTheProposeStep: true });

        // ── THE SELECT IS A BOUNDARY, NOT A CONVENIENCE ─────────────────────
        //
        // This usecase is returned VERBATIM by `GET /agent-runs/:id`, so every
        // column the include names is a column that reaches a browser — and an
        // `AgentProposal` carries `payloadJson`, which the proposals surface
        // deliberately withholds and replaces with a server-computed diff.
        // Widening the include here is a one-word edit that reopens that in a
        // different route, and the type system cannot object: adding a field is
        // additive at every reader.
        //
        // EXACT key-set equality rather than `not.toHaveProperty('payloadJson')`
        // — the named column is only today's instance. `rationale`,
        // `guardRuleIds` and `proposedBySessionRef` are the same class of
        // mistake, and an exact set is the only assertion that objects to a
        // column nobody has thought of yet.
        expect(Object.keys(run.proposals[0]).sort()).toEqual([
            'createdAt',
            'guardVerdict',
            'id',
            'kind',
            'operation',
            'status',
            'stepSeq',
        ]);
    });

    it('a proposal made OUTSIDE a run still carries no run — absence is an answer', async () => {
        // The other half of the optional `origin`. `runProposeTool` has three
        // callers and only one is inside a workflow; if the field had acquired
        // a fallback, a direct propose would have started inventing a run.
        const outside = await prisma.agentProposal.findFirst({
            where: { tenantId: TENANT, runId: null },
            select: { runId: true, stepSeq: true },
        });
        // There may or may not be such a row in this suite's data — what must
        // never happen is a row with one half set.
        const halfSet = await prisma.agentProposal.count({
            where: {
                tenantId: TENANT,
                OR: [
                    { runId: null, stepSeq: { not: null } },
                    { runId: { not: null }, stepSeq: null },
                ],
            },
        });
        expect({ halfSet, outsideIsFullyNull: outside ? outside.stepSeq === null : true }).toEqual({
            halfSet: 0,
            outsideIsFullyNull: true,
        });
    });

    it('abort mid-run stops cleanly (ABORTED)', async () => {
        const result = await startWorkflowRun(ctx(), PROPOSE_WF, {});
        expect(result.status).toBe('AWAITING_APPROVAL');
        await abortWorkflowRun(ctx(), result.runId);
        const run = await getWorkflowRun(ctx(), result.runId);
        expect(run.status).toBe('ABORTED');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  costTokens ACCUMULATES ACROSS ALL KINDS
    //
    //  Plan point 5: "`costTokens` accumulates across ALL kinds, so a loop
    //  cannot escape the cap by spending in a kind the counter ignores."
    //
    //  The implementation was there and NOTHING PROTECTED IT. An audit grepped
    //  the whole test tree for an `expect` touching `costTokens` and found
    //  exactly one — a source-text needle (`toContain('costTokens +=
    //  usage.totalTokens')`) narrowed to the FLUE dispatch. So all three of the
    //  static engine's charge sites could be deleted and every test stayed
    //  green: the escape the bullet names was reachable with no test to notice.
    //
    //  These are per-KIND on purpose. A single workflow exercising all four
    //  proves the total moved; it cannot say WHICH kind moved it, and the
    //  bullet's whole claim is about the kind a counter forgets. One workflow
    //  per kind maps each assertion to one charge site.
    // ─────────────────────────────────────────────────────────────────────
    describe('the token counter charges every kind that spends', () => {
        const runRow = (runId: string) =>
            prisma.workflowRun.findFirstOrThrow({ where: { id: runId, tenantId: TENANT } });

        it('a READ step is charged', async () => {
            const { runId } = await startWorkflowRun(ctx(), READ_WF, {});
            expect((await runRow(runId)).costTokens).toBeGreaterThan(0);
        });

        it('a SYNTHESIS step is charged — the kind most easily forgotten', async () => {
            // SYNTHESIS calls no tool and hits no network; it is the arm a
            // reader is most likely to think costs nothing, and the one the
            // plan's "a kind the counter ignores" is really about.
            const { runId } = await startWorkflowRun(ctx(), SYNTH_WF, {});
            expect((await runRow(runId)).costTokens).toBeGreaterThan(0);
        });

        it('a HUMAN_CHECKPOINT is charged NOTHING', async () => {
            // The other direction, and it is not decoration: if every kind
            // charged, the assertions above would pass under an implementation
            // that charged a flat fee per step and attributed nothing. A pause
            // spends no tokens, and saying so is what makes the rest mean
            // something.
            const { runId } = await startWorkflowRun(ctx(), CHECKPOINT_ONLY_WF, {});
            const row = await runRow(runId);
            expect(row.status).toBe('AWAITING_APPROVAL');
            expect(row.costTokens).toBe(0);
        });

        it('a PROPOSE step adds to what the READ before it already spent', async () => {
            // Attribution without a per-step column: the run pauses at its
            // checkpoint having done READ + PROPOSE, so the total at that point
            // is both charges. Asserting it exceeds a READ-only run's total is
            // what pins the PROPOSE arm specifically.
            const readOnly = await startWorkflowRun(ctx(), READ_WF, {});
            const readOnlyTokens = (await runRow(readOnly.runId)).costTokens;

            const paused = await startWorkflowRun(ctx(), PROPOSE_WF, {});
            expect(paused.status).toBe('AWAITING_APPROVAL');
            const atCheckpoint = (await runRow(paused.runId)).costTokens;
            expect(atCheckpoint).toBeGreaterThan(readOnlyTokens);

            // …and the SYNTHESIS after the checkpoint adds again, so the charge
            // survives a resume rather than restarting or being dropped.
            await resumeWorkflowRun(ctx(), paused.runId);
            expect((await runRow(paused.runId)).costTokens).toBeGreaterThan(atCheckpoint);
        });
    });
});
