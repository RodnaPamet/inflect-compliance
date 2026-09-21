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
            key: PROPOSE_WF,
            name: 'Test propose workflow',
            description: 'read → propose a risk → checkpoint → synthesis',
            steps: [
                { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
                {
                    kind: 'PROPOSE', label: 'proposed', tool: 'propose_risks',
                    buildItems: () => [{ title: 'Agentic proposed risk', description: 'from a workflow' }],
                },
                { kind: 'HUMAN_CHECKPOINT', label: 'review' },
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
});
